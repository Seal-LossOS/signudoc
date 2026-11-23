import { AwsClient } from "aws4fetch";

import { readEnv, type EnvSource } from "../../utils/env.ts";
import { ServiceConfigurationError } from "../service-config.ts";
import {
  normalizeStorageKey,
  type StorageObjectHead,
  StorageObjectNotFoundError,
  type StorageService,
} from "./types.ts";

// An S3-compatible store (Cloudflare R2, AWS S3, MinIO), private: nothing
// in it has a public URL, and every read goes through the app, which checks
// who is asking first. Requests are signed with SigV4 by aws4fetch and
// addressed path-style, which every S3-compatible service accepts.

const S3_REQUIRED = [
  "S3_ENDPOINT",
  "S3_BUCKET",
  "S3_ACCESS_KEY_ID",
  "S3_SECRET_ACCESS_KEY",
] as const;

export type S3Config = {
  accessKeyId: string;
  bucket: string;
  endpoint: string;
  keyPrefix: string;
  region: string;
  secretAccessKey: string;
};

/** The store's settings, or a ServiceConfigurationError naming what is missing. */
export function readS3Config(env: EnvSource = process.env): S3Config {
  const missing = S3_REQUIRED.filter((name) => !readEnv(env, name));

  if (missing.length > 0) {
    throw new ServiceConfigurationError("storage", missing);
  }

  const endpoint = new URL(readEnv(env, "S3_ENDPOINT")!);

  if (endpoint.protocol !== "https:") {
    throw new Error("S3_ENDPOINT must be an https URL.");
  }

  // A bucket in the endpoint's path would be addressed twice.
  if (endpoint.pathname.replace(/\/+$/, "") !== "" || endpoint.search) {
    throw new Error(
      "S3_ENDPOINT must be the service's address only, with no path. Put the bucket in S3_BUCKET.",
    );
  }

  const prefix = (readEnv(env, "S3_KEY_PREFIX") ?? "").replace(/^\/+/, "");

  return {
    accessKeyId: readEnv(env, "S3_ACCESS_KEY_ID")!,
    bucket: readEnv(env, "S3_BUCKET")!,
    endpoint: endpoint.origin,
    keyPrefix: prefix && !prefix.endsWith("/") ? `${prefix}/` : prefix,
    region: readEnv(env, "S3_REGION") ?? "auto",
    secretAccessKey: readEnv(env, "S3_SECRET_ACCESS_KEY")!,
  };
}

type CreateS3StorageServiceOptions = {
  env?: EnvSource;
  /** Replaced in tests. */
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
};

export function createS3StorageService({
  env = process.env,
  fetch: send = (url, init) => fetch(url, init),
}: CreateS3StorageServiceOptions = {}): StorageService {
  const config = readS3Config(env);
  const client = new AwsClient({
    accessKeyId: config.accessKeyId,
    region: config.region,
    secretAccessKey: config.secretAccessKey,
    service: "s3",
  });

  function objectUrl(normalizedKey: string): string {
    const path = `${config.keyPrefix}${normalizedKey}`
      .split("/")
      .map(encodeURIComponent)
      .join("/");

    return `${config.endpoint}/${encodeURIComponent(config.bucket)}/${path}`;
  }

  async function request(
    method: "DELETE" | "GET" | "HEAD" | "PUT",
    normalizedKey: string,
    init: { body?: Uint8Array; headers?: Record<string, string> } = {},
  ): Promise<Response> {
    // BodyInit refuses a Uint8Array typed over ArrayBufferLike; at runtime the bytes go out as they are.
    const body = init.body as BodyInit | undefined;
    const signed = await client.sign(objectUrl(normalizedKey), {
      body,
      headers: init.headers,
      method,
    });

    // The bytes, not the signed Request, go to fetch: a Request's body is a
    // stream, and Next.js's fetch sent it chunked with no length, which R2
    // refuses with 411.
    return send(signed.url, { body, headers: signed.headers, method });
  }

  function failure(method: string, response: Response): Error {
    return new Error(
      `S3 ${method} failed with HTTP ${String(response.status)}.`,
    );
  }

  function contentLengthOf(response: Response): number | undefined {
    const value = Number(response.headers.get("content-length"));

    return Number.isFinite(value) &&
      value >= 0 &&
      response.headers.has("content-length")
      ? value
      : undefined;
  }

  async function headObject(key: string): Promise<StorageObjectHead> {
    const normalizedKey = normalizeStorageKey(key);
    const response = await request("HEAD", normalizedKey);

    if (response.status === 404) {
      return { bucketName: config.bucket, exists: false, key: normalizedKey };
    }

    if (!response.ok) {
      throw failure("HEAD", response);
    }

    return {
      bucketName: config.bucket,
      contentLength: contentLengthOf(response),
      contentType: response.headers.get("content-type") ?? undefined,
      etag: response.headers.get("etag") ?? undefined,
      exists: true,
      key: normalizedKey,
    };
  }

  async function fetchObject(key: string) {
    const normalizedKey = normalizeStorageKey(key);
    const response = await request("GET", normalizedKey);

    if (response.status === 404) {
      await response.body?.cancel();
      throw new StorageObjectNotFoundError(normalizedKey);
    }

    if (!response.ok) {
      await response.body?.cancel();
      throw failure("GET", response);
    }

    return { normalizedKey, response };
  }

  return {
    async deleteObject(key) {
      const response = await request("DELETE", normalizeStorageKey(key));

      // Deleting what is not there is what was asked for.
      if (!response.ok && response.status !== 404) {
        throw failure("DELETE", response);
      }
    },
    async getObject(key) {
      const { normalizedKey, response } = await fetchObject(key);
      const body = new Uint8Array(await response.arrayBuffer());

      return {
        body,
        bucketName: config.bucket,
        contentLength: body.byteLength,
        contentType: response.headers.get("content-type") ?? undefined,
        etag: response.headers.get("etag") ?? undefined,
        key: normalizedKey,
      };
    },
    async getObjectStream(key) {
      const { normalizedKey, response } = await fetchObject(key);

      return {
        bucketName: config.bucket,
        contentLength: contentLengthOf(response),
        contentType: response.headers.get("content-type") ?? undefined,
        key: normalizedKey,
        stream:
          response.body ??
          new ReadableStream<Uint8Array>({ start: (c) => c.close() }),
      };
    },
    headObject,
    async putObject(input) {
      const normalizedKey = normalizeStorageKey(input.key);
      const response = await request("PUT", normalizedKey, {
        body: input.body,
        headers: {
          "content-type": input.contentType,
          // The store itself refuses the second write, so of two writers
          // that arrive together exactly one is kept.
          ...(input.keepExisting ? { "if-none-match": "*" } : {}),
        },
      });

      if (response.ok) {
        return { bucketName: config.bucket, key: normalizedKey };
      }

      // 412: already stored. 409: a write to the same key was in flight;
      // what counts is whether an object is there now.
      if (
        input.keepExisting &&
        (response.status === 412 ||
          (response.status === 409 && (await headObject(normalizedKey)).exists))
      ) {
        return { bucketName: config.bucket, key: normalizedKey };
      }

      throw failure("PUT", response);
    },
  };
}
