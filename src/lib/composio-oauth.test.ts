import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  composioAccessToken,
  composioLogIn,
  composioSignOut,
  loadComposioTokens,
} from "@/lib/composio-oauth";
import { setSecret } from "@/lib/secrets";

/**
 * The loopback listener is Rust; here it is a stub that reports a port and
 * then replays whatever redirect the test wants. What is under test is the
 * protocol either side of it: PKCE, the state check, and refresh.
 */
const redirect = { query: "" };
vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (command: string) => {
    if (command === "oauth_listen_port") {
      return 45_678;
    }
    if (command === "oauth_await_redirect") {
      // The real listener blocks until the browser arrives, which is after
      // `openUrl` has run. Resolving immediately would read `redirect.query`
      // before the test had set it, and would also hide a regression where
      // the app opens the browser before it is listening.
      await new Promise((resolve) => setTimeout(resolve, 0));
      return { query: redirect.query };
    }
    throw new Error(`unexpected command ${command}`);
  },
}));

/** Every request the flow made, so the shape of each can be asserted. */
let calls: { url: string; body: string }[] = [];
/** Overridable token-endpoint reply. */
let tokenReply: Record<string, unknown> = {};
/** HTTP status the token endpoint answers with. */
let tokenStatus = 200;

vi.mock("@/lib/http", () => ({
  httpFetch: async (url: string, init: RequestInit) => {
    const body = typeof init.body === "string" ? init.body : "";
    calls.push({ url, body });
    if (url.includes(".well-known")) {
      return new Response(
        JSON.stringify({
          authorization_endpoint: "https://login.composio.dev/oauth2/authorize",
          token_endpoint: "https://login.composio.dev/oauth2/token",
          registration_endpoint: "https://login.composio.dev/oauth2/register",
        }),
        { status: 200 },
      );
    }
    if (url.endsWith("/register")) {
      return new Response(JSON.stringify({ client_id: "client_TEST" }), { status: 200 });
    }
    return new Response(JSON.stringify(tokenReply), { status: tokenStatus });
  },
}));

beforeEach(async () => {
  calls = [];
  tokenStatus = 200;
  tokenReply = {
    access_token: "at_first",
    refresh_token: "rt_first",
    expires_in: 3600,
  };
  redirect.query = "code=the_code&state=REPLACED";
  await composioSignOut();
});

/** Drive a sign-in, echoing back the state the flow actually generated. */
async function signIn(mangle?: (state: string) => string): Promise<void> {
  await composioLogIn(async (url) => {
    const state = new URL(url).searchParams.get("state") ?? "";
    redirect.query = `code=the_code&state=${mangle === undefined ? state : mangle(state)}`;
  });
}

describe("composioLogIn", () => {
  it("uses PKCE S256 and a loopback redirect, and stores the tokens", async () => {
    let authorizeUrl = "";
    await composioLogIn(async (url) => {
      authorizeUrl = url;
      const state = new URL(url).searchParams.get("state") ?? "";
      redirect.query = `code=the_code&state=${state}`;
    });

    const params = new URL(authorizeUrl).searchParams;
    // S256, not "plain": a plain challenge is the verifier, so anything that
    // can read the authorize URL can complete the exchange.
    expect(params.get("code_challenge_method")).toBe("S256");
    expect(params.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // RFC 8252: loopback, never a custom scheme another app can claim.
    expect(params.get("redirect_uri")).toBe("http://127.0.0.1:45678/callback");
    // Without this the session dies on every restart.
    expect(params.get("scope")).toContain("offline_access");

    const exchange = calls.at(-1);
    expect(exchange?.url).toContain("/token");
    expect(exchange?.body).toContain("grant_type=authorization_code");
    // The verifier proves this is the client that asked for the code.
    expect(exchange?.body).toContain("code_verifier=");
    // A public client sends no secret, because it has none to send.
    expect(exchange?.body).not.toContain("client_secret");

    await expect(loadComposioTokens()).resolves.toMatchObject({
      access: "at_first",
      refresh: "rt_first",
      clientId: "client_TEST",
    });
  });

  it("never reuses a code that came back with the wrong state", async () => {
    // The check that stops another local process from feeding us a code it
    // obtained: without it, that code would be exchanged and stored as ours.
    await expect(signIn((state) => `${state}_tampered`)).rejects.toThrow(/wrong state/i);
    await expect(loadComposioTokens()).resolves.toBeNull();
    expect(calls.some((call) => call.url.includes("/token"))).toBe(false);
  });

  it("passes a provider error through instead of storing nothing quietly", async () => {
    await composioSignOut();
    await expect(
      composioLogIn(async () => {
        redirect.query = "error=access_denied&error_description=You+said+no";
      }),
    ).rejects.toThrow(/You said no/);
  });

  it("generates a different verifier and state each time", async () => {
    const seen = new Set<string>();
    for (let attempt = 0; attempt < 3; attempt++) {
      await composioLogIn(async (url) => {
        const params = new URL(url).searchParams;
        seen.add(`${params.get("state")}:${params.get("code_challenge")}`);
        redirect.query = `code=c&state=${params.get("state")}`;
      });
    }
    // Reuse would make one stolen verifier good for every future sign-in.
    expect(seen.size).toBe(3);
  });
});

describe("composioAccessToken", () => {
  it("is null when signed out, so callers fall back to a pasted key", async () => {
    await expect(composioAccessToken()).resolves.toBeNull();
  });

  it("returns the stored token while it is still fresh", async () => {
    await signIn();
    calls = [];
    await expect(composioAccessToken()).resolves.toBe("at_first");
    // No network: a valid token must not cost a round trip per tool call.
    expect(calls).toHaveLength(0);
  });

  it("refreshes an expired token without asking the user", async () => {
    await setSecret(
      "composio-oauth",
      JSON.stringify({
        access: "at_stale",
        refresh: "rt_first",
        expires: Date.now() - 1_000,
        clientId: "client_TEST",
      }),
    );
    tokenReply = { access_token: "at_second", expires_in: 3600 };

    await expect(composioAccessToken()).resolves.toBe("at_second");
    expect(calls.at(-1)?.body).toContain("grant_type=refresh_token");
    // The server omitted a new refresh token, so the old one must stand —
    // dropping it would sign the user out an hour later.
    await expect(loadComposioTokens()).resolves.toMatchObject({ refresh: "rt_first" });
  });

  it("signs out when the refresh token is dead, rather than retrying forever", async () => {
    await setSecret(
      "composio-oauth",
      JSON.stringify({
        access: "at_stale",
        refresh: "rt_revoked",
        expires: Date.now() - 1_000,
        clientId: "client_TEST",
      }),
    );
    tokenStatus = 400;
    tokenReply = { error: "invalid_grant" };

    await expect(composioAccessToken()).resolves.toBeNull();
    await expect(loadComposioTokens()).resolves.toBeNull();
  });

  it("refreshes once for a burst of callers", async () => {
    await setSecret(
      "composio-oauth",
      JSON.stringify({
        access: "at_stale",
        refresh: "rt_first",
        expires: Date.now() - 1_000,
        clientId: "client_TEST",
      }),
    );
    tokenReply = { access_token: "at_second", expires_in: 3600 };

    const results = await Promise.all([
      composioAccessToken(),
      composioAccessToken(),
      composioAccessToken(),
    ]);
    expect(results).toEqual(["at_second", "at_second", "at_second"]);
    // Three tool calls starting together must not mint three sessions and
    // race over which one gets stored.
    expect(calls.filter((call) => call.body.includes("grant_type=refresh_token"))).toHaveLength(1);
  });

  it("treats a corrupt keychain entry as signed out", async () => {
    await setSecret("composio-oauth", "{not json");
    await expect(composioAccessToken()).resolves.toBeNull();
  });
});
