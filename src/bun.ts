import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { openSqlite } from "./driver.js";

export function sqlite(pathOrOptions: string | { path?: string } = {}) {
  return openSqlite(pathOrOptions, (path) => {
    const client = new Database(path, { strict: true });
    return {
      db: drizzle(client),
      exec: (sql) => {
        client.exec(sql);
      },
      close: () => client.close(),
    };
  });
}
