import { ConfigurationError } from "./config.js";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { randomUUID } from "node:crypto";
import {
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import type { StorageConfig } from "./config.js";

export interface BlobStore {
  get(key: string): Promise<Uint8Array>;
  put(key: string, content: Uint8Array): Promise<void>;
  listPrefix(prefix: string): Promise<string[]>;
  deletePrefix(prefix: string): Promise<void>;
  close(): void;
}

export function isMissingBlob(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const failure = error as {
    code?: string;
    name?: string;
    $metadata?: { httpStatusCode?: number };
  };
  return (
    failure.code === "ENOENT" ||
    failure.name === "NoSuchKey" ||
    failure.$metadata?.httpStatusCode === 404
  );
}

export function createBlobStore(config: StorageConfig): BlobStore {
  if (config.type === "fs") {
    const path = (key: string) => join(config.rootDir, ...key.split("/"));
    return {
      get: (key) => readFile(path(key)),
      async put(key, content) {
        const dest = path(key);
        const temp = `${dest}.${randomUUID()}.tmp`;
        await mkdir(dirname(dest), { recursive: true });
        try {
          await writeFile(temp, content);
          await rename(temp, dest);
        } finally {
          await rm(temp, { force: true });
        }
      },
      async listPrefix(prefix) {
        const root = path(prefix);
        const entries = await readdir(root, { recursive: true, withFileTypes: true });
        return entries
          .filter((entry) => entry.isFile())
          .map((entry) =>
            relative(config.rootDir, join(entry.parentPath, entry.name)).split(sep).join("/"),
          );
      },
      deletePrefix: (prefix) => rm(path(prefix), { recursive: true, force: true }),
      close() {},
    };
  }

  if (
    config.type !== "s3" ||
    !config.bucket ||
    Boolean(config.accessKeyId) !== Boolean(config.secretAccessKey)
  )
    throw new ConfigurationError("Invalid S3 storage configuration");
  const client = new S3Client({
    region: config.region,
    endpoint: config.endpoint,
    forcePathStyle: config.forcePathStyle,
    credentials:
      config.accessKeyId && config.secretAccessKey
        ? { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey }
        : undefined,
  });
  const Bucket = config.bucket;
  const base = config.prefix ? config.prefix.replace(/\/+$/, "") + "/" : "";
  async function listPrefix(prefix: string) {
    const keys: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await client.send(
        new ListObjectsV2Command({ Bucket, Prefix: base + prefix, ContinuationToken: cursor }),
      );
      for (const { Key } of page.Contents ?? []) if (Key) keys.push(Key.slice(base.length));
      cursor = page.NextContinuationToken;
    } while (cursor);
    return keys;
  }
  return {
    async get(key) {
      const result = await client.send(new GetObjectCommand({ Bucket, Key: base + key }));
      if (!result.Body) throw new Error("Missing S3 body");
      return result.Body.transformToByteArray();
    },
    async put(key, content) {
      await client.send(new PutObjectCommand({ Bucket, Key: base + key, Body: content }));
    },
    listPrefix,
    async deletePrefix(prefix) {
      const keys = await listPrefix(prefix);
      for (let start = 0; start < keys.length; start += 1000) {
        const result = await client.send(
          new DeleteObjectsCommand({
            Bucket,
            Delete: {
              Objects: keys.slice(start, start + 1000).map((key) => ({ Key: base + key })),
            },
          }),
        );
        if (result.Errors?.length) throw new Error("S3 blob deletion failed");
      }
    },
    close: () => client.destroy(),
  };
}

export const commitPrefix = (mod: { slug: string; name: string }, commit: string) =>
  `${mod.slug}/${mod.name}/${commit}/`;
export const filePrefix = (mod: { slug: string; name: string }, commit: string) =>
  `${commitPrefix(mod, commit)}files/`;
