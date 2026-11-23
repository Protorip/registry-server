import { InvalidArgumentError, FailedPreconditionError, AbortedError } from "../errors.js";
import { orderUpload } from "../upload-order.js";
import { and, eq } from "drizzle-orm";
import { commits, commitDependencies, labels } from "../schema.js";
import { authorize, type Actor } from "../auth.js";
import type { RegistryConfig, RegistryLogger } from "../config.js";
import { newId, required, type CommitRow, type RegistryDb } from "../db.js";
import { computeB5Digest } from "../digest.js";
import { assignLabel } from "./labels.js";
import { createAccess, createRefs, type ModuleRef, type ScopedLabelRef } from "./refs.js";
import { filePrefix, type BlobStore } from "../storage.js";
import { validateFiles } from "../upload-validation.js";

interface UploadContent {
  moduleRef?: ModuleRef;
  scopedLabelRefs: (ScopedLabelRef | undefined)[];
  files: { path: string; content: Uint8Array }[];
  sourceControlUrl: string;
}

const B5_DIGEST_TYPE = 1;

function findCommit(db: RegistryDb, moduleId: string, digest: string) {
  return db
    .select()
    .from(commits)
    .where(and(eq(commits.module_id, moduleId), eq(commits.digest_value, digest)))
    .get();
}

export function createUpload(
  db: RegistryDb,
  blobs: BlobStore,
  limits: RegistryConfig["limits"],
  allowPublic: boolean,
  log: RegistryLogger,
) {
  const refs = createRefs(db);
  const { access } = createAccess(refs, allowPublic);
  return async function upload(
    req: { contents: UploadContent[]; depCommitIds: string[] },
    actor: Actor | undefined,
    registryHost: string,
  ) {
    authorize(actor, "write");
    const external = [...new Set(req.depCommitIds)].map((id) => {
      const dep = refs.commitById(id);
      access(actor, dep.mod);
      return dep;
    });
    const now = Date.now();
    const contents = req.contents.map((content) => {
      const mod = refs.module(content.moduleRef);
      authorize(actor, "write", mod.slug);
      if (mod.deprecated) throw new FailedPreconditionError("Module is deprecated");
      validateFiles(content.files, limits);
      return { ...content, mod };
    });
    if (new Set(contents.map(({ mod }) => mod.id)).size !== contents.length) {
      throw new InvalidArgumentError("Upload contains duplicate modules");
    }
    const published = new Map<
      (typeof contents)[number],
      { row: CommitRow; mod: (typeof contents)[number]["mod"] }
    >();
    const prepared = orderUpload(contents, (message) => new InvalidArgumentError(message)).map(
      ({ content, dependencies: siblings }) => {
        const { mod } = content;
        const dependencies = [
          ...new Map(
            [...external, ...siblings.map((sibling) => published.get(sibling)!)].map(
              (dependency) => [dependency.row.id, dependency],
            ),
          ).values(),
        ];
        const digests = dependencies.map(({ row }) => Buffer.from(row.digest_value, "hex"));
        const digest = Buffer.from(computeB5Digest(content.files, digests)).toString("hex");
        const existing = findCommit(db, mod.id, digest);
        const row: CommitRow = existing ?? {
          id: newId(),
          module_id: mod.id,
          digest_value: digest,
          digest_type: B5_DIGEST_TYPE,
          create_time: now,
          created_by_user_id: actor!.name,
          source_control_url: content.sourceControlUrl || null,
        };
        published.set(content, { row, mod });
        return {
          mod,
          row,
          dependencies,
          existing,
          files: content.files,
          labelRefs: content.scopedLabelRefs,
        };
      },
    );
    const written: string[] = [];
    try {
      for (const entry of prepared) {
        if (entry.existing) continue;
        const prefix = filePrefix(entry.mod, entry.row.id);
        written.push(prefix);
        for (const file of entry.files) await blobs.put(prefix + file.path, file.content);
      }
      db.transaction(
        (tx) => {
          const txRefs = createRefs(tx);
          for (const { row } of external) txRefs.commitById(row.id);
          for (const { mod, row, existing, labelRefs, dependencies } of prepared) {
            const currentModule = txRefs.module({ case: "id", value: mod.id });
            if (currentModule.deprecated) throw new FailedPreconditionError("Module is deprecated");
            const current = findCommit(tx, mod.id, row.digest_value);
            if (current?.id !== existing?.id)
              throw new AbortedError("Commit changed during upload. Retry the upload.");
            const names = labelRefs.map((ref) => {
              if (ref?.case === "name") return ref?.value;
              return required(
                tx
                  .select()
                  .from(labels)
                  .where(
                    and(
                      eq(labels.module_id, mod.id),
                      eq(
                        labels.id,
                        required(ref?.value, "Label ref required", InvalidArgumentError),
                      ),
                    ),
                  )
                  .get(),
                "Label not found",
              ).name;
            });
            if (!existing) {
              tx.insert(commits).values(row).run();
              for (const dep of dependencies) {
                tx.insert(commitDependencies)
                  .values({
                    commit_id: row.id,
                    dep_commit_id: dep.row.id,
                    dep_registry: registryHost,
                    dep_owner: dep.mod.slug,
                    dep_module: dep.mod.name,
                    dep_digest: dep.row.digest_value,
                  })
                  .run();
              }
            }
            for (const name of names.length ? names : [currentModule.default_label_name])
              assignLabel(tx, mod.id, name, row.id, actor!.name, now);
          }
        },
        { behavior: "immediate" },
      );
    } catch (error) {
      for (const prefix of written) {
        await blobs
          .deletePrefix(prefix)
          .catch(() => log("error", { event: "blob_cleanup_failed", prefix, actor: actor!.name }));
      }
      throw error;
    }
    return contents.map((content) => published.get(content)!);
  };
}
