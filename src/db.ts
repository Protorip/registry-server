import { InvalidArgumentError, NotFoundError, type RegistryError } from "./errors.js";
import { asc, desc } from "drizzle-orm";
import type { BaseSQLiteDatabase, SQLiteColumn } from "drizzle-orm/sqlite-core";
import { v7 } from "uuid";
import type { commits, labels, modules } from "./schema.js";

export type RegistryDb = BaseSQLiteDatabase<"sync", unknown>;
export type ModuleRow = typeof modules.$inferSelect & { slug: string };
export type CommitRow = typeof commits.$inferSelect;
export type LabelRow = typeof labels.$inferSelect;

export const newId = () => v7().replaceAll("-", "");

export type TimeOrder = "created-desc" | "created-asc" | "updated-desc" | "updated-asc";

export interface PageOptions {
  pageSize: number;
  pageToken: string;
}

export function timeOrder(
  order: TimeOrder,
  table: {
    id: SQLiteColumn;
    create_time: SQLiteColumn;
    update_time?: SQLiteColumn;
  },
) {
  const column =
    (order === "updated-desc" || order === "updated-asc") && table.update_time
      ? table.update_time
      : table.create_time;
  const sort = order === "created-asc" || order === "updated-asc" ? asc : desc;
  return [sort(column), sort(table.id)];
}

export function required<T>(
  value: T | null | undefined,
  message: string,
  ErrorType: new (message: string) => RegistryError = NotFoundError,
): T {
  if (value == null) throw new ErrorType(message);
  return value;
}

export function page<T extends { id: string }>(rows: T[], { pageSize, pageToken }: PageOptions) {
  const size = pageSize || 50;
  const start = pageToken ? rows.findIndex(({ id }) => id === pageToken) + 1 : 0;
  if (pageToken && start === 0) throw new InvalidArgumentError("Invalid page token");
  const values = rows.slice(start, start + size);
  return { values, nextPageToken: start + size < rows.length ? values.at(-1)!.id : "" };
}
