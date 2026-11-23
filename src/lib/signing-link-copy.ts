import { createHmac, hkdfSync, randomBytes } from "node:crypto";

import type { PoolClient } from "pg";

import {
  getDb,
  queryOne,
  withTransaction,
  type DbPool,
} from "./db/connection.ts";
import { recordAuditEvent } from "./services/audit.ts";
import { isEmailOff } from "./services/email.ts";
import { hashOpaqueToken } from "./services/opaque-tokens.ts";
import { requireConfigValue } from "./services/service-config.ts";
import { SIGNING_LINK_TTL_SECONDS } from "./types/domain.ts";
import { getEnv, type EnvSource } from "./utils/env.ts";

// Copy link and New link: the sender of a link envelope delivers each
// signer's signing link themselves.
//
// The link is derived from signers.link_nonce with a key made from
// BETTER_AUTH_SECRET, and its sha256 is the signer's usual live hash, so
// every check on /sign/ links works unchanged. Copying again gives the same
// link for as long as that hash is the live one. A link replaced since
// (correction, a new send, a rotated secret) is never brought back: a
// mismatch draws a fresh nonce. New link draws one on purpose.
//
// Every write is a compare-and-set on the hash that was read. Two presses
// at once both write or one moves first; the one that finds nothing to
// update reads again and copies what the other left, so both answer the
// same live link.

const LINK_KEY_LABEL = "signudoc-link-v1";

export class SigningLinkError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode: number) {
    super(message);
    this.name = "SigningLinkError";
    this.statusCode = statusCode;
  }
}

type CopyActor = {
  apiKeyId?: string | null;
  email: string;
  ipAddress?: string | null;
  userAgent?: string | null;
};

type CopyInput = {
  actor: CopyActor;
  envelopeId: string;
  /** New link: replace the signer's link, killing the old one. */
  replace: boolean;
  signerId: string;
  userId: string;
};

function linkKey(env: EnvSource): Buffer {
  const secret = getEnv(env).auth.betterAuthSecret;

  if (!secret) {
    throw new SigningLinkError(
      "Signing links can't be copied until the server has an auth secret.",
      500,
    );
  }

  return Buffer.from(hkdfSync("sha256", secret, "", LINK_KEY_LABEL, 32));
}

function linkToken(key: Buffer, nonce: string): string {
  return createHmac("sha256", key).update(nonce).digest("base64url");
}

/** Why this envelope has no link to copy, or null when it has. */
function deliveryRefusal(delivery: string, env: EnvSource): string | null {
  if (delivery === "link") {
    return null;
  }

  // Emailed before email went off: its next signer would be stranded.
  if (delivery === "email") {
    return isEmailOff(env)
      ? null
      : "This envelope's signers get their links by email. Copying one would replace the link they were sent.";
  }

  return "This envelope is signed in another app, which asks for its signers' links. There is no link to copy.";
}

/**
 * The signer's link, copied or replaced, under the rules above. Answers null
 * when another request moved the link first, so the caller reads again.
 */
async function copyOnce(
  tx: PoolClient,
  input: CopyInput,
  replace: boolean,
  key: Buffer,
  env: EnvSource,
): Promise<{ exp: number; signerName: string; token: string } | null> {
  const now = Math.floor(Date.now() / 1000);
  // Shared, so presses on two signers or two tabs do not wait for each
  // other, while a void, a signature or a correction (which take this row
  // for update) cannot change the envelope underneath.
  const envelope = await queryOne<{
    delivery: string;
    expiresAt: number | null;
    status: string;
  }>(
    tx,
    `
      SELECT delivery, status, expires_at AS "expiresAt"
      FROM envelopes WHERE id = $1 AND user_id = $2
      FOR SHARE
    `,
    [input.envelopeId, input.userId],
  );

  if (!envelope) {
    throw new SigningLinkError("Envelope not found.", 404);
  }

  const refusal = deliveryRefusal(envelope.delivery, env);

  if (refusal) {
    throw new SigningLinkError(refusal, 409);
  }

  if (
    envelope.status !== "sent" ||
    (envelope.expiresAt !== null && envelope.expiresAt <= now)
  ) {
    throw new SigningLinkError(
      "This envelope is not out for signature any more.",
      409,
    );
  }

  const signer = await queryOne<{
    expiresAt: number | null;
    hash: string | null;
    name: string;
    nonce: string | null;
    status: string;
  }>(
    tx,
    `
      SELECT status, name, link_nonce AS nonce, signing_token_hash AS hash,
        signing_token_expires_at AS "expiresAt"
      FROM signers
      WHERE id = $1 AND envelope_id = $2 AND role IN ('signer', 'approver')
    `,
    [input.signerId, input.envelopeId],
  );

  if (!signer) {
    throw new SigningLinkError("Signer not found.", 404);
  }

  if (signer.status !== "notified") {
    throw new SigningLinkError(
      signer.status === "pending"
        ? "Not their turn yet."
        : "This signer has finished.",
      409,
    );
  }

  // As long as an emailed link: to the deadline, or 7 days with none.
  const lifetimeEnd = envelope.expiresAt ?? now + SIGNING_LINK_TTL_SECONDS;
  const current = signer.nonce ? linkToken(key, signer.nonce) : null;

  if (!replace && current && hashOpaqueToken(current) === signer.hash) {
    if (signer.expiresAt === null || signer.expiresAt >= now) {
      return {
        exp: signer.expiresAt ?? lifetimeEnd,
        signerName: signer.name,
        token: current,
      };
    }

    // The pasted link works again: the sender wanted that one.
    const renewed = await tx.query(
      `
        UPDATE signers SET signing_token_expires_at = $3, updated_at = $4
        WHERE id = $1 AND signing_token_hash = $2 AND status = 'notified'
      `,
      [input.signerId, signer.hash, lifetimeEnd, now],
    );

    return renewed.rowCount === 1
      ? { exp: lifetimeEnd, signerName: signer.name, token: current }
      : null;
  }

  const nonce = randomBytes(32).toString("base64url");
  const token = linkToken(key, nonce);
  const issued = await tx.query(
    `
      UPDATE signers
      SET link_nonce = $3, signing_token_hash = $4,
        signing_token_expires_at = $5, updated_at = $6
      WHERE id = $1
        AND signing_token_hash IS NOT DISTINCT FROM $2
        AND status = 'notified'
    `,
    [
      input.signerId,
      signer.hash,
      nonce,
      hashOpaqueToken(token),
      lifetimeEnd,
      now,
    ],
  );

  return issued.rowCount === 1
    ? { exp: lifetimeEnd, signerName: signer.name, token }
    : null;
}

/**
 * Copy link (replace false) or New link (replace true) for a signer whose
 * turn it is on a link envelope of `userId`'s. Records link_copied or
 * link_replaced, never the link.
 */
export async function copySigningLink(
  input: CopyInput,
  options: { database?: DbPool; env?: EnvSource } = {},
): Promise<{ expiresAt: string; url: string }> {
  const env = options.env ?? process.env;
  const key = linkKey(env);
  const appUrl = requireConfigValue(
    "signing links",
    "APP_URL",
    getEnv(env).appUrl,
  );

  return withTransaction(async (tx) => {
    // A press that lost the compare-and-set copies what the winner left,
    // even a New link: the link it saw is already dead.
    const link =
      (await copyOnce(tx, input, input.replace, key, env)) ??
      (await copyOnce(tx, input, false, key, env));

    if (!link) {
      throw new SigningLinkError(
        "This signer's link changed while it was being copied. Try again.",
        409,
      );
    }

    await recordAuditEvent(
      {
        actorEmail: input.actor.email,
        actorType: "sender",
        envelopeId: input.envelopeId,
        event: input.replace ? "link_replaced" : "link_copied",
        ipAddress: input.actor.ipAddress ?? null,
        metadata: {
          ...(input.actor.apiKeyId ? { apiKeyId: input.actor.apiKeyId } : {}),
          signerId: input.signerId,
          signerName: link.signerName,
        },
        userAgent: input.actor.userAgent ?? null,
      },
      tx,
    );

    return {
      expiresAt: new Date(link.exp * 1000).toISOString(),
      url: new URL(`/sign/${link.token}`, appUrl).toString(),
    };
  }, options.database ?? getDb());
}
