import type { MouseEvent, ReactNode } from "react";
import { openExternal } from "@/lib/tauri";

type ExternalLinkProps = {
  href: string;
  children: ReactNode;
  className?: string;
};

/**
 * Opens a URL in the user's real browser instead of inside the webview.
 *
 * The webview must never navigate away from the bundled app: a navigated
 * webview keeps the IPC bridge, so remote content would be able to call
 * commands. The URL must also be allowed by the `opener` capability scope.
 */
export function ExternalLink({ href, children, className }: ExternalLinkProps) {
  const onClick = (event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    openExternal(href).catch(() => {
      // Blocked by the capability scope or no handler available: nothing to do
      // beyond leaving the user where they are.
    });
  };

  return (
    <a href={href} className={className} onClick={onClick} rel="noreferrer noopener">
      {children}
    </a>
  );
}
