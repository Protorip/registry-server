import { NotFoundError, InvalidArgumentError, FailedPreconditionError } from "../errors.js";
import { and, asc, desc, eq } from "drizzle-orm";
import { authorize, type Actor } from "../auth.js";
import {
  newId,
  page,
  required,
  timeOrder,
  type RegistryDb,
  type PageOptions,
  type TimeOrder,
} from "../db.js";
import { labels, labelEvents } from "../schema.js";
import { createAccess, createRefs, type LabelRef, type ResourceRef } from "./refs.js";

interface ListLabels extends PageOptions {
  resourceRef?: ResourceRef;
  order: TimeOrder;
  nameQuery: string;
  archiveFilter: "all" | "archived" | "unarchived";
  filterByCommitChecks: boolean;
}

interface ListLabelHistory extends PageOptions {
  labelRef?: LabelRef;
  ascending: boolean;
  startCommitId: string;
  filterByCommitChecks: boolean;
}

export function createLabels(db: RegistryDb, allowPublic: boolean) {
  const refs = createRefs(db);
  const { access, resolve } = createAccess(refs, allowPublic);
  function setArchive(
    labelRefs: (LabelRef | undefined)[],
    actor: Actor | undefined,
    archive: boolean,
  ) {
    db.transaction(
      (tx) => {
        const refs = createRefs(tx);
        for (const ref of labelRefs) {
          const { label, mod } = refs.label(ref);
          access(actor, mod, "write");
          if (archive && mod.default_label_name === label.name) {
            throw new FailedPreconditionError("Cannot archive the default label");
          }
          if (archive === (label.archive_time !== null)) continue;
          const now = Date.now();
          const actorName = actor!.name;
          tx.update(labels)
            .set({
              archive_time: archive ? now : null,
              updated_by_user_id: actorName,
              update_time: now,
            })
            .where(eq(labels.id, label.id))
            .run();
          tx.insert(labelEvents)
            .values({
              id: newId(),
              label_id: label.id,
              commit_id: label.commit_id,
              action: archive ? "archive" : "unarchive",
              user_id: actorName,
              create_time: now,
            })
            .run();
        }
      },
      { behavior: "immediate" },
    );
  }

  return {
    async getLabels(labelRefs: (LabelRef | undefined)[], actor: Actor | undefined) {
      return labelRefs.map((ref) => {
        const { label, mod } = refs.label(ref);
        return { label, mod: access(actor, mod) };
      });
    },
    async listLabels(req: ListLabels, actor: Actor | undefined) {
      const { mod, label, row } = resolve(actor, req.resourceRef);
      const rows = db
        .select()
        .from(labels)
        .where(
          and(
            eq(labels.module_id, mod.id),
            label ? eq(labels.id, label.id) : row ? eq(labels.commit_id, row.id) : undefined,
          ),
        )
        .orderBy(...timeOrder(req.order, labels))
        .all()
        .filter(
          (label) =>
            label.name.includes(req.nameQuery) &&
            (req.archiveFilter === "all" ||
              (req.archiveFilter === "archived"
                ? label.archive_time !== null
                : label.archive_time === null)),
        );
      const result = page(req.filterByCommitChecks ? [] : rows, req);
      return {
        labels: result.values,
        mod,
        nextPageToken: result.nextPageToken,
      };
    },
    async listLabelHistory(req: ListLabelHistory, actor: Actor | undefined) {
      const { label, mod } = refs.label(req.labelRef);
      access(actor, mod);
      const sort = req.ascending ? asc : desc;
      const rows = db
        .select({ id: labelEvents.id, commit_id: labelEvents.commit_id })
        .from(labelEvents)
        .where(and(eq(labelEvents.label_id, label.id), eq(labelEvents.action, "assign")))
        .orderBy(sort(labelEvents.create_time), sort(labelEvents.id))
        .all();
      const start = req.startCommitId
        ? rows.findIndex((row) => row.commit_id === req.startCommitId)
        : 0;
      if (start < 0) throw new NotFoundError("Commit not in label history");
      const result = page(req.filterByCommitChecks ? [] : rows.slice(start), req);
      return {
        commits: result.values.map((row) => refs.commitById(row.commit_id).row),
        mod,
        nextPageToken: result.nextPageToken,
      };
    },
    async createOrUpdateLabels(
      values: { commitId: string; labelRef?: LabelRef }[],
      actor: Actor | undefined,
    ) {
      authorize(actor, "write");
      return db.transaction(
        (tx) => {
          const refs = createRefs(tx);
          return values.map((value) => {
            const { row, mod } = refs.commitById(value.commitId);
            access(actor, mod, "write");
            const ref = required(value.labelRef, "Label ref required", InvalidArgumentError);
            let name: string;
            if (ref.case === "name") {
              if (ref.value.owner !== mod.slug || ref.value.module !== mod.name) {
                throw new InvalidArgumentError("Label and commit must belong to the same module");
              }
              name = ref.value.label;
            } else {
              const existing = refs.label(ref);
              if (existing.mod.id !== mod.id)
                throw new InvalidArgumentError("Label and commit must belong to the same module");
              name = existing.label.name;
            }
            return { label: assignLabel(tx, mod.id, name, row.id, actor!.name, Date.now()), mod };
          });
        },
        { behavior: "immediate" },
      );
    },
    async archiveLabels(labelRefs: (LabelRef | undefined)[], actor: Actor | undefined) {
      setArchive(labelRefs, actor, true);
    },
    async unarchiveLabels(labelRefs: (LabelRef | undefined)[], actor: Actor | undefined) {
      setArchive(labelRefs, actor, false);
    },
  };
}

export function assignLabel(
  db: RegistryDb,
  moduleId: string,
  name: string,
  commit: string,
  actor: string,
  now: number,
) {
  const previous = db
    .select()
    .from(labels)
    .where(and(eq(labels.module_id, moduleId), eq(labels.name, name)))
    .get();
  if (previous?.commit_id === commit && previous.archive_time === null) return previous;

  const id = previous?.id ?? newId();
  const assignment = {
    archive_time: null,
    commit_id: commit,
    updated_by_user_id: actor,
    update_time: now,
  };
  const label = db
    .insert(labels)
    .values({ id, module_id: moduleId, name, create_time: now, ...assignment })
    .onConflictDoUpdate({ target: [labels.module_id, labels.name], set: assignment })
    .returning()
    .get()!;
  db.insert(labelEvents)
    .values({
      id: newId(),
      label_id: id,
      commit_id: commit,
      action: "assign",
      user_id: actor,
      create_time: now,
    })
    .run();
  return label;
}
