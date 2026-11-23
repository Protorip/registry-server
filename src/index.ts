import { ConfigurationError } from "./config.js";
import { createRegistry } from "@bufbuild/protobuf";
import { file_buf_registry_priv_validate_v1beta1_validate } from "./gen/buf/registry/priv/validate/v1beta1/validate_pb.js";
import { gzip, gunzip } from "node:zlib";
import { promisify } from "node:util";
import {
  Code,
  ConnectError,
  createConnectRouter,
  createContextKey,
  type HandlerContext,
  type Interceptor,
} from "@connectrpc/connect";
import { createFetchHandler } from "@connectrpc/connect/protocol";
import { createValidator } from "@bufbuild/protovalidate";
import { createAuth, type Actor } from "./auth.js";
import type { RegistryConfig, RegistryLogger } from "./config.js";

import { UnauthenticatedError } from "./errors.js";
import { mapError } from "./rpc/errors.js";
import { registerServices } from "./rpc/index.js";
import { createBlobStore } from "./storage.js";

export { ConfigurationError } from "./config.js";
export { migrate } from "./driver.js";
export type { RegistryDb } from "./db.js";
export type {
  LogLevel,
  RegistryConfig,
  RegistryDatabase,
  RegistryLogger,
  StaticTokenEntry,
  StorageConfig,
  TokenRole,
} from "./config.js";

const actorKey = createContextKey<Actor | undefined>(undefined);
const getActor = (ctx: HandlerContext) => ctx.values.get(actorKey);
const mutations = new Set([
  "Upload",
  "CreateModules",
  "UpdateModules",
  "DeleteModules",
  "CreateOrUpdateLabels",
  "ArchiveLabels",
  "UnarchiveLabels",
]);
const compress = promisify(gzip);
const decompress = promisify(gunzip);

export function createRegistryHandler(config: RegistryConfig): {
  fetch(request: Request): Promise<Response>;
  close(): Promise<void>;
} {
  const logger: RegistryLogger =
    config.logger ??
    ((level, event) => {
      if (level === "warn" || level === "error") console.error(JSON.stringify({ level, ...event }));
    });
  const log: RegistryLogger = (level, event) => {
    try {
      logger(level, event);
    } catch {
      // A host logging failure cannot change an RPC outcome.
    }
  };
  for (const limit of Object.values(config.limits ?? {})) {
    if (!Number.isSafeInteger(limit) || limit <= 0)
      throw new ConfigurationError("Limits must be positive integers");
  }
  const auth = createAuth(config.auth, log);
  let blobs: ReturnType<typeof createBlobStore> | undefined;
  try {
    blobs = createBlobStore(config.storage);
    const validator = createValidator({
      registry: createRegistry(file_buf_registry_priv_validate_v1beta1_validate),
    });
    const intercept: Interceptor = (next) => async (request) => {
      let actor: Actor | undefined;
      const method = request.method.name;
      try {
        request.signal.throwIfAborted();
        actor = auth.authenticate(request.header.get("authorization"));
        if (!actor && (!auth.allowPublic || mutations.has(method))) {
          throw new UnauthenticatedError("Authentication required");
        }
        request.contextValues.set(actorKey, actor);
        if (!request.stream) {
          const result = validator.validate(request.method.input, request.message);
          if (result.kind === "error")
            throw new ConnectError("Invalid validation configuration", Code.Internal);
          if (result.kind === "invalid")
            throw new ConnectError("Request validation failed", Code.InvalidArgument);
        }
        const response = await next(request);
        log(mutations.has(method) ? "info" : "debug", {
          event: "rpc",
          method,
          actor: actor?.name ?? "anonymous",
        });
        return response;
      } catch (error) {
        const failure = mapError(error);
        if (failure.code === Code.PermissionDenied || failure.code === Code.Unauthenticated) {
          log("warn", {
            event: "rpc_denied",
            method,
            actor: actor?.name ?? "anonymous",
            code: failure.code,
          });
        }
        if (failure.code === Code.Internal || failure.code === Code.Unknown) {
          log("error", { event: "rpc_error", method, actor: actor?.name ?? "anonymous" });
          throw new ConnectError("Internal registry error", Code.Internal);
        }
        throw failure;
      }
    };
    const router = createConnectRouter({
      grpc: false,
      grpcWeb: false,
      readMaxBytes: 64 * 1024 * 1024,
      acceptCompression: [
        {
          name: "gzip",
          compress: (bytes) => compress(bytes),
          decompress: (bytes, limit) => decompress(bytes, { maxOutputLength: limit }),
        },
      ],
      interceptors: [intercept],
    });
    registerServices(router, config.database.db, blobs, config, auth.allowPublic, getActor, log);
    const handlers = new Map(
      router.handlers.map((handler) => [handler.requestPath, createFetchHandler(handler)]),
    );
    const pending = new Set<Promise<Response>>();
    const blobStore = blobs;
    let closing: Promise<void> | undefined;
    return {
      async fetch(request) {
        if (closing) return new Response(null, { status: 503 });
        const path = new URL(request.url).pathname;
        if (path === "/healthz" && (request.method === "GET" || request.method === "HEAD")) {
          try {
            config.database.db.run("SELECT 1");
          } catch {
            return new Response(null, { status: 503 });
          }
          return new Response(request.method === "GET" ? '{"status":"ok"}' : null, {
            headers: { "Content-Type": "application/json" },
          });
        }
        const handler = handlers.get(path);
        if (!handler) return new Response(null, { status: 404 });
        const response = handler(request);
        pending.add(response);
        try {
          return await response;
        } finally {
          pending.delete(response);
        }
      },
      close() {
        return (closing ??= Promise.allSettled(pending).then(async () => {
          try {
            auth.close();
          } finally {
            try {
              blobStore.close();
            } finally {
              await config.database.close();
            }
          }
        }));
      },
    };
  } catch (error) {
    auth.close();
    blobs?.close();
    throw error;
  }
}
