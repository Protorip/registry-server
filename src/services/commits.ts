import { and, eq } from "drizzle-orm";
import type { Actor } from "../auth.js";
import {
  page,
  required,
  timeOrder,
  type RegistryDb,
  type PageOptions,
  type TimeOrder,
  type CommitRow,
  type ModuleRow,
} from "../db.js";
import { commits, commitDependencies } from "../schema.js";
import { createAccess, createRefs, type ResourceRef } from "./refs.js";

export function createCommits(db: RegistryDb, allowPublic: boolean) {
  const refs = createRefs(db);
  const { access, resolve } = createAccess(refs, allowPublic);
  return {
    async getCommits(resourceRefs: (ResourceRef | undefined)[], actor: Actor | undefined) {
      return resourceRefs.map((ref) => {
        const { row, mod } = resolve(actor, ref, true);
        return { row: required(row, "Commit not found"), mod };
      });
    },
    async listCommits(
      req: PageOptions & { resourceRef?: ResourceRef; order: TimeOrder; idQuery: string },
      actor: Actor | undefined,
    ) {
      const { mod, row } = resolve(actor, req.resourceRef);
      const rows = db
        .select()
        .from(commits)
        .where(and(eq(commits.module_id, mod.id), row ? eq(commits.id, row.id) : undefined))
        .orderBy(...timeOrder(req.order, commits))
        .all()
        .filter((row) => row.id.includes(req.idQuery.toLowerCase()));
      const result = page(rows, req);
      return {
        commits: result.values,
        mod,
        nextPageToken: result.nextPageToken,
      };
    },
    async getResources(resourceRefs: (ResourceRef | undefined)[], actor: Actor | undefined) {
      return resourceRefs.map((ref) => resolve(actor, ref));
    },
    async getGraph(resourceRefs: (ResourceRef | undefined)[], actor: Actor | undefined) {
      const queue = resourceRefs.map((ref) => {
        const { row, mod } = resolve(actor, ref, true);
        return { mod, row: required(row, "Commit not found") };
      });
      const commits = new Map<string, { row: CommitRow; mod: ModuleRow }>();
      const edges = [];
      for (const { row, mod } of queue) {
        if (commits.has(row.id)) continue;
        access(actor, mod);
        commits.set(row.id, { row, mod });
        for (const dep of db
          .select({ dep_commit_id: commitDependencies.dep_commit_id })
          .from(commitDependencies)
          .where(eq(commitDependencies.commit_id, row.id))
          .all()) {
          edges.push({ fromCommitId: row.id, toCommitId: dep.dep_commit_id });
          queue.push(refs.commitById(dep.dep_commit_id));
        }
      }
      return { commits: [...commits.values()], edges };
    },
  };
}
