import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { promisify } from "node:util";
import { proto, reader, serverEntrypoint, startRegistry, writer } from "./helpers.mjs";

const exec = promisify(execFile);
const tokensTool = new URL("../dist/tools/tokens.mjs", import.meta.url).pathname;

for (const entry of [
  "embedded Node",
  "embedded Bun",
  "Bun server",
  ...(process.env.REGISTRY_TEST_IMAGE ? ["docker"] : []),
]) {
  for (const mode of ["none", "static"]) {
    for (const backend of ["fs", "s3"]) {
      test(
        `Buf CLI conformance through ${entry}, ${mode} auth, ${backend} blobs`,
        { timeout: 60000 },
        async (t) => {
          const root = await mkdtemp(join(tmpdir(), "registry-conformance-"));
          const { host, buf } = await startRegistry(t, root, entry, mode, backend);
          t.after(() => rm(root, { recursive: true, force: true }));
          const module = `${host}/example/widgets`;
          const dependent = `${host}/example/uses-widgets`;
          const command = (...args) => buf(["registry", "module", ...args]);
          const who = await buf(["registry", "whoami", host]);
          assert.match(who.stdout, mode === "static" ? /operator/ : /anonymous/);

          if (mode === "static") {
            await assert.rejects(buf(["registry", "whoami", host], { token: "bad" }), /logged in/i);
            await assert.rejects(
              buf(["registry", "module", "create", module], { token: writer }),
              /permission_denied/,
            );
          }
          await command("create", module);
          const source = join(root, "source");
          await mkdir(source);
          await writeFile(
            join(source, "buf.yaml"),
            `version: v2\nmodules:\n  - path: .\n    name: ${module}\n`,
          );
          await writeFile(join(source, "widget.proto"), proto);
          const push = (labels = [], token) => buf(["push", ...labels], { cwd: source, token });
          await writeFile(join(source, "LICENSE"), Buffer.from("89504e470d0a1a0a", "hex"));
          await assert.rejects(push(), /LICENSE.*PNG/);
          await rm(join(source, "LICENSE"));
          if (mode === "static") await assert.rejects(push([], reader), /permission_denied/);
          const first = (await push()).stdout.trim().split(":").at(-1);
          assert.match(first, /^[0-9a-f]{32}$/);
          const retry = (await push()).stdout.trim().split(":").at(-1);
          assert.equal(retry, first);
          await writeFile(join(source, "widget.proto"), proto.replace("{}", "{ string id = 1; }"));
          const second = (
            await push(
              ["--label", "main", "--label", "release"],
              mode === "static" ? writer : undefined,
            )
          ).stdout
            .trim()
            .split(":")
            .at(-1);
          assert.notEqual(second, first);
          await buf(["build", module]);
          const commits = JSON.parse(
            (await command("commit", "list", module, "--format", "json")).stdout,
          );
          assert.deepEqual(
            commits.commits.map((item) => item.commit),
            [second, first],
          );
          const reversed = JSON.parse(
            (
              await command(
                "commit",
                "list",
                module,
                "--reverse",
                "--page-size",
                "1",
                "--format",
                "json",
              )
            ).stdout,
          );
          assert.deepEqual(
            reversed.commits.map((item) => item.commit),
            [first],
          );
          const resolved = JSON.parse(
            (await command("commit", "resolve", `${module}:release`, "--format", "json")).stdout,
          );
          assert.equal(resolved.commit, second);
          const info = async (...args) =>
            JSON.parse((await command(...args, "--format", "json")).stdout);
          assert.equal((await info("commit", "info", `${module}:${first}`)).commit, first);
          await assert.rejects(
            command("commit", "info", `${module}:${"f".repeat(32)}`),
            /not_found|not found|does not exist/i,
          );
          for (const name of ["main", "release"]) {
            const label = await info("label", "info", `${module}:${name}`);
            assert.equal(label.name, name);
            assert.equal(label.commit, second);
          }
          await assert.rejects(
            command("label", "info", `${module}:missing`),
            /not_found|not found|does not exist/i,
          );
          await assert.rejects(
            command("label", "archive", `${module}:main`),
            /cannot archive the default label/i,
          );
          await command("label", "archive", `${module}:release`);
          const list = async (...args) =>
            JSON.parse(
              (await command("label", "list", module, "--format", "json", ...args)).stdout,
            );
          assert.deepEqual(
            (await list()).labels.map((label) => label.name),
            ["main"],
          );
          assert.equal((await list("--archive-status", "all")).labels.length, 2);
          await command("label", "unarchive", `${module}:release`);
          assert.equal((await list()).labels.length, 2);
          await command("label", "archive", `${module}:release`);
          await push(["--label", "release"]);
          assert.equal((await list()).labels.length, 2);

          const consumer = join(root, "consumer");
          await mkdir(consumer);
          await command("create", dependent, "--visibility", "public");
          await writeFile(
            join(consumer, "buf.yaml"),
            `version: v2\nmodules:\n  - path: .\n    name: ${dependent}\ndeps:\n  - ${module}\n`,
          );
          await writeFile(
            join(consumer, "consumer.proto"),
            'syntax = "proto3"; package consumer.v1; import "widget.proto"; message Consumer { example.v1.Widget widget = 1; }',
          );
          await buf(["dep", "update"], { cwd: consumer });
          assert.match(
            await readFile(join(consumer, "buf.lock"), "utf8"),
            new RegExp(`commit: ${second}\\s+digest: b5:[0-9a-f]{128}`),
          );
          await buf(["build"], { cwd: consumer });
          const consumerPush = await buf(["push"], { cwd: consumer });
          const dependentCommit = consumerPush.stdout.trim().split(":").at(-1);
          const graph = await buf(["dep", "graph", `${dependent}:${dependentCommit}`]);
          assert.ok(
            graph.stdout.includes(`"${dependent}:${dependentCommit}" -> "${module}:${second}"`),
            graph.stdout,
          );
          await buf(["build", dependent]);
          if (mode === "static") {
            await assert.rejects(
              buf(["build", module], { token: "" }),
              /unauthenticated|authenticate|login/i,
            );
            await buf(["registry", "module", "info", dependent], { token: "" });
          }
          await assert.rejects(
            command("delete", module, "--force"),
            /referenced by another module/,
          );
          await command("deprecate", module);
          const deprecated = await command("info", module, "--format", "json");
          assert.match(deprecated.stdout, /deprecated/i);
          await command("undeprecate", module);
          await command("delete", dependent, "--force");
          await command("delete", module, "--force");
          await assert.rejects(command("info", module), /does not exist/i);
        },
      );
    }
  }
}

test("Server defaults to static auth and generated credentials match their hash", async () => {
  const env = { ...process.env, TOKENS: "", TOKENS_FILE: "", DB_PATH: ":memory:" };
  delete env.AUTH_MODE;
  await assert.rejects(
    exec(process.execPath, [serverEntrypoint], { env, timeout: 5000 }),
    /startup_failed/,
  );
  const { stdout } = await exec(process.execPath, [tokensTool, "--name", "bot", "--role", "read"]);
  const [token, entry] = stdout.trim().split("\n");
  const { createHash } = await import("node:crypto");
  assert.match(token, /^psr_[A-Za-z0-9_-]+$/);
  assert.equal(entry, `bot:sha256:${createHash("sha256").update(token).digest("hex")}:read`);
});

test("Token utility exposes help and rejects server startup arguments", async () => {
  await assert.rejects(
    exec(process.execPath, [tokensTool, "serve"], { timeout: 5000 }),
    /Usage: node tokens\.mjs --name/,
  );
  for (const flag of ["--help", "-h"]) {
    const { stdout, stderr } = await exec(process.execPath, [tokensTool, flag]);
    assert.match(stdout, /tokens\.mjs --name/);
    assert.equal(stderr, "");
  }
});

test("Node server reports an unreadable token file and invalid port", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "registry-missing-tokens-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = {
    ...process.env,
    AUTH_MODE: "static",
    TOKENS: "",
    TOKENS_FILE: join(root, "missing"),
    PORT: "0",
    DB_PATH: ":memory:",
  };
  await assert.rejects(
    exec(process.execPath, [serverEntrypoint], { env, timeout: 5000 }),
    /TOKENS_FILE.*file not found/i,
  );
  await assert.rejects(
    exec(process.execPath, [serverEntrypoint], {
      env: { ...env, PORT: "invalid" },
      timeout: 5000,
    }),
    /Invalid PORT/,
  );
});

test(
  "Node server serves on 8080 and allows module creation with blank settings",
  { timeout: 15000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "registry-node-server-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const child = spawn(process.execPath, [serverEntrypoint], {
      env: {
        ...process.env,
        AUTH_MODE: "none",
        STORAGE_BACKEND: "fs",
        LOG_LEVEL: "info",
        PORT: "",
        ALLOWED_SCOPES: "",
        DB_PATH: ":memory:",
        FS_ROOT: root,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const exited = once(child, "exit");
    t.after(async () => {
      child.kill();
      await exited;
    });
    let stderr = "";
    child.stderr.setEncoding("utf8").on("data", (chunk) => {
      stderr += chunk;
    });
    const lines = createInterface({ input: child.stdout });
    const event = await Promise.race([
      once(lines, "line").then(([line]) => JSON.parse(line)),
      exited.then(() => {
        throw new Error(stderr);
      }),
    ]);
    assert.equal(event.event, "listening");
    assert.equal(event.port, 8080);
    const url = `http://127.0.0.1:${event.port}`;
    assert.equal((await fetch(`${url}/healthz`)).status, 200);
    const response = await fetch(`${url}/buf.registry.module.v1.ModuleService/CreateModules`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ values: [{ ownerRef: { name: "example" }, name: "widgets" }] }),
    });
    assert.equal(response.status, 200, await response.text());
  },
);
