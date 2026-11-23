import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:https";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import S3rver from "s3rver";
import { serve } from "@hono/node-server";
import { createRegistryHandler } from "@protorip/registry-server";
import { sqlite } from "@protorip/registry-server/node";

const exec = promisify(execFile);
const admin = "psr_test-admin-secret";
export const reader = "psr_test-reader-secret";
export const writer = "psr_test-writer-secret";
export const serverEntrypoint = new URL("../dist/server.js", import.meta.url).pathname;
const embeddedBun = new URL("./embedded-bun.mjs", import.meta.url).pathname;
const bun = process.env.BUN_EXECUTABLE ?? "bun";

export async function startRegistry(
  t,
  root,
  entry,
  mode,
  backend,
  { allowPublicModules = true, plainHttp = false } = {},
) {
  const dbPath = join(root, "registry.db");
  const rootDir = join(root, "blobs");
  const tokens = [
    { name: "operator", plain: admin },
    { name: "reader", plain: reader, role: "read" },
    { name: "writer", plain: writer, role: "write", scopes: ["example"] },
  ];
  const bucket = "registry";
  let storage = { type: "fs", rootDir };
  if (backend === "s3") {
    const emulator = new S3rver({
      address: "127.0.0.1",
      port: 0,
      silent: true,
      directory: join(root, "s3"),
      configureBuckets: [{ name: bucket }],
    });
    const { port } = await emulator.run();
    t.after(() => emulator.close());
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
  let tlsOptions = {};
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
  let handler;
  if (entry === "embedded Node") {
    const registry = createRegistryHandler({
      database: sqlite(dbPath),
      storage,
      auth: mode === "none" ? { mode } : { mode, tokens, allowPublicModules },
      logger() {},
    });
    t.after(() => registry.close());
    handler = registry.fetch;
  } else {
    const env = {
      ...process.env,
      PORT: "0",
      DB_PATH: dbPath,
      FS_ROOT: rootDir,
      STORAGE_BACKEND: backend,
      S3_BUCKET: bucket,
      S3_ENDPOINT: storage.endpoint,
      S3_PREFIX: "conformance",
      S3_REGION: storage.region,
      S3_FORCE_PATH_STYLE: "true",
      S3_ACCESS_KEY_ID: storage.accessKeyId,
      S3_SECRET_ACCESS_KEY: storage.secretAccessKey,
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
    const args = docker
      ? [
          "run",
          "--rm",
          "--network",
          "host",
          "--user",
          `${process.getuid()}:${process.getgid()}`,
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
          process.env.REGISTRY_TEST_IMAGE,
        ]
      : entry === "embedded Bun"
        ? [embeddedBun]
        : [serverEntrypoint];
    const child = spawn(docker ? "docker" : bun, args, {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const exited = once(child, "exit");
    t.after(async () => {
      child.kill();
      await exited;
    });
    let errors = "";
    child.stderr.on("data", (chunk) => {
      errors += chunk;
    });
    const lines = createInterface({ input: child.stdout });
    const port = await Promise.race([
      new Promise((resolve) =>
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
  t.after(() => new Promise((resolve) => listener.close(resolve)));
  const host = `127.0.0.1:${listener.address().port}`;
  return {
    host,
    buf(args, { cwd = root, token = mode === "static" ? admin : "", input } = {}) {
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
      if (input !== undefined) command.child.stdin.end(input);
      return command;
    },
  };
}

export const proto = 'syntax = "proto3"; package example.v1; message Widget {}\n';
