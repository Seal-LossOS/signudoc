// What a page framed by Sunday tells it (product-signatures D9): hints for
// Sunday's address bar and states, never authority. Sunday checks the
// sender and parses each message itself.

export type SundayFrameMessage =
  | { path: string; type: "signudoc:navigated" }
  | { path: string; type: "signudoc:ready" }
  | { type: "signudoc:signed-out" };

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
  const path = search ? `${input.pathname}?${search}` : input.pathname;

  return input.first
    ? { path, type: "signudoc:ready" }
    : { path, type: "signudoc:navigated" };
}
