import assert from "node:assert/strict";
import { test } from "node:test";

import type { Resend } from "resend";

import {
  canSendEmail,
  createEmailService,
  createLazyEmailService,
  fitsAsAttachments,
  isEmailOff,
  missingPostmarkSettings,
  resolveEmailDriver,
  type EmailService,
} from "./email.ts";

// What the Resend client is asked to do when the service turns a request
// away for rate. Nothing here talks to Resend.

type Answer = {
  data: { id: string } | null;
  error: { message: string; name: string; statusCode: number } | null;
  headers: Record<string, string> | null;
};

const RATE_LIMITED: Answer = {
  data: null,
  error: {
    message:
      "Too many requests. Please limit the number of requests per second.",
    name: "rate_limit_exceeded",
    statusCode: 429,
  },
  headers: { "retry-after": "1" },
};

const SENT: Answer = { data: { id: "email_1" }, error: null, headers: {} };

const MESSAGE = {
  subject: "Your signed copy",
  template: "completion_notification" as const,
  textBody: "Attached.",
  to: "signer@example.test",
};

/** An email service whose Resend client gives these answers, in order. */
function serviceAnswering(answers: Answer[]) {
  const waits: number[] = [];
  let requests = 0;
  const next = async () => {
    const answer = answers[Math.min(requests, answers.length - 1)];

    requests += 1;

    return answer;
  };
  const service = createEmailService({
    resendClient: {
      batch: { send: next },
      emails: { send: next },
    } as unknown as Resend,
    resolveAddresses: async () => ({
      senderAddress: "Example <hello@example.test>",
      supportAddress: null,
    }),
    wait: async (milliseconds) => {
      waits.push(milliseconds);
    },
  });

  return { requests: () => requests, service, waits };
}

test("a message Resend turns away for rate is sent again after the wait it names", async () => {
  const { requests, service, waits } = serviceAnswering([
    RATE_LIMITED,
    { ...RATE_LIMITED, headers: { "retry-after": "2" } },
    SENT,
  ]);

  const delivery = await service.send(MESSAGE);

  assert.equal(delivery.messageId, "email_1");
  assert.equal(requests(), 3);
  assert.deepEqual(waits, [1000, 2000]);
});

test("a rate limit that does not clear is reported after a few tries", async () => {
  const { requests, service, waits } = serviceAnswering([RATE_LIMITED]);

  await assert.rejects(service.send(MESSAGE), /Too many requests/);
  // The first try and three more.
  assert.equal(requests(), 4);
  assert.equal(waits.length, 3);
});

test("the wait is a second when Resend names none, and is never long", async () => {
  const { service, waits } = serviceAnswering([
    { ...RATE_LIMITED, headers: null },
    { ...RATE_LIMITED, headers: { "retry-after": "3600" } },
    SENT,
  ]);

  await service.send(MESSAGE);

  assert.deepEqual(waits, [1000, 5000]);
});

test("a used-up quota is reported at once: waiting a second does not bring it back", async () => {
  const { requests, service, waits } = serviceAnswering([
    {
      data: null,
      error: {
        message: "You have exceeded your daily email sending quota.",
        name: "daily_quota_exceeded",
        statusCode: 429,
      },
      headers: { "retry-after": "1" },
    },
  ]);

  await assert.rejects(service.send(MESSAGE), /daily email sending quota/);
  assert.equal(requests(), 1);
  assert.deepEqual(waits, []);
});

test("a batch turned away for rate is sent again too", async () => {
  const { requests, service } = serviceAnswering([
    RATE_LIMITED,
    {
      data: { data: [{ id: "email_1" }] } as unknown as { id: string },
      error: null,
      headers: {},
    },
  ]);

  const deliveries = await service.sendBatch([MESSAGE]);

  assert.equal(deliveries[0]?.messageId, "email_1");
  assert.equal(requests(), 2);
});

test("a lazy email service is only built when it first sends, and only once", async () => {
  let built = 0;
  const service = createLazyEmailService(() => {
    built += 1;

    return {
      async send(message) {
        return { accepted: [message.to], messageId: "m-1", rejected: [] };
      },
      async sendBatch() {
        return [];
      },
    } satisfies EmailService;
  });

  assert.equal(built, 0);
  await service.send(MESSAGE);
  await service.sendBatch([MESSAGE]);
  assert.equal(built, 1);
});

test("a lazy email service with no provider fails the send, not its creation (issue #96)", async () => {
  const service = createLazyEmailService(() => createEmailService({ env: {} }));

  await assert.rejects(service.send(MESSAGE), /RESEND_API_KEY/);
});

test("signup knows when there is no email provider to send with (issue #95)", () => {
  assert.equal(canSendEmail({ NODE_ENV: "production" }), false);
  assert.equal(
    canSendEmail({ NODE_ENV: "production", RESEND_API_KEY: "re_test" }),
    true,
  );
  assert.equal(
    canSendEmail({ EMAIL_DRIVER: "capture", NODE_ENV: "development" }),
    true,
  );
  // The capture driver drops mail, so a real site cannot count on it.
  assert.equal(
    canSendEmail({
      APP_URL: "https://sign.example.com",
      EMAIL_DRIVER: "capture",
      NODE_ENV: "production",
    }),
    false,
  );
});

// The off and postmark drivers. Email off is defined in one place,
// isEmailOff, and a Postmark setup missing its token or sender is off.

const POSTMARK = {
  EMAIL_DRIVER: "postmark",
  POSTMARK_FROM_EMAIL: "sign@acme.test",
  POSTMARK_TOKEN: "pm-test-token",
};

test("the off and postmark drivers are known, and an unknown one names all four", () => {
  assert.equal(resolveEmailDriver({ EMAIL_DRIVER: "off" }), "off");
  assert.equal(resolveEmailDriver({ EMAIL_DRIVER: "postmark" }), "postmark");
  assert.equal(resolveEmailDriver({ EMAIL_DRIVER: " Postmark " }), "postmark");
  assert.throws(
    () => resolveEmailDriver({ EMAIL_DRIVER: "smtp" }),
    (error: Error) =>
      error.message.includes('"postmark"') && error.message.includes('"off"'),
  );
});

test("the Postmark settings still unset are named in order", () => {
  assert.deepEqual(missingPostmarkSettings({ EMAIL_DRIVER: "postmark" }), [
    "POSTMARK_TOKEN",
    "POSTMARK_FROM_EMAIL",
  ]);
  assert.deepEqual(
    missingPostmarkSettings({
      EMAIL_DRIVER: "postmark",
      POSTMARK_TOKEN: "pm-test-token",
    }),
    ["POSTMARK_FROM_EMAIL"],
  );
  assert.deepEqual(missingPostmarkSettings(POSTMARK), []);
  assert.deepEqual(missingPostmarkSettings({ EMAIL_DRIVER: "off" }), []);
});

test("email is off under the off driver and under an incomplete Postmark setup", () => {
  assert.equal(isEmailOff({ EMAIL_DRIVER: "off" }), true);
  assert.equal(isEmailOff({ ...POSTMARK, POSTMARK_TOKEN: undefined }), true);
  assert.equal(
    isEmailOff({ ...POSTMARK, POSTMARK_FROM_EMAIL: undefined }),
    true,
  );
  assert.equal(isEmailOff(POSTMARK), false);
  assert.equal(isEmailOff({ EMAIL_DRIVER: "resend" }), false);
  assert.equal(isEmailOff({ EMAIL_DRIVER: "capture" }), false);
  assert.equal(isEmailOff({}), false);
  assert.equal(isEmailOff({ EMAIL_DRIVER: "smtp" }), false);
});

test("email that is off does not count as a provider to send with", () => {
  assert.equal(
    canSendEmail({ EMAIL_DRIVER: "off", NODE_ENV: "production" }),
    false,
  );
  assert.equal(
    canSendEmail({
      ...POSTMARK,
      NODE_ENV: "production",
      POSTMARK_TOKEN: undefined,
    }),
    false,
  );
  assert.equal(canSendEmail({ ...POSTMARK, NODE_ENV: "production" }), true);
});

test("the off driver answers every message as not sent, even in production", async (t) => {
  const info = t.mock.method(console, "info", () => {});
  const service = createEmailService({
    env: { EMAIL_DRIVER: "off", NODE_ENV: "production" },
  });

  const delivery = await service.send(MESSAGE);

  assert.deepEqual(delivery.accepted, []);
  assert.deepEqual(delivery.rejected, ["signer@example.test"]);
  assert.match(delivery.messageId ?? "", /^off:/);
  assert.equal(info.mock.callCount(), 1);

  const line = String(info.mock.calls[0]?.arguments[0]);

  assert.match(line, /completion_notification/);
  assert.doesNotMatch(line, /signer@example\.test/);
  assert.doesNotMatch(line, /Your signed copy/);

  const deliveries = await service.sendBatch([
    MESSAGE,
    { ...MESSAGE, to: "second@example.test" },
  ]);

  assert.deepEqual(
    deliveries.map((item) => item.rejected),
    [["signer@example.test"], ["second@example.test"]],
  );
});

test("Postmark's smaller size limit decides what goes as attachments", () => {
  const eightMiB = [
    {
      content: new Uint8Array(8 * 1024 * 1024),
      contentType: "application/pdf",
      filename: "big.pdf",
    },
  ];

  assert.equal(fitsAsAttachments(eightMiB, POSTMARK), false);
  assert.equal(fitsAsAttachments(eightMiB, { EMAIL_DRIVER: "resend" }), true);
  assert.equal(fitsAsAttachments(eightMiB, { EMAIL_DRIVER: "smtp" }), true);
});

test("a complete Postmark setup sends through Postmark", async () => {
  const urls: string[] = [];
  const service = createEmailService({
    env: POSTMARK,
    fetch: async (url) => {
      urls.push(url);

      return new Response(JSON.stringify({ ErrorCode: 0, MessageID: "pm-1" }), {
        status: 200,
      });
    },
    resolveAddresses: async () => ({
      senderAddress: "Acme <sign@acme.test>",
      supportAddress: null,
    }),
  });

  const delivery = await service.send(MESSAGE);

  assert.deepEqual(urls, ["https://api.postmarkapp.com/email"]);
  assert.equal(delivery.messageId, "pm-1");
});
