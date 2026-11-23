import {
  DatabaseSync,
  type SQLInputValue,
  type SQLOutputValue,
  type StatementResultingChanges,
  type StatementSync,
} from "node:sqlite";
import { entityKind, fillPlaceholders, type Query } from "drizzle-orm";
import {
  BaseSQLiteDatabase,
  SQLitePreparedQuery,
  SQLiteSession,
  SQLiteSyncDialect,
  SQLiteTransaction,
  type SelectedFieldsOrdered,
  type SQLiteExecuteMethod,
  type SQLiteTransactionConfig,
} from "drizzle-orm/sqlite-core";
import * as drizzleUtils from "drizzle-orm/utils";
import { openSqlite } from "./driver.js";

// Drizzle uses this runtime export in its SQLite drivers, but omits it from its declarations.
const { mapResultRow } = drizzleUtils as typeof drizzleUtils & {
  mapResultRow(
    fields: SelectedFieldsOrdered,
    row: SQLOutputValue[],
    joinsNotNullableMap?: Record<string, boolean>,
  ): unknown;
};

type NodeTransaction = SQLiteTransaction<
  "sync",
  StatementResultingChanges,
  Record<string, never>,
  Record<string, never>
>;
type NodeDb = BaseSQLiteDatabase<"sync", StatementResultingChanges>;
type ResultMapper = (rows: SQLOutputValue[][]) => unknown;

class NodeSQLitePreparedQuery extends SQLitePreparedQuery<{
  type: "sync";
  run: StatementResultingChanges;
  all: unknown;
  get: unknown;
  values: SQLOutputValue[][];
  execute: unknown;
}> {
  static readonly [entityKind] = "NodeSQLitePreparedQuery";
  declare joinsNotNullableMap?: Record<string, boolean>;

  constructor(
    private readonly stmt: StatementSync,
    query: Query,
    executeMethod: SQLiteExecuteMethod,
    private readonly fields: SelectedFieldsOrdered | undefined,
    private readonly arrayMode: boolean,
    private readonly customResultMapper?: ResultMapper,
  ) {
    super("sync", executeMethod, query);
  }

  private params(placeholderValues?: Record<string, unknown>): SQLInputValue[] {
    return fillPlaceholders(this.query.params, placeholderValues ?? {}) as SQLInputValue[];
  }

  run(placeholderValues?: Record<string, unknown>): StatementResultingChanges {
    return this.stmt.run(...this.params(placeholderValues));
  }

  all(placeholderValues?: Record<string, unknown>): unknown {
    const { fields, customResultMapper } = this;
    if (!fields && !customResultMapper) {
      this.stmt.setReturnArrays(false);
      return this.stmt.all(...this.params(placeholderValues));
    }
    const rows = this.values(placeholderValues);
    if (customResultMapper) return customResultMapper(rows);
    return rows.map((row) => mapResultRow(fields!, row, this.joinsNotNullableMap));
  }

  get(placeholderValues?: Record<string, unknown>): unknown {
    const { fields, customResultMapper } = this;
    this.stmt.setReturnArrays(Boolean(fields || customResultMapper));
    const row = this.stmt.get(...this.params(placeholderValues));
    if (!row || (!fields && !customResultMapper)) return row;
    const values = row as unknown as SQLOutputValue[];
    if (customResultMapper) return customResultMapper([values]);
    return mapResultRow(fields!, values, this.joinsNotNullableMap);
  }

  values(placeholderValues?: Record<string, unknown>): SQLOutputValue[][] {
    this.stmt.setReturnArrays(true);
    return this.stmt.all(...this.params(placeholderValues)) as unknown as SQLOutputValue[][];
  }

  isResponseInArrayMode(): boolean {
    return this.arrayMode;
  }
}

class NodeSQLiteSession extends SQLiteSession<
  "sync",
  StatementResultingChanges,
  Record<string, never>,
  Record<string, never>
> {
  static readonly [entityKind] = "NodeSQLiteSession";

  constructor(
    readonly client: DatabaseSync,
    private readonly nodeDialect: SQLiteSyncDialect,
  ) {
    super(nodeDialect);
  }

  prepareQuery(
    query: Query,
    fields: SelectedFieldsOrdered | undefined,
    executeMethod: SQLiteExecuteMethod,
    isResponseInArrayMode: boolean,
    customResultMapper?: ResultMapper,
  ): NodeSQLitePreparedQuery {
    return new NodeSQLitePreparedQuery(
      this.client.prepare(query.sql),
      query,
      executeMethod,
      fields,
      isResponseInArrayMode,
      customResultMapper,
    );
  }

  transaction<T>(
    fn: (tx: NodeTransaction) => T,
    { behavior = "deferred" }: SQLiteTransactionConfig = {},
  ): T {
    this.client.exec(`BEGIN ${behavior}`);
    try {
      const result = fn(new NodeSQLiteTransaction(this.nodeDialect, this));
      this.client.exec("COMMIT");
      return result;
    } catch (error) {
      if (this.client.isTransaction) this.client.exec("ROLLBACK");
      throw error;
    }
  }
}

class NodeSQLiteTransaction extends SQLiteTransaction<
  "sync",
  StatementResultingChanges,
  Record<string, never>,
  Record<string, never>
> {
  static readonly [entityKind] = "NodeSQLiteTransaction";

  constructor(
    private readonly nodeDialect: SQLiteSyncDialect,
    private readonly nodeSession: NodeSQLiteSession,
    nestedIndex = 0,
  ) {
    super("sync", nodeDialect, nodeSession, undefined, nestedIndex);
  }

  transaction<T>(fn: (tx: NodeTransaction) => T): T {
    const { client } = this.nodeSession;
    const savepoint = `sp${this.nestedIndex}`;
    client.exec(`SAVEPOINT ${savepoint}`);
    try {
      const result = fn(
        new NodeSQLiteTransaction(this.nodeDialect, this.nodeSession, this.nestedIndex + 1),
      );
      client.exec(`RELEASE SAVEPOINT ${savepoint}`);
      return result;
    } catch (error) {
      if (client.isTransaction) {
        client.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
        client.exec(`RELEASE SAVEPOINT ${savepoint}`);
      }
      throw error;
    }
  }
}

export function drizzleNode(client: DatabaseSync): NodeDb {
  const dialect = new SQLiteSyncDialect();
  return new BaseSQLiteDatabase("sync", dialect, new NodeSQLiteSession(client, dialect), undefined);
}

export function sqlite(pathOrOptions: string | { path?: string } = {}) {
  return openSqlite(pathOrOptions, (path) => {
    const client = new DatabaseSync(path);
    return {
      db: drizzleNode(client),
      exec: (sql) => client.exec(sql),
      close: () => client.close(),
    };
  });
}
