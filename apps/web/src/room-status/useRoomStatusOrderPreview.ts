import { useEffect, useState } from "react";
import { api } from "../api";
import { assertOrderViewAllowedActions } from "../orderViewValidation";
import type { MemberViewDto, OrderViewDto } from "../types";
import type { RoomStatusOrderIdentity } from "./roomStatusState";

export function roomStatusOrderPreviewKey(scope: string, revision: string | undefined, identity: Pick<RoomStatusOrderIdentity, "orderId" | "stayId"> | undefined) {
  return identity ? JSON.stringify([scope, revision, identity.orderId, identity.stayId]) : "";
}

export interface RoomStatusOrderPreview {
  key: string;
  view?: OrderViewDto;
  memberView?: MemberViewDto;
  error?: unknown;
}

// Hover reads are independent of the selected order and never replace an open drawer or draft.
export function useRoomStatusOrderPreview(options: {
  identity: RoomStatusOrderIdentity | undefined;
  propertyId: string;
  scope: string;
  revision: string | undefined;
  allowedActions: ReadonlySet<string>;
}) {
  const { identity, propertyId, scope, revision, allowedActions } = options;
  const key = roomStatusOrderPreviewKey(scope, revision, identity);
  const [result, setResult] = useState<RoomStatusOrderPreview>({ key: "" });
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!identity) return;
    let current = true;
    const controller = new AbortController();
    setResult({ key });
    const timeout = window.setTimeout(() => {
      if (!current) return;
      current = false;
      controller.abort();
      setResult({ key, error: new Error("订单信息载入超时，请重新载入。") });
    }, 15_000);
    api.order(identity.orderId, controller.signal).then((view) => {
      if (!current) return;
      if (view.order.id !== identity.orderId || view.stay.id !== identity.stayId || view.order.property_id !== propertyId) {
        throw new Error("订单详情与当前房态的住宿记录不一致。");
      }
      assertOrderViewAllowedActions(view, allowedActions);
      window.clearTimeout(timeout);
      setResult({ key, view });
      const memberId = view.order.member_id;
      if (memberId) void api.member(memberId, propertyId).then((memberView) => {
        if (current && memberView.member.id === memberId) setResult({ key, view, memberView });
      }).catch(() => { /* The order facts remain available without an optional balance lookup. */ });
    }).catch((error: unknown) => {
      if (current) setResult({ key, error });
    }).finally(() => window.clearTimeout(timeout));
    return () => { current = false; window.clearTimeout(timeout); controller.abort(); };
  }, [key, retry, propertyId, allowedActions]);
  return {
    ...(result.key === key ? result : { key }),
    loading: Boolean(identity && (result.key !== key || (!result.view && !result.error))),
    retry: () => setRetry((value) => value + 1)
  };
}
