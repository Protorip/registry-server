import { NotFoundError } from "../errors.js";
import { eq } from "drizzle-orm";
import type { Actor } from "../auth.js";
import { required, type RegistryDb } from "../db.js";
import { commits } from "../schema.js";
import { filePrefix, isMissingBlob, type BlobStore } from "../storage.js";
import { createAccess, createRefs, type ResourceRef } from "./refs.js";

export type DownloadFileType = "proto" | "doc" | "license" | "unknown";

interface DownloadSelection {
  resourceRef?: ResourceRef;
  fileTypes: DownloadFileType[];
  paths: string[];
  pathsAllowNotExist: boolean;
}

export function createDownloads(db: RegistryDb, blobs: BlobStore, allowPublic: boolean) {
  const { resolve } = createAccess(createRefs(db), allowPublic);
  return {
    async download(values: DownloadSelection[], actor: Actor | undefined) {
      const contents = [];
      for (const value of values) {
        const { row, mod } = resolve(actor, value.resourceRef, true);
        const commit = required(row, "Commit not found");
        const prefix = filePrefix(mod, commit.id);
        const commitExists = () =>
          db.select({ id: commits.id }).from(commits).where(eq(commits.id, commit.id)).get();
        try {
          const keys = (await blobs.listPrefix(prefix)).sort();
          if (!keys.length) {
            if (!commitExists()) throw new NotFoundError("Commit not found");
            throw new Error(`Commit ${commit.id} files missing from storage`);
          }
          const candidates = keys
            .map((key) => ({ key, path: key.slice(prefix.length) }))
            .filter(
              ({ path }) =>
                !value.fileTypes.length || value.fileTypes.some((type) => matchesType(path, type)),
            );
          if (
            !value.pathsAllowNotExist &&
            value.paths.some((path) => !candidates.some((file) => matchesPath(file.path, path)))
          ) {
            throw new NotFoundError("Requested path not found");
          }
          const selection = candidates.filter(
            ({ path }) =>
              !value.paths.length || value.paths.some((requested) => matchesPath(path, requested)),
          );
          const files = [];
          for (const { key, path } of selection)
            files.push({ path, content: await blobs.get(key) });
          contents.push({ row: commit, mod, files });
        } catch (error) {
          if (isMissingBlob(error) && !commitExists()) {
            throw new NotFoundError("Commit not found");
          }
          throw error;
        }
      }
      return contents;
    },
  };
}

function matchesPath(file: string, path: string) {
  return file === path || file.startsWith(path + "/");
}

function matchesType(path: string, type: DownloadFileType) {
  if (type === "proto") return path.endsWith(".proto");
  if (type === "doc") return ["README.md", "README.markdown", "buf.md"].includes(path);
  return type === "license" && path === "LICENSE";
}
