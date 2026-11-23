import type { EnvSource } from "./utils/env.ts";

// Reading the site that may frame an embedded signing page. Kept apart
// from embedding.ts, which talks to the database, because proxy.ts needs
// it on every request to /embed/sign.

/**
 * Plain-http origins, for a test page on this machine. Never on Vercel,
 * whatever the variable says.
 */
export function httpEmbedOriginsAllowed(env: EnvSource = process.env) {
  return env.EMBED_ALLOW_HTTP_ORIGINS === "1" && !env.VERCEL;
}

/**
 * An exact origin, such as https://app.example.com, or null. Paths,
 * queries, wildcards and user names are refused, so what is allowed is
 * exactly one site.
 */
export function parseEmbedOrigin(
  value: unknown,
  env: EnvSource = process.env,
): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim().replace(/\/$/, "");

  if (trimmed.length === 0 || trimmed.length > 255 || trimmed.includes("*")) {
    return null;
  }

  let url: URL;

  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }

  const allowedProtocol =
    url.protocol === "https:" ||
    (url.protocol === "http:" && httpEmbedOriginsAllowed(env));

  if (!allowedProtocol || url.username || url.password) {
    return null;
  }

  // Nothing but the origin itself.
  return url.origin.toLowerCase() === trimmed.toLowerCase() ? url.origin : null;
}

/**
 * The one site that may frame the app's own pages (a portal the whole
 * app is shown inside, such as Sunday), from APP_FRAME_ORIGIN. Null when
 * unset or not one exact origin.
 */
export function readAppFrameOrigin(
  env: EnvSource = process.env,
): string | null {
  return parseEmbedOrigin(env.APP_FRAME_ORIGIN, env);
}

// Never framed by the portal: the signer's pages and downloads (so a
// signature is never captured inside someone else's frame) and the API.
const NEVER_FRAMED_PREFIXES = ["/sign/", "/download/", "/api/"] as const;

function isNeverFramed(pathname: string): boolean {
  return NEVER_FRAMED_PREFIXES.some(
    (prefix) => pathname === prefix.slice(0, -1) || pathname.startsWith(prefix),
  );
}

/**
 * The Content-Security-Policy frame-ancestors sources for a path: the
 * origin named in ?origin= on an embedded signing page, else none. The page
 * itself then refuses to open unless that origin is the one its link was
 * made for, and the link was made only for an origin an administrator
 * allowed. So a page shows in a frame only on an allowed site. With
 * APP_FRAME_ORIGIN set, the app's other pages may be framed by that one site.
 */
export function frameAncestorsFor(
  pathname: string,
  searchParams: URLSearchParams,
  env: EnvSource = process.env,
): string {
  if (pathname.startsWith("/embed/")) {
    return pathname.startsWith("/embed/sign/")
      ? (parseEmbedOrigin(searchParams.get("origin"), env) ?? "'none'")
      : "'none'";
  }

  if (isNeverFramed(pathname)) {
    return "'none'";
  }

  return readAppFrameOrigin(env) ?? "'none'";
}
