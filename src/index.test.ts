import { DatabaseSync } from "node:sqlite";
import { expect, test, type TestContext } from "vitest";
import { drizzleNode, sqlite } from "./node.js";
import { createRegistryHandler, migrate } from "./index.js";

type RpcResult = {
  code?: string;
  commits: Array<{ id: string }>;
  labels: Array<{ name: string }>;
  modules: Array<{ id: string; visibility: string }>;
};

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
      expect(response.status, await response.text()).toBe(200);
    } finally {
      await Promise.all([registry.close(), registry.close()]);
    }
    expect(closeCalls).toBe(1);
    expect(client.prepare("SELECT name FROM modules").get()?.name).toBe("widgets");
  } finally {
    client.close();
  }
});

test("resource-scoped lists and filtered downloads honor the full request", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = await mkdtemp(join(tmpdir(), "registry-scoped-rpcs-"));
  const registry = createRegistryHandler({
    database: sqlite(":memory:"),
    auth: { mode: "none" },
    storage: { type: "fs", rootDir: root },
  });
  async function rpc(service: string, method: string, body: object, status = 200) {
    const response = await registry.fetch(
      new Request(`http://localhost/buf.registry.module.v1.${service}/${method}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
    const result = (await response.json()) as RpcResult;
    expect(response.status, JSON.stringify(result)).toBe(status);
    return result;
  }
  const moduleRef = { name: { owner: "example", module: "widgets" } };
  try {
    await rpc("ModuleService", "CreateModules", {
      values: [
        { ownerRef: { name: "example" }, name: "widgets", visibility: "MODULE_VISIBILITY_PRIVATE" },
      ],
    });
    const upload = (label: string, text: string) =>
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
    expect(commits.commits.map((commit) => commit.id)).toStrictEqual([resourceRef.id]);
    const labels = await rpc("LabelService", "ListLabels", { resourceRef });
    expect(labels.labels.map((label) => label.name)).toStrictEqual(["release"]);
    const error = await rpc(
      "DownloadService",
      "Download",
      {
        values: [{ resourceRef, fileTypes: ["FILE_TYPE_PROTO"], paths: ["LICENSE"] }],
      },
      404,
    );
    expect(error.code).toBe("not_found");
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
    expect(get.status).toBe(200);
    expect(get.headers.get("content-type")).toBe("application/json");
    expect(await get.json()).toStrictEqual({ status: "ok" });
    const head = await health("HEAD");
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    const closing = registry.close();
    expect((await health()).status).toBe(503);
    await closing;
  } finally {
    await registry.close();
    client.close();
  }
});

async function s3Registry(t: TestContext) {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { default: S3rver } = await import("s3rver");
  const root = await mkdtemp(join(tmpdir(), "registry-races-"));
  const emulator = new S3rver({
    address: "127.0.0.1",
    port: 0,
    silent: true,
    directory: root,
    configureBuckets: [{ name: "registry" }],
  });
  let pause: { method: string; entered: () => void; released: Promise<void> } | undefined;
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
  t.onTestFinished(async () => {
    await registry.close();
    await emulator.close();
    await rm(root, { recursive: true, force: true });
  });
  async function rpc(service: string, method: string, body: object, status?: number) {
    const response = await registry.fetch(
      new Request(`http://localhost/buf.registry.module.v1.${service}/${method}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
    const result = (await response.json()) as RpcResult;
    if (status !== undefined) expect(response.status, JSON.stringify(result)).toBe(status);
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
    deleteStoredFile(key: string) {
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
    pauseNext(method: string) {
      const entered = Promise.withResolvers<void>();
      const released = Promise.withResolvers<void>();
      pause = { method, entered: entered.resolve, released: released.promise };
      return { entered: entered.promise, release: released.resolve };
    },
  };
}

async function beforeRelease<T>(operation: Promise<T>) {
  const { setTimeout } = await import("node:timers/promises");
  const timer = new AbortController();
  try {
    return await Promise.race([
      operation,
      setTimeout(5000, undefined, { signal: timer.signal }).then(() => {
        throw new Error("RPC did not finish while another RPC was waiting on storage");
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
  expect((await first).code).toBe("aborted");
  const winnerId = winner.commits[0].id;
  const otherId = other.commits[0].id;
  expect(winnerId).not.toBe(otherId);
  expect((await registry.upload()).commits[0].id).toBe(winnerId);
  expect(await registry.storedKeys()).toStrictEqual(
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
    expect(deletion).toStrictEqual({});
  } finally {
    gate.release();
  }
  expect(await download).toStrictEqual({ code: "not_found", message: "Commit not found" });
});

test("a download fails when an existing commit has no stored files", async (t) => {
  const registry = await s3Registry(t);
  const { commits } = await registry.upload();
  const resourceRef = { id: commits[0].id };
  const files = await registry.storedKeys();
  expect(files.length).toBe(1);
  await registry.deleteStoredFile(files[0]);
  expect(await registry.storedKeys()).toStrictEqual([]);

  const error = await registry.rpc(
    "DownloadService",
    "Download",
    { values: [{ resourceRef }] },
    500,
  );
  expect(error.code).toBe("internal");
});

test("public reads honor module visibility and hide private owners from anonymous callers", async (t) => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const rootDir = await mkdtemp(join(tmpdir(), "registry-public-"));
  t.onTestFinished(() => rm(rootDir, { recursive: true, force: true }));
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
  t.onTestFinished(() => registry.close());

  async function rpc(method: string, body: object, token?: string, code?: string) {
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
    const result = (await response.json()) as RpcResult;
    if (code) expect(result.code, JSON.stringify(result)).toBe(code);
    else expect(response.status, JSON.stringify(result)).toBe(200);
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
  expect(consumer.visibility).toBe("MODULE_VISIBILITY_PRIVATE");
  expect((await rpc(list, {})).modules.map(({ id }) => id)).toStrictEqual([dependency.id]);
  expect(
    (await rpc(list, { ownerRefs: [{ name: "public-owner" }] }, "psr_test-writer")).modules.map(
      ({ id }) => id,
    ),
  ).toStrictEqual([dependency.id]);
  for (const name of ["missing-owner", "private-owner"]) {
    await rpc(owners, { ownerRefs: [{ name }] }, undefined, "unauthenticated");
  }
  await rpc(owners, { ownerRefs: [{ name: "missing-owner" }] }, "psr_test-admin", "not_found");

  const file = (path: string, text: string) => ({
    path,
    content: Buffer.from(text).toString("base64"),
  });
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

test("CreateModules enforces the configured owner allowlist", async (t) => {
  const registry = createRegistryHandler({
    database: sqlite(":memory:"),
    auth: { mode: "none" },
    storage: { type: "fs", rootDir: "." },
    allowedScopes: ["example"],
  });
  t.onTestFinished(() => registry.close());
  const createModule = (owner: string) =>
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
  expect(denied.status).toBe(403);
  expect((await denied.json()).code).toBe("permission_denied");
  const allowed = await createModule("example");
  expect(allowed.status, await allowed.text()).toBe(200);
});
