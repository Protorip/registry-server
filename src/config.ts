import type { RegistryDb } from "./db.js";

export type TokenRole = "read" | "write" | "admin";
export type LogLevel = "debug" | "info" | "warn" | "error";
export type RegistryLogger = (level: LogLevel, event: Record<string, string | number>) => void;

export interface StaticTokenEntry {
  name: string;
  hash?: string;
  plain?: string;
  role?: TokenRole;
  scopes?: string[];
}

export type StorageConfig =
  | { type: "fs"; rootDir: string }
  | {
      type: "s3";
      bucket: string;
      region?: string;
      endpoint?: string;
      prefix?: string;
      accessKeyId?: string;
      secretAccessKey?: string;
      forcePathStyle?: boolean;
    };

export interface RegistryDatabase {
  db: RegistryDb;
  close(): void | Promise<void>;
}

export interface RegistryConfig {
  database: RegistryDatabase;
  storage: StorageConfig;
  auth:
    | { mode: "none" }
    | {
        mode: "static";
        tokens?: StaticTokenEntry[];
        tokensFile?: string;
        allowPublicModules?: boolean;
      };
  allowedScopes?: string[];
  limits?: { maxFileBytes?: number; maxCommitBytes?: number; maxFilesPerCommit?: number };
  logger?: RegistryLogger;
}

export class ConfigurationError extends Error {}
