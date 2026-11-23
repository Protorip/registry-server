import type { TestContext } from "vitest";
import type { Actor } from "../auth.js";
import { sqlite } from "../node.js";
import { commits, modules, scopes } from "../schema.js";

export const actor: Actor = { name: "operator", role: "admin", scopes: ["*"] };

export function seedCommits(t: TestContext, moduleForCommit: Record<string, string>) {
  const database = sqlite(":memory:");
  t.onTestFinished(() => database.close());
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
