import type { ConnectRouter } from "@connectrpc/connect";
import { ModuleState } from "../gen/buf/registry/module/v1/module_pb.js";
import { ModuleService } from "../gen/buf/registry/module/v1/module_service_pb.js";
import type { createModules } from "../services/modules.js";
import { moduleMessage } from "../wire.js";
import { mapOrder, parseRef, type GetActor } from "./inputs.js";

export function registerModules(
  router: ConnectRouter,
  modules: ReturnType<typeof createModules>,
  getActor: GetActor,
) {
  router.service(ModuleService, {
    async getModules(req, ctx) {
      const rows = await modules.getModules(req.moduleRefs.map(parseRef), getActor(ctx));
      return { modules: rows.map(moduleMessage) };
    },
    async listModules(req, ctx) {
      const result = await modules.listModules(
        {
          ownerRefs: req.ownerRefs.map(parseRef),
          order: mapOrder(req.order),
          pageSize: req.pageSize,
          pageToken: req.pageToken,
        },
        getActor(ctx),
      );
      return { modules: result.values.map(moduleMessage), nextPageToken: result.nextPageToken };
    },
    async createModules(req, ctx) {
      const rows = await modules.createModules(
        req.values.map(({ ownerRef, name, visibility, defaultLabelName, description, url }) => ({
          ownerRef: parseRef(ownerRef),
          name,
          visibility,
          defaultLabelName,
          description,
          url,
        })),
        getActor(ctx),
      );
      return { modules: rows.map(moduleMessage) };
    },
    async updateModules(req, ctx) {
      const rows = await modules.updateModules(
        req.values.map(({ moduleRef, state, visibility, defaultLabelName, description, url }) => ({
          moduleRef: parseRef(moduleRef),
          deprecated: state === undefined ? undefined : state === ModuleState.DEPRECATED,
          visibility,
          defaultLabelName,
          description,
          url,
        })),
        getActor(ctx),
      );
      return { modules: rows.map(moduleMessage) };
    },
    async deleteModules(req, ctx) {
      await modules.deleteModules(req.moduleRefs.map(parseRef), getActor(ctx));
      return {};
    },
  });
}
