// Sunday's sign-in handoff token (v1): Sunday signs it with a secret both sides share, and the bridge (sunday-bridge.ts) turns it into a session. Pure, so the format is pinned by one test vector that Sunday's repo also commits.
import { createHmac, timingSafeEqual } from "node:crypto";

import { parseEmbedOrigin } from "../embed-origin.ts";
import { readEnv, type EnvSource } from "../utils/env.ts";

export const SUNDAY_TOKEN_MAX_SECONDS = 60;
export const SUNDAY_CLOCK_SKEW_SECONDS = 30;

const MINIMUM_SECRET_LENGTH = 32;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const JTI = /^[0-9a-f]{32}$/;

export type SundayClaims = {
  aud: string;
  email: string;
  exp: number;
  iat: number;
  iss: "sunday";
  jti: string;
  name: string;
  role: "admin" | "user";
  sub: string;
  ws: string;
};

export type SundayTokenRefusal =
  | "bad_signature"
  | "expired"
  | "malformed"
  | "not_yet_valid"
  | "wrong_audience"
  | "wrong_issuer"
  | "wrong_workspace";

export type SundayBridgeConfig = {
  secret: string;
  sundayOrigin: string;
  workspaceId: string;
};

/** The bridge's settings, or null when any of the three is unset or invalid. */
export function readSundayBridgeConfig(
  env: EnvSource = process.env,
): SundayBridgeConfig | null {
  const secret = readEnv(env, "SUNDAY_BRIDGE_SECRET");
  const workspaceId = readEnv(env, "SUNDAY_WORKSPACE_ID");
  const sundayOrigin = parseEmbedOrigin(readEnv(env, "SUNDAY_ORIGIN"), env);

  if (
    secret === undefined ||
    secret.length < MINIMUM_SECRET_LENGTH ||
    workspaceId === undefined ||
    sundayOrigin === null
  ) {
    return null;
  }

  return { secret, sundayOrigin, workspaceId };
}

/** The bridge variables still missing when some but not all are set; [] when all or none are. */
export function missingSundayBridgeSettings(
  env: EnvSource = process.env,
): string[] {
  const secret = readEnv(env, "SUNDAY_BRIDGE_SECRET");
  const workspaceId = readEnv(env, "SUNDAY_WORKSPACE_ID");
  const origin = readEnv(env, "SUNDAY_ORIGIN");

  if (
    secret === undefined &&
    workspaceId === undefined &&
    origin === undefined
  ) {
    return [];
  }

  const missing: string[] = [];

  if (secret === undefined || secret.length < MINIMUM_SECRET_LENGTH) {
    missing.push("SUNDAY_BRIDGE_SECRET");
  }

  if (workspaceId === undefined) {
    missing.push("SUNDAY_WORKSPACE_ID");
  }

  if (parseEmbedOrigin(origin, env) === null) {
    missing.push("SUNDAY_ORIGIN");
  }

  return missing;
}

/** Checks a handoff token in the order the spec names; the first failing check is the reason. */
export function verifySundayToken(
  token: string,
  expected: {
    audience: string;
    nowSeconds: number;
    secret: string;
    workspaceId: string;
  },
):
  | { claims: SundayClaims; ok: true }
  | { ok: false; reason: SundayTokenRefusal } {
  const parts = token.split(".");

  if (
    parts.length !== 3 ||
    parts[0] !== "v1" ||
    !BASE64URL.test(parts[1]) ||
    !BASE64URL.test(parts[2])
  ) {
    return { ok: false, reason: "malformed" };
  }

  const [, payload, signature] = parts;
  const expectedSignature = createHmac("sha256", expected.secret)
    .update(`v1.${payload}`)
    .digest();
  const givenSignature = Buffer.from(signature, "base64url");

  // The length is checked first: timingSafeEqual throws on unequal lengths.
  if (
    givenSignature.length !== expectedSignature.length ||
    !timingSafeEqual(givenSignature, expectedSignature)
  ) {
    return { ok: false, reason: "bad_signature" };
  }

  const claims = parseClaims(
    Buffer.from(payload, "base64url").toString("utf8"),
  );

  if (claims === null) {
    return { ok: false, reason: "malformed" };
  }

  if (claims.iss !== "sunday") {
    return { ok: false, reason: "wrong_issuer" };
  }

  if (claims.aud !== expected.audience) {
    return { ok: false, reason: "wrong_audience" };
  }

  if (claims.ws !== expected.workspaceId) {
    return { ok: false, reason: "wrong_workspace" };
  }

  if (expected.nowSeconds >= claims.exp) {
    return { ok: false, reason: "expired" };
  }

  if (claims.iat > expected.nowSeconds + SUNDAY_CLOCK_SKEW_SECONDS) {
    return { ok: false, reason: "not_yet_valid" };
  }

  return {
    claims: {
      ...claims,
      email: claims.email.trim().toLowerCase(),
      iss: "sunday",
    },
    ok: true,
  };
}

function isBoundedString(value: unknown, maxLength: number): value is string {
  return (
    typeof value === "string" && value.length > 0 && value.length <= maxLength
  );
}

function isSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value);
}

// Parses the payload and checks each claim's shape. Null on any mismatch, so
// the caller reports one reason. iss stays a plain string here: its value is
// checked by the caller, which must answer wrong_issuer, not malformed.
function parseClaims(
  json: string,
): (Omit<SundayClaims, "iss"> & { iss: string }) | null {
  let value: unknown;

  try {
    value = JSON.parse(json);
  } catch {
    return null;
  }

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }

  const { iss, aud, ws, sub, email, name, role, iat, exp, jti } =
    value as Record<string, unknown>;

  if (
    !isBoundedString(iss, 255) ||
    !isBoundedString(aud, 255) ||
    !isBoundedString(ws, 255) ||
    !isBoundedString(sub, 255) ||
    !isBoundedString(email, 320) ||
    !email.includes("@") ||
    !isBoundedString(name, 200) ||
    (role !== "admin" && role !== "user") ||
    !isSafeInteger(iat) ||
    !isSafeInteger(exp) ||
    typeof jti !== "string" ||
    !JTI.test(jti)
  ) {
    return null;
  }

  const lifetime = exp - iat;

  if (lifetime < 1 || lifetime > SUNDAY_TOKEN_MAX_SECONDS) {
    return null;
  }

  return {
    aud,
    email,
    exp,
    iat,
    iss,
    jti,
    name,
    role,
    sub,
    ws,
  };
}
