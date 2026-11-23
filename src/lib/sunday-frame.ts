// What a page framed by Sunday tells it (product-signatures D9): hints for
// Sunday's address bar and states, never authority. Sunday checks the
// sender and parses each message itself.

export type SundayFrameMessage =
  | { path: string; type: "signudoc:navigated" }
  | { path: string; type: "signudoc:ready" }
  | { type: "signudoc:signed-out" };

/** Escapes what Sunday's path pattern refuses: useSearchParams writes a space as "+" and keeps "*", and both would drop the message. */
function toSafePath(text: string): string {
  return text
    .replace(/\+/g, "%20")
    .replace(/[^A-Za-z0-9/_?=&%.-]/g, (character) =>
      /^[ -~]$/.test(character)
        ? `%${character.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`
        : encodeURIComponent(character),
    );
}

/** The message for a page: signed-out on /login, ready on first paint, navigated after. */
export function frameMessageFor(input: {
  first: boolean;
  pathname: string;
  search: string;
}): SundayFrameMessage {
  if (input.pathname === "/login") {
    return { type: "signudoc:signed-out" };
  }

  const search = input.search.replace(/^\?/, "");
  const path = toSafePath(
    search ? `${input.pathname}?${search}` : input.pathname,
  );

  return input.first
    ? { path, type: "signudoc:ready" }
    : { path, type: "signudoc:navigated" };
}
