import type { ConnectRouter } from "@connectrpc/connect";
import { CommitService } from "../gen/buf/registry/module/v1/commit_service_pb.js";
import { GraphService } from "../gen/buf/registry/module/v1/graph_service_pb.js";
import { ResourceService } from "../gen/buf/registry/module/v1/resource_service_pb.js";
import type { createCommits } from "../services/commits.js";
import { commitMessage, labelMessage, moduleMessage } from "../wire.js";
import { mapOrder, parseResourceRef, type GetActor } from "./inputs.js";

export function registerCommits(
  router: ConnectRouter,
  commits: ReturnType<typeof createCommits>,
  getActor: GetActor,
) {
  router.service(CommitService, {
    async getCommits(req, ctx) {
      const rows = await commits.getCommits(req.resourceRefs.map(parseResourceRef), getActor(ctx));
      return { commits: rows.map(({ row, mod }) => commitMessage(row, mod)) };
    },
    async listCommits(req, ctx) {
      const result = await commits.listCommits(
        {
          resourceRef: parseResourceRef(req.resourceRef),
          order: mapOrder(req.order),
          idQuery: req.idQuery,
          pageSize: req.pageSize,
          pageToken: req.pageToken,
        },
        getActor(ctx),
      );
      return {
        commits: result.commits.map((row) => commitMessage(row, result.mod)),
        nextPageToken: result.nextPageToken,
      };
    },
  });
  router.service(ResourceService, {
    async getResources(req, ctx) {
      const resources = await commits.getResources(
        req.resourceRefs.map(parseResourceRef),
        getActor(ctx),
      );
      return {
        resources: resources.map(({ row, label, mod }) => {
          if (label) return { value: { case: "label", value: labelMessage(label, mod) } };
          if (row) return { value: { case: "commit", value: commitMessage(row, mod) } };
          return { value: { case: "module", value: moduleMessage(mod) } };
        }),
      };
    },
  });
  router.service(GraphService, {
    async getGraph(req, ctx) {
      const graph = await commits.getGraph(req.resourceRefs.map(parseResourceRef), getActor(ctx));
      return {
        graph: {
          commits: graph.commits.map(({ row, mod }) => commitMessage(row, mod)),
          edges: graph.edges.map(({ fromCommitId, toCommitId }) => ({
            fromNode: { commitId: fromCommitId },
            toNode: { commitId: toCommitId },
          })),
        },
      };
    },
  });
}
