import { expect, test } from "vitest";
import { NotFoundError } from "../errors.js";
import { assignLabel, createLabels } from "./labels.js";
import { actor, seedCommits } from "./test-fixtures.js";

test("label history orders assignments, skips archive events, and starts at the requested commit", async (t) => {
  const db = seedCommits(t, { a: "widgets", b: "widgets", c: "widgets", unassigned: "widgets" });
  const labels = createLabels(db, false);
  const label = assignLabel(db, "widgets", "release", "a", actor.name, 1);
  const labelRef = { case: "id", value: label.id } as const;
  await labels.archiveLabels([labelRef], actor);
  await labels.unarchiveLabels([labelRef], actor);
  assignLabel(db, "widgets", "release", "b", actor.name, 2);
  assignLabel(db, "widgets", "release", "c", actor.name, 3);

  const history = async (options: Partial<Parameters<typeof labels.listLabelHistory>[0]> = {}) => {
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
  expect(await history()).toStrictEqual(["a", "b", "c"]);
  expect(await history({ ascending: false })).toStrictEqual(["c", "b", "a"]);
  expect(await history({ startCommitId: "b" })).toStrictEqual(["b", "c"]);
  await expect(history({ startCommitId: "unassigned" })).rejects.toThrow(NotFoundError);
});
