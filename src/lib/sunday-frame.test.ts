import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { frameMessageFor } from "./sunday-frame.ts";

describe("frameMessageFor", () => {
  it("reports the first paint as ready with the path", () => {
    assert.deepEqual(
      frameMessageFor({ first: true, pathname: "/dashboard", search: "" }),
      { path: "/dashboard", type: "signudoc:ready" },
    );
  });

  it("reports later page changes as navigated with the query", () => {
    assert.deepEqual(
      frameMessageFor({
        first: false,
        pathname: "/envelopes/x",
        search: "tab=audit",
      }),
      { path: "/envelopes/x?tab=audit", type: "signudoc:navigated" },
    );
  });

  it("gives the same path whether or not the search carries its ?", () => {
    assert.deepEqual(
      frameMessageFor({
        first: false,
        pathname: "/envelopes/x",
        search: "?tab=audit",
      }),
      frameMessageFor({
        first: false,
        pathname: "/envelopes/x",
        search: "tab=audit",
      }),
    );
  });

  // useSearchParams().toString() writes a space as "+" and keeps "*"; Sunday's path pattern refuses both and would drop the message.
  it("escapes what Sunday's path pattern refuses, so a search with spaces still reaches it", () => {
    const message = frameMessageFor({
      first: false,
      pathname: "/dashboard",
      search: "q=two+words&s=a*b&n=שלום",
    });
    assert.deepEqual(message, {
      path: "/dashboard?q=two%20words&s=a%2Ab&n=%D7%A9%D7%9C%D7%95%D7%9D",
      type: "signudoc:navigated",
    });
    assert.match(
      (message as { path: string }).path,
      /^\/[A-Za-z0-9/_?=&%.-]*$/,
    );
  });

  it("sends signed-out with no path on /login, first or not", () => {
    for (const first of [true, false]) {
      const message = frameMessageFor({
        first,
        pathname: "/login",
        search: "",
      });

      assert.deepEqual(message, { type: "signudoc:signed-out" });
      assert.equal("path" in message, false);
    }
  });

  it("reports a page Sunday does not list as ready, leaving the choice to Sunday", () => {
    assert.deepEqual(
      frameMessageFor({ first: true, pathname: "/two-step-setup", search: "" }),
      { path: "/two-step-setup", type: "signudoc:ready" },
    );
  });
});
