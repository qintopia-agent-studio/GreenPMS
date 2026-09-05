import type {
  AccessLevel,
  AmountSummaryDto,
  BookingChannelCode,
  CommandCapability,
  CommandCatalogType,
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
  propertyCommandGrants: Record<string, CommandCatalogType[]>;
  allowedActions: Record<string, CommandCapability[]>;
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
  subjectId: string;
  displayName: string;
  id: string;
  label: string;
  access_ceiling: "READ" | "WRITE";
  property_scope: string;
  expires_at: string;
  revoked_at: string | null;
  rotated_from_id: string | null;
  replaced_by_id: string | null;
  created_at: string;
  commandCeiling: CommandCapability[];
  persistedCommandCeiling: CommandCatalogType[];
  historicalReadCeilingPreserved: boolean;
}

export interface TokenTargetDto {
  subjectId: string;
  displayName: string;
  accessLevel: "READ" | "WRITE";
  commandGrants: CommandCapability[];
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
  status: "ACTIVE" | "EXPIRED" | "VOIDED";
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
  status: "ACTIVE" | "VOIDED";
  version: number;
  created_at: string;
}

export interface EntitlementLedgerDto {
  fact_id: string;
  lot_id: string;
  entry_type: "ADJUST" | "HOLD" | "RELEASE" | "CONSUME" | "RESTORE" | "EXPIRE" | "VOID" | "CONVERSION_CONSUME";
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
  profileCorrections: MemberProfileCorrectionDto[];
  effectiveDateCorrections: MembershipEffectiveDateCorrectionDto[];
  historicalMembershipBackfills: HistoricalMembershipBackfillDto[];
  paymentReclassifications: MembershipPaymentReclassificationDto[];
  voidReconversions: MembershipVoidReconversionDto[];
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
  validity_period: "P1Y";
  allowed_room_type_code: string;
  allowed_inventory_kind: "ROOM" | "BED";
  status: "DRAFT" | "ACTIVE" | "VOIDED";
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
  business_date: string;
  created_at: string;
}

export interface MembershipOrderSummaryDto {
  order: MembershipOrderDto;
  paymentFacts: MembershipPaymentFactDto[];
  paymentTotalMinor: number;
  paymentDifferenceMinor: number;
}

export interface MemberCorrectionActorDto {
  subjectId: string;
  displayName: string;
}

interface MemberCorrectionAuditDto {
  id: string;
  property_id: string;
  member_id: string;
  evidence_note: string;
  command_id: string;
  created_at: string;
  actor: MemberCorrectionActorDto;
}

export interface MemberProfileCorrectionDto extends MemberCorrectionAuditDto {
  sequence: number;
  prior_full_name: string;
  prior_nickname: string;
  prior_identity_card_number: string | null;
  prior_phone: string;
  prior_wechat: string;
  corrected_full_name: string;
  corrected_nickname: string;
  corrected_identity_card_number: string | null;
  corrected_phone: string;
  corrected_wechat: string;
  changed_fields: Array<"fullName" | "nickname" | "identityCardNumber" | "phone" | "wechat">;
}

export interface MembershipEffectiveDateCorrectionDto extends MemberCorrectionAuditDto {
  membership_order_id: string;
  contract_id: string;
  entitlement_lot_id: string;
  sequence: number;
  prior_valid_from: string;
  prior_valid_until: string;
  corrected_valid_from: string;
  corrected_valid_until: string;
  prior_order_version: number;
  prior_contract_version: number;
  prior_lot_version: number;
}

export interface HistoricalMembershipBackfillDto extends MemberCorrectionAuditDto {
  membership_order_id: string;
  contract_id: string;
  entitlement_lot_id: string;
  payment_fact_id: string;
  product_id: string;
  product_code: string;
  product_version: number;
  product_name: string;
  listed_price_minor: number;
  agreed_price_minor: number;
  currency: string;
  entitlement_unit_kind: "ROOM_NIGHT" | "BED_NIGHT";
  entitlement_units: number;
  validity_period: "P1Y";
  allowed_room_type_code: string;
  allowed_inventory_kind: "ROOM" | "BED";
  actual_membership_date: string;
  valid_until: string;
  business_date: string;
  transaction_reference: string;
}

export interface MembershipPaymentReclassificationDto extends MemberCorrectionAuditDto {
  old_membership_order_id: string;
  old_payment_fact_id: string;
  old_reversal_fact_id: string;
  new_membership_order_id: string;
  new_payment_fact_id: string | null;
  amount_minor: number;
  currency: string;
}

export interface MembershipVoidReconversionDto extends MemberCorrectionAuditDto {
  old_membership_order_id: string;
  old_contract_id: string;
  old_entitlement_lot_id: string;
  prior_old_order_version: number;
  prior_old_contract_version: number;
  prior_old_lot_version: number;
  source_order_id: string;
  source_stay_id: string;
  prior_source_order_version: number;
  new_membership_order_id: string;
  new_contract_id: string;
  new_entitlement_lot_id: string;
  replacement_payment_fact_id: string | null;
  replacement_business_date: string | null;
  replacement_transaction_reference: string | null;
  actual_membership_date: string;
  valid_until: string;
  old_direct_collection_total_minor: number;
  stay_transfer_total_minor: number;
  membership_agreed_price_minor: number;
  currency: string;
  service_dates: string[];
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

export interface OrderDetailRowDto {
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

export interface OrderRowDto extends OrderDetailRowDto {
  stay_status: "PLANNED" | "IN_HOUSE" | "COMPLETED" | "CANCELLED" | "NO_SHOW" | "CHECK_IN_REVOKED";
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
  order: OrderDetailRowDto;
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
  referencedInventoryUnits: InventoryUnitDto[];
  amendments: AmendmentDto[];
  pricingRevisions: PricingRevisionDto[];
  membershipConversion: {
    membershipOrderId: string;
    memberId: string;
    contractId: string;
    entitlementLotId: string;
    commandId: string;
  } | null;
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
  historicalStayCorrectionContexts?: Record<string, { guestName: string }>;
  initialReason?: CommandReason;
}

export type {
  AccessLevel,
  AmountSummaryDto,
  BookingChannelCode,
  CommandCapability,
  CommandCatalogType,
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
