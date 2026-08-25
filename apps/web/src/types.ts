import type {
  AccessLevel,
  AmountSummaryDto,
  BookingChannelCode,
  CommandType,
  CommandReason,
  CreateQuoteCommandResponseDto,
  PreviewDto,
  QuoteDto,
  ReceiptDto,
  HistoricalCommandType,
  HistoricalRecoverableCommandType,
  OrderArrangementDto,
  OrderArrangementHistoryItemDto,
  OrderAllowedActionDto,
  OrderEffectiveArrangementDto,
  OrderFulfillmentProjectionDto,
  OrderOccupantSnapshotDto,
  StayType
} from "@qintopia/contracts";

export interface PrincipalDto {
  subjectId: string;
  displayName: string;
  credentialType: "SESSION" | "TOKEN";
  propertyAccess: Record<string, "READ" | "WRITE">;
}

export interface ClientCommandMetadata {
  idempotencyKey: string;
  correlationId: string;
}

export type TrackedCommandState =
  | "LOCAL_ONLY"
  | "PREVIEWING"
  | "PREVIEW_UNKNOWN"
  | "PREVIEWED"
  | "CONFIRMING"
  | "UNKNOWN"
  | "EXECUTED"
  | "NOT_EXECUTED";

export interface PendingTokenCommand {
  operationId: string;
  request: CommandRequest;
  state: TrackedCommandState;
  previewMetadata?: ClientCommandMetadata;
  previewId?: string;
  confirmationKey?: string;
}

export interface RetainedTokenSecret {
  operationId: string;
  propertyId: string;
  operation: "ISSUE" | "ROTATE";
  label: string;
  value: string;
  command: CommandRequest;
  state: TrackedCommandState;
  previewMetadata?: ClientCommandMetadata;
  previewId?: string;
  confirmationKey?: string;
}

export interface TokenDto {
  id: string;
  label: string;
  access_ceiling: "READ" | "WRITE";
  property_scope: string;
  expires_at: string;
  revoked_at: string | null;
  rotated_from_id: string | null;
  replaced_by_id: string | null;
  created_at: string;
}

export interface PropertyDto {
  id: string;
  code: string;
  name: string;
  timezone: string;
  currency: string;
}

export interface InventoryUnitDto {
  id: string;
  property_id: string;
  kind: "ROOM" | "BED";
  parent_room_id: string | null;
  code: string;
  name: string;
  active: boolean;
  catalog_version: string | null;
  building_code: string | null;
  room_type_code: string | null;
  pricing_product_code: string | null;
  inventory_basis: "INDEPENDENT" | "WHOLE_ROOM_COMBINATION" | null;
  code_provenance: "SOURCE_EXPLICIT" | "USER_CONFIRMED_RENAMED" | "PMS_GENERATED" | null;
  physical_bed_count: number | null;
  occupancy_capacity: number;
}

export interface PricingPolicyVersionDto {
  id: string;
  property_id: string;
  code: string;
  version: number;
  stay_type: StayType | null;
  calculation_kind: "FLAT_NIGHTLY" | "DURATION_BAND_TOTAL" | "FREE";
  nightly_rate_minor: number | null;
  product_anchor_rates_minor: Record<string, { "1": number; "7": number; "14": number; "30": number }> | null;
  effective_from: string | null;
  effective_until: string | null;
  rounding_rule: "FINAL_TOTAL_WHOLE_YUAN_HALF_UP" | null;
  currency: string;
  status: "PUBLISHED";
}

export interface MemberContractDto {
  id: string;
  property_id: string;
  member_id: string | null;
  member_name: string;
  status: "ACTIVE" | "EXPIRED";
  valid_from: string;
  valid_until: string;
  version: number;
  created_at: string;
}

export interface MemberDto {
  id: string;
  identity_card_number: string | null;
  nickname: string;
  full_name: string;
  phone: string;
  wechat: string;
  created_at: string;
}

export interface MemberExternalReferenceDto {
  id: string;
  member_id: string;
  property_id: string;
  provider: "FEISHU_BASE";
  source_container_id: string;
  source_table_id: string;
  external_record_id: string;
  created_at: string;
}

export interface MemberAvailableBalanceDto {
  ROOM_NIGHT: number;
  BED_NIGHT: number;
}

export interface MemberLotBalanceDto {
  lotId: string;
  unitKind: "ROOM_NIGHT" | "BED_NIGHT";
  availableUnits: number;
}

export interface EntitlementLotDto {
  id: string;
  contract_id: string;
  unit_kind: "ROOM_NIGHT" | "BED_NIGHT";
  total_units: number;
  expires_on: string;
  version: number;
  created_at: string;
}

export interface EntitlementLedgerDto {
  fact_id: string;
  lot_id: string;
  entry_type: "ADJUST" | "HOLD" | "RELEASE" | "CONSUME" | "RESTORE" | "EXPIRE" | "CONVERSION_CONSUME";
  quantity_delta: number;
  service_date: string | null;
  order_id: string | null;
  coverage_id: string | null;
  reason: string;
  command_id: string | null;
  created_at: string;
}

export interface MemberViewDto {
  member: MemberDto;
  contracts: MemberContractDto[];
  lots: EntitlementLotDto[];
  ledger: EntitlementLedgerDto[];
  externalReferences: MemberExternalReferenceDto[];
  lotBalances: MemberLotBalanceDto[];
  availableBalance: MemberAvailableBalanceDto;
  balanceAsOfDate: string;
  membershipProducts: MembershipProductDto[];
  membershipOrders: MembershipOrderSummaryDto[];
}

export interface MembershipProductDto {
  id: string;
  code: string;
  version: number;
  name: string;
  list_price_minor: number;
  currency: string;
  entitlement_unit_kind: "ROOM_NIGHT" | "BED_NIGHT";
  entitlement_units: number;
  validity_period: "P1Y";
  allowed_room_type_code: string;
  allowed_inventory_kind: "ROOM" | "BED";
  status: "PUBLISHED";
  created_at: string;
}

export interface MembershipOrderDto {
  id: string;
  property_id: string;
  member_id: string;
  product_id: string;
  product_code: string;
  product_version: number;
  product_name: string;
  listed_price_minor: number;
  agreed_price_minor: number;
  price_adjustment_minor: number;
  price_adjustment_reason: string | null;
  currency: string;
  entitlement_unit_kind: "ROOM_NIGHT" | "BED_NIGHT";
  entitlement_units: number;
  allowed_room_type_code: string;
  allowed_inventory_kind: "ROOM" | "BED";
  status: "DRAFT" | "ACTIVE";
  activated_at: string | null;
  valid_from: string | null;
  valid_until: string | null;
  contract_id: string | null;
  entitlement_lot_id: string | null;
  version: number;
  created_by_command_id: string;
  activated_by_command_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface MembershipPaymentFactDto {
  fact_id: string;
  membership_order_id: string;
  fact_type: "COLLECTION" | "REVERSAL";
  amount_minor: number;
  net_effect_minor: number;
  currency: string;
  transaction_reference: string | null;
  corrects_fact_id: string | null;
  reverses_fact_id: string | null;
  source_type: "DIRECT_WECOM" | "STAY_COLLECTION_TRANSFER";
  source_order_id: string | null;
  source_collection_fact_id: string | null;
  note: string;
  command_id: string;
  created_at: string;
}

export interface MembershipOrderSummaryDto {
  order: MembershipOrderDto;
  paymentFacts: MembershipPaymentFactDto[];
  paymentTotalMinor: number;
  paymentDifferenceMinor: number;
}

export interface MemberSummaryDto {
  member: MemberDto;
}

export interface MetaDto {
  properties: PropertyDto[];
  inventoryUnits: InventoryUnitDto[];
  pricingPolicyVersions: PricingPolicyVersionDto[];
  members: MemberDto[];
  memberContracts: MemberContractDto[];
  membershipProducts: MembershipProductDto[];
}

export interface AvailabilityNightDto {
  serviceDate: string;
  available: boolean;
  blockingClaimIds: string[];
}

export interface UnitAvailabilityDto {
  id: string;
  propertyId: string;
  kind: "ROOM" | "BED";
  roomId: string;
  code: string;
  name: string;
  catalogVersion: string | null;
  buildingCode: string | null;
  roomTypeCode: string | null;
  pricingProductCode: string | null;
  inventoryBasis: "INDEPENDENT" | "WHOLE_ROOM_COMBINATION" | null;
  codeProvenance: "SOURCE_EXPLICIT" | "USER_CONFIRMED_RENAMED" | "PMS_GENERATED" | null;
  physicalBedCount: number | null;
  occupancyCapacity: number;
  nights: AvailabilityNightDto[];
  available: boolean;
}

export interface AvailabilityDto {
  propertyId: string;
  units: UnitAvailabilityDto[];
}

export interface MaintenanceLockDto {
  id: string;
  property_id: string;
  inventory_unit_id: string;
  arrival_date: string;
  departure_date: string;
  reason: string;
  status: "ACTIVE" | "RELEASED";
  version: number;
  created_at: string;
  released_at: string | null;
}

export interface OrderRowDto {
  id: string;
  property_id: string;
  status: string;
  stay_type: StayType;
  arrival_date: string;
  departure_date: string;
  primary_guest_snapshot: Record<string, unknown>;
  booking_channel_code: BookingChannelCode | null;
  channel_order_reference: string | null;
  free_stay_reason: string | null;
  free_stay_category_code: "VOLUNTEER" | "RECEPTION" | null;
  pricing_policy_version_id: string;
  member_id: string | null;
  member_contract_id: string | null;
  current_revision_id: string | null;
  current_contract_amount_minor: number | null;
  currency: string | null;
  current_unit_name?: string | null;
  current_unit_code?: string | null;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface StaySegmentDto {
  id: string;
  stay_id: string;
  sequence: number;
  inventory_unit_id: string;
  arrival_date: string;
  departure_date: string;
  segment_type: string;
  supersedes_segment_id: string | null;
  amendment_id: string;
  created_at: string;
}

export interface AmendmentDto {
  id: string;
  order_id: string;
  sequence: number;
  amendment_type: string;
  reason_code: string;
  reason_note: string;
  prior_version: number;
  new_version: number;
  payload: unknown;
  command_id: string | null;
  actor: { subjectId: string; displayName: string } | null;
  created_at: string;
}

export interface PricingRevisionDto {
  id: string;
  order_id: string;
  revision_no: number;
  amendment_id: string;
  policy_version_id: string;
  arrival_date: string;
  departure_date: string;
  coverage_set: unknown;
  cash_lines: unknown;
  policy_base_amount_minor: number;
  pricing_basis: "POLICY" | "CHANNEL_CONTRACT" | "MANUAL_ADJUSTMENT" | "MEMBER_ENTITLEMENT" | "FREE";
  manual_adjustment_minor: number;
  current_contract_amount_minor: number;
  difference_from_policy_minor: number;
  reason: { code: string; note: string };
  currency: string;
  created_at: string;
}

export interface CoverageRowDto {
  id: string;
  order_id: string;
  contract_id: string;
  lot_id: string;
  inventory_unit_id: string;
  service_date: string;
  unit_kind: string;
  status: "HELD" | "CONSUMED" | "RELEASED";
  held_by_revision_id: string;
  created_at: string;
  updated_at: string;
}

export interface CollectionFactDto {
  fact_id: string;
  order_id: string;
  fact_type: "COLLECTION" | "REFUND" | "REVERSAL";
  amount_minor: number;
  net_effect_minor: number;
  currency: string;
  references_fact_id: string | null;
  reverses_fact_id: string | null;
  method: string;
  cash_collector: string | null;
  note: string;
  transaction_reference: string | null;
  pricing_revision_id: string | null;
  command_id: string;
  created_at: string;
  transfer?: {
    id: string;
    membershipOrderId: string;
    memberId: string;
    membershipPaymentFactId: string;
    sourceReversalFactId: string;
  } | null;
}

export interface CleaningTaskSummaryDto {
  id: string;
  inventoryUnitId: string;
  serviceDate: string;
  status: "PENDING" | "COMPLETED";
  createdAt: string;
  completedAt: string | null;
  createdBy: { subjectId: string; displayName: string } | null;
  completedBy: { subjectId: string; displayName: string } | null;
}

export interface OrderViewDto {
  accessLevel: AccessLevel;
  allowedActions: OrderAllowedActionDto[];
  order: OrderRowDto;
  occupants: Array<{
    id: string;
    orderId: string;
    ordinal: number;
    role: "PRIMARY" | "ADDITIONAL";
    fullName: string | null;
    nickname: string | null;
    phone: string | null;
    documentNumber: string | null;
    createdAt: string;
  }>;
  occupantCorrections: Array<{
    id: string;
    orderId: string;
    occupantId: string;
    sequence: number;
    priorSnapshot: OrderOccupantSnapshotDto;
    correctedSnapshot: OrderOccupantSnapshotDto;
    reason: { code: string; note: string };
    actor: { subjectId: string; displayName: string };
    amendmentId: string;
    commandId: string;
    createdAt: string;
  }>;
  stay: { id: string; status: string };
  currentSegment: {
    id: string;
    sequence: number;
    inventoryUnitId: string;
    arrivalDate: string;
    departureDate: string;
  };
  segments: StaySegmentDto[];
  originalArrangement: OrderArrangementDto;
  effectiveArrangement: OrderEffectiveArrangementDto;
  fulfillment: OrderFulfillmentProjectionDto;
  arrangementHistory: OrderArrangementHistoryItemDto[];
  amendments: AmendmentDto[];
  pricingRevisions: PricingRevisionDto[];
  coverageSet: CoverageRowDto[];
  collectionFacts: CollectionFactDto[];
  cleaningTasks: CleaningTaskSummaryDto[];
  amounts: AmountSummaryDto;
}

export interface CommandPreviewResponse {
  preview: PreviewDto;
  receipt: ReceiptDto;
}

export interface CommandRequest {
  commandType: HistoricalCommandType;
  input: Record<string, unknown>;
  title: string;
  description: string;
  presentation?: "MEMBER_STAY" | "BACKFILL_STAY" | "COMPLETE_STAY" | "FULFILLMENT" | "STAY_DATES" | "MOVE_UNIT" | "ORDER_LIFECYCLE";
  recoveryEffectHash?: string;
  inventoryUnitLabels?: Record<string, string>;
  orderLifecycleContext?: { guestName: string; arrivalDate: string; departureDate: string };
  initialReason?: CommandReason;
}

export type {
  AccessLevel,
  AmountSummaryDto,
  BookingChannelCode,
  CommandType,
  CommandReason,
  CreateQuoteCommandResponseDto,
  PreviewDto,
  QuoteDto,
  OrderAllowedActionDto,
  OrderOccupantSnapshotDto,
  ReceiptDto,
  HistoricalCommandType,
  HistoricalRecoverableCommandType,
  StayType
};
