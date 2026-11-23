import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";

import { PDFDocument } from "pdf-lib";
import type pg from "pg";

import { openTestDatabase } from "./db/test-database.ts";
import { ELECTRONIC_RECORDS_DISCLOSURE_VERSION } from "./electronic-records-disclosure.ts";
import {
  correctSentEnvelopeSigner,
  EnvelopeMutationError,
  sendDraftEnvelope,
  voidSentEnvelope,
} from "./envelopes.ts";
import { ReminderMutationError, sendManualEnvelopeNudge } from "./reminders.ts";
import { verifyAuditChain } from "./services/audit.ts";
import {
  createStorageService,
  type StorageService,
} from "./services/storage.ts";
import { copySigningLink, SigningLinkError } from "./signing-link-copy.ts";
import {
  getSigningPayloadForToken,
  recordSignerConsent,
  SigningAccessError,
  submitSigningForToken,
} from "./signing.ts";
import { setWebhookDrainScheduler } from "./webhooks/outbox.ts";

// Link delivery against a real Postgres and real files: the sender copies
// each signer's link and delivers it; SignuDoc emails no invitation or
// reminder. Sends run under the capture driver unless a case says
// otherwise, and the outbox is read to prove nothing was emailed. Run with
// `npm run test:db`.

const SETTINGS = [
  "APP_URL",
  "BETTER_AUTH_SECRET",
  "DATABASE_URL",
  "DEFAULT_SIGNING_DELIVERY",
  "EMAIL_CAPTURE_DIR",
  "EMAIL_DRIVER",
  "STORAGE_DRIVER",
  "STORAGE_LOCAL_DIR",
] as const;

// A PNG of one transparent pixel, standing in for a drawn signature.
const DRAWN_SIGNATURE =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

const SENDER = { senderEmail: "sam@example.test", senderName: "Sam Sender" };

let database: pg.Pool;
let workDir: string;
let outboxDir: string;
let storageService: StorageService;
const createdUsers: string[] = [];
// Every envelope a case touched; the last case checks each audit chain.
const touchedEnvelopes: string[] = [];
const settingsBefore = new Map<string, string | undefined>();

before(async () => {
  for (const name of SETTINGS) {
    settingsBefore.set(name, process.env[name]);
  }

  process.env.DATABASE_URL =
    process.env.E2E_DATABASE_URL ??
    "postgres://signudoc:signudoc@127.0.0.1:5432/signudoc_e2e";
  database = await openTestDatabase();
  // The emails and the seal read the install's settings through the shared
  // pool.
  globalThis.__signudocPgPool = database;
  workDir = await mkdtemp(path.join(tmpdir(), "signudoc-link-"));
  outboxDir = path.join(workDir, "outbox");
  Object.assign(process.env, {
    APP_URL: "https://sign.example.test",
    BETTER_AUTH_SECRET: "link-delivery-test-secret-0123456789abcdef",
    EMAIL_CAPTURE_DIR: outboxDir,
    STORAGE_DRIVER: "local",
    STORAGE_LOCAL_DIR: path.join(workDir, "storage"),
  });
  storageService = createStorageService();
  setWebhookDrainScheduler(() => undefined);
});

beforeEach(() => {
  process.env.EMAIL_DRIVER = "capture";
  delete process.env.DEFAULT_SIGNING_DELIVERY;
});

after(async () => {
  setWebhookDrainScheduler(null);
  await database.query(`delete from public."user" where id = any($1)`, [
    createdUsers,
  ]);
  await database.end();

  for (const [name, value] of settingsBefore) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }

  await rm(workDir, { force: true, recursive: true });
});

/** A draft with one signature field per signer, each in a step of their own. */
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
  touchedEnvelopes.push(envelopeId);
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

type Draft = Awaited<ReturnType<typeof createDraftEnvelope>>;

async function sendByLink(signerCount = 1) {
  const draft = await createDraftEnvelope(signerCount);

  await sendDraftEnvelope(
    draft.userId,
    draft.envelopeId,
    { ...SENDER, delivery: "link" },
    { database },
  );

  return draft;
}

function copy(draft: Draft, signerIndex = 0, replace = false) {
  return copySigningLink(
    {
      actor: { email: SENDER.senderEmail },
      envelopeId: draft.envelopeId,
      replace,
      signerId: draft.signers[signerIndex]!.id,
      userId: draft.userId,
    },
    { database },
  );
}

function tokenOf(url: string): string {
  return decodeURIComponent(new URL(url).pathname.split("/").pop() ?? "");
}

async function opens(url: string): Promise<boolean> {
  try {
    await getSigningPayloadForToken(tokenOf(url), { database });
    return true;
  } catch (error) {
    if (error instanceof SigningAccessError) {
      return false;
    }

    throw error;
  }
}

async function sign(draft: Draft, signerIndex: number, url: string) {
  const token = tokenOf(url);

  await recordSignerConsent(
    token,
    { disclosureVersion: ELECTRONIC_RECORDS_DISCLOSURE_VERSION },
    { database },
  );
  await submitSigningForToken(
    token,
    {
      clientTimezoneOffsetMinutes: 0,
      fields: [
        {
          fieldId: draft.signers[signerIndex]!.fieldId,
          imageDataUrl: DRAWN_SIGNATURE,
          inputMethod: "drawn",
          type: "signature",
        },
      ],
    },
    { database },
  );
}

/** Invitations and reminders the capture driver wrote for this address. */
async function emailsTo(email: string): Promise<number> {
  const files = await readdir(outboxDir).catch((error: unknown) => {
    if ((error as { code?: string }).code === "ENOENT") {
      return [] as string[];
    }

    throw error;
  });
  let count = 0;

  for (const file of files.filter((name) => name.endsWith(".json"))) {
    const message = JSON.parse(
      await readFile(path.join(outboxDir, file), "utf8"),
    ) as { template?: string; to?: string | string[] };

    if (
      message.template !== "signer_email_code" &&
      [message.to].flat().includes(email)
    ) {
      count += 1;
    }
  }

  return count;
}

async function envelopeRow(envelopeId: string) {
  const result = await database.query<{ delivery: string; status: string }>(
    `select delivery, status from envelopes where id = $1`,
    [envelopeId],
  );

  return result.rows[0];
}

async function signerStatus(signerId: string): Promise<string | undefined> {
  const result = await database.query<{ status: string }>(
    `select status from signers where id = $1`,
    [signerId],
  );

  return result.rows[0]?.status;
}

function refusedWith(statusCode: number, message?: RegExp) {
  return (error: unknown) =>
    error instanceof SigningLinkError &&
    error.statusCode === statusCode &&
    (message === undefined || message.test(error.message));
}

test("a link send emails nothing and stores delivery link", async () => {
  const draft = await sendByLink();
  const sent = await database.query<{ metadata: { delivery?: string } }>(
    `select metadata from audit_events where envelope_id = $1 and event = 'sent'`,
    [draft.envelopeId],
  );
  const emailed = await database.query(
    `select 1 from audit_events where envelope_id = $1 and event = 'email_sent'`,
    [draft.envelopeId],
  );

  assert.deepEqual(await envelopeRow(draft.envelopeId), {
    delivery: "link",
    status: "sent",
  });
  assert.equal(sent.rows[0]?.metadata.delivery, "link");
  assert.equal(emailed.rowCount, 0);
  assert.equal(await emailsTo(draft.signers[0]!.email), 0);
  assert.equal(await signerStatus(draft.signers[0]!.id), "notified");
});

test("with email off a send naming no delivery goes by link, and one naming email is refused", async () => {
  process.env.EMAIL_DRIVER = "off";

  const draft = await createDraftEnvelope(1);

  await sendDraftEnvelope(draft.userId, draft.envelopeId, SENDER, {
    database,
  });
  assert.equal((await envelopeRow(draft.envelopeId))?.delivery, "link");

  const emailDraft = await createDraftEnvelope(1);

  await assert.rejects(
    sendDraftEnvelope(
      emailDraft.userId,
      emailDraft.envelopeId,
      { ...SENDER, delivery: "email" },
      { database },
    ),
    (error: unknown) =>
      error instanceof EnvelopeMutationError &&
      error.statusCode === 409 &&
      /link delivery/.test(error.message),
  );
  assert.equal((await envelopeRow(emailDraft.envelopeId))?.status, "draft");
});

test("DEFAULT_SIGNING_DELIVERY=link sends by link when a send names none", async () => {
  process.env.DEFAULT_SIGNING_DELIVERY = "link";

  const draft = await createDraftEnvelope(1);

  await sendDraftEnvelope(draft.userId, draft.envelopeId, SENDER, {
    database,
  });
  assert.equal((await envelopeRow(draft.envelopeId))?.delivery, "link");
  assert.equal(await emailsTo(draft.signers[0]!.email), 0);
});

test("the next step of a link envelope is emailed to nobody, and its signer is up", async () => {
  const draft = await sendByLink(2);

  // Not their turn yet.
  await assert.rejects(
    copy(draft, 1),
    refusedWith(409, /^Not their turn yet\.$/),
  );

  await sign(draft, 0, (await copy(draft, 0)).url);

  assert.equal(await signerStatus(draft.signers[0]!.id), "signed");
  assert.equal(await signerStatus(draft.signers[1]!.id), "notified");
  assert.equal(await emailsTo(draft.signers[1]!.email), 0);

  // The signed event records how the link reached the signer.
  const signed = await database.query<{ metadata: { delivery?: string } }>(
    `select metadata from audit_events where envelope_id = $1 and event = 'signed'`,
    [draft.envelopeId],
  );

  assert.equal(signed.rows[0]?.metadata.delivery, "link");
  // A finished signer has nothing to copy.
  await assert.rejects(
    copy(draft, 0),
    refusedWith(409, /^This signer has finished\.$/),
  );
  assert.ok(await opens((await copy(draft, 1)).url));
});

test("copying twice gives the same link, and it opens the signing page", async () => {
  const draft = await sendByLink();
  const first = await copy(draft);
  const second = await copy(draft);

  assert.equal(second.url, first.url);
  assert.equal(new URL(first.url).origin, "https://sign.example.test");
  assert.match(new URL(first.url).pathname, /^\/sign\/[A-Za-z0-9_-]{43}$/);

  const payload = await getSigningPayloadForToken(tokenOf(first.url), {
    database,
  });

  assert.equal(payload.signer.id, draft.signers[0]!.id);
});

test("an expired copied link is renewed with the same token", async () => {
  const draft = await sendByLink();
  const first = await copy(draft);

  await database.query(
    `update signers set signing_token_expires_at = $2 where id = $1`,
    [draft.signers[0]!.id, Math.floor(Date.now() / 1000) - 60],
  );
  assert.equal(await opens(first.url), false);

  const renewed = await copy(draft);

  assert.equal(renewed.url, first.url);
  assert.ok(Date.parse(renewed.expiresAt) > Date.now());
  assert.ok(await opens(first.url));
});

test("after a signer correction Copy gives a new link and the old one stays dead", async () => {
  const draft = await sendByLink();
  const before = await copy(draft);
  const corrected = await correctSentEnvelopeSigner(
    draft.userId,
    draft.envelopeId,
    draft.signers[0]!.id,
    { email: `fixed-${randomUUID()}@example.test` },
    SENDER,
    { database },
  );

  // The sender delivers the new link; nobody is emailed.
  assert.equal(corrected.invitationSent, false);
  assert.equal(await emailsTo(corrected.email), 0);
  assert.equal(await opens(before.url), false);

  const after = await copy(draft);

  assert.notEqual(after.url, before.url);
  assert.ok(await opens(after.url));
  assert.equal(await opens(before.url), false);
});

test("Copy and New link are refused on emailed and embedded envelopes", async () => {
  const emailed = await createDraftEnvelope(1);

  await sendDraftEnvelope(
    emailed.userId,
    emailed.envelopeId,
    { ...SENDER, delivery: "email" },
    { database },
  );

  const embedded = await sendByLink();

  await database.query(
    `update envelopes set delivery = 'embedded' where id = $1`,
    [embedded.envelopeId],
  );

  for (const draft of [emailed, embedded]) {
    await assert.rejects(copy(draft), refusedWith(409));
    await assert.rejects(copy(draft, 0, true), refusedWith(409));
  }

  // Someone else's envelope is not found, in the same words as a missing one.
  const stranger = await sendByLink();

  await assert.rejects(
    copySigningLink(
      {
        actor: { email: SENDER.senderEmail },
        envelopeId: stranger.envelopeId,
        replace: false,
        signerId: stranger.signers[0]!.id,
        userId: emailed.userId,
      },
      { database },
    ),
    refusedWith(404, /^Envelope not found\.$/),
  );
});

test("an emailed envelope's link can be copied once email is off", async () => {
  const draft = await createDraftEnvelope(1);

  await sendDraftEnvelope(
    draft.userId,
    draft.envelopeId,
    { ...SENDER, delivery: "email" },
    { database },
  );
  process.env.EMAIL_DRIVER = "off";

  const link = await copy(draft);

  assert.ok(await opens(link.url));
  assert.equal((await copy(draft)).url, link.url);
});

test("New link kills the old one", async () => {
  const draft = await sendByLink();
  const old = await copy(draft);
  const replaced = await copy(draft, 0, true);

  assert.notEqual(replaced.url, old.url);
  assert.equal(await opens(old.url), false);
  assert.ok(await opens(replaced.url));
  assert.equal((await copy(draft)).url, replaced.url);
});

test("presses at the same moment answer the one live link", async () => {
  const twoCopies = await sendByLink();
  const [first, second] = await Promise.all([copy(twoCopies), copy(twoCopies)]);

  assert.equal(first.url, second.url);
  assert.ok(await opens(first.url));

  // Both write from a signer with no copied link yet: one moves first and
  // the other copies what it left.
  const copyAndNew = await sendByLink();
  const [copied, replaced] = await Promise.all([
    copy(copyAndNew),
    copy(copyAndNew, 0, true),
  ]);

  assert.equal(copied.url, replaced.url);
  assert.ok(await opens(copied.url));
});

test("voiding spends the copied link, and so does signing", async () => {
  const voided = await sendByLink();
  const voidedLink = await copy(voided);

  await voidSentEnvelope(voided.userId, voided.envelopeId, SENDER, {
    database,
  });
  assert.equal(await opens(voidedLink.url), false);
  await assert.rejects(copy(voided), refusedWith(409, /not out for signature/));

  const signed = await sendByLink(2);
  const signedLink = await copy(signed);

  await sign(signed, 0, signedLink.url);
  assert.equal(await opens(signedLink.url), false);
});

test("a sender's reminder on a link envelope is refused", async () => {
  const draft = await sendByLink();
  const link = await copy(draft);

  await assert.rejects(
    sendManualEnvelopeNudge(draft.userId, draft.envelopeId, SENDER, {
      database,
    }),
    (error: unknown) =>
      error instanceof ReminderMutationError && error.statusCode === 409,
  );
  assert.ok(await opens(link.url));
  assert.equal(await emailsTo(draft.signers[0]!.email), 0);
});

test("an emailed code refuses a link send while email is off, and not while it works", async () => {
  const requireCode = async (draft: Draft) =>
    database.query(
      `update signers set require_email_code = true where envelope_id = $1`,
      [draft.envelopeId],
    );
  const offDraft = await createDraftEnvelope(1);

  await requireCode(offDraft);
  process.env.EMAIL_DRIVER = "off";
  await assert.rejects(
    sendDraftEnvelope(
      offDraft.userId,
      offDraft.envelopeId,
      { ...SENDER, delivery: "link" },
      { database },
    ),
    (error: unknown) =>
      error instanceof EnvelopeMutationError &&
      error.statusCode === 400 &&
      /emailed a code/.test(error.message),
  );
  assert.equal((await envelopeRow(offDraft.envelopeId))?.status, "draft");

  process.env.EMAIL_DRIVER = "capture";

  const captureDraft = await createDraftEnvelope(1);

  await requireCode(captureDraft);
  await sendDraftEnvelope(
    captureDraft.userId,
    captureDraft.envelopeId,
    { ...SENDER, delivery: "link" },
    { database },
  );
  assert.equal((await envelopeRow(captureDraft.envelopeId))?.status, "sent");
});

test("the certificate says the sender delivered the link", async () => {
  const draft = await sendByLink();

  await sign(draft, 0, (await copy(draft)).url);

  const stored = await database.query<{
    evidence_key: string | null;
    status: string;
  }>(`select status, evidence_key from envelopes where id = $1`, [
    draft.envelopeId,
  ]);

  assert.equal(stored.rows[0]?.status, "completed");

  const certificate = await storageService.getObject(
    stored.rows[0]!.evidence_key!,
  );
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const document = await pdfjs.getDocument({
    data: new Uint8Array(certificate.body),
    useSystemFonts: false,
    verbosity: 0,
  }).promise;
  const parts: string[] = [];

  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
    const content = await (await document.getPage(pageNumber)).getTextContent();

    parts.push(
      content.items.map((item: { str?: string }) => item.str ?? "").join(" "),
    );
  }

  await document.destroy();

  const text = parts.join(" ").replace(/\s+/g, " ");

  assert.ok(
    text.includes(
      "possession of a signing link the sender delivered themselves",
    ),
  );
  assert.ok(!text.includes("possession of the emailed signing link"));
});

test("copies and replacements are audited with the signer, never the link", async () => {
  const draft = await sendByLink();
  const copied = await copy(draft);
  const replaced = await copy(draft, 0, true);
  const rows = await database.query<{
    actor_email: string;
    actor_type: string;
    event: string;
    metadata: Record<string, unknown>;
  }>(
    `
      select event, actor_type, actor_email, metadata from audit_events
      where envelope_id = $1 and event in ('link_copied', 'link_replaced')
      order by sequence
    `,
    [draft.envelopeId],
  );

  assert.deepEqual(
    rows.rows.map((row) => row.event),
    ["link_copied", "link_replaced"],
  );

  for (const row of rows.rows) {
    const stored = JSON.stringify(row.metadata);

    assert.equal(row.metadata.signerId, draft.signers[0]!.id);
    assert.equal(row.actor_type, "sender");
    assert.equal(row.actor_email, SENDER.senderEmail);

    for (const link of [copied.url, replaced.url]) {
      assert.ok(!stored.includes(tokenOf(link)));
      assert.ok(!stored.includes("/sign/"));
    }
  }
});

test("every envelope's audit chain still verifies", async () => {
  assert.ok(touchedEnvelopes.length > 10);

  for (const envelopeId of touchedEnvelopes) {
    assert.deepEqual(
      { envelopeId, ok: (await verifyAuditChain(envelopeId, database)).ok },
      { envelopeId, ok: true },
    );
  }
});
