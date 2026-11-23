import { parseArgs } from "node:util";

const usage = "Usage: node dist/tools/migrate.mjs [--db <path>]";

try {
  const { values } = parseArgs({
    options: {
      help: { type: "boolean", short: "h" },
      db: { type: "string" },
    },
  });
  if (values.help) {
    console.log(`${usage}

Apply pending registry migrations. The path defaults to DB_PATH or ./data/registry.db.`);
  } else {
    const { sqlite } = "Bun" in globalThis ? await import("../bun.js") : await import("../node.js");
    const database = sqlite({ path: values.db ?? process.env.DB_PATH });
    await database.close();
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  console.error(usage);
  process.exitCode = 1;
}
