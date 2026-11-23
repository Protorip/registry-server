import { index, integer, primaryKey, sqliteTable, text, unique } from "drizzle-orm/sqlite-core";

const id = () => text().primaryKey().notNull();
const created = () => integer().notNull();
const updated = () => integer().notNull();

export const scopes = sqliteTable("scopes", {
  id: id(),
  name: text().notNull(),
  slug: text().unique().notNull(),
  create_time: created(),
  update_time: updated(),
});

export const modules = sqliteTable(
  "modules",
  {
    id: id(),
    scope_id: text()
      .notNull()
      .references(() => scopes.id),
    name: text().notNull(),
    visibility: integer().notNull(),
    deprecated: integer().notNull().default(0),
    default_label_name: text().notNull().default("main"),
    description: text(),
    url: text(),
    create_time: created(),
    update_time: updated(),
  },
  (table) => [unique().on(table.scope_id, table.name)],
);

export const commits = sqliteTable(
  "commits",
  {
    id: id(),
    module_id: text()
      .notNull()
      .references(() => modules.id, { onDelete: "cascade" }),
    digest_type: integer().notNull(),
    digest_value: text().notNull(),
    source_control_url: text(),
    created_by_user_id: text(),
    create_time: created(),
  },
  (table) => [unique().on(table.module_id, table.digest_value)],
);

export const labels = sqliteTable(
  "labels",
  {
    id: id(),
    module_id: text()
      .notNull()
      .references(() => modules.id, { onDelete: "cascade" }),
    name: text().notNull(),
    commit_id: text()
      .notNull()
      .references(() => commits.id),
    archive_time: integer(),
    updated_by_user_id: text(),
    create_time: created(),
    update_time: updated(),
  },
  (table) => [unique().on(table.module_id, table.name)],
);

export const labelEvents = sqliteTable(
  "label_events",
  {
    id: id(),
    label_id: text()
      .notNull()
      .references(() => labels.id, { onDelete: "cascade" }),
    commit_id: text()
      .notNull()
      .references(() => commits.id),
    action: text().notNull(),
    user_id: text(),
    create_time: created(),
  },
  (table) => [index("label_events_history").on(table.label_id, table.create_time)],
);

export const commitDependencies = sqliteTable(
  "commit_dependencies",
  {
    commit_id: text()
      .notNull()
      .references(() => commits.id, { onDelete: "cascade" }),
    // The SQL migration defers this constraint so dependent modules can be deleted together.
    dep_commit_id: text()
      .notNull()
      .references(() => commits.id),
    dep_registry: text().notNull(),
    dep_owner: text().notNull(),
    dep_module: text().notNull(),
    dep_digest: text(),
  },
  (table) => [
    primaryKey({ columns: [table.commit_id, table.dep_commit_id] }),
    index("commit_dependencies_target").on(table.dep_commit_id),
  ],
);
