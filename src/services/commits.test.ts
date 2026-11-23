import { expect, test } from "vitest";
import type { TimeOrder } from "../db.js";
import type { ResourceRef } from "./refs.js";
import { NotFoundError } from "../errors.js";
import { commitDependencies } from "../schema.js";
import { createCommits } from "./commits.js";
import { assignLabel } from "./labels.js";
import { actor, seedCommits } from "./test-fixtures.js";

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
  expect(graph.commits.map(({ row }) => row.id).sort()).toStrictEqual(["a", "b", "c", "d"]);
  expect(
    graph.edges.map(({ fromCommitId, toCommitId }) => `${fromCommitId}->${toCommitId}`).sort(),
  ).toStrictEqual(["a->b", "a->c", "b->d", "c->d"]);
});

const byId = (value: string): ResourceRef => ({ case: "id", value });
const widgets = { case: "name", value: { owner: "example", module: "widgets" } } as const;

test("commit lookup resolves a label and an ID in request order", async (t) => {
  const db = seedCommits(t, { a: "widgets", b: "widgets" });
  assignLabel(db, "widgets", "release", "b", actor.name, 1);
  const release: ResourceRef = {
    ...widgets,
    value: { ...widgets.value, child: { case: "labelName", value: "release" } },
  };
  const rows = await createCommits(db, false).getCommits([release, byId("a")], actor);
  expect(rows.map(({ row }) => row.id)).toStrictEqual(["b", "a"]);
});

test("commit lookup rejects a batch containing an unknown commit", async (t) => {
  const db = seedCommits(t, { a: "widgets" });
  await expect(
    createCommits(db, false).getCommits([byId("a"), byId("missing")], actor),
  ).rejects.toThrow(NotFoundError);
});

const orders: Array<[TimeOrder, string[]]> = [
  ["created-asc", ["a", "b", "c"]],
  ["created-desc", ["c", "b", "a"]],
];
for (const [order, expected] of orders) {
  test(`commit listing pages consistently through timestamp ties for ${order}`, async (t) => {
    const db = seedCommits(t, { b: "widgets", a: "widgets", c: "widgets", d: "another" });
    const service = createCommits(db, false);
    const list = (pageToken: string) =>
      service.listCommits(
        { resourceRef: widgets, order, idQuery: "", pageSize: 2, pageToken },
        actor,
      );
    const first = await list("");
    expect(first.commits.map(({ id }) => id)).toStrictEqual(expected.slice(0, 2));
    expect(first.nextPageToken).toBe(expected[1]);
    const last = await list(first.nextPageToken);
    expect(last.commits.map(({ id }) => id)).toStrictEqual(expected.slice(2));
    expect(last.nextPageToken).toBe("");
  });
}
