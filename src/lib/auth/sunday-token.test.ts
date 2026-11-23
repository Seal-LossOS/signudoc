import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";

import { isSafeSundayNext, SUNDAY_DEFAULT_NEXT } from "./sunday-path.ts";
import {
  missingSundayBridgeSettings,
  readSundayBridgeConfig,
  verifySundayToken,
} from "./sunday-token.ts";

// The committed test vector, shared with Sunday's repo (P1 of the signatures brief).
const SECRET = "sunday-bridge-test-secret-0123456789abcdef";
const AUDIENCE = "https://signday.example.test";
const WORKSPACE = "ws_test_0001";
const CLAIMS = {
  iss: "sunday",
  aud: AUDIENCE,
  ws: WORKSPACE,
  sub: "user_test_0001",
  email: "oran@example.com",
  name: "אורן G",
  role: "admin",
  iat: 1795000000,
  exp: 1795000060,
  jti: "0123456789abcdef0123456789abcdef",
};
const VECTOR =
  "v1.eyJpc3MiOiJzdW5kYXkiLCJhdWQiOiJodHRwczovL3NpZ25kYXkuZXhhbXBsZS50ZXN0Iiwid3MiOiJ3c190ZXN0XzAwMDEiLCJzdWIiOiJ1c2VyX3Rlc3RfMDAwMSIsImVtYWlsIjoib3JhbkBleGFtcGxlLmNvbSIsIm5hbWUiOiLXkNeV16jXnyBHIiwicm9sZSI6ImFkbWluIiwiaWF0IjoxNzk1MDAwMDAwLCJleHAiOjE3OTUwMDAwNjAsImp0aSI6IjAxMjM0NTY3ODlhYmNkZWYwMTIzNDU2Nzg5YWJjZGVmIn0.eB0C4baGyqq-G6PEnHa_d4LyREGTFJ-2RJFD5vMPx2Q";

const expected = {
  audience: AUDIENCE,
  workspaceId: WORKSPACE,
  secret: SECRET,
  nowSeconds: 1795000010,
};

// Mints a token the way Sunday does (P1): the claims JSON, then HMAC over "v1." + payload.
function mint(claims: Record<string, unknown>, secret: string): string {
  const payload = Buffer.from(JSON.stringify(claims), "utf8").toString(
    "base64url",
  );
  const signature = createHmac("sha256", secret)
    .update(`v1.${payload}`)
    .digest("base64url");

  return `v1.${payload}.${signature}`;
}

test("the committed vector verifies and yields its claims", () => {
  assert.equal(mint(CLAIMS, SECRET), VECTOR);

  const result = verifySundayToken(VECTOR, expected);

  assert.deepEqual(result, { ok: true, claims: CLAIMS });
});

test("a token is refused as expired at its exp, and as not yet valid beyond the clock skew", () => {
  assert.deepEqual(
    verifySundayToken(VECTOR, { ...expected, nowSeconds: 1795000060 }),
    { ok: false, reason: "expired" },
  );
  assert.deepEqual(
    verifySundayToken(VECTOR, { ...expected, nowSeconds: 1794999960 }),
    { ok: false, reason: "not_yet_valid" },
  );
  assert.deepEqual(
    verifySundayToken(VECTOR, { ...expected, nowSeconds: 1794999975 }),
    { ok: true, claims: CLAIMS },
  );
});

test("a token signed with another secret, or altered after signing, is a bad signature", () => {
  assert.deepEqual(
    verifySundayToken(VECTOR, { ...expected, secret: `${SECRET}x` }),
    { ok: false, reason: "bad_signature" },
  );

  const [version, payload, signature] = VECTOR.split(".");

  assert.equal(signature[0], "e");
  assert.deepEqual(
    verifySundayToken(
      [version, payload, `f${signature.slice(1)}`].join("."),
      expected,
    ),
    { ok: false, reason: "bad_signature" },
  );

  const userPayload = Buffer.from(
    JSON.stringify({ ...CLAIMS, role: "user" }),
    "utf8",
  ).toString("base64url");

  assert.deepEqual(
    verifySundayToken([version, userPayload, signature].join("."), expected),
    { ok: false, reason: "bad_signature" },
  );
});

test("a token for another audience or workspace is refused", () => {
  assert.deepEqual(
    verifySundayToken(VECTOR, {
      ...expected,
      audience: "https://other.example.test",
    }),
    { ok: false, reason: "wrong_audience" },
  );
  assert.deepEqual(
    verifySundayToken(VECTOR, { ...expected, workspaceId: "ws_other" }),
    { ok: false, reason: "wrong_workspace" },
  );
});

test("a token that does not have the v1 three-part shape is malformed", () => {
  for (const token of ["", "v2.a.b", "v1.abc", "v1.a.b.c", "v1.a+b.c"]) {
    assert.deepEqual(
      verifySundayToken(token, expected),
      {
        ok: false,
        reason: "malformed",
      },
      token,
    );
  }
});

test("a validly signed token with a wrong claim is refused for that claim", () => {
  assert.deepEqual(
    verifySundayToken(mint({ ...CLAIMS, iss: "other" }, SECRET), expected),
    { ok: false, reason: "wrong_issuer" },
  );
  assert.deepEqual(
    verifySundayToken(
      mint({ ...CLAIMS, exp: CLAIMS.iat + 61 }, SECRET),
      expected,
    ),
    { ok: false, reason: "malformed" },
  );
  assert.deepEqual(
    verifySundayToken(mint({ ...CLAIMS, jti: "xyz" }, SECRET), expected),
    { ok: false, reason: "malformed" },
  );
});

test("the email is trimmed and lower-cased on the way out", () => {
  const result = verifySundayToken(
    mint({ ...CLAIMS, email: "Oran@Example.com " }, SECRET),
    expected,
  );

  assert.equal(result.ok, true);
  assert.equal(result.ok && result.claims.email, "oran@example.com");
});

test("the handoff path accepts exactly the SignuDoc pages of the prefixes", () => {
  const rows: [string, boolean][] = [
    ["/dashboard", true],
    ["/dashboard/", true],
    ["/envelopes/8c1d0e2a-1111-4222-8333-444455556666", true],
    ["/envelopes/8c1d/prepare", true],
    ["/templates?page=2", true],
    ["/settings/organization", true],
    ["/dashboard?a=b&c=%20", true],
    ["/envelopes?next=//x", true],
    ["/dashboardx", false],
    ["/", false],
    ["//x", false],
    ["//evil.example/dashboard", false],
    ["/dashboard/../api", false],
    ["/dashboard/%2e%2e/api", false],
    ["/dashboard/%2E%2E/api", false],
    ["/dashboard/./x", false],
    ["/api/v1/me", false],
    ["/sign/abc", false],
    ["/dashboard#x", false],
    ["dashboard", false],
    ["/Dashboard", false],
    ["/dashboard\\x", false],
    [`/${"a".repeat(600)}`, false],
  ];

  for (const [path, safe] of rows) {
    assert.equal(isSafeSundayNext(path), safe, path);
  }
  assert.equal(isSafeSundayNext(undefined), false);
  assert.equal(isSafeSundayNext(42), false);
  assert.equal(SUNDAY_DEFAULT_NEXT, "/dashboard");
});

const bridge = {
  SUNDAY_BRIDGE_SECRET: SECRET,
  SUNDAY_WORKSPACE_ID: WORKSPACE,
  SUNDAY_ORIGIN: "https://sunday.getseal.ai",
};

test("the bridge config needs a long secret, a workspace and an https origin", () => {
  assert.deepEqual(readSundayBridgeConfig(bridge), {
    secret: SECRET,
    sundayOrigin: "https://sunday.getseal.ai",
    workspaceId: WORKSPACE,
  });
  assert.equal(
    readSundayBridgeConfig({
      ...bridge,
      SUNDAY_BRIDGE_SECRET: "x".repeat(31),
    }),
    null,
  );
  assert.equal(
    readSundayBridgeConfig({ ...bridge, SUNDAY_ORIGIN: "http://x.test" }),
    null,
  );
  assert.equal(
    readSundayBridgeConfig({ ...bridge, SUNDAY_WORKSPACE_ID: undefined }),
    null,
  );
});

test("missing bridge settings are named in order, and none when none is set", () => {
  assert.deepEqual(missingSundayBridgeSettings({}), []);
  assert.deepEqual(
    missingSundayBridgeSettings({ SUNDAY_BRIDGE_SECRET: SECRET }),
    ["SUNDAY_WORKSPACE_ID", "SUNDAY_ORIGIN"],
  );
  assert.deepEqual(missingSundayBridgeSettings(bridge), []);
  assert.deepEqual(
    missingSundayBridgeSettings({ ...bridge, SUNDAY_BRIDGE_SECRET: "short" }),
    ["SUNDAY_BRIDGE_SECRET"],
  );
});
