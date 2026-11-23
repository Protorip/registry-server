import { expect, test } from "vitest";
import { create } from "@bufbuild/protobuf";
import { CommitSchema } from "./gen/buf/registry/module/v1/commit_pb.js";
import { LabelSchema } from "./gen/buf/registry/module/v1/label_pb.js";
import type { ModuleRow } from "./db.js";
import { commitMessage, labelMessage } from "./wire.js";

const mod: ModuleRow = {
  id: "a".repeat(32),
  scope_id: "b".repeat(32),
  slug: "example",
  name: "widgets",
  visibility: 2,
  deprecated: 0,
  default_label_name: "main",
  description: null,
  url: null,
  create_time: 1,
  update_time: 1,
};
const commitId = "c".repeat(32);
const now = Date.now();

test("commit responses omit the token name stored for audit", () => {
  const commit = create(
    CommitSchema,
    commitMessage(
      {
        id: commitId,
        module_id: mod.id,
        digest_type: 1,
        digest_value: "00".repeat(64),
        source_control_url: null,
        created_by_user_id: "operator",
        create_time: now,
      },
      mod,
    ),
  );
  expect(commit.createdByUserId).toBe("");
});

test("label responses omit the token name stored for audit", () => {
  const label = create(
    LabelSchema,
    labelMessage(
      {
        id: "d".repeat(32),
        name: "main",
        module_id: mod.id,
        commit_id: commitId,
        archive_time: null,
        updated_by_user_id: "operator",
        create_time: now,
        update_time: now,
      },
      mod,
    ),
  );
  expect(label.updatedByUserId).toBe("");
});
