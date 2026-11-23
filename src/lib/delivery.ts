import { queryOne, type DbExecutor } from "./db/connection.ts";
import { isEmailOff } from "./services/email.ts";
import { readEnv, type EnvSource } from "./utils/env.ts";

// How an envelope's signers get their signing links.
//
// - "email": SignuDoc emails each signer their link when their turn starts.
// - "embedded": another app frames the signing page (see embedding.ts).
// - "link": the sender copies each signer's link from the envelope page and
//   delivers it themselves (see signing-link-copy.ts). Nobody is emailed an
//   invitation or a reminder.

export type Delivery = "email" | "embedded" | "link";

/**
 * The delivery of a send that names none. While email is off nothing could
 * reach the signers, so it is link; otherwise DEFAULT_SIGNING_DELIVERY,
 * where only "link" changes upstream's default of email.
 */
export function defaultDelivery(
  env: EnvSource = process.env,
): "email" | "link" {
  if (isEmailOff(env)) {
    return "link";
  }

  return readEnv(env, "DEFAULT_SIGNING_DELIVERY")?.toLowerCase() === "link"
    ? "link"
    : "email";
}

/** Whether a send may ask for email delivery on this install. */
export function emailDeliveryAvailable(env: EnvSource = process.env): boolean {
  return !isEmailOff(env);
}

/** An envelope's delivery, or null when there is no such envelope. */
export async function readEnvelopeDelivery(
  envelopeId: string,
  database: DbExecutor,
  ownerId?: string,
): Promise<Delivery | null> {
  const row = await queryOne<{ delivery: Delivery }>(
    database,
    `
      SELECT delivery FROM envelopes
      WHERE id = $1 AND ($2::text IS NULL OR user_id = $2)
    `,
    [envelopeId, ownerId ?? null],
  );

  return row?.delivery ?? null;
}
