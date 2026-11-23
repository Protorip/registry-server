import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, test, type TestContext } from "vitest";
import { fileURLToPath } from "node:url";
import { proto, reader, startRegistry, writer, type RegistryOptions } from "./helpers.js";

test("the migration tool shows help and applies migrations once", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "registry-migrate-"));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  const tool = fileURLToPath(new URL("../dist/tools/migrate.mjs", import.meta.url));
  const run = (...args: string[]) =>
    execFileSync(process.execPath, [tool, ...args], { cwd: root, encoding: "utf8" });
  expect(run("--help")).toMatch(/Usage: .*migrate\.mjs/);

  const path = join(root, "registry.db");
  run("--db", path);
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    expect(db.prepare("SELECT count(*) AS count FROM modules").get()?.count).toBe(0);
    const history = db.prepare("SELECT * FROM __protorip_registry_migrations ORDER BY id");
    const applied = history.all();
    const journal = JSON.parse(
      await readFile(new URL("../drizzle/meta/_journal.json", import.meta.url), "utf8"),
    );
    const [initial] = journal.entries;
    const sql = await readFile(new URL(`../drizzle/${initial.tag}.sql`, import.meta.url));
    expect(applied.map(({ hash, created_at }) => ({ hash, created_at }))).toStrictEqual([
      { hash: createHash("sha256").update(sql).digest("hex"), created_at: initial.when },
    ]);

    run("--db", path);
    expect(history.all()).toStrictEqual(applied);
  } finally {
    db.close();
  }
});

test("a workspace push publishes sibling dependencies for remote builds", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "registry-multi-push-"));
  const { host, buf } = await startRegistry(t, root, "embedded Node", "none", "fs");
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  const base = `${host}/example/base`;
  const dependent = `${host}/example/dependent`;
  for (const module of [base, dependent]) await buf(["registry", "module", "create", module]);
  await mkdir(join(root, "base"));
  await mkdir(join(root, "dependent"));
  await writeFile(
    join(root, "buf.yaml"),
    `version: v2\nmodules:\n  - path: dependent\n    name: ${dependent}\n  - path: base\n    name: ${base}\n`,
  );
  await writeFile(join(root, "base", "widget.proto"), proto);
  await writeFile(
    join(root, "dependent", "consumer.proto"),
    'syntax = "proto3"; package consumer.v1; import "widget.proto"; message Consumer { example.v1.Widget widget = 1; }',
  );
  await buf(["push"]);
  await buf(["build", dependent]);
});

test("static auth restricts cross-owner writes, administration, and public modules", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "registry-static-policy-"));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  const { host, buf } = await startRegistry(t, root, "Bun server", "static", "fs", {
    allowPublicModules: false,
  });
  const module = `${host}/other/widgets`;
  const command = (args: string[], token?: string) =>
    buf(["registry", "module", ...args], { token });

  await expect(command(["create", module, "--visibility", "public"])).rejects.toThrow(
    /permission_denied/,
  );
  await command(["create", module, "--visibility", "private"]);
  await writeFile(
    join(root, "buf.yaml"),
    `version: v2\nmodules:\n  - path: .\n    name: ${module}\n`,
  );
  await writeFile(join(root, "widget.proto"), proto);
  await expect(buf(["push"], { token: writer })).rejects.toThrow(/permission_denied/);
  await buf(["push"]);
  await expect(buf(["build", module], { token: "" })).rejects.toThrow(
    /unauthenticated|authenticate|login/i,
  );

  // Use the writer's own scope to isolate role checks from the owner restriction.
  const inScope = `${host}/example/widgets`;
  await command(["create", inScope]);
  const database = new DatabaseSync(join(root, "registry.db"), { readOnly: true });
  try {
    const row = database
      .prepare(
        "SELECT visibility FROM modules JOIN scopes ON modules.scope_id = scopes.id WHERE scopes.slug = ? AND modules.name = ?",
      )
      .get("example", "widgets");
    expect(row?.visibility).toBe(2);
  } finally {
    database.close();
  }
  for (const token of [writer, reader]) {
    await expect(command(["deprecate", inScope], token)).rejects.toThrow(/permission_denied/);
    await expect(command(["delete", inScope, "--force"], token)).rejects.toThrow(
      /permission_denied/,
    );
  }
  await expect(command(["delete", `${host}/example/missing`, "--force"])).rejects.toThrow(
    /not_found|not found|does not exist/i,
  );
});

async function cliRegistry(t: TestContext, options?: RegistryOptions) {
  const root = await mkdtemp(join(tmpdir(), "registry-cli-"));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  const { host, buf } = await startRegistry(t, root, "embedded Node", "static", "fs", options);
  const moduleCommand = (...args: string[]) => buf(["registry", "module", ...args]);
  const moduleJson = async (...args: string[]) =>
    JSON.parse((await moduleCommand(...args, "--format", "json")).stdout);

  async function workspace(name: string, files: Record<string, string>) {
    const cwd = join(root, name);
    await mkdir(cwd, { recursive: true });
    for (const [path, content] of Object.entries(files)) {
      await writeFile(join(cwd, path), content);
    }
    return cwd;
  }

  async function widgets() {
    const module = `${host}/example/widgets`;
    await moduleCommand("create", module, "--visibility", "private");
    const cwd = await workspace("widgets", {
      "buf.yaml": `version: v2\nmodules:\n  - path: .\n    name: ${module}\n`,
    });
    return {
      module,
      cwd,
      write: (content: string) => writeFile(join(cwd, "widget.proto"), content),
      async push(...args: string[]) {
        const { stdout } = await buf(["push", ...args], { cwd });
        expect(stdout.trim()).toMatch(/:[0-9a-f]{32}$/);
        return stdout.trim().split(":").at(-1)!;
      },
    };
  }

  return { root, host, buf, moduleCommand, moduleJson, workspace, widgets };
}

test("Buf login persists a validated token for later commands", async (t) => {
  const { host, buf } = await cliRegistry(t);
  const login = (token: string) =>
    buf(["registry", "login", host, "--token-stdin"], { token: "", input: `${token}\n` });
  const whoami = () => buf(["registry", "whoami", host], { token: "" });

  await expect(login("invalid-token")).rejects.toThrow(/invalid|unauthenticated|authenticate/i);
  await expect(whoami()).rejects.toThrow(/logged in/i);
  await login(reader);
  expect((await whoami()).stdout).toMatch(/\breader\b/);
});

test("Buf reaches the registry over plain HTTP with the documented TLS setting", async (t) => {
  const { host, buf, widgets } = await cliRegistry(t, { plainHttp: true });
  expect((await buf(["registry", "whoami", host])).stdout).toMatch(/\boperator\b/);
  const source = await widgets();
  await source.write(proto);
  await source.push();
  await buf(["build", source.module]);
});

test("Buf exports a pinned schema and checks local changes against it", async (t) => {
  const { root, buf, widgets } = await cliRegistry(t);
  const source = await widgets();
  const published = proto.replace("{}", "{ string id = 1; }");
  await source.write(published);
  const first = await source.push();
  const additive = published.replace("id = 1;", "id = 1; string name = 2;");
  await source.write(additive);
  await source.push();

  const baseline = `${source.module}:${first}`;
  const output = join(root, "exported");
  await buf(["export", baseline, "--output", output]);
  expect(await readFile(join(output, "widget.proto"), "utf8")).toBe(published);

  const breaking = () => buf(["breaking", "--against", baseline], { cwd: source.cwd });
  await breaking();
  await source.write(proto);
  await expect(breaking()).rejects.toMatchObject({
    code: 100,
    stdout: expect.stringMatching(
      /Previously present field "1" with name "id" on message "Widget" was deleted/i,
    ),
  });
});

test("Buf module update changes anonymous visibility and the default push label", async (t) => {
  const { buf, widgets, moduleCommand, moduleJson } = await cliRegistry(t);
  const source = await widgets();
  await source.write(proto);
  const first = await source.push();
  const secondSchema = proto.replace("{}", "{ string id = 1; }");
  await source.write(secondSchema);
  await source.push("--label", "release");

  const anonymousInfo = () => buf(["registry", "module", "info", source.module], { token: "" });
  await expect(anonymousInfo()).rejects.toThrow(/unauthenticated|authenticate|login/i);
  await moduleCommand(
    "update",
    source.module,
    "--visibility",
    "public",
    "--default-label-name",
    "release",
  );
  await anonymousInfo();

  await source.write(secondSchema.replace("id = 1;", "id = 1; string name = 2;"));
  const latest = await source.push();
  expect((await moduleJson("label", "info", `${source.module}:release`)).commit).toBe(latest);
  expect((await moduleJson("label", "info", `${source.module}:main`)).commit).toBe(first);
  expect((await moduleJson("commit", "resolve", source.module)).commit).toBe(latest);
});

test("Buf push rejects new content on a deprecated module until it is reactivated", async (t) => {
  const { widgets, moduleCommand, moduleJson } = await cliRegistry(t);
  const source = await widgets();
  await source.write(proto);
  const first = await source.push();
  await moduleCommand("deprecate", source.module);
  await source.write(proto.replace("{}", "{ string id = 1; }"));
  await expect(source.push()).rejects.toThrow(/module is deprecated/i);
  expect((await moduleJson("commit", "resolve", source.module)).commit).toBe(first);
  await moduleCommand("undeprecate", source.module);
  expect(await source.push()).not.toBe(first);
});

test("Buf label listing paginates only labels pointing to the requested commit", async (t) => {
  const { widgets, moduleJson } = await cliRegistry(t);
  const source = await widgets();
  await source.write(proto);
  await source.push();
  await source.write(proto.replace("{}", "{ string id = 1; }"));
  const release = await source.push("--label", "release", "--label", "stable");

  const list = async (
    ...args: string[]
  ): Promise<{
    labels: Array<{ name: string; commit: string }>;
    next_page: string;
  }> => moduleJson("label", "list", `${source.module}:${release}`, "--page-size", "1", ...args);
  const first = await list();
  expect(first.labels.length).toBe(1);
  expect(first.next_page).toBeTruthy();
  const last = await list("--page-token", first.next_page);
  expect(last.labels.length).toBe(1);
  expect(last.next_page).toBeFalsy();
  const labels = [...first.labels, ...last.labels];
  expect(labels.map(({ name }) => name).sort()).toStrictEqual(["release", "stable"]);
  expect(labels.every(({ commit }) => commit === release)).toBeTruthy();
});

test("Buf keeps a locked dependency as main advances and upgrades it on dep update", async (t) => {
  const { root, buf, workspace, widgets } = await cliRegistry(t);
  const source = await widgets();
  await source.write(proto.replace("{}", "{ string original = 1; }"));
  const first = await source.push();
  const cwd = await workspace("consumer", {
    "buf.yaml": `version: v2\ndeps:\n  - ${source.module}\n`,
    "consumer.proto":
      'syntax = "proto3"; import "widget.proto"; message Consumer { example.v1.Widget widget = 1; }\n',
  });
  const update = () => buf(["dep", "update"], { cwd });
  const lock = () => readFile(join(cwd, "buf.lock"), "utf8");
  await update();
  const originalLock = await lock();
  expect(originalLock).toMatch(new RegExp(`commit: ${first}\\b`));

  await source.write(proto.replace("{}", "{ string updated = 2; }"));
  const latest = await source.push("--label", "main", "--label", "release");
  // Force a fresh registry download for the previously locked commit.
  await rm(join(root, "cache"), { recursive: true, force: true });
  const pinned = join(root, "pinned");
  await buf(["export", ".", "--output", pinned], { cwd });
  expect(await readFile(join(pinned, "widget.proto"), "utf8")).toMatch(/string original = 1/);
  expect(await lock()).toBe(originalLock);

  await update();
  expect(await lock()).toMatch(new RegExp(`commit: ${latest}\\b`));
  const upgraded = join(root, "upgraded");
  await buf(["export", ".", "--output", upgraded], { cwd });
  expect(await readFile(join(upgraded, "widget.proto"), "utf8")).toMatch(/string updated = 2/);
});

test("Buf dep update locks a shared transitive dependency once in a diamond", async (t) => {
  const { host, buf, widgets, workspace, moduleCommand } = await cliRegistry(t);
  const base = await widgets();
  await base.write(proto);
  const baseCommit = await base.push();

  const parents = await Promise.all(
    ["left", "right"].map(async (name) => {
      const module = `${host}/example/${name}`;
      await moduleCommand("create", module);
      const cwd = await workspace(name, {
        "buf.yaml": `version: v2\nmodules:\n  - path: .\n    name: ${module}\ndeps:\n  - ${base.module}\n`,
        [`${name}.proto`]: `syntax = "proto3"; package ${name}.v1; import "widget.proto"; message Wrapper { example.v1.Widget widget = 1; }\n`,
      });
      await buf(["dep", "update"], { cwd });
      await buf(["push"], { cwd });
      return module;
    }),
  );
  const cwd = await workspace("diamond", {
    "buf.yaml": `version: v2\ndeps:\n  - ${parents.join("\n  - ")}\n`,
    "diamond.proto":
      'syntax = "proto3"; import "left.proto"; import "right.proto"; message Diamond { left.v1.Wrapper left = 1; right.v1.Wrapper right = 2; }\n',
  });
  await buf(["dep", "update"], { cwd });
  const lock = await readFile(join(cwd, "buf.lock"), "utf8");
  const names = [...lock.matchAll(/^  - name: (.+)$/gm)].map((match) => match[1]);
  expect(names.sort()).toStrictEqual([...parents, base.module].sort());
  expect(lock.includes(`name: ${base.module}\n    commit: ${baseCommit}\n`), lock).toBeTruthy();
  await buf(["build"], { cwd });
});
