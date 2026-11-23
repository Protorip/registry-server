import type { HandlerContext } from "@connectrpc/connect";
import type { Actor } from "../auth.js";
import type { TimeOrder } from "../db.js";
import { ListLabelsRequest_Order } from "../gen/buf/registry/module/v1/label_service_pb.js";
import type { ResourceRef as ProtoResourceRef } from "../gen/buf/registry/module/v1/resource_pb.js";
import type { Ref, ResourceRef } from "../services/refs.js";

export type GetActor = (ctx: HandlerContext) => Actor | undefined;

export function parseRef<T>(ref?: { value: Ref<T> }): Ref<T> | undefined {
  return ref?.value;
}

export function parseResourceRef(ref?: ProtoResourceRef): ResourceRef | undefined {
  const value = parseRef(ref);
  if (value?.case !== "name") return value;
  const { owner, module, child } = value.value;
  return {
    case: "name",
    value: { owner, module, child: child.case === undefined ? undefined : child },
  };
}

export function mapOrder(order: number): TimeOrder {
  switch (order) {
    case ListLabelsRequest_Order.CREATE_TIME_ASC:
      return "created-asc";
    case ListLabelsRequest_Order.UPDATE_TIME_DESC:
      return "updated-desc";
    case ListLabelsRequest_Order.UPDATE_TIME_ASC:
      return "updated-asc";
    default:
      return "created-desc";
  }
}
