import { InvalidArgumentError } from "../errors.js";
import { authorize, type Actor } from "../auth.js";
import type { TokenRole } from "../config.js";
import { and, eq, getTableColumns, isNull } from "drizzle-orm";
import { required, type RegistryDb, type ModuleRow, type LabelRow, type CommitRow } from "../db.js";
import { scopes, modules, labels, commits } from "../schema.js";

export const PUBLIC_MODULE_VISIBILITY = 1;

export type Ref<Name> =
  | { case: "id"; value: string }
  | { case: "name"; value: Name }
  | { case: undefined; value?: undefined };
type ModuleName = { owner: string; module: string };
export type OwnerRef = Ref<string>;
export type ModuleRef = Ref<ModuleName>;
export type LabelRef = Ref<ModuleName & { label: string }>;
export type ResourceRef = Ref<
  ModuleName & {
    child?: { case: "labelName" | "ref"; value: string };
  }
>;
export type ScopedLabelRef = Ref<string>;

export const moduleQuery = (db: RegistryDb) =>
  db
    .select({ ...getTableColumns(modules), slug: scopes.slug })
    .from(modules)
    .innerJoin(scopes, eq(scopes.id, modules.scope_id));

export const namedModule = (owner: string, module: string) => ({
  case: "name" as const,
  value: { owner, module },
});

export function createRefs(db: RegistryDb) {
  function owner(ref?: OwnerRef) {
    const value = required(ref?.value, "Owner reference required", InvalidArgumentError);
    return db
      .select()
      .from(scopes)
      .where(eq(ref?.case === "id" ? scopes.id : scopes.slug, value))
      .get();
  }

  function module(ref?: ModuleRef) {
    if (ref?.case === "id") {
      return required(moduleQuery(db).where(eq(modules.id, ref.value)).get(), "Module not found");
    }
    const name = required(ref?.value, "Module reference required", InvalidArgumentError);
    return required(
      moduleQuery(db)
        .where(and(eq(scopes.slug, name.owner), eq(modules.name, name.module)))
        .get(),
      "Module not found",
    );
  }

  function label(ref?: LabelRef) {
    if (ref?.case === "id") {
      const label = required(
        db.select().from(labels).where(eq(labels.id, ref.value)).get(),
        "Label not found",
      );
      return { label, mod: module({ case: "id", value: label.module_id }) };
    }
    const name = required(ref?.value, "Label reference required", InvalidArgumentError);
    const mod = module(namedModule(name.owner, name.module));
    return {
      mod,
      label: required(
        db
          .select()
          .from(labels)
          .where(and(eq(labels.module_id, mod.id), eq(labels.name, name.label)))
          .get(),
        "Label not found",
      ),
    };
  }

  const commit = (id: string) => db.select().from(commits).where(eq(commits.id, id)).get();

  function commitById(id: string) {
    const row = required(commit(id), "Commit not found");
    return { row, mod: module({ case: "id", value: row.module_id }) };
  }

  function resource(
    ref?: ResourceRef,
    resolveDefault = false,
  ): { mod: ModuleRow; row?: CommitRow; label?: LabelRow } {
    if (ref?.case === "id") {
      const id = ref.value;
      const row = commit(id);
      if (row) return { mod: module({ case: "id", value: row.module_id }), row };
      const label = db.select().from(labels).where(eq(labels.id, id)).get();
      if (label) return { ...commitById(label.commit_id), label };
      const mod = module({ case: "id", value: id });
      return resolveDefault ? byChild(mod, mod.default_label_name, false, true) : { mod };
    }
    const name = required(ref?.value, "Resource reference required", InvalidArgumentError);
    const mod = module(namedModule(name.owner, name.module));
    if (!name.child?.value && !resolveDefault) return { mod };
    return byChild(
      mod,
      name.child?.value || mod.default_label_name,
      name.child?.case === "ref",
      resolveDefault,
    );
  }

  function byChild(mod: ModuleRow, child: string, allowCommit: boolean, activeOnly: boolean) {
    if (allowCommit) {
      const row = commit(child);
      if (row?.module_id === mod.id) return { mod, row };
    }
    const label = required(
      db
        .select()
        .from(labels)
        .where(
          and(
            eq(labels.module_id, mod.id),
            eq(labels.name, child),
            activeOnly ? isNull(labels.archive_time) : undefined,
          ),
        )
        .get(),
      "Label not found",
    );
    return { ...commitById(label.commit_id), label };
  }

  return { owner, module, label, resource, commitById };
}

export function createAccess(refs: ReturnType<typeof createRefs>, allowPublic: boolean) {
  function access(actor: Actor | undefined, mod: ModuleRow, role: TokenRole = "read") {
    authorize(actor, role, mod.slug, allowPublic && mod.visibility === PUBLIC_MODULE_VISIBILITY);
    return mod;
  }

  function resolve(actor: Actor | undefined, ref?: ResourceRef, resolveDefault = false) {
    const result = refs.resource(ref, resolveDefault);
    access(actor, result.mod);
    return result;
  }

  return { access, resolve };
}
