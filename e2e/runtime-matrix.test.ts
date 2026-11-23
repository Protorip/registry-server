import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { expect, test } from "vitest";
import { promisify } from "node:util";
import { proto, reader, serverEntrypoint, startRegistry, writer } from "./helpers.js";

const exec = promisify(execFile);
const tokensTool = new URL("../dist/tools/tokens.mjs", import.meta.url).pathname;

for (const entry of [
  "embedded Node",
  "embedded Bun",
  "Bun server",
  ...(process.env.REGISTRY_TEST_IMAGE ? (["docker"] as const) : []),
] as const) {
  for (const mode of ["none", "static"] as const) {
    for (const backend of ["fs", "s3"] as const) {
      test(
        `Buf CLI conformance through ${entry}, ${mode} auth, ${backend} blobs`,
        { timeout: 60000 },
        async (t) => {
          const root = await mkdtemp(join(tmpdir(), "registry-conformance-"));
          t.onTestFinished(() => rm(root, { recursive: true, force: true }));
          const { host, buf } = await startRegistry(t, root, entry, mode, backend);
          const module = `${host}/example/widgets`;
          const dependent = `${host}/example/uses-widgets`;
          const command = (...args: string[]) => buf(["registry", "module", ...args]);
          const who = await buf(["registry", "whoami", host]);
          expect(who.stdout).toMatch(mode === "static" ? /operator/ : /anonymous/);

          if (mode === "static") {
            await expect(buf(["registry", "whoami", host], { token: "bad" })).rejects.toThrow(
              /logged in/i,
            );
            await expect(
              buf(["registry", "module", "create", module], { token: writer }),
            ).rejects.toThrow(/permission_denied/);
          }
          await command("create", module);
          const source = join(root, "source");
          await mkdir(source);
          await writeFile(
            join(source, "buf.yaml"),
            `version: v2\nmodules:\n  - path: .\n    name: ${module}\n`,
          );
          await writeFile(join(source, "widget.proto"), proto);
          const push = (labels: string[] = [], token?: string) =>
            buf(["push", ...labels], { cwd: source, token });
          await writeFile(join(source, "LICENSE"), Buffer.from("89504e470d0a1a0a", "hex"));
          await expect(push()).rejects.toThrow(/LICENSE.*PNG/);
          await rm(join(source, "LICENSE"));
          if (mode === "static")
            await expect(push([], reader)).rejects.toThrow(/permission_denied/);
          const first = (await push()).stdout.trim().split(":").at(-1);
          expect(first).toMatch(/^[0-9a-f]{32}$/);
          const retry = (await push()).stdout.trim().split(":").at(-1);
          expect(retry).toBe(first);
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
          expect(second).not.toBe(first);
          await buf(["build", module]);
          const commits = JSON.parse(
            (await command("commit", "list", module, "--format", "json")).stdout,
          );
          expect(commits.commits.map((item: { commit: string }) => item.commit)).toStrictEqual([
            second,
            first,
          ]);
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
          expect(reversed.commits.map((item: { commit: string }) => item.commit)).toStrictEqual([
            first,
          ]);
          const resolved = JSON.parse(
            (await command("commit", "resolve", `${module}:release`, "--format", "json")).stdout,
          );
          expect(resolved.commit).toBe(second);
          const info = async (...args: string[]) =>
            JSON.parse((await command(...args, "--format", "json")).stdout);
          expect((await info("commit", "info", `${module}:${first}`)).commit).toBe(first);
          await expect(command("commit", "info", `${module}:${"f".repeat(32)}`)).rejects.toThrow(
            /not_found|not found|does not exist/i,
          );
          for (const name of ["main", "release"]) {
            const label = await info("label", "info", `${module}:${name}`);
            expect(label.name).toBe(name);
            expect(label.commit).toBe(second);
          }
          await expect(command("label", "info", `${module}:missing`)).rejects.toThrow(
            /not_found|not found|does not exist/i,
          );
          await expect(command("label", "archive", `${module}:main`)).rejects.toThrow(
            /cannot archive the default label/i,
          );
          await command("label", "archive", `${module}:release`);
          const list = async (...args: string[]) =>
            JSON.parse(
              (await command("label", "list", module, "--format", "json", ...args)).stdout,
            );
          expect((await list()).labels.map((label: { name: string }) => label.name)).toStrictEqual([
            "main",
          ]);
          expect((await list("--archive-status", "all")).labels.length).toBe(2);
          await command("label", "unarchive", `${module}:release`);
          expect((await list()).labels.length).toBe(2);
          await command("label", "archive", `${module}:release`);
          await push(["--label", "release"]);
          expect((await list()).labels.length).toBe(2);

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
          expect(await readFile(join(consumer, "buf.lock"), "utf8")).toMatch(
            new RegExp(`commit: ${second}\\s+digest: b5:[0-9a-f]{128}`),
          );
          await buf(["build"], { cwd: consumer });
          const consumerPush = await buf(["push"], { cwd: consumer });
          const dependentCommit = consumerPush.stdout.trim().split(":").at(-1);
          const graph = await buf(["dep", "graph", `${dependent}:${dependentCommit}`]);
          expect(
            graph.stdout.includes(`"${dependent}:${dependentCommit}" -> "${module}:${second}"`),
            graph.stdout,
          ).toBeTruthy();
          await buf(["build", dependent]);
          if (mode === "static") {
            await expect(buf(["build", module], { token: "" })).rejects.toThrow(
              /unauthenticated|authenticate|login/i,
            );
            await buf(["registry", "module", "info", dependent], { token: "" });
          }
          await expect(command("delete", module, "--force")).rejects.toThrow(
            /referenced by another module/,
          );
          await command("deprecate", module);
          const deprecated = await command("info", module, "--format", "json");
          expect(deprecated.stdout).toMatch(/deprecated/i);
          await command("undeprecate", module);
          await command("delete", dependent, "--force");
          await command("delete", module, "--force");
          await expect(command("info", module)).rejects.toThrow(/does not exist/i);
        },
      );
    }
  }
}

test("Server defaults to static auth and generated credentials match their hash", async () => {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    TOKENS: "",
    TOKENS_FILE: "",
    DB_PATH: ":memory:",
  };
  delete env.AUTH_MODE;
  await expect(exec(process.execPath, [serverEntrypoint], { env, timeout: 5000 })).rejects.toThrow(
    /startup_failed/,
  );
  const { stdout } = await exec(process.execPath, [tokensTool, "--name", "bot", "--role", "read"]);
  const [token, entry] = stdout.trim().split("\n");
  const { createHash } = await import("node:crypto");
  expect(token).toMatch(/^psr_[A-Za-z0-9_-]+$/);
  expect(entry).toBe(`bot:sha256:${createHash("sha256").update(token).digest("hex")}:read`);
});

test("Token utility exposes help and rejects server startup arguments", async () => {
  await expect(exec(process.execPath, [tokensTool, "serve"], { timeout: 5000 })).rejects.toThrow(
    /Usage: node tokens\.mjs --name/,
  );
  for (const flag of ["--help", "-h"]) {
    const { stdout, stderr } = await exec(process.execPath, [tokensTool, flag]);
    expect(stdout).toMatch(/tokens\.mjs --name/);
    expect(stderr).toBe("");
  }
});

test("Node server reports an unreadable token file and invalid port", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "registry-missing-tokens-"));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  const env = {
    ...process.env,
    AUTH_MODE: "static",
    TOKENS: "",
    TOKENS_FILE: join(root, "missing"),
    PORT: "0",
    DB_PATH: ":memory:",
  };
  await expect(exec(process.execPath, [serverEntrypoint], { env, timeout: 5000 })).rejects.toThrow(
    /TOKENS_FILE.*file not found/i,
  );
  await expect(
    exec(process.execPath, [serverEntrypoint], {
      env: { ...env, PORT: "invalid" },
      timeout: 5000,
    }),
  ).rejects.toThrow(/Invalid PORT/);
});

test(
  "Node server serves on 8080 and allows module creation with blank settings",
  { timeout: 15000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "registry-node-server-"));
    t.onTestFinished(() => rm(root, { recursive: true, force: true }));
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
    t.onTestFinished(async () => {
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
    expect(event.event).toBe("listening");
    expect(event.port).toBe(8080);
    const url = `http://127.0.0.1:${event.port}`;
    expect((await fetch(`${url}/healthz`)).status).toBe(200);
    const response = await fetch(`${url}/buf.registry.module.v1.ModuleService/CreateModules`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ values: [{ ownerRef: { name: "example" }, name: "widgets" }] }),
    });
    expect(response.status, await response.text()).toBe(200);
  },
);
