import { and, eq } from "drizzle-orm";
import { authorize, type Actor } from "../auth.js";
import { required, type RegistryDb } from "../db.js";
import { modules } from "../schema.js";
import { createRefs, PUBLIC_MODULE_VISIBILITY, type OwnerRef } from "./refs.js";

export function createOwners(db: RegistryDb, allowPublic: boolean) {
  const refs = createRefs(db);
  return {
    async getOwners(ownerRefs: (OwnerRef | undefined)[], actor: Actor | undefined) {
      authorize(actor, "read", undefined, allowPublic);
      return ownerRefs.map((ref) => {
        const match = refs.owner(ref);
        if (!match) authorize(actor, "read");
        const owner = required(match, "Owner not found");
        authorize(
          actor,
          "read",
          owner.slug,
          allowPublic &&
            Boolean(
              db
                .select({ id: modules.id })
                .from(modules)
                .where(
                  and(
                    eq(modules.scope_id, owner.id),
                    eq(modules.visibility, PUBLIC_MODULE_VISIBILITY),
                  ),
                )
                .get(),
            ),
        );
        return owner;
      });
    },
  };
}
