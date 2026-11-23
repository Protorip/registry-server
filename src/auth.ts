import { UnauthenticatedError, PermissionDeniedError } from "./errors.js";
import { ConfigurationError } from "./config.js";
import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import type { RegistryConfig, RegistryLogger, StaticTokenEntry, TokenRole } from "./config.js";

export const tokenPrefix = "psr_";

const roles = { read: 1, write: 2, admin: 3 };
export const hashToken = (secret: string) => createHash("sha256").update(secret).digest();

export function parseTokens(input: string): StaticTokenEntry[] {
  const text = input.trim();
  if (text.startsWith("[")) {
    try {
      return JSON.parse(text);
    } catch {
      throw new ConfigurationError("Invalid token JSON");
    }
  }
  return text
    .split(/[,\n]+/)
    .filter((entry) => entry.trim())
    .map((entry) => {
      const [name, format, secret, role, ...rest] = entry.trim().split(":");
      if (!secret || rest.length || (format !== "sha256" && format !== "plain")) {
        throw new ConfigurationError("Invalid token entry");
      }
      return {
        name,
        role: role as TokenRole,
        ...(format === "plain" ? { plain: secret } : { hash: `sha256:${secret}` }),
      };
    });
}

export interface Actor {
  name: string;
  role: TokenRole;
  scopes: string[];
}

function tokenMap(entries: StaticTokenEntry[]) {
  const seen = new Set<string>();
  return entries.map((entry) => {
    if (
      !entry ||
      typeof entry.name !== "string" ||
      !/^[a-zA-Z0-9_.-]{1,128}$/.test(entry.name) ||
      entry.name.startsWith(tokenPrefix) ||
      !Object.hasOwn(roles, entry.role ?? "admin") ||
      (entry.scopes !== undefined &&
        (!Array.isArray(entry.scopes) || entry.scopes.some((scope) => typeof scope !== "string")))
    ) {
      throw new ConfigurationError("Invalid token identity, role or scopes");
    }
    const hasHash = typeof entry.hash === "string" && /^sha256:[a-fA-F0-9]{64}$/.test(entry.hash);
    const hasPlain = typeof entry.plain === "string" && entry.plain.length > 0;
    if (hasHash === hasPlain)
      throw new ConfigurationError("Each token needs exactly one valid hash or plaintext secret");
    if (hasPlain && !entry.plain!.startsWith(tokenPrefix)) {
      throw new ConfigurationError("Plaintext tokens must start with psr_");
    }
    const digest = hasHash ? Buffer.from(entry.hash!.slice(7), "hex") : hashToken(entry.plain!);
    const key = digest.toString("hex");
    if (seen.has(key)) throw new ConfigurationError("Duplicate token credentials");
    seen.add(key);
    return {
      digest,
      actor: { name: entry.name, role: entry.role ?? "admin", scopes: entry.scopes ?? ["*"] },
    };
  });
}

export function createAuth(config: RegistryConfig["auth"], log: RegistryLogger) {
  if (config.mode === "none") {
    return {
      allowPublic: true,
      authenticate: () => ({ name: "anonymous", role: "admin", scopes: ["*"] }) as Actor,
      close() {},
    };
  }
  if (config.mode !== "static") throw new ConfigurationError("AUTH_MODE must be static or none");
  const file = config.tokensFile;
  let entries: ReturnType<typeof tokenMap>;
  let version: string | undefined;
  const reload = (initial: boolean, force: boolean) => {
    try {
      const stat = file ? statSync(file) : undefined;
      const nextVersion = stat ? `${stat.ino}:${stat.mtimeMs}:${stat.ctimeMs}` : undefined;
      if (!force && version === nextVersion) return;
      const next = tokenMap([
        ...(config.tokens ?? []),
        ...(file ? parseTokens(readFileSync(file, "utf8")) : []),
      ]);
      if (!next.length) throw new ConfigurationError("AUTH_MODE=static requires tokens");
      entries = next;
      version = nextVersion;
      if (file) log("info", { event: "tokens_reloaded" });
    } catch (error) {
      if (initial) {
        if (error instanceof ConfigurationError) throw error;
        const code = (error as NodeJS.ErrnoException).code;
        if (file && code) {
          const reason =
            code === "ENOENT"
              ? "file not found"
              : code === "EACCES" || code === "EPERM"
                ? "permission denied"
                : code === "EISDIR"
                  ? "expected a file, found a directory"
                  : "unable to read file";
          throw new ConfigurationError(`Failed to load TOKENS_FILE: ${reason}`);
        }
        throw new ConfigurationError("AUTH_MODE=static requires valid token configuration");
      }
      log("warn", { event: "tokens_reload_failed" });
    }
  };
  reload(true, true);
  const signal = () => reload(false, true);
  if (file) process.on("SIGHUP", signal);
  const timer = file ? setInterval(() => reload(false, false), 1000).unref() : undefined;
  return {
    allowPublic: config.allowPublicModules ?? false,
    authenticate(header: string | null) {
      if (!header) return undefined;
      const match = /^Bearer ([^\s,]+)$/i.exec(header);
      if (!match?.[1].startsWith(tokenPrefix)) throw new UnauthenticatedError("Invalid token");
      const digest = hashToken(match[1]);
      const actor = entries.find((entry) => timingSafeEqual(entry.digest, digest))?.actor;
      if (!actor) throw new UnauthenticatedError("Invalid token");
      return actor;
    },
    close() {
      if (file) process.off("SIGHUP", signal);
      clearInterval(timer);
    },
  };
}

export function authorize(
  actor: Actor | undefined,
  role: TokenRole,
  scope?: string,
  publicRead = false,
) {
  if (role === "read" && publicRead) return;
  if (!actor) throw new UnauthenticatedError("Authentication required");
  if (
    roles[actor.role] < roles[role] ||
    (scope && !actor.scopes.includes("*") && !actor.scopes.includes(scope))
  ) {
    throw new PermissionDeniedError("Token lacks permission");
  }
}
