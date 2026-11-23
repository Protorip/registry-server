import type { ConnectRouter } from "@connectrpc/connect";
import { DownloadService } from "../gen/buf/registry/module/v1/download_service_pb.js";
import { FileType } from "../gen/buf/registry/module/v1/file_pb.js";
import { UploadService } from "../gen/buf/registry/module/v1/upload_service_pb.js";
import type { createDownloads, DownloadFileType } from "../services/downloads.js";
import type { createUpload } from "../services/uploads.js";
import { commitMessage } from "../wire.js";
import { parseRef, parseResourceRef, type GetActor } from "./inputs.js";

function mapFileType(fileType: FileType): DownloadFileType {
  switch (fileType) {
    case FileType.PROTO:
      return "proto";
    case FileType.DOC:
      return "doc";
    case FileType.LICENSE:
      return "license";
    default:
      return "unknown";
  }
}

export function registerTransfers(
  router: ConnectRouter,
  upload: ReturnType<typeof createUpload>,
  downloads: ReturnType<typeof createDownloads>,
  getActor: GetActor,
) {
  router.service(UploadService, {
    async upload(req, ctx) {
      const commits = await upload(
        {
          depCommitIds: req.depCommitIds,
          contents: req.contents.map(({ moduleRef, scopedLabelRefs, files, sourceControlUrl }) => ({
            moduleRef: parseRef(moduleRef),
            scopedLabelRefs: scopedLabelRefs.map(parseRef),
            files: files.map(({ path, content }) => ({ path, content })),
            sourceControlUrl,
          })),
        },
        getActor(ctx),
        new URL(ctx.url).host,
      );
      return { commits: commits.map(({ row, mod }) => commitMessage(row, mod)) };
    },
  });
  router.service(DownloadService, {
    async download(req, ctx) {
      const contents = await downloads.download(
        req.values.map(({ resourceRef, fileTypes, paths, pathsAllowNotExist }) => ({
          resourceRef: parseResourceRef(resourceRef),
          fileTypes: fileTypes.map(mapFileType),
          paths,
          pathsAllowNotExist,
        })),
        getActor(ctx),
      );
      return {
        contents: contents.map(({ row, mod, files }) => ({
          commit: commitMessage(row, mod),
          files,
        })),
      };
    },
  });
}
