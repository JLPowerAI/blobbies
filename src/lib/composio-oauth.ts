/**
 * Sign in to Composio with a browser, instead of pasting a key.
 *
 * A key works and stays supported, but it is a worse first run: the person
 * has to find the dashboard, locate the right page, copy a secret and paste
 * it into a desktop app. Composio's MCP endpoint advertises OAuth, so the
 * button can just say "Log in" — the same thing the old CLI did, minus the
 * CLI.
 *
 * Every step below was verified against the live server before it was
 * written:
 *
 * - `WWW-Authenticate` on an unauthenticated request points at the RFC 9728
 *   metadata, which names `login.composio.dev` as the authorization server.
 * - **Dynamic client registration works**, so no client id is baked into this
 *   repo and nothing has to be pre-arranged with Composio.
 * - **No client secret is issued** (`token_endpoint_auth_method: "none"`),
 *   which is the correct shape for a public client — there is no secret in
 *   the binary for anyone to extract.
 * - **PKCE S256** is supported and used, so an authorization code lifted from
 *   the loopback socket is useless without the verifier, which never leaves
 *   this process.
 * - `offline_access` is granted, so the session survives a restart without
 *   asking the user to sign in every launch.
 *
 * The redirect lands on `http://127.0.0.1:{random}` per RFC 8252. A custom
 * scheme would be simpler and worse: any program on the machine can register
 * `blobbies://` and race for the code.
 */

import { invoke } from "@tauri-apps/api/core";
import { httpFetch } from "@/lib/http";
import { deleteSecret, getSecret, setSecret } from "@/lib/secrets";

/** Composio's authorization server, from its own protected-resource metadata. */
const ISSUER = "https://login.composio.dev";

/** The resource these tokens are for, echoed per RFC 8707. */
const RESOURCE = "https://connect.composio.dev/mcp";

/** Everything the MCP endpoint needs, plus a refresh token. */
const SCOPE = "openid profile email offline_access";

/** Endpoints, as published by the issuer's discovery document. */
interface Metadata {
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
}

/** What the token endpoint hands back. */
interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

/** What we keep between launches. */
export interface StoredTokens {
  access: string;
  refresh: string;
  /** Epoch ms when `access` stops being usable. */
  expires: number;
  /** The registered client, reused so every launch is not a new client. */
  clientId: string;
}

/** Failure already phrased for a person. */
export class OauthError extends Error {}

/** Base64url without padding, which every OAuth field wants. */
function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Cryptographically random string for a verifier or a state value. */
function randomToken(bytes = 32): string {
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

/** The S256 challenge for a verifier. */
async function challengeFor(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

async function json<T>(response: Response, what: string): Promise<T> {
  if (!response.ok) {
    throw new OauthError(`Composio ${what} failed (${response.status}).`);
  }
  return (await response.json()) as T;
}

/** Discovery, so endpoints are never hardcoded and can move. */
async function metadata(): Promise<Metadata> {
  return json<Metadata>(
    await httpFetch(`${ISSUER}/.well-known/oauth-authorization-server`, { method: "GET" }),
    "discovery",
  );
}

/**
 * Register this install as its own OAuth client.
 *
 * Per install rather than one shared id in the repo: a public client id in
 * open source is not a secret, and registering locally means revoking one
 * user's client cannot affect anybody else.
 */
async function register(redirectUri: string, endpoint: string): Promise<string> {
  const registered = await json<{ client_id?: string }>(
    await httpFetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "Blobbies",
        redirect_uris: [redirectUri],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
        scope: SCOPE,
      }),
    }),
    "client registration",
  );
  if (registered.client_id === undefined) {
    throw new OauthError("Composio did not issue a client id.");
  }
  return registered.client_id;
}

/** Persist tokens in the OS keychain, never a file. */
async function store(tokens: StoredTokens): Promise<void> {
  await setSecret("composio-oauth", JSON.stringify(tokens));
}

/** Read the stored session, or null when there is none. */
export async function loadComposioTokens(): Promise<StoredTokens | null> {
  const raw = await getSecret("composio-oauth");
  if (raw === null || raw === "") {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as StoredTokens;
    return typeof parsed.access === "string" && parsed.access !== "" ? parsed : null;
  } catch {
    // Corrupt entry: treat as signed out rather than wedging every request.
    return null;
  }
}

/** Forget the session entirely. */
export async function composioSignOut(): Promise<void> {
  await deleteSecret("composio-oauth");
}

/** Convert a token response into what we store, or explain the refusal. */
function toStored(body: TokenResponse, clientId: string, previous?: StoredTokens): StoredTokens {
  if (body.error !== undefined || body.access_token === undefined) {
    throw new OauthError(body.error_description ?? body.error ?? "Composio refused the sign-in.");
  }
  return {
    access: body.access_token,
    // A server may omit a new refresh token and expect the old one to stand.
    refresh: body.refresh_token ?? previous?.refresh ?? "",
    // 60s of slack, so a token cannot expire between the check and the call.
    expires: Date.now() + (body.expires_in ?? 3600) * 1000 - 60_000,
    clientId,
  };
}

/**
 * Run the whole browser sign-in and store the result.
 *
 * `openUrl` is injected so the caller decides how a browser opens (and so
 * this is testable); it receives the authorize URL.
 */
export async function composioLogIn(openUrl: (url: string) => Promise<void>): Promise<void> {
  const port = await invoke<number>("oauth_listen_port");
  const redirectUri = `http://127.0.0.1:${port}/callback`;
  const meta = await metadata();
  if (meta.registration_endpoint === undefined) {
    throw new OauthError("Composio does not support automatic sign-in from this app.");
  }
  const clientId = await register(redirectUri, meta.registration_endpoint);

  const verifier = randomToken();
  const state = randomToken(16);
  const authorize = new URL(meta.authorization_endpoint);
  authorize.search = new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    redirect_uri: redirectUri,
    scope: SCOPE,
    state,
    code_challenge: await challengeFor(verifier),
    code_challenge_method: "S256",
    resource: RESOURCE,
  }).toString();

  // Listen before opening, or a fast redirect can arrive before the socket is
  // ready and the sign-in hangs on a code nobody caught.
  const waiting = invoke<{ query: string }>("oauth_await_redirect", { port });
  await openUrl(authorize.toString());
  const { query } = await waiting;

  const returned = new URLSearchParams(query);
  const error = returned.get("error");
  if (error !== null) {
    throw new OauthError(returned.get("error_description") ?? error);
  }
  // Constant-ish comparison is beside the point here (the value is ours and
  // single-use), but the check itself is not: without it a code injected by
  // another local process would be exchanged as though we had asked for it.
  if (returned.get("state") !== state) {
    throw new OauthError("The sign-in came back with the wrong state. Try again.");
  }
  const code = returned.get("code");
  if (code === null) {
    throw new OauthError("The sign-in came back without a code. Try again.");
  }

  const body = await json<TokenResponse>(
    await httpFetch(meta.token_endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        client_id: clientId,
        code_verifier: verifier,
        resource: RESOURCE,
      }).toString(),
    }),
    "token exchange",
  );
  await store(toStored(body, clientId));
}

/** Swap a refresh token for a fresh access token. */
async function refresh(tokens: StoredTokens): Promise<StoredTokens> {
  if (tokens.refresh === "") {
    throw new OauthError("Session expired. Sign in to Composio again.");
  }
  const meta = await metadata();
  const body = await json<TokenResponse>(
    await httpFetch(meta.token_endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: tokens.refresh,
        client_id: tokens.clientId,
        resource: RESOURCE,
      }).toString(),
    }),
    "token refresh",
  );
  const next = toStored(body, tokens.clientId, tokens);
  await store(next);
  return next;
}

/** One refresh at a time, however many callers ask at once. */
let refreshing: Promise<StoredTokens> | null = null;

/**
 * A usable access token, refreshing first when the stored one has aged out.
 *
 * Returns null when the user has not signed in, which is not an error: the
 * caller falls back to a pasted key.
 */
export async function composioAccessToken(): Promise<string | null> {
  const tokens = await loadComposioTokens();
  if (tokens === null) {
    return null;
  }
  if (Date.now() < tokens.expires) {
    return tokens.access;
  }
  refreshing ??= refresh(tokens).finally(() => {
    refreshing = null;
  });
  try {
    return (await refreshing).access;
  } catch {
    // A refresh token the server no longer honours means signed out. Clearing
    // it turns every later call into "sign in again" instead of a retry loop
    // against a dead credential.
    await composioSignOut();
    return null;
  }
}
