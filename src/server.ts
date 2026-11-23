import { serve } from "@hono/node-server";
import { parseTokens } from "./auth.js";
import { ConfigurationError, type LogLevel, type RegistryConfig } from "./config.js";
import { createRegistryHandler } from "./index.js";

function flag(value: string | undefined) {
  if (value === undefined || value === "false") return false;
  if (value === "true") return true;
  throw new ConfigurationError("Expected true or false");
}

function configFromEnv(env: NodeJS.ProcessEnv): Omit<RegistryConfig, "database"> {
  const mode = env.AUTH_MODE ?? "static";
  if (mode !== "static" && mode !== "none")
    throw new ConfigurationError("AUTH_MODE must be static or none");
  const storage = env.STORAGE_BACKEND ?? "fs";
  if (storage !== "fs" && storage !== "s3")
    throw new ConfigurationError("STORAGE_BACKEND must be fs or s3");
  const scopes = env.ALLOWED_SCOPES?.split(",")
    .map((scope) => scope.trim())
    .filter(Boolean);
  return {
    allowedScopes: scopes?.length ? scopes : undefined,
    auth:
      mode === "none"
        ? { mode }
        : {
            mode,
            tokens: parseTokens(env.TOKENS ?? ""),
            tokensFile: env.TOKENS_FILE,
            allowPublicModules: flag(env.ALLOW_PUBLIC_MODULES),
          },
    storage:
      storage === "fs"
        ? { type: storage, rootDir: env.FS_ROOT ?? "./data/blobs" }
        : {
            type: storage,
            bucket: env.S3_BUCKET ?? "",
            region: env.S3_REGION,
            endpoint: env.S3_ENDPOINT,
            prefix: env.S3_PREFIX,
            accessKeyId: env.S3_ACCESS_KEY_ID,
            secretAccessKey: env.S3_SECRET_ACCESS_KEY,
            forcePathStyle: flag(env.S3_FORCE_PATH_STYLE),
          },
  };
}

async function main() {
  if (process.argv.length > 2)
    throw new ConfigurationError("Configure the server with environment variables");
  const port = Number(process.env.PORT?.trim() || 8080);
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new ConfigurationError("Invalid PORT");
  const levels: LogLevel[] = ["debug", "info", "warn", "error"];
  const threshold = levels.indexOf((process.env.LOG_LEVEL ?? "info") as LogLevel);
  if (threshold < 0) throw new ConfigurationError("Invalid LOG_LEVEL");
  const config = configFromEnv(process.env);
  config.logger = (level, event) => {
    if (levels.indexOf(level) < threshold) return;
    const stream = level === "warn" || level === "error" ? process.stderr : process.stdout;
    stream.write(JSON.stringify({ level, ...event }) + "\n");
  };
  const { sqlite } = "Bun" in globalThis ? await import("./bun.js") : await import("./node.js");
  const database = sqlite({ path: process.env.DB_PATH });
  let registry;
  try {
    registry = createRegistryHandler({ ...config, database });
  } catch (error) {
    await database.close();
    throw error;
  }
  const server = serve({ fetch: registry.fetch, port }, (address) => {
    config.logger!("info", {
      event: "listening",
      port: address.port,
      auth: config.auth.mode,
      storage: config.storage.type,
    });
  });
  server.once("error", () => {
    config.logger!("error", { event: "listen_failed" });
    process.exitCode = 1;
    void registry.close();
  });
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => server.close(() => void registry.close()));
  }
}

main().catch((error: unknown) => {
  console.error(
    JSON.stringify({
      level: "error",
      event: "startup_failed",
      message:
        error instanceof ConfigurationError
          ? error.message
          : "Check registry configuration and SQLite access",
    }),
  );
  process.exitCode = 1;
});
