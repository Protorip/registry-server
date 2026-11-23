import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { drizzleNode } from "@protorip/registry-server/node";
import { createRegistryHandler, migrate } from "@protorip/registry-server";

test("the core serves requests and closes its database adapter once", async () => {
  const client = new DatabaseSync(":memory:");
  try {
    client.exec("PRAGMA foreign_keys = ON");
    const db = drizzleNode(client);
    migrate(db);
    let closeCalls = 0;
    const registry = createRegistryHandler({
      database: {
        db,
        async close() {
          await Promise.resolve();
          closeCalls++;
        },
      },
      auth: { mode: "none" },
      storage: { type: "fs", rootDir: "." },
    });
    try {
      const response = await registry.fetch(
        new Request("http://localhost/buf.registry.module.v1.ModuleService/CreateModules", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            values: [
              {
                ownerRef: { name: "example" },
                name: "widgets",
                visibility: "MODULE_VISIBILITY_PRIVATE",
              },
            ],
          }),
        }),
      );
      assert.equal(response.status, 200, await response.text());
    } finally {
      await Promise.all([registry.close(), registry.close()]);
    }
    assert.equal(closeCalls, 1);
    assert.equal(client.prepare("SELECT name FROM modules").get().name, "widgets");
  } finally {
    client.close();
  }
});

test("resource-scoped lists and filtered downloads honor the full request", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = await mkdtemp(join(tmpdir(), "registry-scoped-rpcs-"));
  const { sqlite } = await import("@protorip/registry-server/node");
  const registry = createRegistryHandler({
    database: sqlite(":memory:"),
    auth: { mode: "none" },
    storage: { type: "fs", rootDir: root },
  });
  async function rpc(service, method, body, status = 200) {
    const response = await registry.fetch(
      new Request(`http://localhost/buf.registry.module.v1.${service}/${method}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
    const result = await response.json();
    assert.equal(response.status, status, JSON.stringify(result));
    return result;
  }
  const moduleRef = { name: { owner: "example", module: "widgets" } };
  try {
    await rpc("ModuleService", "CreateModules", {
      values: [
        { ownerRef: { name: "example" }, name: "widgets", visibility: "MODULE_VISIBILITY_PRIVATE" },
      ],
    });
    const upload = (label, text) =>
      rpc("UploadService", "Upload", {
        contents: [
          {
            moduleRef,
            scopedLabelRefs: [{ name: label }],
            files: [
              { path: "widget.proto", content: Buffer.from(text).toString("base64") },
              { path: "LICENSE", content: Buffer.from("example license").toString("base64") },
            ],
          },
        ],
      });
    const first = await upload("release", 'syntax = "proto3"; message Widget {}');
    await upload("main", 'syntax = "proto3"; message Widget { string name = 1; }');
    const resourceRef = { id: first.commits[0].id };
    const commits = await rpc("CommitService", "ListCommits", { resourceRef });
    assert.deepEqual(
      commits.commits.map((commit) => commit.id),
      [resourceRef.id],
    );
    const labels = await rpc("LabelService", "ListLabels", { resourceRef });
    assert.deepEqual(
      labels.labels.map((label) => label.name),
      ["release"],
    );
    const error = await rpc(
      "DownloadService",
      "Download",
      {
        values: [{ resourceRef, fileTypes: ["FILE_TYPE_PROTO"], paths: ["LICENSE"] }],
      },
      404,
    );
    assert.equal(error.code, "not_found");
  } finally {
    await registry.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("health checks bypass static authentication and report shutdown", async () => {
  const client = new DatabaseSync(":memory:");
  const registry = createRegistryHandler({
    database: { db: drizzleNode(client), close() {} },
    auth: { mode: "static", tokens: [{ name: "operator", plain: "psr_test-secret" }] },
    storage: { type: "fs", rootDir: "." },
  });
  const health = (method = "GET") =>
    registry.fetch(new Request("http://localhost/healthz", { method }));
  try {
    const get = await health();
    assert.equal(get.status, 200);
    assert.equal(get.headers.get("content-type"), "application/json");
    assert.deepEqual(await get.json(), { status: "ok" });
    const head = await health("HEAD");
    assert.equal(head.status, 200);
    assert.equal(await head.text(), "");
    const closing = registry.close();
    assert.equal((await health()).status, 503);
    await closing;
  } finally {
    await registry.close();
    client.close();
  }
});

async function s3Registry(t) {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { default: S3rver } = await import("s3rver");
  const { sqlite } = await import("@protorip/registry-server/node");
  const root = await mkdtemp(join(tmpdir(), "registry-races-"));
  const emulator = new S3rver({
    address: "127.0.0.1",
    port: 0,
    silent: true,
    directory: root,
    configureBuckets: [{ name: "registry" }],
  });
  let pause;
  emulator.middleware.unshift(async (ctx, next) => {
    if (pause?.method === ctx.method && !ctx.query["list-type"]) {
      const { entered, released } = pause;
      pause = undefined;
      entered();
      await released;
    }
    await next();
  });
  const { port } = await emulator.run();
  const registry = createRegistryHandler({
    database: sqlite(":memory:"),
    auth: { mode: "none" },
    storage: {
      type: "s3",
      bucket: "registry",
      endpoint: `http://127.0.0.1:${port}`,
      region: "us-east-1",
      accessKeyId: "S3RVER",
      secretAccessKey: "S3RVER",
      forcePathStyle: true,
    },
    logger() {},
  });
  t.after(async () => {
    await registry.close();
    await emulator.close();
    await rm(root, { recursive: true, force: true });
  });
  async function rpc(service, method, body, status) {
    const response = await registry.fetch(
      new Request(`http://localhost/buf.registry.module.v1.${service}/${method}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
    const result = await response.json();
    if (status !== undefined) assert.equal(response.status, status, JSON.stringify(result));
    return result;
  }
  const moduleRef = { name: { owner: "example", module: "widgets" } };
  await rpc("ModuleService", "CreateModules", {
    values: [
      { ownerRef: { name: "example" }, name: "widgets", visibility: "MODULE_VISIBILITY_PRIVATE" },
    ],
  });
  return {
    rpc,
    moduleRef,
    async storedKeys() {
      const { objects } = await emulator.store.listObjects("registry", {});
      return objects.map(({ key }) => key).sort();
    },
    deleteStoredFile(key) {
      return emulator.store.deleteObject("registry", key);
    },
    upload(message = "Widget") {
      return rpc("UploadService", "Upload", {
        contents: [
          {
            moduleRef,
            files: [
              {
                path: "widget.proto",
                content: Buffer.from(`syntax = "proto3"; message ${message} {}`).toString("base64"),
              },
            ],
          },
        ],
      });
    },
    pauseNext(method) {
      const entered = Promise.withResolvers();
      const released = Promise.withResolvers();
      pause = { method, entered: entered.resolve, released: released.promise };
      return { entered: entered.promise, release: released.resolve };
    },
  };
}

async function beforeRelease(operation) {
  const { setTimeout } = await import("node:timers/promises");
  const timer = new AbortController();
  try {
    return await Promise.race([
      operation,
      setTimeout(5000, undefined, { signal: timer.signal }).then(() => {
        assert.fail("RPC did not finish while another RPC was waiting on storage");
      }),
    ]);
  } finally {
    timer.abort();
  }
}

test("uploads overlap and a duplicate digest can be retried against the winning commit", async (t) => {
  const registry = await s3Registry(t);
  const gate = registry.pauseNext("PUT");
  const first = registry.upload();
  let winner, other;
  try {
    await beforeRelease(gate.entered);
    [winner, other] = await beforeRelease(
      Promise.all([registry.upload(), registry.upload("Other")]),
    );
  } finally {
    gate.release();
  }
  assert.equal((await first).code, "aborted");
  const winnerId = winner.commits[0].id;
  const otherId = other.commits[0].id;
  assert.notEqual(winnerId, otherId);
  assert.equal((await registry.upload()).commits[0].id, winnerId);
  assert.deepEqual(
    await registry.storedKeys(),
    [winnerId, otherId].map((id) => `example/widgets/${id}/files/widget.proto`).sort(),
  );
});

test("a download returns not_found when deletion removes a blob after listing", async (t) => {
  const registry = await s3Registry(t);
  const { commits } = await registry.upload();
  const gate = registry.pauseNext("GET");
  const download = registry.rpc("DownloadService", "Download", {
    values: [{ resourceRef: { id: commits[0].id } }],
  });
  try {
    await beforeRelease(gate.entered);
    const deletion = await beforeRelease(
      registry.rpc("ModuleService", "DeleteModules", { moduleRefs: [registry.moduleRef] }),
    );
    assert.deepEqual(deletion, {});
  } finally {
    gate.release();
  }
  assert.deepEqual(await download, { code: "not_found", message: "Commit not found" });
});

test("a download fails when an existing commit has no stored files", async (t) => {
  const registry = await s3Registry(t);
  const { commits } = await registry.upload();
  const resourceRef = { id: commits[0].id };
  const files = await registry.storedKeys();
  assert.equal(files.length, 1);
  await registry.deleteStoredFile(files[0]);
  assert.deepEqual(await registry.storedKeys(), []);

  const error = await registry.rpc(
    "DownloadService",
    "Download",
    { values: [{ resourceRef }] },
    500,
  );
  assert.equal(error.code, "internal");
});

test("public reads honor module visibility and hide private owners from anonymous callers", async (t) => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { sqlite } = await import("@protorip/registry-server/node");
  const rootDir = await mkdtemp(join(tmpdir(), "registry-public-"));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  const registry = createRegistryHandler({
    database: sqlite(":memory:"),
    storage: { type: "fs", rootDir },
    auth: {
      mode: "static",
      allowPublicModules: true,
      tokens: [
        { name: "admin", plain: "psr_test-admin" },
        { name: "writer", plain: "psr_test-writer", role: "write", scopes: ["private-owner"] },
      ],
    },
    logger() {},
  });
  t.after(() => registry.close());

  async function rpc(method, body, token, code) {
    const response = await registry.fetch(
      new Request(`http://localhost/buf.registry.${method}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(body),
      }),
    );
    const result = await response.json();
    if (code) assert.equal(result.code, code, JSON.stringify(result));
    else assert.equal(response.status, 200, JSON.stringify(result));
    return result;
  }

  const create = "module.v1.ModuleService/CreateModules";
  const list = "module.v1.ModuleService/ListModules";
  const owners = "owner.v1.OwnerService/GetOwners";
  const upload = "module.v1.UploadService/Upload";
  const { modules } = await rpc(
    create,
    {
      values: [
        { ownerRef: { name: "public-owner" }, name: "dependency", visibility: 1 },
        { ownerRef: { name: "private-owner" }, name: "consumer" },
      ],
    },
    "psr_test-admin",
  );
  const [dependency, consumer] = modules;
  assert.equal(consumer.visibility, "MODULE_VISIBILITY_PRIVATE");
  assert.deepEqual(
    (await rpc(list, {})).modules.map(({ id }) => id),
    [dependency.id],
  );
  assert.deepEqual(
    (await rpc(list, { ownerRefs: [{ name: "public-owner" }] }, "psr_test-writer")).modules.map(
      ({ id }) => id,
    ),
    [dependency.id],
  );
  for (const name of ["missing-owner", "private-owner"]) {
    await rpc(owners, { ownerRefs: [{ name }] }, undefined, "unauthenticated");
  }
  await rpc(owners, { ownerRefs: [{ name: "missing-owner" }] }, "psr_test-admin", "not_found");

  const file = (path, text) => ({ path, content: Buffer.from(text).toString("base64") });
  const { commits } = await rpc(
    upload,
    {
      contents: [
        {
          moduleRef: { id: dependency.id },
          files: [file("dependency.proto", 'syntax = "proto3"; message Dependency {}')],
        },
      ],
    },
    "psr_test-admin",
  );
  await rpc(
    upload,
    {
      depCommitIds: [commits[0].id],
      contents: [
        {
          moduleRef: { id: consumer.id },
          files: [
            file(
              "consumer.proto",
              'syntax = "proto3"; import "dependency.proto"; message Consumer { Dependency value = 1; }',
            ),
          ],
        },
      ],
    },
    "psr_test-writer",
  );
});
