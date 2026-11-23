import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";

import { PDFDocument } from "pdf-lib";
import type pg from "pg";

import { submitPublicContactMessage } from "./contact.ts";
import { openTestDatabase } from "./db/test-database.ts";
import { sendFreshDownloadLinks } from "./download-renewal.ts";
import {
  createRecipientDownloadLink,
  DownloadAccessError,
} from "./downloads.ts";
import { ELECTRONIC_RECORDS_DISCLOSURE_VERSION } from "./electronic-records-disclosure.ts";
import { EMAIL_OFF_TEST_MESSAGE, sendTestEmail } from "./email-test.ts";
import { sendDraftEnvelope, voidSentEnvelope } from "./envelopes.ts";
import {
  ReminderMutationError,
  sendAutomaticEnvelopeReminder,
  sendManualEnvelopeNudge,
} from "./reminders.ts";
import { recordEmailSent } from "./services/audit.ts";
import { OFF_MESSAGE_ID_PREFIX } from "./services/email.ts";
import {
  createStorageService,
  type StorageService,
} from "./services/storage.ts";
import {
  recordSignerConsent,
  sendSignerEmailCode,
  submitSigningForToken,
} from "./signing.ts";

// What happens when email is turned off on an install that already has
// envelopes out, against a real Postgres: nothing that was not sent may be
// recorded as sent, and nothing may be lost because it was not. Envelopes
// are sent under the capture driver, then EMAIL_DRIVER is switched to off.
// The todo cases are K11's to fix (envelopes.ts, signing.ts, reminders.ts).
// Run with `npm run test:db`.

process.env.APP_URL ??= "https://sign.example.test";

const DAY = 24 * 60 * 60;

// A PNG of one transparent pixel, standing in for a drawn signature.
const DRAWN_SIGNATURE =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

const SENDER = { senderEmail: "sam@example.test", senderName: "Sam Sender" };

let database: pg.Pool;
let storageDir: string;
let outboxDir: string;
let storageService: StorageService;
const createdUsers: string[] = [];

before(async () => {
  process.env.DATABASE_URL =
    process.env.E2E_DATABASE_URL ??
    "postgres://signudoc:signudoc@127.0.0.1:5432/signudoc_e2e";
  database = await openTestDatabase();
  // The emails and the seal read the install's settings through the shared
  // pool.
  globalThis.__signudocPgPool = database;
  storageDir = await mkdtemp(path.join(tmpdir(), "signudoc-email-off-"));
  outboxDir = path.join(storageDir, "outbox");
  Object.assign(process.env, {
    EMAIL_CAPTURE_DIR: outboxDir,
    STORAGE_DRIVER: "local",
    STORAGE_LOCAL_DIR: storageDir,
  });
  storageService = createStorageService();
});

// Every case starts by sending under capture and switches to off itself.
beforeEach(() => {
  process.env.EMAIL_DRIVER = "capture";
});

after(async () => {
  await database.query(`delete from public."user" where id = any($1)`, [
    createdUsers,
  ]);
  await database.end();
  await rm(storageDir, { force: true, recursive: true });
});

/** A draft with one signature field per signer, ready to send. */
async function createDraftEnvelope(signerCount: number) {
  const userId = randomUUID();
  const envelopeId = randomUUID();
  const sourcePdf = await PDFDocument.create();

  sourcePdf.addPage([612, 792]);

  const sourcePdfBytes = await sourcePdf.save();
  const sourcePdfKey = `test/${envelopeId}.pdf`;

  await storageService.putObject({
    body: sourcePdfBytes,
    contentType: "application/pdf",
    key: sourcePdfKey,
  });

  createdUsers.push(userId);
  await database.query(
    `insert into public."user" (id, name, email, role) values ($1, 'Sam Sender', $2, 'user')`,
    [userId, `${userId}@example.test`],
  );
  await database.query(
    `
      insert into envelopes (
        id, user_id, title, status, source_pdf_key, source_pdf_filename,
        source_pdf_size_bytes, page_count, source_pdf_hash
      ) values ($1, $2, 'Lease', 'draft', $3, 'lease.pdf', $4, 1, $5)
    `,
    [
      envelopeId,
      userId,
      sourcePdfKey,
      sourcePdfBytes.length,
      createHash("sha256").update(sourcePdfBytes).digest("hex"),
    ],
  );
  await database.query(
    `
      insert into envelope_pages (id, envelope_id, page_number, width_pt, height_pt)
      values ($1, $2, 1, 612, 792)
    `,
    [randomUUID(), envelopeId],
  );

  const signers: { email: string; fieldId: string; id: string }[] = [];

  for (let index = 0; index < signerCount; index += 1) {
    const signerId = randomUUID();
    const fieldId = randomUUID();
    const email = `${signerId}@example.test`;

    await database.query(
      `
        insert into signers (id, envelope_id, name, email, sign_order, status)
        values ($1, $2, $3, $4, $5, 'pending')
      `,
      [signerId, envelopeId, `Signer ${String(index + 1)}`, email, index + 1],
    );
    await database.query(
      `
        insert into fields (
          id, envelope_id, signer_id, type, page, x, y, width, height
        ) values ($1, $2, $3, 'signature', 1, 0.1, $4, 0.2, 0.1)
      `,
      [fieldId, envelopeId, signerId, 0.1 + index * 0.2],
    );
    signers.push({ email, fieldId, id: signerId });
  }

  return { envelopeId, signers, userId };
}

/** The signing token in the invitation captured for this address. */
async function capturedSigningToken(email: string): Promise<string> {
  const files = await readdir(outboxDir).catch(() => [] as string[]);

  for (const file of files.filter((name) => name.endsWith(".json"))) {
    const message = JSON.parse(
      await readFile(path.join(outboxDir, file), "utf8"),
    ) as { template: string; text: string; to: string | string[] };
    const to = Array.isArray(message.to) ? message.to : [message.to];
    const token = /\/sign\/([A-Za-z0-9_.-]+)/.exec(message.text)?.[1];

    if (message.template === "signing_invitation" && to.includes(email)) {
      assert.ok(token, "the invitation carries no signing link");
      return token;
    }
  }

  assert.fail("no invitation was captured for the signer");
}

/** A one-signer envelope sent under capture, with its signer's token. */
async function sendUnderCapture(
  options: { reminderIntervalDays?: number } = {},
) {
  const draft = await createDraftEnvelope(1);
  const signer = draft.signers[0]!;

  await sendDraftEnvelope(
    draft.userId,
    draft.envelopeId,
    { ...SENDER, ...options },
    { database },
  );

  return { ...draft, signer, token: await capturedSigningToken(signer.email) };
}

async function emailSentEvents(envelopeId: string): Promise<number> {
  const result = await database.query<{ count: string }>(
    `select count(*) from audit_events where envelope_id = $1 and event = 'email_sent'`,
    [envelopeId],
  );

  return Number(result.rows[0]?.count ?? 0);
}

async function signerRow(signerId: string) {
  const result = await database.query<{
    email_code_hash: string | null;
    signing_token_hash: string | null;
    status: string;
  }>(
    `select status, signing_token_hash, email_code_hash from signers where id = $1`,
    [signerId],
  );

  return result.rows[0];
}

test("voiding an envelope while email is off succeeds and records no email as sent", async () => {
  const envelope = await sendUnderCapture();
  const sentBefore = await emailSentEvents(envelope.envelopeId);

  // The invitation went out under capture and is on the trail.
  assert.equal(sentBefore, 1);

  process.env.EMAIL_DRIVER = "off";

  await voidSentEnvelope(envelope.userId, envelope.envelopeId, SENDER, {
    database,
  });

  const status = await database.query<{ status: string }>(
    `select status from envelopes where id = $1`,
    [envelope.envelopeId],
  );

  assert.equal(status.rows[0]?.status, "voided");
  assert.equal(await emailSentEvents(envelope.envelopeId), sentBefore);
});

test("signing to completion while email is off finishes the documents and records no email as sent", async () => {
  const envelope = await sendUnderCapture();
  const sentBefore = await emailSentEvents(envelope.envelopeId);

  await recordSignerConsent(
    envelope.token,
    { disclosureVersion: ELECTRONIC_RECORDS_DISCLOSURE_VERSION },
    { database },
  );
  process.env.EMAIL_DRIVER = "off";

  await submitSigningForToken(
    envelope.token,
    {
      clientTimezoneOffsetMinutes: 0,
      fields: [
        {
          fieldId: envelope.signer.fieldId,
          imageDataUrl: DRAWN_SIGNATURE,
          inputMethod: "drawn",
          type: "signature",
        },
      ],
    },
    { database },
  );

  const stored = await database.query<{
    evidence_key: string | null;
    signed_pdf_key: string | null;
    status: string;
  }>(
    `select status, signed_pdf_key, evidence_key from envelopes where id = $1`,
    [envelope.envelopeId],
  );
  const row = stored.rows[0];

  assert.equal(row?.status, "completed");
  assert.ok(row?.signed_pdf_key && row.evidence_key);
  assert.equal(
    (await storageService.headObject(row.signed_pdf_key)).exists,
    true,
  );
  assert.equal(
    (await storageService.headObject(row.evidence_key)).exists,
    true,
  );
  // The completion emails were answered "not sent" and are not on the trail.
  assert.equal(await emailSentEvents(envelope.envelopeId), sentBefore);
});

test("recordEmailSent writes nothing for the off driver's message ids, and a row for a real one", async () => {
  const draft = await createDraftEnvelope(1);
  const signer = draft.signers[0]!;
  const input = {
    envelopeId: draft.envelopeId,
    recipient: signer.email,
    signerId: signer.id,
    template: "signing_invitation",
  };

  await recordEmailSent(
    { ...input, messageId: `${OFF_MESSAGE_ID_PREFIX}${randomUUID()}` },
    database,
  );
  assert.equal(await emailSentEvents(draft.envelopeId), 0);

  await recordEmailSent({ ...input, messageId: randomUUID() }, database);
  assert.equal(await emailSentEvents(draft.envelopeId), 1);
});

test("a test email while email is off is refused, never reported as sent", async () => {
  const name = "Ada Admin";
  const to = "ada@example.test";

  assert.deepEqual(
    await sendTestEmail({ env: { EMAIL_DRIVER: "off" }, name, to }),
    { message: EMAIL_OFF_TEST_MESSAGE, sent: false },
  );

  // A service that answers without accepting proves nothing either, and
  // would otherwise mark email as working.
  const result = await sendTestEmail({
    emailService: {
      send: async (message) => ({ accepted: [], rejected: [message.to] }),
      sendBatch: async () => [],
    },
    env: { ...process.env, EMAIL_DRIVER: "capture" },
    name,
    to,
  });

  assert.equal(result.sent, false);
});

test("the public contact form says it is unavailable instead of losing the message while email is off", async () => {
  await assert.rejects(
    submitPublicContactMessage(
      {
        email: "visitor@example.test",
        message: "Hello, I have a question.",
        name: "Vera Visitor",
      },
      { env: { EMAIL_DRIVER: "off", SUPPORT_EMAIL: "help@example.test" } },
    ),
    (error: unknown) =>
      error instanceof Error &&
      "statusCode" in error &&
      error.statusCode === 503,
  );
});

test("asking for new download links while email is off is refused and keeps the old links", async () => {
  const draft = await createDraftEnvelope(1);
  const signer = draft.signers[0]!;

  await database.query(
    `update envelopes set status = 'completed', completed_at = $2 where id = $1`,
    [draft.envelopeId, Math.floor(Date.now() / 1000)],
  );
  await database.query(`update signers set status = 'signed' where id = $1`, [
    signer.id,
  ]);

  // A finished signer holds a link to each file.
  await createRecipientDownloadLink(
    { envelopeId: draft.envelopeId, fileType: "signed", signerId: signer.id },
    { database },
  );
  const evidence = await createRecipientDownloadLink(
    { envelopeId: draft.envelopeId, fileType: "evidence", signerId: signer.id },
    { database },
  );
  const linkHashes = async () =>
    (
      await database.query<{ token_hash: string }>(
        `select token_hash from recipient_download_tokens where envelope_id = $1 order by file_type`,
        [draft.envelopeId],
      )
    ).rows.map((row) => row.token_hash);
  const before = await linkHashes();

  process.env.EMAIL_DRIVER = "off";

  await assert.rejects(
    sendFreshDownloadLinks(
      new URL(evidence.url).pathname.split("/").at(-1) ?? "",
      { database },
    ),
    (error: unknown) =>
      error instanceof DownloadAccessError && error.statusCode === 503,
  );
  // Replacing them would leave the signer with links nobody received.
  assert.deepEqual(await linkHashes(), before);
});

test(
  "a sender's reminder while email is off is refused and keeps the signer's link",
  { todo: "K11 fixes reminders.ts" },
  async () => {
    const envelope = await sendUnderCapture();
    const linkBefore = (await signerRow(envelope.signer.id))
      ?.signing_token_hash;

    process.env.EMAIL_DRIVER = "off";

    // Today the reminder retires the link and emails the new one to nobody.
    await assert.rejects(
      sendManualEnvelopeNudge(envelope.userId, envelope.envelopeId, SENDER, {
        database,
      }),
      (error: unknown) =>
        error instanceof ReminderMutationError && error.statusCode === 409,
    );
    assert.equal(
      (await signerRow(envelope.signer.id))?.signing_token_hash,
      linkBefore,
    );
  },
);

test(
  "the daily reminder while email is off sends nothing and keeps the signer's link",
  { todo: "K11 fixes reminders.ts" },
  async () => {
    const envelope = await sendUnderCapture({ reminderIntervalDays: 1 });
    const linkBefore = (await signerRow(envelope.signer.id))
      ?.signing_token_hash;

    process.env.EMAIL_DRIVER = "off";

    const sent = await sendAutomaticEnvelopeReminder(envelope.envelopeId, {
      database,
      nowUnixTimestamp: Math.floor(Date.now() / 1000) + 2 * DAY,
      signerId: envelope.signer.id,
    });

    assert.equal(sent, false);
    assert.equal(
      (await signerRow(envelope.signer.id))?.signing_token_hash,
      linkBefore,
    );
  },
);

test(
  "a signer's emailed code while email is off is refused, not reported as sent",
  { todo: "K11 fixes signing.ts" },
  async () => {
    const envelope = await sendUnderCapture();

    await database.query(
      `update signers set require_email_code = true where id = $1`,
      [envelope.signer.id],
    );
    process.env.EMAIL_DRIVER = "off";

    // Today it answers sent: true and leaves a code nobody received.
    await assert.rejects(sendSignerEmailCode(envelope.token, { database }));
    assert.equal((await signerRow(envelope.signer.id))?.email_code_hash, null);
  },
);
