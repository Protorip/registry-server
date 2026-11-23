import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readMigrationFiles } from "drizzle-orm/migrator";
import type { SQLiteSyncDialect } from "drizzle-orm/sqlite-core";
import type { RegistryDatabase } from "./config.js";
import type { RegistryDb } from "./db.js";

export function migrate(db: RegistryDb): void {
  const folder = [
    new URL("../drizzle", import.meta.url),
    new URL("../../drizzle", import.meta.url),
  ].find((candidate) => existsSync(candidate));
  if (!folder) throw new Error("Registry migration directory not found");

  const config = {
    migrationsFolder: fileURLToPath(folder),
    migrationsTable: "__protorip_registry_migrations",
  };
  const migrations = readMigrationFiles(config);
  const { dialect, session } = db as unknown as {
    dialect: SQLiteSyncDialect;
    session: Parameters<SQLiteSyncDialect["migrate"]>[1];
  };
  dialect.migrate(migrations, session, config);
}

export function openSqlite(
  pathOrOptions: string | { path?: string },
  connect: (path: string) => { db: RegistryDb; close(): void; exec(statement: string): void },
): RegistryDatabase {
  const path =
    (typeof pathOrOptions === "string" ? pathOrOptions : pathOrOptions.path) ??
    "./data/registry.db";
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const connection = connect(path);
  try {
    connection.exec(
      "PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;",
    );
    migrate(connection.db);
    return { db: connection.db, close: connection.close };
  } catch (error) {
    connection.close();
    throw error;
  }
}
