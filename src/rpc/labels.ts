import type { ConnectRouter } from "@connectrpc/connect";
import {
  LabelService,
  ListLabelHistoryRequest_Order,
  ListLabelsRequest_ArchiveFilter,
} from "../gen/buf/registry/module/v1/label_service_pb.js";
import type { createLabels } from "../services/labels.js";
import { commitMessage, labelMessage } from "../wire.js";
import { mapOrder, parseRef, parseResourceRef, type GetActor } from "./inputs.js";

function mapArchiveFilter(filter: ListLabelsRequest_ArchiveFilter) {
  switch (filter) {
    case ListLabelsRequest_ArchiveFilter.ALL:
      return "all";
    case ListLabelsRequest_ArchiveFilter.ARCHIVED_ONLY:
      return "archived";
    default:
      return "unarchived";
  }
}

export function registerLabels(
  router: ConnectRouter,
  labels: ReturnType<typeof createLabels>,
  getActor: GetActor,
) {
  router.service(LabelService, {
    async getLabels(req, ctx) {
      const rows = await labels.getLabels(req.labelRefs.map(parseRef), getActor(ctx));
      return { labels: rows.map(({ label, mod }) => labelMessage(label, mod)) };
    },
    async listLabels(req, ctx) {
      const result = await labels.listLabels(
        {
          resourceRef: parseResourceRef(req.resourceRef),
          order: mapOrder(req.order),
          nameQuery: req.nameQuery,
          archiveFilter: mapArchiveFilter(req.archiveFilter),
          filterByCommitChecks: req.commitCheckStatuses.length > 0,
          pageSize: req.pageSize,
          pageToken: req.pageToken,
        },
        getActor(ctx),
      );
      return {
        labels: result.labels.map((label) => labelMessage(label, result.mod)),
        nextPageToken: result.nextPageToken,
      };
    },
    async listLabelHistory(req, ctx) {
      const result = await labels.listLabelHistory(
        {
          labelRef: parseRef(req.labelRef),
          ascending: req.order === ListLabelHistoryRequest_Order.ASC,
          startCommitId: req.startCommitId,
          filterByCommitChecks: req.commitCheckStatuses.length > 0,
          pageSize: req.pageSize,
          pageToken: req.pageToken,
        },
        getActor(ctx),
      );
      return {
        values: result.commits.map((row) => ({ commit: commitMessage(row, result.mod) })),
        nextPageToken: result.nextPageToken,
      };
    },
    async createOrUpdateLabels(req, ctx) {
      const rows = await labels.createOrUpdateLabels(
        req.values.map(({ commitId, labelRef }) => ({ commitId, labelRef: parseRef(labelRef) })),
        getActor(ctx),
      );
      return { labels: rows.map(({ label, mod }) => labelMessage(label, mod)) };
    },
    async archiveLabels(req, ctx) {
      await labels.archiveLabels(req.labelRefs.map(parseRef), getActor(ctx));
      return {};
    },
    async unarchiveLabels(req, ctx) {
      await labels.unarchiveLabels(req.labelRefs.map(parseRef), getActor(ctx));
      return {};
    },
  });
}
