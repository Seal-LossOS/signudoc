import assert from "node:assert/strict";
import { test } from "node:test";

import type { TransactionalEmailMessage } from "./email.ts";
import { createPostmarkEmailService } from "./email-postmark.ts";

// What is asked of Postmark's HTTP API, through a fake fetch. Nothing here
// talks to Postmark.

type Call = { init: RequestInit; url: string };

function answer(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json", ...headers },
    status,
  });
}

const ACCEPTED = (id: string) =>
  answer(200, { ErrorCode: 0, Message: "OK", MessageID: id });

/** A Postmark service whose fake API gives these answers, in order. */
function serviceAnswering(
  answers: Array<() => Response>,
  supportAddress: string | null = "help@acme.test",
) {
  const calls: Call[] = [];
  const waits: number[] = [];
  const service = createPostmarkEmailService({
    fetch: async (url, init) => {
      const next = answers[Math.min(calls.length, answers.length - 1)];

      calls.push({ init, url });

      return next();
    },
    messageStream: "outbound",
    resolveAddresses: async () => ({
      senderAddress: "Acme <sign@acme.test>",
      supportAddress,
    }),
    token: "pm-test-token",
    wait: async (milliseconds) => {
      waits.push(milliseconds);
    },
  });

  return { calls, service, waits };
}

function sentBody(call: Call | undefined): Record<string, unknown> {
  assert.ok(call);
  return JSON.parse(String(call.init.body)) as Record<string, unknown>;
}

const MESSAGE: TransactionalEmailMessage = {
  subject: "Your signed copy",
  template: "completion_notification",
  textBody: "Attached.",
  to: "signer@example.test",
};

test("a message goes to Postmark with tracking off and every field in place", async () => {
  const { calls, service } = serviceAnswering([() => ACCEPTED("pm-1")]);

  const delivery = await service.send({
    ...MESSAGE,
    attachments: [
      {
        content: new Uint8Array([1, 2, 3]),
        contentType: "application/pdf",
        filename: "signed.pdf",
      },
    ],
    htmlBody: "<p>Attached.</p>",
  });

  assert.deepEqual(delivery, {
    accepted: ["signer@example.test"],
    messageId: "pm-1",
    rejected: [],
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, "https://api.postmarkapp.com/email");
  assert.equal(calls[0]?.init.method, "POST");
  assert.deepEqual(calls[0]?.init.headers, {
    Accept: "application/json",
    "Content-Type": "application/json",
    "X-Postmark-Server-Token": "pm-test-token",
  });
  assert.deepEqual(sentBody(calls[0]), {
    From: "Acme <sign@acme.test>",
    To: "signer@example.test",
    Subject: "Your signed copy",
    TextBody: "Attached.",
    HtmlBody: "<p>Attached.</p>",
    ReplyTo: "help@acme.test",
    Tag: "completion_notification",
    MessageStream: "outbound",
    TrackOpens: false,
    TrackLinks: "None",
    Attachments: [
      { Name: "signed.pdf", Content: "AQID", ContentType: "application/pdf" },
    ],
  });
});

test("the message's own reply-to wins over the support address", async () => {
  const { calls, service } = serviceAnswering([() => ACCEPTED("pm-1")]);

  await service.send({ ...MESSAGE, replyTo: "owner@acme.test" });

  assert.equal(sentBody(calls[0]).ReplyTo, "owner@acme.test");
});

test("fields with nothing to say are left out", async () => {
  const { calls, service } = serviceAnswering([() => ACCEPTED("pm-1")], null);

  await service.send(MESSAGE);

  const body = sentBody(calls[0]);

  assert.equal("ReplyTo" in body, false);
  assert.equal("HtmlBody" in body, false);
  assert.equal("Attachments" in body, false);
});

test("a refusal names the status and Postmark's code, never its message or the address", async () => {
  const { service } = serviceAnswering([
    () =>
      answer(422, {
        ErrorCode: 300,
        Message: "Invalid 'To' address: 'x@y.test'",
      }),
  ]);

  await assert.rejects(service.send(MESSAGE), (error: Error) => {
    assert.match(error.message, /422/);
    assert.match(error.message, /300/);
    assert.doesNotMatch(error.message, /x@y\.test/);
    assert.doesNotMatch(error.message, /signer@example\.test/);
    return true;
  });
});

test("a refusal without a JSON body says it has no code", async () => {
  const { service } = serviceAnswering([
    () => new Response("Bad gateway", { status: 502 }),
  ]);

  await assert.rejects(
    service.send(MESSAGE),
    /^Error: Postmark refused the message \(HTTP 502, ErrorCode none\)\.$/,
  );
});

test("a 200 that carries an error code is not a delivery", async () => {
  const { service } = serviceAnswering([
    () => answer(200, { ErrorCode: 406, Message: "Inactive recipient" }),
  ]);

  await assert.rejects(service.send(MESSAGE), /HTTP 200, ErrorCode 406/);
});

test("a message Postmark turns away for rate is sent again after the wait it names", async () => {
  const { calls, service, waits } = serviceAnswering([
    () => answer(429, { ErrorCode: 429 }, { "retry-after": "2" }),
    () => ACCEPTED("pm-2"),
  ]);

  const delivery = await service.send(MESSAGE);

  assert.equal(delivery.messageId, "pm-2");
  assert.equal(calls.length, 2);
  assert.deepEqual(waits, [2000]);
});

test("the wait is a second when Postmark names none, and is never long", async () => {
  const { service, waits } = serviceAnswering([
    () => answer(429, {}),
    () => answer(429, {}, { "retry-after": "3600" }),
    () => ACCEPTED("pm-3"),
  ]);

  await service.send(MESSAGE);

  assert.deepEqual(waits, [1000, 5000]);
});

test("a rate limit that does not clear is reported after three more tries", async () => {
  const { calls, service, waits } = serviceAnswering([
    () => answer(429, { ErrorCode: 429 }, { "retry-after": "1" }),
  ]);

  await assert.rejects(service.send(MESSAGE), /HTTP 429/);
  assert.equal(calls.length, 4);
  assert.equal(waits.length, 3);
});

test("a batch with an attachment is refused before anything is sent", async () => {
  const { calls, service } = serviceAnswering([() => ACCEPTED("pm-1")]);

  await assert.rejects(
    service.sendBatch([
      MESSAGE,
      {
        ...MESSAGE,
        attachments: [
          {
            content: new Uint8Array([1]),
            contentType: "application/pdf",
            filename: "a.pdf",
          },
        ],
      },
    ]),
    /Messages with attachments must be sent one by one\./,
  );
  assert.equal(calls.length, 0);
});

test("a batch is sent one message at a time, in order", async () => {
  const { calls, service } = serviceAnswering([
    () => ACCEPTED("pm-1"),
    () => ACCEPTED("pm-2"),
  ]);

  const deliveries = await service.sendBatch([
    MESSAGE,
    { ...MESSAGE, to: "second@example.test" },
  ]);

  assert.deepEqual(
    calls.map((call) => sentBody(call).To),
    ["signer@example.test", "second@example.test"],
  );
  assert.deepEqual(
    deliveries.map((delivery) => delivery.messageId),
    ["pm-1", "pm-2"],
  );
});

test("a batch stops at the first message Postmark refuses", async () => {
  const { calls, service } = serviceAnswering([
    () => answer(422, { ErrorCode: 300 }),
  ]);

  await assert.rejects(
    service.sendBatch([MESSAGE, { ...MESSAGE, to: "second@example.test" }]),
    /HTTP 422/,
  );
  assert.equal(calls.length, 1);
});
