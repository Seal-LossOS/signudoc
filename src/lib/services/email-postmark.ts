import type { EmailAddresses } from "./email-addresses.ts";
import type {
  EmailDeliveryResult,
  EmailService,
  TransactionalEmailMessage,
} from "./email.ts";

// Postmark's HTTP API, called with fetch: no SDK. Open and link tracking are
// off on every message, because link tracking would send download and
// signing links through Postmark's redirect host, which logs them.
// https://postmarkapp.com/developer/user-guide/send-email-with-api

export const POSTMARK_API_URL = "https://api.postmarkapp.com";

/** Postmark takes 10 MB per message after base64; 7 MiB of files stays under it with the bodies. */
export const POSTMARK_MAX_ATTACHMENT_BYTES = 7 * 1024 * 1024;

// The same as the Resend driver's in email.ts. Not imported from there:
// email.ts imports this file, and the cycle is not worth three numbers.
const RATE_LIMIT_RETRIES = 3;
const DEFAULT_RATE_LIMIT_WAIT_MS = 1_000;
const MAX_RATE_LIMIT_WAIT_MS = 5_000;

type PostmarkOptions = {
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  messageStream: string;
  resolveAddresses: () => Promise<EmailAddresses>;
  token: string;
  wait?: (milliseconds: number) => Promise<void>;
};

function waitFor(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function rateLimitWaitMs(retryAfter: string | null): number {
  const seconds = Number(retryAfter);

  return retryAfter !== null && Number.isFinite(seconds) && seconds > 0
    ? Math.min(seconds * 1000, MAX_RATE_LIMIT_WAIT_MS)
    : DEFAULT_RATE_LIMIT_WAIT_MS;
}

function buildPostmarkPayload(
  message: TransactionalEmailMessage,
  addresses: EmailAddresses,
  messageStream: string,
) {
  const replyTo = message.replyTo ?? addresses.supportAddress;

  return {
    From: addresses.senderAddress,
    To: message.to,
    Subject: message.subject,
    TextBody: message.textBody,
    ...(message.htmlBody ? { HtmlBody: message.htmlBody } : {}),
    ...(replyTo ? { ReplyTo: replyTo } : {}),
    Tag: message.template,
    MessageStream: messageStream,
    TrackOpens: false,
    TrackLinks: "None",
    ...(message.attachments?.length
      ? {
          Attachments: message.attachments.map((attachment) => ({
            Name: attachment.filename,
            Content: Buffer.from(attachment.content).toString("base64"),
            ContentType: attachment.contentType,
          })),
        }
      : {}),
  };
}

type PostmarkAnswer = { errorCode: number | null; messageId?: string };

async function readAnswer(response: Response): Promise<PostmarkAnswer> {
  try {
    const body = (await response.json()) as {
      ErrorCode?: unknown;
      MessageID?: unknown;
    };

    return {
      errorCode: typeof body.ErrorCode === "number" ? body.ErrorCode : null,
      messageId:
        typeof body.MessageID === "string" ? body.MessageID : undefined,
    };
  } catch {
    return { errorCode: null };
  }
}

/**
 * Postmark's own Message is never passed on: it can quote the recipient's
 * address, and this error ends up in logs. The status and code say enough.
 */
function refusal(status: number, errorCode: number | null): Error {
  return new Error(
    `Postmark refused the message (HTTP ${String(status)}, ErrorCode ${errorCode === null ? "none" : String(errorCode)}).`,
  );
}

export function createPostmarkEmailService({
  fetch: fetchImpl = (url, init) => fetch(url, init),
  messageStream,
  resolveAddresses,
  token,
  wait = waitFor,
}: PostmarkOptions): EmailService {
  async function send(
    message: TransactionalEmailMessage,
  ): Promise<EmailDeliveryResult> {
    const addresses = await resolveAddresses();
    const body = JSON.stringify(
      buildPostmarkPayload(message, addresses, messageStream),
    );

    // A 429 is retried like Resend's: the message would otherwise be lost.
    for (let attempt = 0; ; attempt += 1) {
      const response = await fetchImpl(`${POSTMARK_API_URL}/email`, {
        body,
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "X-Postmark-Server-Token": token,
        },
        method: "POST",
      });

      if (response.status === 429 && attempt < RATE_LIMIT_RETRIES) {
        await wait(rateLimitWaitMs(response.headers.get("retry-after")));
        continue;
      }

      const answer = await readAnswer(response);

      if (response.status !== 200 || answer.errorCode !== 0) {
        throw refusal(response.status, answer.errorCode);
      }

      return {
        accepted: [message.to],
        messageId: answer.messageId,
        rejected: [],
      };
    }
  }

  return {
    // options.idempotencyKey is ignored: Postmark has none, so a retried send can go twice.
    send: (message) => send(message),
    async sendBatch(messages) {
      if (messages.some((message) => message.attachments?.length)) {
        throw new Error("Messages with attachments must be sent one by one.");
      }

      const results: EmailDeliveryResult[] = [];

      for (const message of messages) {
        results.push(await send(message));
      }

      return results;
    },
  };
}
