import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:https";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import S3rver from "s3rver";
import { serve } from "@hono/node-server";
import type { TestContext } from "vitest";
import {
  createRegistryHandler,
  type StaticTokenEntry,
  type StorageConfig,
} from "@protorip/registry-server";
import { sqlite } from "@protorip/registry-server/node";

const exec = promisify(execFile);
const admin = "psr_test-admin-secret";
export const reader = "psr_test-reader-secret";
export const writer = "psr_test-writer-secret";
export const serverEntrypoint = new URL("../dist/server.js", import.meta.url).pathname;
const embeddedBun = new URL("./embedded-bun.ts", import.meta.url).pathname;
const bun = process.env.BUN_EXECUTABLE ?? "bun";

type Runtime = "embedded Node" | "embedded Bun" | "Bun server" | "docker";
type AuthMode = "none" | "static";
type StorageBackend = StorageConfig["type"];

export interface RegistryOptions {
  allowPublicModules?: boolean;
  plainHttp?: boolean;
}

interface BufOptions {
  cwd?: string;
  token?: string;
  input?: string;
}

export async function startRegistry(
  t: TestContext,
  root: string,
  entry: Runtime,
  mode: AuthMode,
  backend: StorageBackend,
  { allowPublicModules = true, plainHttp = false }: RegistryOptions = {},
) {
  const dbPath = join(root, "registry.db");
  const rootDir = join(root, "blobs");
  const tokens: StaticTokenEntry[] = [
    { name: "operator", plain: admin },
    { name: "reader", plain: reader, role: "read" },
    { name: "writer", plain: writer, role: "write", scopes: ["example"] },
  ];
  const bucket = "registry";
  let storage: StorageConfig = { type: "fs", rootDir };
  if (backend === "s3") {
    const emulator = new S3rver({
      address: "127.0.0.1",
      port: 0,
      silent: true,
      directory: join(root, "s3"),
      configureBuckets: [{ name: bucket }],
    });
    const { port } = await emulator.run();
    t.onTestFinished(() => emulator.close());
    storage = {
      type: "s3",
      bucket,
      endpoint: `http://127.0.0.1:${port}`,
      region: "us-east-1",
      accessKeyId: "S3RVER",
      secretAccessKey: "S3RVER",
      forcePathStyle: true,
    };
  }
  const cert = join(root, "cert.pem");
  const config = join(root, "buf-config");
  await mkdir(config);
  let tlsOptions:
    | { createServer: typeof createServer; serverOptions: { cert: Buffer; key: Buffer } }
    | undefined;
  if (plainHttp) {
    await writeFile(join(config, "config.yaml"), 'version: v1\ntls:\n  use: "false"\n');
  } else {
    const key = join(root, "key.pem");
    await exec("openssl", [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=IP:127.0.0.1",
      "-keyout",
      key,
      "-out",
      cert,
    ]);
    tlsOptions = {
      createServer,
      serverOptions: { cert: await readFile(cert), key: await readFile(key) },
    };
  }
  let handler: (request: Request) => Response | Promise<Response>;
  if (entry === "embedded Node") {
    const registry = createRegistryHandler({
      database: sqlite(dbPath),
      storage,
      auth: mode === "none" ? { mode } : { mode, tokens, allowPublicModules },
      logger() {},
    });
    t.onTestFinished(() => registry.close());
    handler = registry.fetch;
  } else {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PORT: "0",
      DB_PATH: dbPath,
      FS_ROOT: rootDir,
      STORAGE_BACKEND: backend,
      S3_BUCKET: bucket,
      S3_ENDPOINT: storage.type === "s3" ? storage.endpoint : undefined,
      S3_PREFIX: "conformance",
      S3_REGION: storage.type === "s3" ? storage.region : undefined,
      S3_FORCE_PATH_STYLE: "true",
      S3_ACCESS_KEY_ID: storage.type === "s3" ? storage.accessKeyId : undefined,
      S3_SECRET_ACCESS_KEY: storage.type === "s3" ? storage.secretAccessKey : undefined,
      AUTH_MODE: mode,
      TOKENS: JSON.stringify(tokens),
      TOKENS_FILE: "",
      ALLOW_PUBLIC_MODULES: String(allowPublicModules),
      LOG_LEVEL: "info",
    };
    if (entry === "embedded Bun") {
      env.REGISTRY_TEST_CONFIG = JSON.stringify({
        dbPath,
        storage,
        auth: mode === "none" ? { mode } : { mode, tokens, allowPublicModules },
      });
    }
    const docker = entry === "docker";
    const image = process.env.REGISTRY_TEST_IMAGE;
    if (docker && !image) throw new Error("REGISTRY_TEST_IMAGE must be set for Docker tests");
    const args =
      docker && image
        ? [
            "run",
            "--rm",
            "--network",
            "host",
            "--user",
            `${process.getuid?.()}:${process.getgid?.()}`,
            "--volume",
            `${root}:/data`,
            ...Object.keys(env)
              .filter(
                (name) =>
                  name === "PORT" ||
                  name === "AUTH_MODE" ||
                  /^(TOKENS|ALLOW_PUBLIC|S3_|STORAGE_BACKEND|LOG_LEVEL)/.test(name),
              )
              .flatMap((name) => ["--env", name]),
            image,
          ]
        : entry === "embedded Bun"
          ? [embeddedBun]
          : [serverEntrypoint];
    const child = spawn(docker ? "docker" : bun, args, {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const exited = once(child, "exit");
    t.onTestFinished(async () => {
      child.kill();
      await exited;
    });
    let errors = "";
    child.stderr.on("data", (chunk) => {
      errors += chunk;
    });
    const lines = createInterface({ input: child.stdout });
    const port = await Promise.race([
      new Promise<number>((resolve) =>
        lines.on("line", (line) => {
          const event = JSON.parse(line);
          if (event.event === "listening") resolve(event.port);
        }),
      ),
      exited.then(() => {
        throw new Error(`Server exited during startup: ${errors}`);
      }),
    ]);
    handler = (request) => {
      const url = new URL(request.url);
      url.protocol = "http:";
      url.host = `127.0.0.1:${port}`;
      return fetch(new Request(url, request));
    };
  }
  const listener = serve({
    ...tlsOptions,
    fetch: handler,
    port: 0,
    hostname: "127.0.0.1",
  });
  await once(listener, "listening");
  t.onTestFinished(
    () =>
      new Promise<void>((resolve, reject) =>
        listener.close((error) => (error ? reject(error) : resolve())),
      ),
  );
  const address = listener.address();
  if (!address || typeof address === "string") throw new Error("Expected a TCP listener");
  const host = `127.0.0.1:${address.port}`;
  return {
    host,
    buf(
      args: string[],
      { cwd = root, token = mode === "static" ? admin : "", input }: BufOptions = {},
    ) {
      const command = exec("buf", args, {
        cwd,
        timeout: 15000,
        env: {
          ...process.env,
          HOME: root,
          SSL_CERT_FILE: cert,
          NETRC: join(root, ".netrc"),
          BUF_CONFIG_DIR: config,
          BUF_CACHE_DIR: join(root, "cache"),
          BUF_TOKEN: token ? `${token}@${host}` : "",
        },
      });
      if (input !== undefined) command.child.stdin?.end(input);
      return command;
    },
  };
}

export const proto = 'syntax = "proto3"; package example.v1; message Widget {}\n';
