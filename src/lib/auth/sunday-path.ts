// Where Sunday's handoff may send a person inside SignuDoc (P2 of Sunday's signatures brief). Client-safe: the /sunday/enter page imports it.

export const SUNDAY_PATH_PREFIXES = [
  "/dashboard",
  "/envelopes",
  "/templates",
  "/settings",
] as const;

export const SUNDAY_DEFAULT_NEXT = "/dashboard";

const MAX_PATH_LENGTH = 512;
const SAFE_CHARACTERS = /^\/[A-Za-z0-9/_?=&%.-]*$/;

/** A SignuDoc page the bridge may send the person to. The URL round trip refuses dot segments and fragments. */
export function isSafeSundayNext(path: unknown): path is string {
  if (
    typeof path !== "string" ||
    path.length < 1 ||
    path.length > MAX_PATH_LENGTH ||
    !SAFE_CHARACTERS.test(path) ||
    path.startsWith("//")
  ) {
    return false;
  }

  let url: URL;

  try {
    url = new URL(path, "https://x");
  } catch {
    return false;
  }

  if (url.origin !== "https://x" || url.pathname + url.search !== path) {
    return false;
  }

  return SUNDAY_PATH_PREFIXES.some(
    (prefix) =>
      url.pathname === prefix || url.pathname.startsWith(`${prefix}/`),
  );
}
