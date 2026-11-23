import assert from "node:assert/strict";
import { test } from "node:test";
import { create } from "@bufbuild/protobuf";
import { CommitSchema } from "../dist/gen/buf/registry/module/v1/commit_pb.js";
import { LabelSchema } from "../dist/gen/buf/registry/module/v1/label_pb.js";
import { commitMessage, labelMessage } from "../dist/wire.js";

const mod = { id: "a".repeat(32), scope_id: "b".repeat(32) };
const commitId = "c".repeat(32);
const now = Date.now();

test("commit responses omit the token name stored for audit", () => {
  const commit = create(
    CommitSchema,
    commitMessage(
      {
        id: commitId,
        digest_value: "00".repeat(64),
        source_control_url: null,
        created_by_user_id: "operator",
        create_time: now,
      },
      mod,
    ),
  );
  assert.equal(commit.createdByUserId, "");
});

test("label responses omit the token name stored for audit", () => {
  const label = create(
    LabelSchema,
    labelMessage(
      {
        id: "d".repeat(32),
        name: "main",
        commit_id: commitId,
        archive_time: null,
        updated_by_user_id: "operator",
        create_time: now,
        update_time: now,
      },
      mod,
    ),
  );
  assert.equal(label.updatedByUserId, "");
});
