import type { InventoryUnitDto, MemberDto, MembershipProductDto, OrderViewDto } from "./types";

export const STAY_MEMBERSHIP_UPGRADE_ACTION = "STAY_MEMBERSHIP_UPGRADE" as const;

export interface StayMembershipUpgradeIntent {
  action: typeof STAY_MEMBERSHIP_UPGRADE_ACTION;
  orderId: string;
  primaryOccupantId: string;
  phone?: string;
  memberId?: string;
}

export interface StayUpgradeMemberCreationIntent {
  action: typeof STAY_MEMBERSHIP_UPGRADE_ACTION;
  orderId: string;
  primaryOccupantId: string;
  phone: string;
  prefill: {
    fullName: string;
    nickname: string;
  };
}

export interface StayUpgradeMemberCreationState {
  fullName: string;
  nickname: string;
  phone: string;
  returnTo: {
    action: typeof STAY_MEMBERSHIP_UPGRADE_ACTION;
    orderId: string;
    primaryOccupantId: string;
    phone: string;
  };
}

export type StayMembershipUpgradeEntry =
  | {
    state: "READY";
    orderId: string;
    primaryOccupantId: string;
    phone: string;
    memberId: string;
    transferableCollectionFactIds: string[];
  }
  | {
    state: "CORRECT_PRIMARY_OCCUPANT";
    orderId: string;
    primaryOccupantId: string;
    reason: "PRIMARY_PHONE_REQUIRED";
  }
  | {
    state: "CREATE_MEMBER";
    orderId: string;
    primaryOccupantId: string;
    prefill: {
      fullName: string;
      nickname: string;
      phone: string;
    };
    returnTo: {
      action: typeof STAY_MEMBERSHIP_UPGRADE_ACTION;
      orderId: string;
      primaryOccupantId: string;
      phone: string;
    };
  }
  | {
    state: "UNAVAILABLE";
    reason: "PRIMARY_OCCUPANT_REQUIRED" | "MEMBER_PHONE_AMBIGUOUS" | "MEMBERSHIP_PRODUCT_NOT_APPLICABLE" | "ACTION_NOT_AVAILABLE";
  };

export function normalizeStayUpgradePhone(value: string | null | undefined): string {
  return value?.replace(/\s+/g, "") ?? "";
}

export function membershipProductMatchesCurrentStay(
  product: MembershipProductDto,
  view: OrderViewDto,
  unitMap: ReadonlyMap<string, InventoryUnitDto>
): boolean {
  const unitIds = [...new Set(view.effectiveArrangement.intervals.map((interval) => interval.inventoryUnitId))];
  if (!unitIds.length) return false;
  return unitIds.every((unitId) => {
    const unit = unitMap.get(unitId);
    return unit
      && unit.kind === product.allowed_inventory_kind
      && unit.room_type_code === product.allowed_room_type_code
      && (unit.kind === "ROOM" ? product.entitlement_unit_kind === "ROOM_NIGHT" : product.entitlement_unit_kind === "BED_NIGHT");
  });
}

function transferableCollectionFactIds(view: OrderViewDto): string[] {
  const reversed = new Set(view.collectionFacts
    .filter((fact) => fact.fact_type === "REVERSAL" && fact.reverses_fact_id)
    .map((fact) => fact.reverses_fact_id!));
  return view.collectionFacts.filter((fact) => {
    if (fact.fact_type !== "COLLECTION"
      || fact.method !== "WECOM"
      || !fact.transaction_reference
      || fact.transfer
      || reversed.has(fact.fact_id)) return false;
    const refundedMinor = view.collectionFacts
      .filter((candidate) => candidate.fact_type === "REFUND" && candidate.references_fact_id === fact.fact_id)
      .filter((refund) => !view.collectionFacts.some((candidate) => candidate.reverses_fact_id === refund.fact_id))
      .reduce((sum, refund) => sum + refund.amount_minor, 0);
    return refundedMinor >= 0 && refundedMinor < fact.amount_minor;
  }).map((fact) => fact.fact_id);
}

export function stayMembershipUpgradeEntry(
  view: OrderViewDto,
  members: readonly Pick<MemberDto, "id" | "phone">[],
  membershipProducts: readonly MembershipProductDto[],
  unitMap: ReadonlyMap<string, InventoryUnitDto>
): StayMembershipUpgradeEntry {
  const action = view.allowedActions.find((candidate) => candidate.code === "CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP");
  if (!action?.enabled) return { state: "UNAVAILABLE", reason: "ACTION_NOT_AVAILABLE" };
  if (!membershipProducts.some((product) => membershipProductMatchesCurrentStay(product, view, unitMap))) {
    return { state: "UNAVAILABLE", reason: "MEMBERSHIP_PRODUCT_NOT_APPLICABLE" };
  }
  const primary = view.occupants.find((occupant) => occupant.role === "PRIMARY");
  if (!primary) return { state: "UNAVAILABLE", reason: "PRIMARY_OCCUPANT_REQUIRED" };
  const phone = normalizeStayUpgradePhone(primary.phone);
  if (!phone) {
    return {
      state: "CORRECT_PRIMARY_OCCUPANT",
      orderId: view.order.id,
      primaryOccupantId: primary.id,
      reason: "PRIMARY_PHONE_REQUIRED"
    };
  }
  const matches = members.filter((member) => normalizeStayUpgradePhone(member.phone) === phone);
  if (matches.length > 1) return { state: "UNAVAILABLE", reason: "MEMBER_PHONE_AMBIGUOUS" };
  if (matches.length === 0) {
    return {
      state: "CREATE_MEMBER",
      orderId: view.order.id,
      primaryOccupantId: primary.id,
      prefill: { fullName: primary.fullName ?? "", nickname: primary.nickname ?? "", phone },
      returnTo: {
        action: STAY_MEMBERSHIP_UPGRADE_ACTION,
        orderId: view.order.id,
        primaryOccupantId: primary.id,
        phone
      }
    };
  }
  return {
    state: "READY",
    orderId: view.order.id,
    primaryOccupantId: primary.id,
    phone,
    memberId: matches[0]!.id,
    transferableCollectionFactIds: transferableCollectionFactIds(view)
  };
}

export function stayMembershipUpgradeResumeAfterOccupantCorrection(
  intent: Omit<StayMembershipUpgradeIntent, "phone" | "memberId">,
  occupant: Pick<OrderViewDto["occupants"][number], "id" | "phone">
): StayMembershipUpgradeIntent | undefined {
  const phone = normalizeStayUpgradePhone(occupant.phone);
  if (intent.action !== STAY_MEMBERSHIP_UPGRADE_ACTION
    || occupant.id !== intent.primaryOccupantId
    || !phone) return undefined;
  return { ...intent, phone };
}

export function stayUpgradeMemberCreationState(
  intent: StayUpgradeMemberCreationIntent | undefined
): StayUpgradeMemberCreationState | undefined {
  if (!intent || intent.action !== STAY_MEMBERSHIP_UPGRADE_ACTION) return undefined;
  const phone = normalizeStayUpgradePhone(intent.phone);
  if (!intent.orderId.trim() || !intent.primaryOccupantId.trim() || !phone) return undefined;
  return {
    fullName: intent.prefill.fullName,
    nickname: intent.prefill.nickname,
    phone,
    returnTo: {
      action: STAY_MEMBERSHIP_UPGRADE_ACTION,
      orderId: intent.orderId,
      primaryOccupantId: intent.primaryOccupantId,
      phone
    }
  };
}

export function continueStayUpgradeAfterMemberCreated(
  state: StayUpgradeMemberCreationState | undefined,
  createdMember: Pick<MemberDto, "id" | "phone"> | { id: string; phone: string | null }
): StayMembershipUpgradeIntent | undefined {
  if (!state || normalizeStayUpgradePhone(createdMember.phone) !== state.returnTo.phone) return undefined;
  return {
    action: STAY_MEMBERSHIP_UPGRADE_ACTION,
    orderId: state.returnTo.orderId,
    primaryOccupantId: state.returnTo.primaryOccupantId,
    memberId: createdMember.id
  };
}

export function stayMembershipUpgradeActionVisible(
  view: Pick<OrderViewDto, "accessLevel" | "order" | "stay" | "amendments">,
  action: OrderViewDto["allowedActions"][number] | undefined
): boolean {
  if (!action || action.code !== "CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP") return false;
  if (view.accessLevel !== "WRITE"
    || !((view.order.status === "CHECKED_IN" && view.stay.status === "IN_HOUSE")
      || (view.order.status === "CHECKED_OUT" && view.stay.status === "COMPLETED"))
    || view.order.stay_type === "FREE"
    || view.order.member_id
    || view.order.member_contract_id) return false;
  return !view.amendments.some((amendment) => amendment.amendment_type === "CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP");
}

export function upgradedStayActionDisabledReason(
  view: Pick<OrderViewDto, "amendments">,
  actionCode: string
): string | undefined {
  const upgraded = view.amendments.some((amendment) => amendment.amendment_type === "CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP");
  if (!upgraded) return undefined;
  if (actionCode === "REPRICE_ORDER") return "STAY_MEMBERSHIP_UPGRADE_REPRICE_CLOSED";
  if (actionCode === "REVOKE_CHECK_IN") return "STAY_MEMBERSHIP_UPGRADE_REVOKE_CHECK_IN_CLOSED";
  if (actionCode === "REFRESH_MEMBER_COVERAGE") return "STAY_MEMBERSHIP_UPGRADE_REFRESH_CLOSED";
  return undefined;
}

export function stayUpgradeMemberCreationHref(entry: Extract<StayMembershipUpgradeEntry, { state: "CREATE_MEMBER" }>): string {
  const params = new URLSearchParams({
    action: entry.returnTo.action,
    orderId: entry.orderId,
    primaryOccupantId: entry.primaryOccupantId,
    phone: entry.returnTo.phone,
    fullName: entry.prefill.fullName,
    nickname: entry.prefill.nickname
  });
  return `/members?${params.toString()}`;
}

export function parseStayUpgradeMemberCreationIntent(search: string): StayUpgradeMemberCreationIntent | undefined {
  const params = new URLSearchParams(search);
  if (params.get("action") !== STAY_MEMBERSHIP_UPGRADE_ACTION) return undefined;
  const orderId = params.get("orderId")?.trim() ?? "";
  const primaryOccupantId = params.get("primaryOccupantId")?.trim() ?? "";
  const phone = normalizeStayUpgradePhone(params.get("phone"));
  const fullName = params.get("fullName") ?? "";
  const nickname = params.get("nickname") ?? "";
  if (!orderId || !primaryOccupantId || !phone) return undefined;
  return {
    action: STAY_MEMBERSHIP_UPGRADE_ACTION,
    orderId,
    primaryOccupantId,
    phone,
    prefill: { fullName, nickname }
  };
}

export function stayUpgradeOrderHref(intent: StayMembershipUpgradeIntent): string {
  const params = new URLSearchParams({ action: "CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP" });
  if (intent.memberId) params.set("memberId", intent.memberId);
  return `/orders/${encodeURIComponent(intent.orderId)}?${params.toString()}`;
}

export function stayUpgradeOccupantCorrectionHref(state: StayUpgradeMemberCreationState): string {
  const params = new URLSearchParams({
    action: "CORRECT_ORDER_OCCUPANT",
    occupantId: state.returnTo.primaryOccupantId,
    resumeAction: state.returnTo.action
  });
  return `/orders/${encodeURIComponent(state.returnTo.orderId)}?${params.toString()}`;
}
