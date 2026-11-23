import {
  AlreadyExistsError,
  FailedPreconditionError,
  InvalidArgumentError,
  PermissionDeniedError,
} from "../errors.js";
import { and, eq } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { ModuleVisibility } from "../gen/buf/registry/module/v1/module_pb.js";
import { createOwners } from "./owners.js";
import { authorize, type Actor } from "../auth.js";
import type { RegistryConfig, RegistryLogger } from "../config.js";
import {
  newId,
  page,
  required,
  timeOrder,
  type PageOptions,
  type RegistryDb,
  type TimeOrder,
} from "../db.js";
import { scopes, modules, commits, commitDependencies, labels } from "../schema.js";
import { commitPrefix, type BlobStore } from "../storage.js";
import {
  createAccess,
  createRefs,
  moduleQuery,
  PUBLIC_MODULE_VISIBILITY,
  type ModuleRef,
  type OwnerRef,
} from "./refs.js";

interface CreateModule {
  ownerRef?: OwnerRef;
  name: string;
  visibility: number;
  defaultLabelName: string;
  description: string;
  url: string;
}

interface UpdateModule {
  moduleRef?: ModuleRef;
  visibility?: number;
  deprecated?: boolean;
  defaultLabelName?: string;
  description?: string;
  url?: string;
}

export function createModules(
  db: RegistryDb,
  blobs: BlobStore,
  allowedScopes: RegistryConfig["allowedScopes"],
  allowPublic: boolean,
  log: RegistryLogger,
) {
  const refs = createRefs(db);
  const { access } = createAccess(refs, allowPublic);
  const { getOwners } = createOwners(db, allowPublic);
  function visibility(value: number) {
    if (value === PUBLIC_MODULE_VISIBILITY && !allowPublic)
      throw new PermissionDeniedError("Public modules are disabled");
    return value;
  }
  return {
    async getModules(moduleRefs: (ModuleRef | undefined)[], actor: Actor | undefined) {
      return moduleRefs.map((ref) => access(actor, refs.module(ref)));
    },
    async listModules(
      req: PageOptions & { ownerRefs: (OwnerRef | undefined)[]; order: TimeOrder },
      actor: Actor | undefined,
    ) {
      authorize(actor, "read", undefined, allowPublic);
      const owners = new Set((await getOwners(req.ownerRefs, actor)).map((scope) => scope.id));
      const rows = moduleQuery(db)
        .orderBy(...timeOrder(req.order, modules))
        .all()
        .filter(
          (mod) =>
            (!owners.size || owners.has(mod.scope_id)) &&
            ((allowPublic && mod.visibility === PUBLIC_MODULE_VISIBILITY) ||
              actor?.scopes.includes("*") ||
              actor?.scopes.includes(mod.slug)),
        );
      return page(rows, req);
    },
    async createModules(values: CreateModule[], actor: Actor | undefined) {
      authorize(actor, "admin");
      return db.transaction(
        (tx) => {
          const refs = createRefs(tx);
          return values.map((value) => {
            const scope = refs.owner(value.ownerRef);
            const slug = required(
              scope?.slug ?? (value.ownerRef?.case === "name" ? value.ownerRef.value : undefined),
              "Owner not found",
            );
            authorize(actor, "admin", slug);
            if (allowedScopes && !allowedScopes.includes(slug)) {
              throw new PermissionDeniedError("Scope is not allowed");
            }
            const visibilityValue = visibility(
              value.visibility === ModuleVisibility.UNSPECIFIED
                ? ModuleVisibility.PRIVATE
                : value.visibility,
            );
            const now = Date.now();
            const scopeId = scope?.id ?? newId();
            if (!scope)
              tx.insert(scopes)
                .values({
                  id: scopeId,
                  name: slug,
                  slug,
                  create_time: now,
                  update_time: now,
                })
                .run();
            if (
              tx
                .select({ id: modules.id })
                .from(modules)
                .where(and(eq(modules.scope_id, scopeId), eq(modules.name, value.name)))
                .get()
            ) {
              throw new AlreadyExistsError("Module already exists");
            }
            const saved = tx
              .insert(modules)
              .values({
                id: newId(),
                scope_id: scopeId,
                name: value.name,
                visibility: visibilityValue,
                default_label_name: value.defaultLabelName || "main",
                description: value.description,
                url: value.url,
                create_time: now,
                update_time: now,
              })
              .returning()
              .get()!;
            return { ...saved, slug };
          });
        },
        { behavior: "immediate" },
      );
    },
    async updateModules(values: UpdateModule[], actor: Actor | undefined) {
      authorize(actor, "admin");
      return db.transaction(
        (tx) => {
          const refs = createRefs(tx);
          return values.map((value) => {
            const mod = access(actor, refs.module(value.moduleRef), "admin");
            if (value.defaultLabelName !== undefined) {
              if (value.defaultLabelName === "") {
                throw new InvalidArgumentError("Default label name must not be empty");
              }
              const label = tx
                .select({ archive_time: labels.archive_time })
                .from(labels)
                .where(and(eq(labels.module_id, mod.id), eq(labels.name, value.defaultLabelName)))
                .get();
              if (label && label.archive_time !== null) {
                throw new FailedPreconditionError(
                  "Cannot set an archived label as the default label",
                );
              }
            }
            const saved = tx
              .update(modules)
              .set({
                visibility:
                  value.visibility === undefined ? mod.visibility : visibility(value.visibility),
                deprecated:
                  value.deprecated === undefined ? mod.deprecated : Number(value.deprecated),
                description: value.description ?? mod.description,
                url: value.url ?? mod.url,
                default_label_name: value.defaultLabelName ?? mod.default_label_name,
                update_time: Date.now(),
              })
              .where(eq(modules.id, mod.id))
              .returning()
              .get()!;
            return { ...saved, slug: mod.slug };
          });
        },
        { behavior: "immediate" },
      );
    },
    async deleteModules(moduleRefs: (ModuleRef | undefined)[], actor: Actor | undefined) {
      authorize(actor, "admin");
      const prefixes = db.transaction(
        (tx) => {
          const refs = createRefs(tx);
          const targets = moduleRefs.map((ref) => access(actor, refs.module(ref), "admin"));
          const deletion = new Set(targets.map((mod) => mod.id));
          const prefixes: string[] = [];
          const source = alias(commits, "source");
          for (const mod of targets) {
            const dependents = tx
              .selectDistinct({ module_id: source.module_id })
              .from(commitDependencies)
              .innerJoin(source, eq(source.id, commitDependencies.commit_id))
              .innerJoin(commits, eq(commits.id, commitDependencies.dep_commit_id))
              .where(eq(commits.module_id, mod.id))
              .all();
            if (dependents.some((dependent) => !deletion.has(dependent.module_id))) {
              throw new FailedPreconditionError("Module is referenced by another module");
            }
          }
          for (const mod of targets) {
            for (const { id } of tx
              .select({ id: commits.id })
              .from(commits)
              .where(eq(commits.module_id, mod.id))
              .all()) {
              prefixes.push(commitPrefix(mod, id));
            }
            tx.delete(modules).where(eq(modules.id, mod.id)).run();
          }
          return prefixes;
        },
        { behavior: "immediate" },
      );
      for (const prefix of prefixes) {
        await blobs
          .deletePrefix(prefix)
          .catch(() => log("error", { event: "blob_cleanup_failed", prefix }));
      }
    },
  };
}
