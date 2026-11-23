import assert from "node:assert/strict";
import test from "node:test";

import {
  frameAncestorsFor,
  parseEmbedOrigin,
  readAppFrameOrigin,
} from "./embed-origin.ts";

test("an embed origin is one exact https site", () => {
  const env = {};

  assert.equal(
    parseEmbedOrigin("https://app.example.com", env),
    "https://app.example.com",
  );
  assert.equal(
    parseEmbedOrigin("https://App.Example.com/", env),
    "https://app.example.com",
  );
  assert.equal(
    parseEmbedOrigin("https://app.example.com:8443", env),
    "https://app.example.com:8443",
  );

  for (const bad of [
    "http://app.example.com",
    "https://app.example.com/path",
    "https://app.example.com?x=1",
    "https://*.example.com",
    "https://user@app.example.com",
    "app.example.com",
    "javascript:alert(1)",
    "",
    null,
    42,
  ]) {
    assert.equal(parseEmbedOrigin(bad, env), null, String(bad));
  }
});

test("plain http origins only when asked for, and never on Vercel", () => {
  assert.equal(
    parseEmbedOrigin("http://127.0.0.1:4000", {
      EMBED_ALLOW_HTTP_ORIGINS: "1",
    }),
    "http://127.0.0.1:4000",
  );
  assert.equal(
    parseEmbedOrigin("http://127.0.0.1:4000", {
      EMBED_ALLOW_HTTP_ORIGINS: "1",
      VERCEL: "1",
    }),
    null,
  );
});

test("only an embedded signing page may be framed, and only by the site it names", () => {
  const env = {};
  const named = new URLSearchParams({ origin: "https://app.example.com" });

  assert.equal(
    frameAncestorsFor("/embed/sign/abc", named, env),
    "https://app.example.com",
  );
  assert.equal(frameAncestorsFor("/sign/abc", named, env), "'none'");
  assert.equal(frameAncestorsFor("/settings", named, env), "'none'");
  assert.equal(
    frameAncestorsFor(
      "/embed/sign/abc",
      new URLSearchParams({
        origin: "https://a.example.com https://b.example.com",
      }),
      env,
    ),
    "'none'",
  );
  assert.equal(
    frameAncestorsFor(
      "/embed/sign/abc",
      new URLSearchParams({ origin: "https://app.example.com; script-src *" }),
      env,
    ),
    "'none'",
  );
  assert.equal(
    frameAncestorsFor("/embed/sign/abc", new URLSearchParams(), env),
    "'none'",
  );
});

const portalEnv = { APP_FRAME_ORIGIN: "https://sunday.example.com" };

test("with APP_FRAME_ORIGIN set, the app's own pages may be framed by that one site", () => {
  const none = new URLSearchParams();

  for (const path of [
    "/dashboard",
    "/envelopes/x/prepare",
    "/settings",
    "/login",
    "/sunday/enter",
  ]) {
    assert.equal(
      frameAncestorsFor(path, none, portalEnv),
      "https://sunday.example.com",
      path,
    );
  }
});

test("with APP_FRAME_ORIGIN set, signing pages, downloads and the API are never framed by the portal", () => {
  const none = new URLSearchParams();

  for (const path of ["/sign/x", "/sign", "/download/x", "/api/x", "/api"]) {
    assert.equal(frameAncestorsFor(path, none, portalEnv), "'none'", path);
  }
});

test("an embedded signing page keeps its own origin rule under APP_FRAME_ORIGIN", () => {
  assert.equal(
    frameAncestorsFor(
      "/embed/sign/abc",
      new URLSearchParams({ origin: "https://app.example.com" }),
      portalEnv,
    ),
    "https://app.example.com",
  );
  assert.equal(
    frameAncestorsFor("/embed/sign/abc", new URLSearchParams(), portalEnv),
    "'none'",
  );
  assert.equal(
    frameAncestorsFor("/embed/other", new URLSearchParams(), portalEnv),
    "'none'",
  );
});

test("an invalid APP_FRAME_ORIGIN is ignored", () => {
  for (const value of [
    "http://sunday.example.com",
    "https://sunday.example.com/path",
    "https://*.example.com",
    "",
  ]) {
    assert.equal(
      frameAncestorsFor("/dashboard", new URLSearchParams(), {
        APP_FRAME_ORIGIN: value,
      }),
      "'none'",
      value,
    );
  }
});

test("without APP_FRAME_ORIGIN the app's own pages are not framed", () => {
  assert.equal(
    frameAncestorsFor("/dashboard", new URLSearchParams(), {}),
    "'none'",
  );
});

test("readAppFrameOrigin returns the exact origin in lower case", () => {
  assert.equal(
    readAppFrameOrigin({ APP_FRAME_ORIGIN: "https://Sunday.Example.com/" }),
    "https://sunday.example.com",
  );
});
