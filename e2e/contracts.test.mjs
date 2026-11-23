import assert from "node:assert/strict";
import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ConfigurationError, createRegistryHandler } from "@protorip/registry-server";
import { sqlite } from "@protorip/registry-server/node";
import { createAuth, hashToken } from "../dist/auth.js";
import { page } from "../dist/db.js";
import {
  FailedPreconditionError,
  InvalidArgumentError,
  NotFoundError,
  UnauthenticatedError,
} from "../dist/errors.js";
import { commitDependencies, commits, modules, scopes } from "../dist/schema.js";
import { createCommits } from "../dist/services/commits.js";
import { assignLabel, createLabels } from "../dist/services/labels.js";
import { createModules } from "../dist/services/modules.js";
import { validateFiles } from "../dist/upload-validation.js";

test("static auth requires the psr prefix even for a configured hash", () => {
  const tokens = ["psr_current-token", "unprefixed-token"].map((secret, index) => ({
    name: `token-${index}`,
    hash: `sha256:${hashToken(secret).toString("hex")}`,
  }));
  const auth = createAuth({ mode: "static", tokens }, () => {});
  assert.equal(auth.authenticate("Bearer psr_current-token").name, "token-0");
  assert.throws(() => auth.authenticate("Bearer unprefixed-token"), UnauthenticatedError);
});

test("static auth preserves safe startup configuration errors", () => {
  for (const [config, message] of [
    [{ tokens: [] }, "AUTH_MODE=static requires tokens"],
    [
      {
        tokens: [
          { name: "one", plain: "psr_test-secret" },
          { name: "two", plain: "psr_test-secret" },
        ],
      },
      "Duplicate token credentials",
    ],
  ]) {
    assert.throws(
      () => createAuth({ mode: "static", ...config }, () => {}),
      (error) => error instanceof ConfigurationError && error.message === message,
    );
  }
});

test("the token file reloads on SIGHUP and mtime changes and retains the last valid tokens", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "registry-token-reload-"));
  const tokensFile = join(root, "tokens.json");
  const writeTokens = (...names) =>
    writeFile(
      tokensFile,
      JSON.stringify(names.map((name) => ({ name, plain: `psr_test-${name}` }))),
    );
  await writeTokens("initial");

  t.mock.timers.enable({ apis: ["setInterval"] });
  const events = [];
  const auth = createAuth({ mode: "static", tokensFile }, (_, { event }) => events.push(event));
  t.after(async () => {
    auth.close();
    await rm(root, { recursive: true, force: true });
  });
  const authenticate = (name) => auth.authenticate(`Bearer psr_test-${name}`).name;
  assert.equal(authenticate("initial"), "initial");

  await writeTokens("initial", "signal");
  assert.throws(() => authenticate("signal"), UnauthenticatedError);
  process.emit("SIGHUP");
  assert.equal(authenticate("signal"), "signal");

  await writeTokens("initial", "signal", "poll");
  await utimes(tokensFile, 1000, 1000);
  assert.throws(() => authenticate("poll"), UnauthenticatedError);
  t.mock.timers.tick(1000);
  assert.equal(authenticate("poll"), "poll");

  await writeFile(tokensFile, "[invalid JSON");
  await utimes(tokensFile, 2000, 2000);
  t.mock.timers.tick(1000);
  assert.equal(events.at(-1), "tokens_reload_failed");
  for (const name of ["initial", "signal", "poll"]) assert.equal(authenticate(name), name);
});

test("CreateModules enforces the configured owner allowlist", async (t) => {
  const registry = createRegistryHandler({
    database: sqlite(":memory:"),
    auth: { mode: "none" },
    storage: { type: "fs", rootDir: "." },
    allowedScopes: ["example"],
  });
  t.after(() => registry.close());
  const createModule = (owner) =>
    registry.fetch(
      new Request("http://localhost/buf.registry.module.v1.ModuleService/CreateModules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          values: [
            { ownerRef: { name: owner }, name: "widgets", visibility: "MODULE_VISIBILITY_PRIVATE" },
          ],
        }),
      }),
    );
  const denied = await createModule("other");
  assert.equal(denied.status, 403);
  assert.equal((await denied.json()).code, "permission_denied");
  const allowed = await createModule("example");
  assert.equal(allowed.status, 200, await allowed.text());
});

const file = (path, content) => ({ path, content: Buffer.from(content) });
const proto = file("nested/widget.proto", 'syntax = "proto3"; message Widget {}');
const metadata = ["LICENSE", "buf.md", "README.md", "README.markdown", "buf.yaml", "buf.lock"];

test("uploads accept nested protos and only allowlisted root metadata", () => {
  validateFiles([proto, ...metadata.map((path) => file(path, "text"))]);
  for (const path of ["notes.txt", ...metadata.map((name) => `nested/${name}`)]) {
    assert.throws(
      () => validateFiles([proto, file(path, "text")]),
      {
        constructor: InvalidArgumentError,
        message: /is not allowed/,
      },
      path,
    );
  }
});

test("upload limits apply independently to file bytes, total bytes, and file count", () => {
  const files = [proto, file("LICENSE", "text")];
  const maxFileBytes = proto.content.byteLength;
  const maxCommitBytes = maxFileBytes + files[1].content.byteLength;
  validateFiles(files, { maxFileBytes, maxCommitBytes, maxFilesPerCommit: 2 });
  for (const [limits, message] of [
    [{ maxFileBytes: maxFileBytes - 1 }, /file "nested\/widget.proto".*exceeds max/],
    [{ maxCommitBytes: maxCommitBytes - 1 }, /commit total size.*exceeds max/],
    [{ maxFilesPerCommit: 1 }, /too many files/],
  ]) {
    assert.throws(() => validateFiles(files, limits), {
      constructor: InvalidArgumentError,
      message,
    });
  }
});

test("uploads reject invalid proto encoding and syntax and binary licenses", () => {
  assert.throws(() => validateFiles([file("widget.proto", [0xff])]), {
    constructor: InvalidArgumentError,
    message: /not valid UTF-8/,
  });
  assert.throws(() => validateFiles([file("widget.proto", "message Widget {")]), {
    constructor: InvalidArgumentError,
    message: /invalid \.proto in widget\.proto/,
  });
  validateFiles([proto, file("LICENSE", "MZ Research Foundation\n")]);
  const pe = Buffer.alloc(68);
  pe.write("MZ");
  pe.writeUInt32LE(64, 0x3c);
  pe.write("PE\0\0", 64);
  for (const [format, header] of [
    ["PE (Windows EXE/DLL)", pe.toString("hex")],
    ["PE (Windows EXE/DLL)", "4d5a00010300"],
    ["PNG", "89504e470d0a1a0a"],
    ["PDF", "25504446"],
    ["ZIP", "504b0304"],
  ]) {
    assert.throws(() => validateFiles([proto, file("LICENSE", Buffer.from(header, "hex"))]), {
      constructor: InvalidArgumentError,
      message: new RegExp(`invalid LICENSE: binary format \\(${RegExp.escape(format)}`),
    });
  }
});

const actor = { name: "operator", role: "admin", scopes: ["*"] };

function seedCommits(t, moduleForCommit) {
  const database = sqlite(":memory:");
  t.after(() => database.close());
  const { db } = database;
  const timestamps = { create_time: 1, update_time: 1 };
  db.insert(scopes)
    .values({ id: "owner", name: "example", slug: "example", ...timestamps })
    .run();
  for (const name of new Set(Object.values(moduleForCommit))) {
    db.insert(modules)
      .values({ id: name, scope_id: "owner", name, visibility: 1, ...timestamps })
      .run();
  }
  db.insert(commits)
    .values(
      Object.entries(moduleForCommit).map(([id, module_id]) => ({
        id,
        module_id,
        digest_type: 1,
        digest_value: id,
        create_time: 1,
      })),
    )
    .run();
  return db;
}

test("UpdateModules accepts only nonempty, unarchived default label names", async (t) => {
  const db = seedCommits(t, { a: "widgets" });
  const labels = createLabels(db, false);
  const archived = assignLabel(db, "widgets", "archived", "a", actor.name, 1);
  await labels.archiveLabels([{ case: "id", value: archived.id }], actor);
  assignLabel(db, "widgets", "active", "a", actor.name, 1);

  const service = createModules(db, undefined, [], false, () => {});
  const moduleRef = { case: "id", value: "widgets" };
  const update = (defaultLabelName) =>
    service.updateModules([{ moduleRef, defaultLabelName }], actor);
  for (const name of ["active", "future"]) {
    const [updated] = await update(name);
    assert.equal(updated.default_label_name, name);
  }
  const failures = await Promise.allSettled([update(""), update("archived")]);
  assert.deepEqual(
    failures.map(({ reason }) => reason?.constructor),
    [InvalidArgumentError, FailedPreconditionError],
  );
  assert.equal(failures[1].reason.message, "Cannot set an archived label as the default label");
});

test("a diamond graph returns each commit once and preserves all dependency edges", async (t) => {
  const db = seedCommits(t, { a: "alpha", b: "bravo", c: "charlie", d: "delta" });
  db.insert(commitDependencies)
    .values(
      [
        ["a", "b", "bravo"],
        ["a", "c", "charlie"],
        ["b", "d", "delta"],
        ["c", "d", "delta"],
      ].map(([commit_id, dep_commit_id, dep_module]) => ({
        commit_id,
        dep_commit_id,
        dep_module,
        dep_registry: "localhost",
        dep_owner: "example",
      })),
    )
    .run();

  const graph = await createCommits(db, false).getGraph([{ case: "id", value: "a" }], actor);
  assert.deepEqual(graph.commits.map(({ row }) => row.id).sort(), ["a", "b", "c", "d"]);
  assert.deepEqual(
    graph.edges.map(({ fromCommitId, toCommitId }) => `${fromCommitId}->${toCommitId}`).sort(),
    ["a->b", "a->c", "b->d", "c->d"],
  );
});

test("label history orders assignments, skips archive events, and starts at the requested commit", async (t) => {
  const db = seedCommits(t, { a: "widgets", b: "widgets", c: "widgets", unassigned: "widgets" });
  const labels = createLabels(db, false);
  const label = assignLabel(db, "widgets", "release", "a", actor.name, 1);
  const labelRef = { case: "id", value: label.id };
  await labels.archiveLabels([labelRef], actor);
  await labels.unarchiveLabels([labelRef], actor);
  assignLabel(db, "widgets", "release", "b", actor.name, 2);
  assignLabel(db, "widgets", "release", "c", actor.name, 3);

  const history = async (options) => {
    const result = await labels.listLabelHistory(
      {
        labelRef,
        ascending: true,
        startCommitId: "",
        pageSize: 10,
        pageToken: "",
        filterByCommitChecks: false,
        ...options,
      },
      actor,
    );
    return result.commits.map(({ id }) => id);
  };
  assert.deepEqual(await history(), ["a", "b", "c"]);
  assert.deepEqual(await history({ ascending: false }), ["c", "b", "a"]);
  assert.deepEqual(await history({ startCommitId: "b" }), ["b", "c"]);
  await assert.rejects(history({ startCommitId: "unassigned" }), NotFoundError);
});

test("pagination resumes after the cursor and rejects an unknown token", () => {
  const rows = [{ id: "a" }, { id: "b" }, { id: "c" }];
  const first = page(rows, { pageSize: 2, pageToken: "" });
  assert.deepEqual(first, { values: rows.slice(0, 2), nextPageToken: "b" });
  assert.deepEqual(page(rows, { pageSize: 2, pageToken: first.nextPageToken }), {
    values: rows.slice(2),
    nextPageToken: "",
  });
  assert.throws(() => page(rows, { pageSize: 2, pageToken: "missing" }), InvalidArgumentError);
});
