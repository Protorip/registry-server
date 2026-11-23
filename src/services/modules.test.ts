import { expect, test } from "vitest";
import { FailedPreconditionError, InvalidArgumentError } from "../errors.js";
import { assignLabel, createLabels } from "./labels.js";
import { createModules } from "./modules.js";
import { createBlobStore } from "../storage.js";
import { actor, seedCommits } from "./test-fixtures.js";

test("UpdateModules accepts only nonempty, unarchived default label names", async (t) => {
  const db = seedCommits(t, { a: "widgets" });
  const labels = createLabels(db, false);
  const archived = assignLabel(db, "widgets", "archived", "a", actor.name, 1);
  await labels.archiveLabels([{ case: "id", value: archived.id }], actor);
  assignLabel(db, "widgets", "active", "a", actor.name, 1);

  const service = createModules(
    db,
    createBlobStore({ type: "fs", rootDir: "." }),
    [],
    false,
    () => {},
  );
  const moduleRef = { case: "id", value: "widgets" } as const;
  const update = (defaultLabelName: string) =>
    service.updateModules([{ moduleRef, defaultLabelName }], actor);
  for (const name of ["active", "future"]) {
    const [updated] = await update(name);
    expect(updated.default_label_name).toBe(name);
  }
  await expect(update("")).rejects.toThrow(InvalidArgumentError);
  await expect(update("archived")).rejects.toThrow(
    expect.objectContaining({
      constructor: FailedPreconditionError,
      message: "Cannot set an archived label as the default label",
    }),
  );
});
