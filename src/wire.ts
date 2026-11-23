import { timestampFromMs } from "@bufbuild/protobuf/wkt";
import { DigestType } from "./gen/buf/registry/module/v1/digest_pb.js";
import { ModuleState } from "./gen/buf/registry/module/v1/module_pb.js";
import type { CommitRow, LabelRow, ModuleRow } from "./db.js";

export const moduleMessage = (row: ModuleRow) => ({
  id: row.id,
  ownerId: row.scope_id,
  name: row.name,
  visibility: row.visibility,
  state: row.deprecated ? ModuleState.DEPRECATED : ModuleState.ACTIVE,
  description: row.description ?? "",
  url: row.url ?? "",
  defaultLabelName: row.default_label_name,
  createTime: timestampFromMs(row.create_time),
  updateTime: timestampFromMs(row.update_time),
});

export const commitMessage = (row: CommitRow, mod: ModuleRow) => ({
  id: row.id,
  ownerId: mod.scope_id,
  moduleId: mod.id,
  digest: { type: DigestType.B5, value: Buffer.from(row.digest_value, "hex") },
  sourceControlUrl: row.source_control_url ?? "",
  createTime: timestampFromMs(row.create_time),
});

export const labelMessage = (row: LabelRow, mod: ModuleRow) => ({
  id: row.id,
  name: row.name,
  ownerId: mod.scope_id,
  moduleId: mod.id,
  commitId: row.commit_id,
  archiveTime: row.archive_time === null ? undefined : timestampFromMs(row.archive_time),
  createTime: timestampFromMs(row.create_time),
  updateTime: timestampFromMs(row.update_time),
});

export { commitPrefix, filePrefix } from "./storage.js";
