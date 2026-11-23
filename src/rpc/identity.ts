import { timestampFromMs } from "@bufbuild/protobuf/wkt";
import type { ConnectRouter } from "@connectrpc/connect";
import { authorize } from "../auth.js";
import { AuthnService } from "../gen/buf/alpha/registry/v1alpha1/authn_pb.js";
import { OwnerService } from "../gen/buf/registry/owner/v1/owner_service_pb.js";
import type { createOwners } from "../services/owners.js";
import { parseRef, type GetActor } from "./inputs.js";

export function registerIdentity(
  router: ConnectRouter,
  owners: ReturnType<typeof createOwners>,
  getActor: GetActor,
) {
  router.service(AuthnService, {
    async getCurrentUser(_, ctx) {
      const actor = getActor(ctx);
      authorize(actor, "read");
      return { user: { username: actor!.name } };
    },
  });

  router.service(OwnerService, {
    async getOwners(req, ctx) {
      const rows = await owners.getOwners(req.ownerRefs.map(parseRef), getActor(ctx));
      return {
        owners: rows.map((owner) => ({
          value: {
            case: "organization",
            value: {
              id: owner.id,
              name: owner.slug,
              createTime: timestampFromMs(owner.create_time),
              updateTime: timestampFromMs(owner.update_time),
            },
          },
        })),
      };
    },
  });
}
