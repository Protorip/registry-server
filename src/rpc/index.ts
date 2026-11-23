import type { ConnectRouter } from "@connectrpc/connect";
import type { RegistryConfig, RegistryLogger } from "../config.js";
import type { RegistryDb } from "../db.js";
import { createCommits } from "../services/commits.js";
import { createDownloads } from "../services/downloads.js";
import { createLabels } from "../services/labels.js";
import { createModules } from "../services/modules.js";
import { createOwners } from "../services/owners.js";
import { createUpload } from "../services/uploads.js";
import type { BlobStore } from "../storage.js";
import { registerCommits } from "./commits.js";
import { registerIdentity } from "./identity.js";
import type { GetActor } from "./inputs.js";
import { registerLabels } from "./labels.js";
import { registerModules } from "./modules.js";
import { registerTransfers } from "./transfers.js";

export function registerServices(
  router: ConnectRouter,
  db: RegistryDb,
  blobs: BlobStore,
  config: RegistryConfig,
  allowPublic: boolean,
  getActor: GetActor,
  log: RegistryLogger,
) {
  registerIdentity(router, createOwners(db, allowPublic), getActor);
  registerModules(
    router,
    createModules(db, blobs, config.allowedScopes, allowPublic, log),
    getActor,
  );
  registerLabels(router, createLabels(db, allowPublic), getActor);
  registerCommits(router, createCommits(db, allowPublic), getActor);
  registerTransfers(
    router,
    createUpload(db, blobs, config.limits, allowPublic, log),
    createDownloads(db, blobs, allowPublic),
    getActor,
  );
}
