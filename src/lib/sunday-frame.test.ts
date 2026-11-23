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
