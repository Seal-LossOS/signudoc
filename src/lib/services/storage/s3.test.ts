import assert from "node:assert/strict";
import { test } from "node:test";

import { ServiceConfigurationError } from "../service-config.ts";
import { createStorageService } from "../storage.ts";
import { createS3StorageService, readS3Config } from "./s3.ts";
import { StorageObjectNotFoundError } from "./types.ts";

// A fake fetch that records each signed request and answers from a queue.
function createFakeFetch(answers: Response[]) {
  const requests: Request[] = [];
  const bodies: unknown[] = [];

  async function send(url: string, init: RequestInit): Promise<Response> {
    requests.push(new Request(url, init));
    bodies.push(init.body);

    const answer = answers.shift();

    if (!answer) {
      throw new Error("The fake has no answer queued.");
    }

    return answer;
  }

  return { bodies, requests, send };
}

const base = {
  S3_ENDPOINT: "https://acct.r2.example.test",
  S3_BUCKET: "bucket",
  S3_ACCESS_KEY_ID: "AKIDTEST",
  S3_SECRET_ACCESS_KEY: "secret-test-0123456789",
  S3_KEY_PREFIX: "signudoc",
};

const KEY = "envelopes/abc/source.pdf";

test("the store's settings are read from the environment", () => {
  assert.deepEqual(readS3Config(base), {
    accessKeyId: "AKIDTEST",
    bucket: "bucket",
    endpoint: "https://acct.r2.example.test",
    keyPrefix: "signudoc/",
    region: "auto",
    secretAccessKey: "secret-test-0123456789",
  });
  assert.equal(
    readS3Config({ ...base, S3_KEY_PREFIX: "/signudoc/" }).keyPrefix,
    "signudoc/",
  );
  assert.equal(
    readS3Config({ ...base, S3_KEY_PREFIX: undefined }).keyPrefix,
    "",
  );
  assert.equal(
    readS3Config({ ...base, S3_REGION: "eu-west-1" }).region,
    "eu-west-1",
  );
  assert.equal(
    readS3Config({ ...base, S3_ENDPOINT: "https://x.test/" }).endpoint,
    "https://x.test",
  );
});

test("a store with no settings says which variables it needs", () => {
  assert.throws(
    () => readS3Config({}),
    (error: unknown) =>
      error instanceof ServiceConfigurationError &&
      /S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY/.test(
        error.message,
      ),
  );
  assert.throws(
    () => readS3Config({ ...base, S3_ENDPOINT: "http://x.test" }),
    /https/,
  );
  assert.throws(
    () => readS3Config({ ...base, S3_ENDPOINT: "https://x.test/bucket" }),
    /S3_BUCKET/,
  );
});

test("an object is written signed, to the bucket path, without if-none-match", async () => {
  const fake = createFakeFetch([new Response(null, { status: 200 })]);
  const storage = createS3StorageService({ env: base, fetch: fake.send });
  const body = new Uint8Array([1, 2, 3, 4, 5]);

  const reference = await storage.putObject({
    body,
    contentType: "application/pdf",
    key: KEY,
  });

  assert.deepEqual(reference, { bucketName: "bucket", key: KEY });
  assert.equal(fake.requests.length, 1);

  const [request] = fake.requests;

  assert.equal(request?.method, "PUT");
  assert.equal(
    request?.url,
    "https://acct.r2.example.test/bucket/signudoc/envelopes/abc/source.pdf",
  );
  assert.equal(request?.headers.get("content-type"), "application/pdf");
  assert.equal(request?.headers.get("if-none-match"), null);
  assert.ok(
    request?.headers
      .get("authorization")
      ?.startsWith("AWS4-HMAC-SHA256 Credential=AKIDTEST/"),
  );
  assert.ok(
    request?.headers.get("authorization")?.includes("/auto/s3/aws4_request"),
  );
  assert.ok(request?.headers.has("x-amz-date"));
  assert.ok(request?.headers.has("x-amz-content-sha256"));
  assert.deepEqual(
    [...new Uint8Array(await request!.arrayBuffer())],
    [1, 2, 3, 4, 5],
  );

  for (const value of request?.headers.values() ?? []) {
    assert.ok(!value.includes("secret-test-0123456789"));
  }
});

test("an object that is to be kept is kept, whoever wrote it first", async () => {
  const stored = createFakeFetch([
    new Response(null, { status: 200 }),
    new Response(null, { status: 412 }),
  ]);
  const storage = createS3StorageService({ env: base, fetch: stored.send });
  const put = {
    body: new Uint8Array([1]),
    contentType: "image/jpeg",
    key: KEY,
    keepExisting: true,
  };

  assert.deepEqual(await storage.putObject(put), {
    bucketName: "bucket",
    key: KEY,
  });
  assert.equal(stored.requests[0]?.headers.get("if-none-match"), "*");
  assert.deepEqual(await storage.putObject(put), {
    bucketName: "bucket",
    key: KEY,
  });

  const inFlight = createFakeFetch([
    new Response(null, { status: 409 }),
    new Response(null, { status: 200 }),
  ]);
  const racing = createS3StorageService({ env: base, fetch: inFlight.send });

  assert.deepEqual(await racing.putObject(put), {
    bucketName: "bucket",
    key: KEY,
  });
  assert.equal(inFlight.requests[1]?.method, "HEAD");

  const lost = createFakeFetch([
    new Response(null, { status: 409 }),
    new Response(null, { status: 404 }),
  ]);
  const losing = createS3StorageService({ env: base, fetch: lost.send });

  await assert.rejects(losing.putObject(put), /HTTP 409/);

  const failing = createFakeFetch([new Response(null, { status: 500 })]);
  const broken = createS3StorageService({ env: base, fetch: failing.send });

  await assert.rejects(broken.putObject(put), /S3 PUT failed with HTTP 500/);
});

test("without keepExisting, a write refused as already stored is a failure", async () => {
  const fake = createFakeFetch([new Response(null, { status: 412 })]);
  const storage = createS3StorageService({ env: base, fetch: fake.send });

  await assert.rejects(
    storage.putObject({
      body: new Uint8Array([1]),
      contentType: "image/jpeg",
      key: KEY,
    }),
    /HTTP 412/,
  );
});

test("an object is read whole, with its type and etag", async () => {
  const fake = createFakeFetch([
    new Response("hello", {
      headers: { "content-type": "application/pdf", etag: '"e1"' },
      status: 200,
    }),
  ]);
  const storage = createS3StorageService({ env: base, fetch: fake.send });
  const object = await storage.getObject(KEY);

  assert.deepEqual([...object.body], [...new TextEncoder().encode("hello")]);
  assert.equal(object.contentLength, 5);
  assert.equal(object.contentType, "application/pdf");
  assert.equal(object.etag, '"e1"');
});

test("a missing object is not found, a refused read is a failure", async () => {
  const missing = createFakeFetch([new Response(null, { status: 404 })]);
  const notFound = createS3StorageService({ env: base, fetch: missing.send });

  await assert.rejects(notFound.getObject(KEY), StorageObjectNotFoundError);

  const refused = createFakeFetch([new Response(null, { status: 403 })]);
  const forbidden = createS3StorageService({ env: base, fetch: refused.send });

  await assert.rejects(forbidden.getObject(KEY), /S3 GET failed with HTTP 403/);
});

test("an object is streamed with its length", async () => {
  const fake = createFakeFetch([
    new Response("hello", { headers: { "content-length": "5" }, status: 200 }),
  ]);
  const storage = createS3StorageService({ env: base, fetch: fake.send });
  const object = await storage.getObjectStream(KEY);

  assert.equal(object.contentLength, 5);
  assert.equal(await new Response(object.stream).text(), "hello");
});

test("head reports what is stored, and a missing object as absent", async () => {
  const present = createFakeFetch([
    new Response(null, {
      headers: {
        "content-length": "5",
        "content-type": "application/pdf",
        etag: '"e1"',
      },
      status: 200,
    }),
  ]);
  const found = createS3StorageService({ env: base, fetch: present.send });

  assert.deepEqual(await found.headObject(KEY), {
    bucketName: "bucket",
    contentLength: 5,
    contentType: "application/pdf",
    etag: '"e1"',
    exists: true,
    key: KEY,
  });

  const absent = createFakeFetch([new Response(null, { status: 404 })]);
  const notThere = createS3StorageService({ env: base, fetch: absent.send });

  assert.deepEqual(await notThere.headObject(KEY), {
    bucketName: "bucket",
    exists: false,
    key: KEY,
  });

  const broken = createFakeFetch([new Response(null, { status: 500 })]);
  const failing = createS3StorageService({ env: base, fetch: broken.send });

  await assert.rejects(failing.headObject(KEY), /HTTP 500/);
});

test("delete resolves for a deleted and an absent object, and fails otherwise", async () => {
  const fake = createFakeFetch([
    new Response(null, { status: 204 }),
    new Response(null, { status: 404 }),
    new Response(null, { status: 500 }),
  ]);
  const storage = createS3StorageService({ env: base, fetch: fake.send });

  await storage.deleteObject(KEY);
  await storage.deleteObject(KEY);
  await assert.rejects(storage.deleteObject(KEY), /S3 DELETE failed/);
});

test("with no key prefix the object sits directly under the bucket", async () => {
  const fake = createFakeFetch([new Response(null, { status: 200 })]);
  const storage = createS3StorageService({
    env: { ...base, S3_KEY_PREFIX: undefined },
    fetch: fake.send,
  });

  await storage.putObject({
    body: new Uint8Array([1]),
    contentType: "application/pdf",
    key: KEY,
  });

  assert.equal(
    fake.requests[0]?.url,
    "https://acct.r2.example.test/bucket/envelopes/abc/source.pdf",
  );
});

test("a key that could escape its folder is refused before any request", async () => {
  const fake = createFakeFetch([]);
  const storage = createS3StorageService({ env: base, fetch: fake.send });

  await assert.rejects(storage.getObject("../x"), /invalid/);
  assert.equal(fake.requests.length, 0);
});

test("the S3 driver is chosen by STORAGE_DRIVER and offers the whole service", () => {
  const storage = createStorageService({
    env: { ...base, STORAGE_DRIVER: "s3" },
  });

  assert.equal(typeof storage.deleteObject, "function");
  assert.equal(typeof storage.getObject, "function");
  assert.equal(typeof storage.getObjectStream, "function");
  assert.equal(typeof storage.headObject, "function");
  assert.equal(typeof storage.putObject, "function");
});

test("a PUT hands fetch the bytes themselves, so the length is known", async () => {
  // R2 refuses a PUT with no Content-Length (411). A stream body, as inside
  // a Request, went out chunked under Next.js; bytes always carry a length.
  const fake = createFakeFetch([new Response(null, { status: 200 })]);
  const storage = createS3StorageService({ env: base, fetch: fake.send });
  const body = Buffer.from("aGVsbG8=", "base64");

  await storage.putObject({ body, contentType: "image/png", key: KEY });

  assert.equal(fake.bodies[0], body);
  assert.match(
    fake.requests[0]!.headers.get("authorization") ?? "",
    /^AWS4-HMAC-SHA256 /,
  );
});
