import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import { after, before, beforeEach, test } from "node:test";

import type pg from "pg";

import type { createAppAuth as CreateAppAuth } from "./server.ts";
import { replaceDbPoolForTests } from "../db/connection.ts";
import { openTestDatabase } from "../db/test-database.ts";
import { clearRateLimitStoreForTests } from "../security/rate-limit.ts";
import { listSystemAuditEvents } from "../services/system-audit.ts";
import { invalidateSettingsCache, saveSettings } from "../settings.ts";
import { needsTwoFactorSetup } from "../sign-in-security.ts";

// Sunday's sign-in handoff against a real Postgres and the real Better Auth
// endpoints: tokens are minted here the way Sunday mints them (P1 of Sunday's
// signatures brief) and posted to /api/auth/sunday/enter. Run with
// `npm run test:db`.

const BASE_URL = "http://localhost:3000";
const SECRET = "sunday-bridge-test-secret-0123456789abcdef";
const WORKSPACE = "ws_test_0001";
const PASSWORD = "a long enough passphrase";
const REFUSED = {
  code: "SUNDAY_BRIDGE_REFUSED",
  message: "Open Signatures from Sunday again.",
};

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (/^next\/[a-z-]+$/.test(specifier)) {
      return nextResolve(`${specifier}.js`, context);
    }

    return nextResolve(specifier, context);
  },
});

type Claims = {
  aud: string;
  email: string;
  exp: number;
  iat: number;
  iss: string;
  jti: string;
  name: string;
  role: "admin" | "user";
  sub: string;
  ws: string;
};

let database: pg.Pool;
let replaced: pg.Pool | null = null;
let databaseUrlBefore: string | undefined;
let jtiCounter = 0;

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

/** P1: the claims in Sunday's key order, then HMAC over "v1." + payload. */
function mint(claims: Claims, secret = SECRET): string {
  const ordered = {
    iss: claims.iss,
    aud: claims.aud,
    ws: claims.ws,
    sub: claims.sub,
    email: claims.email,
    name: claims.name,
    role: claims.role,
    iat: claims.iat,
    exp: claims.exp,
    jti: claims.jti,
  };
  const payload = Buffer.from(JSON.stringify(ordered), "utf8").toString(
    "base64url",
  );
  const signature = createHmac("sha256", secret)
    .update(`v1.${payload}`)
    .digest("base64url");

  return `v1.${payload}.${signature}`;
}

function claimsFor(overrides: Partial<Claims> = {}): Claims {
  const iat = nowSeconds();

  jtiCounter += 1;

  return {
    aud: BASE_URL,
    email: "pat@acme.com",
    exp: iat + 60,
    iat,
    iss: "sunday",
    jti: jtiCounter.toString(16).padStart(32, "0"),
    name: "Pat Person",
    role: "user",
    sub: "sunday_user_pat",
    ws: WORKSPACE,
    ...overrides,
  };
}

type Cookies = Map<string, string>;

function cookieHeader(cookies: Cookies): string {
  return [...cookies].map(([name, value]) => `${name}=${value}`).join("; ");
}

function absorbCookies(response: Response, cookies: Cookies) {
  for (const line of response.headers.getSetCookie()) {
    const [pair] = line.split(";");
    const index = pair?.indexOf("=") ?? -1;

    if (!pair || index < 0) {
      continue;
    }

    const name = pair.slice(0, index).trim();
    const value = pair.slice(index + 1).trim();

    if (value === "" || /max-age=0/i.test(line)) {
      cookies.delete(name);
    } else {
      cookies.set(name, value);
    }
  }
}

type Auth = ReturnType<typeof CreateAppAuth>;

function makeAuth(extraEnv: Record<string, string> = {}): Promise<Auth> {
  return import("./server.ts").then(({ createAppAuth }) =>
    createAppAuth({
      database,
      env: {
        APP_URL: BASE_URL,
        BETTER_AUTH_SECRET:
          "test-secret-that-is-long-enough-for-better-auth-0123",
        BETTER_AUTH_URL: BASE_URL,
        EMAIL_DRIVER: "capture",
        NODE_ENV: "test",
        SUNDAY_BRIDGE_SECRET: SECRET,
        SUNDAY_ORIGIN: "https://sunday.example.test",
        SUNDAY_WORKSPACE_ID: WORKSPACE,
        ...extraEnv,
      },
      includeNextCookies: false,
    }),
  );
}

async function post(
  auth: Auth,
  path: string,
  body: unknown,
  cookies: Cookies = new Map(),
) {
  const response = await auth.handler(
    new Request(`${BASE_URL}/api/auth${path}`, {
      body: JSON.stringify(body),
      headers: {
        "content-type": "application/json",
        cookie: cookieHeader(cookies),
        origin: BASE_URL,
        "x-forwarded-for": "203.0.113.9",
      },
      method: "POST",
    }),
  );

  absorbCookies(response, cookies);

  return {
    payload: (await response.json().catch(() => null)) as Record<
      string,
      unknown
    > | null,
    status: response.status,
  };
}

function enter(
  auth: Auth,
  token: string,
  next?: string,
  cookies: Cookies = new Map(),
) {
  return post(
    auth,
    "/sunday/enter",
    next === undefined ? { token } : { next, token },
    cookies,
  );
}

async function sessionUser(auth: Auth, cookies: Cookies) {
  const session = await auth.api.getSession({
    headers: new Headers({ cookie: cookieHeader(cookies) }),
  });

  return session?.user ?? null;
}

async function userRow(email: string) {
  const { rows } = await database.query<{
    emailVerified: boolean;
    id: string;
    name: string;
    role: string;
  }>(
    `select id, name, role, "emailVerified" from "user" where lower(email) = $1`,
    [email],
  );

  return rows;
}

async function sundayLinks(userId?: string) {
  const { rows } = await database.query<{
    accountId: string;
    userId: string;
  }>(
    `select "accountId", "userId" from account where "providerId" = 'sunday' and ($1::text is null or "userId" = $1)`,
    [userId ?? null],
  );

  return rows;
}

async function failureReasons() {
  return (await listSystemAuditEvents({ limit: 100 }, database))
    .filter((event) => event.event === "sign_in_failed")
    .map((event) => event.metadata?.reason);
}

before(async () => {
  database = await openTestDatabase();
  replaced = replaceDbPoolForTests(database);
  databaseUrlBefore = process.env.DATABASE_URL;
  process.env.DATABASE_URL =
    process.env.E2E_DATABASE_URL ??
    "postgres://signudoc:signudoc@127.0.0.1:5432/signudoc_e2e";
});

beforeEach(async () => {
  await database.query(`truncate public."user" cascade`);
  await database.query("delete from public.system_audit_events");
  await database.query("delete from public.app_settings");
  await database.query("delete from public.rate_limits");
  await database.query("delete from public.verification");
  await database.query("delete from public.sunday_bridge_uses");
  clearRateLimitStoreForTests();
  invalidateSettingsCache();
  await saveSettings({ signupMode: "open" }, database);
  // An install that has been set up has an administrator.
  await database.query(
    `insert into "user" (id, name, email, "emailVerified", role) values ($1, 'Owner', 'owner@acme.com', true, 'admin')`,
    [randomUUID()],
  );
});

after(async () => {
  await database.query(`truncate public."user" cascade`);
  await database.query("delete from public.system_audit_events");
  await database.query("delete from public.app_settings");
  await database.query("delete from public.sunday_bridge_uses");
  replaceDbPoolForTests(replaced ?? database);
  process.env.DATABASE_URL = databaseUrlBefore;
  await database.end();
});

test("a new person is made with the claim's role, verified, linked once, and signed in", async () => {
  const auth = await makeAuth();
  const cookies: Cookies = new Map();
  const result = await enter(
    auth,
    mint(claimsFor({ role: "admin" })),
    undefined,
    cookies,
  );

  assert.equal(result.status, 200, JSON.stringify(result.payload));
  assert.deepEqual(result.payload, { next: "/dashboard" });
  assert.ok(cookies.size > 0, "the answer sets a session cookie");

  const [row, ...others] = await userRow("pat@acme.com");

  assert.equal(others.length, 0);
  assert.equal(row?.role, "admin");
  assert.equal(row?.emailVerified, true);
  assert.equal(row?.name, "Pat Person");
  assert.deepEqual(await sundayLinks(), [
    { accountId: "sunday_user_pat", userId: row?.id },
  ]);

  // The cookie is an ordinary session: Better Auth reads it back, and its
  // row is what the session controls check.
  assert.equal((await sessionUser(auth, cookies))?.id, row?.id);

  const sessions = await database.query(
    `select 1 from session where "userId" = $1`,
    [row?.id],
  );

  assert.equal(sessions.rowCount, 1);
});

test("an existing password account with the same address in another case is linked, not duplicated", async () => {
  const auth = await makeAuth();
  const context = await auth.$context;
  const id = randomUUID();

  await database.query(
    `insert into "user" (id, name, email, "emailVerified", role) values ($1, 'Pat Person', 'Pat@Acme.com', true, 'user')`,
    [id],
  );
  await database.query(
    `insert into account (id, "accountId", "providerId", "userId", password) values ($1, $2, 'credential', $2, $3)`,
    [randomUUID(), id, await context.password.hash(PASSWORD)],
  );

  const cookies: Cookies = new Map();
  const result = await enter(auth, mint(claimsFor()), undefined, cookies);

  assert.equal(result.status, 200, JSON.stringify(result.payload));
  assert.equal((await sessionUser(auth, cookies))?.id, id);
  assert.equal((await userRow("pat@acme.com")).length, 1);
  assert.deepEqual(await sundayLinks(), [
    { accountId: "sunday_user_pat", userId: id },
  ]);
});

test("a linked person is found by their Sunday id after their address changed on Sunday", async () => {
  const auth = await makeAuth();
  const first = new Map<string, string>();

  assert.equal(
    (await enter(auth, mint(claimsFor()), undefined, first)).status,
    200,
  );

  const [pat] = await userRow("pat@acme.com");
  const second: Cookies = new Map();
  const result = await enter(
    auth,
    mint(claimsFor({ email: "patricia@acme.com" })),
    undefined,
    second,
  );

  assert.equal(result.status, 200, JSON.stringify(result.payload));
  assert.equal((await sessionUser(auth, second))?.id, pat?.id);
  assert.equal((await userRow("patricia@acme.com")).length, 0);
  assert.equal((await sundayLinks()).length, 1);
});

test("a token used twice is refused the second time, and the replay is audited", async () => {
  const auth = await makeAuth();
  const token = mint(claimsFor());

  assert.equal((await enter(auth, token)).status, 200);

  const replay = await enter(auth, token);

  assert.equal(replay.status, 401);
  assert.deepEqual(replay.payload, REFUSED);
  assert.deepEqual(await failureReasons(), ["replayed"]);
});

test("expired, wrong-workspace and badly signed tokens get one answer and audit their own reason", async () => {
  const auth = await makeAuth();
  const now = nowSeconds();
  const tokens = [
    mint(claimsFor({ exp: now - 1, iat: now - 61 })),
    mint(claimsFor({ ws: "ws_other" })),
    mint(claimsFor(), "another-secret-that-is-long-enough-0123456789"),
  ];

  for (const token of tokens) {
    const result = await enter(auth, token);

    assert.equal(result.status, 401);
    assert.deepEqual(result.payload, REFUSED);
  }

  assert.deepEqual((await failureReasons()).sort(), [
    "bad_signature",
    "expired",
    "wrong_workspace",
  ]);
  assert.equal((await userRow("pat@acme.com")).length, 0);
});

test("a later sign-in as a user leaves an administrator one, and updates the name", async () => {
  const auth = await makeAuth();

  assert.equal(
    (await enter(auth, mint(claimsFor({ role: "admin" })))).status,
    200,
  );
  assert.equal(
    (await enter(auth, mint(claimsFor({ name: "אורן G", role: "user" }))))
      .status,
    200,
  );

  const [row] = await userRow("pat@acme.com");

  assert.equal(row?.role, "admin");
  assert.equal(row?.name, "אורן G");
});

test("the sign-in is in the site trail, and no audit row holds the token", async () => {
  const auth = await makeAuth();
  const token = mint(claimsFor());
  const [, payload, signature] = token.split(".");

  assert.equal((await enter(auth, token)).status, 200);
  assert.equal((await enter(auth, token)).status, 401);

  const [row] = await userRow("pat@acme.com");
  const events = await listSystemAuditEvents({ limit: 100 }, database);
  const succeeded = events.find((event) => event.event === "sign_in_succeeded");

  assert.deepEqual(succeeded?.metadata, { method: "sunday" });
  assert.equal(succeeded?.actorUserId, row?.id);
  assert.equal(succeeded?.targetUserId, row?.id);
  assert.equal(succeeded?.ipAddress, "203.0.113.9");

  for (const event of events) {
    const text = JSON.stringify(event);

    assert.ok(!text.includes(payload ?? "?"), event.event);
    assert.ok(!text.includes(signature ?? "?"), event.event);
  }
});

test("requiring two-step sign-in does not hold up someone who only arrives from Sunday", async () => {
  const auth = await makeAuth();
  const cookies: Cookies = new Map();

  assert.equal(
    (await enter(auth, mint(claimsFor()), undefined, cookies)).status,
    200,
  );

  const user = await sessionUser(auth, cookies);

  assert.ok(user);
  assert.equal(
    await needsTwoFactorSetup({ requireTwoFactor: true }, user, { database }),
    false,
  );
});

test("with the sign-up rule Nobody, Sunday still brings a new person in, and a password sign-up is still refused", async () => {
  await saveSettings({ signupMode: "closed" }, database);
  invalidateSettingsCache();

  const auth = await makeAuth();
  const result = await enter(auth, mint(claimsFor()));

  assert.equal(result.status, 200, JSON.stringify(result.payload));
  assert.equal((await userRow("pat@acme.com")).length, 1);

  const signUp = await post(auth, "/sign-up/email", {
    email: "sam@acme.com",
    name: "Sam",
    password: PASSWORD,
  });

  assert.equal(signUp.status, 403);
  assert.equal((await userRow("sam@acme.com")).length, 0);
});

/** Resolves once `count` other sessions wait on a lock `holder` has. */
async function waitUntilWaiting(holder: pg.PoolClient, count: number) {
  const self = await holder.query<{ pid: number }>(
    "select pg_backend_pid() as pid",
  );

  for (let attempt = 0; attempt < 500; attempt += 1) {
    const waiting = await database.query<{ count: number }>(
      `select count(*)::int as count from pg_stat_activity where $1::integer = any(pg_blocking_pids(pid))`,
      [self.rows[0]?.pid],
    );

    if ((waiting.rows[0]?.count ?? 0) >= count) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error(`Fewer than ${String(count)} sessions waited on the lock.`);
}

test("two first sign-ins of one new person at once end with one person and one link", async () => {
  const auth = await makeAuth();
  // Both requests look the person up and find nobody, then both try to make
  // them: the user table is held until both inserts wait, so the race is
  // run every time rather than by luck. The loser must find the winner's.
  const holder = await database.connect();
  let results: Awaited<ReturnType<typeof enter>>[];

  try {
    await holder.query("begin");
    await holder.query(`lock table public."user" in share row exclusive mode`);

    const both = Promise.all([
      enter(auth, mint(claimsFor())),
      enter(auth, mint(claimsFor())),
    ]);

    await waitUntilWaiting(holder, 2);
    await holder.query("commit");
    results = await both;
  } finally {
    holder.release();
  }

  assert.deepEqual(
    results.map((result) => result.status),
    [200, 200],
    JSON.stringify(results.map((result) => result.payload)),
  );
  assert.equal((await userRow("pat@acme.com")).length, 1);
  assert.equal((await sundayLinks()).length, 1);
});

test("a session the limits have ended does not stand in the way of arriving from Sunday", async () => {
  const auth = await makeAuth();
  const cookies: Cookies = new Map();

  assert.equal(
    (await enter(auth, mint(claimsFor()), undefined, cookies)).status,
    200,
  );

  // Ended by an administrator: the row is gone, the signed cookie cache
  // still vouches for it, and the session controls say it has ended.
  await database.query("delete from session");

  const again = await enter(auth, mint(claimsFor()), undefined, cookies);

  assert.equal(again.status, 200, JSON.stringify(again.payload));
  assert.ok(await sessionUser(auth, cookies));
});

test("with password sign-in off and only the bridge set up, passwords point to Sunday except for the kept addresses", async () => {
  const auth = await makeAuth({
    PASSWORD_SIGN_IN: "off",
    PASSWORD_SIGN_IN_ALLOWED_EMAILS: "admin@acme.com",
  });
  const context = await auth.$context;

  for (const email of ["admin@acme.com", "pat@acme.com"]) {
    const id = randomUUID();

    await database.query(
      `insert into "user" (id, name, email, "emailVerified", role) values ($1, 'Someone', $2, true, 'user')`,
      [id, email],
    );
    await database.query(
      `insert into account (id, "accountId", "providerId", "userId", password) values ($1, $2, 'credential', $2, $3)`,
      [randomUUID(), id, await context.password.hash(PASSWORD)],
    );
  }

  const refused = await post(auth, "/sign-in/email", {
    email: "pat@acme.com",
    password: PASSWORD,
  });

  assert.equal(refused.status, 403);
  assert.equal(refused.payload?.code, "PASSWORD_SIGN_IN_OFF");
  assert.equal(
    refused.payload?.message,
    "Password sign-in is turned off here. Open Signatures from Sunday instead.",
  );

  const kept = await post(auth, "/sign-in/email", {
    email: "Admin@Acme.com",
    password: PASSWORD,
  });

  assert.equal(kept.status, 200, JSON.stringify(kept.payload));
});

test("the answer's next is a SignuDoc page, or the dashboard", async () => {
  const auth = await makeAuth();
  const evil = await enter(auth, mint(claimsFor()), "//evil.example");

  assert.deepEqual(evil.payload, { next: "/dashboard" });

  const kept = await enter(auth, mint(claimsFor()), "/envelopes/x");

  assert.deepEqual(kept.payload, { next: "/envelopes/x" });
});
