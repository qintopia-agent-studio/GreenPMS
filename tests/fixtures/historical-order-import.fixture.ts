import { stableHash } from "@qintopia/domain";
import { historicalOperationalTupleHash } from "../../packages/db/src/historical-order-import.ts";

const CUTOVER_AT = "2026-08-10T13:30:00+08:00";
export const historicalImportFixtureSourceIds = Object.freeze({
  member: "fixture-operational-member-entitlement",
  overdue: "fixture-operational-overdue-hold",
  sparse: "fixture-operational-sparse-component",
  dualUnit: "fixture-operational-dual-unit"
});
const MEMBER_SOURCE_ID = historicalImportFixtureSourceIds.member;
const OVERDUE_SOURCE_ID = historicalImportFixtureSourceIds.overdue;
const SPARSE_SOURCE_ID = historicalImportFixtureSourceIds.sparse;
const DUAL_UNIT_SOURCE_ID = historicalImportFixtureSourceIds.dualUnit;
const FROZEN_IN_HOUSE_OPERATIONAL_COUNT = 37;

const operationalUnits: ReadonlyArray<string | readonly string[]> = [
  "D01",
  "306",
  "C01",
  ["108-A", "108-B"],
  "A01",
  "A02", "A03", "A04", "B01", "B02", "B03", "B04",
  "C02", "C03", "C04", "D02", "D03", "D04", "D05",
  "E01", "E02", "E03", "201", "205",
  "301", "302", "303", "304", "305", "307", "308", "309",
  "101-A", "101-B", "101-C", "101-D",
  "102-A", "102-B", "102-C", "102-D",
  "103-A", "103-B", "103-C", "103-D"
];

function withCanonicalHash(record: Record<string, unknown>) {
  return { ...record, canonicalPayloadHash: stableHash(record) };
}

function syntheticSourceId(index: number): string {
  const special = [MEMBER_SOURCE_ID, OVERDUE_SOURCE_ID, SPARSE_SOURCE_ID, DUAL_UNIT_SOURCE_ID][index];
  return special ?? (90_000_000_000_000_000_000n + BigInt(index)).toString();
}

function segment(sequence: number, unit: string, arrivalDate: string, departureDate: string, amountFen: number) {
  return {
    sequence,
    sourceOrderRow: sequence + 4,
    sourceRoom: unit,
    inventoryUnitCode: unit,
    roomType: "SYNTHETIC",
    arrivalDate,
    departureDate,
    amountFen,
    sourceStatus: "SYNTHETIC"
  };
}

function operationalRecord(index: number) {
  const sourceId = syntheticSourceId(index);
  const lifecycle = index < FROZEN_IN_HOUSE_OPERATIONAL_COUNT ? "IN_HOUSE" : "RESERVED";
  const isMember = index === 0;
  const isOverdue = index === 1;
  const isSparse = index === 2;
  const isDual = index === 3;
  const isFree = index === 4;
  const mappedChannel = isMember ? null : isSparse ? "YOUMUDAO" : "WECOM";
  const amountFen = isMember || isFree ? 0 : isOverdue ? 13_000 : index === 43 ? 2_022_032 : 100_000;
  const units = Array.isArray(operationalUnits[index]) ? operationalUnits[index] as readonly string[] : [operationalUnits[index] as string];
  let arrivalDate = lifecycle === "RESERVED" ? "2026-08-10" : "2026-08-07";
  let departureDate = lifecycle === "RESERVED" ? "2026-08-14" : "2026-08-11";
  let segments = units.map((unit, unitIndex) => segment(unitIndex + 1, unit, arrivalDate, departureDate, Math.floor(amountFen / units.length)));

  if (isMember) {
    arrivalDate = "2026-08-06";
    departureDate = "2026-08-25";
    segments = [segment(1, "D01", arrivalDate, departureDate, 0)];
  } else if (isOverdue) {
    arrivalDate = "2026-08-08";
    departureDate = "2026-08-09";
    segments = [segment(1, "306", arrivalDate, departureDate, amountFen)];
  } else if (isSparse) {
    arrivalDate = "2026-07-19";
    departureDate = "2026-08-23";
    segments = [
      segment(1, "C01", "2026-07-19", "2026-08-02", 40_000),
      segment(2, "C01", "2026-08-07", "2026-08-23", 60_000)
    ];
  } else if (index >= 5 && index <= 8) {
    arrivalDate = "2026-07-01";
    segments = [
      segment(1, units[0]!, "2026-07-01", "2026-07-02", 0),
      segment(2, units[0]!, "2026-08-07", departureDate, amountFen)
    ];
  }

  const fallback = !new Set([1, 38, 39, 40, 41, 42]).has(index);
  const guestName = isMember ? "历史权益住客" : isOverdue ? "历史在住客人" : `历史运营住客-${String(index + 1).padStart(2, "0")}`;
  const pricingBasis = isMember ? "MEMBER_ENTITLEMENT" : isFree ? "FREE" : mappedChannel === "WECOM" ? "POLICY" : "CHANNEL_CONTRACT";
  const flags = isMember
    ? ["LEGACY_MEMBER_ENTITLEMENT_RECONSTRUCTION"]
    : isOverdue ? ["LIVE_DEPARTURE_DATE_UNCONFIRMED", "KEEP_INVENTORY_UNAVAILABLE"] : [];
  const membership = isMember ? {
    memberKeyStrategy: "LEGACY_NAME_ONLY",
    memberName: guestName,
    memberId: null,
    channel: null,
    externalOrderNo: null,
    entitlement: {
      unit: "ROOM_NIGHT",
      quantity: 19,
      serviceStartDate: "2026-08-06",
      serviceEndDate: "2026-08-24",
      reason: "SYNTHETIC_PRIOR_BALANCE"
    },
    consumption: { unit: "ROOM_NIGHT", quantity: 19 }
  } : null;
  const record = {
    channel: {
      raw: mappedChannel,
      normalized: mappedChannel,
      externalOrderNo: null,
      externalOrderNoStatus: isSparse ? "HISTORICAL_NOT_RECORDED" : "NOT_APPLICABLE"
    },
    disposition: "OPERATIONAL",
    flags,
    guest: {
      name: guestName,
      nameProvenance: "SYNTHETIC_FIXTURE",
      nickname: guestName,
      nicknameProvenance: fallback ? "FULL_NAME_DISPLAY_FALLBACK" : "SYNTHETIC_CONFIRMED",
      phone: null,
      phoneProvenance: "HISTORICAL_NOT_RECORDED"
    },
    manualConfirmation: isFree ? { reason: "SYNTHETIC_FREE_RECEPTION" } : {},
    membership,
    observedLifecycle: lifecycle,
    pricing: {
      origin: "MIGRATED_ACTUAL",
      basis: pricingBasis,
      currency: "CNY",
      currentContractAmountFen: amountFen,
      evidence: { historicalActualAmountFen: amountFen, fixture: true }
    },
    provenance: { fixture: true, rawSnapshot: { sourceOrderStatus: "SYNTHETIC_OPERATIONAL_STATUS" } },
    recordKind: "ACCOMMODATION",
    segments,
    source: {
      system: "ORDER_LAILE",
      orderId: sourceId,
      auditRow: index + 2,
      sourceValuesHash: stableHash({ fixture: "operational", index })
    },
    sourceStay: {
      arrivalDate,
      departureDate,
      rawRoom: units.join(","),
      standardInventoryUnits: units.join(","),
      rawRoomType: "SYNTHETIC"
    },
    stayType: isMember ? "MEMBER_ENTITLEMENT" : isFree ? "FREE_RECEPTION" : "STANDARD"
  };
  return withCanonicalHash(record);
}

function archiveRecord(index: number) {
  const channel = index < 15 ? "CTRIP" : index < 26 ? "MEITUAN" : index < 29 ? "YOUMUDAO" : "WECOM";
  const missingReference = index < 23;
  const amountFen = index === 489 ? 2_545_406 : 40_000;
  const sourceId = (80_000_000_000_000_000_000n + BigInt(index)).toString();
  const record = {
    channel: {
      raw: channel,
      normalized: channel,
      externalOrderNo: channel !== "WECOM" && !missingReference ? `fixture-channel-${index}` : null,
      externalOrderNoStatus: channel === "WECOM" ? "NOT_APPLICABLE" : missingReference ? "HISTORICAL_NOT_RECORDED" : "RECORDED"
    },
    disposition: "HISTORICAL_ARCHIVE",
    flags: [],
    guest: {
      name: `历史归档住客-${String(index + 1).padStart(3, "0")}`,
      nameProvenance: "SYNTHETIC_FIXTURE",
      nickname: null,
      nicknameProvenance: "HISTORICAL_NOT_RECORDED",
      phone: index === 0 ? "SYNTHETIC-PHONE-001" : null,
      phoneProvenance: index === 0 ? "SYNTHETIC_FIXTURE" : "HISTORICAL_NOT_RECORDED"
    },
    manualConfirmation: {},
    membership: null,
    observedLifecycle: "ARCHIVED",
    pricing: {
      origin: "MIGRATED_ACTUAL",
      basis: channel === "WECOM" ? "POLICY" : "CHANNEL_CONTRACT",
      currency: "CNY",
      currentContractAmountFen: amountFen,
      evidence: { historicalActualAmountFen: amountFen, fixture: true }
    },
    provenance: { fixture: true, rawSnapshot: { sourceOrderStatus: "SYNTHETIC_ARCHIVED_STATUS" } },
    recordKind: "ACCOMMODATION",
    segments: [],
    source: {
      system: "ORDER_LAILE",
      orderId: sourceId,
      auditRow: index + 46,
      sourceValuesHash: stableHash({ fixture: "archive", index })
    },
    sourceStay: { arrivalDate: "2026-03-13", departureDate: "2026-03-14", rawRoom: null, standardInventoryUnits: null, rawRoomType: null },
    stayType: "STANDARD"
  };
  return withCanonicalHash(record);
}

function nonAccommodationRecord() {
  const record = {
    channel: { raw: "WECOM", normalized: "WECOM", externalOrderNo: null, externalOrderNoStatus: "NOT_APPLICABLE" },
    disposition: "NON_ACCOMMODATION_ARCHIVE",
    flags: [],
    guest: { name: null, nameProvenance: "HISTORICAL_NOT_RECORDED", nickname: null, nicknameProvenance: "HISTORICAL_NOT_RECORDED", phone: null, phoneProvenance: "HISTORICAL_NOT_RECORDED" },
    manualConfirmation: {},
    membership: null,
    observedLifecycle: "ARCHIVED",
    pricing: { origin: "MIGRATED_ACTUAL", basis: "POLICY", currency: "CNY", currentContractAmountFen: 0, evidence: { historicalActualAmountFen: 0, fixture: true } },
    provenance: { fixture: true, rawSnapshot: { sourceCheckoutStatus: "SYNTHETIC_CHECKOUT_STATUS" } },
    recordKind: "NON_ACCOMMODATION_CHECKOUT",
    segments: [],
    source: { system: "ORDER_LAILE", orderId: "70000000000000000000", auditRow: 536, sourceValuesHash: stableHash({ fixture: "non-accommodation" }) },
    sourceStay: { arrivalDate: "2026-03-13", departureDate: "2026-03-13", rawRoom: null, standardInventoryUnits: null, rawRoomType: null },
    stayType: "STANDARD"
  };
  return withCanonicalHash(record);
}

function sourceFiles() {
  const rawExportTimestamp = "2026-08-10T13:00:00+08:00";
  return [
    { role: "ORDER_EXPORT", fileName: "synthetic-orders.xlsx", sha256: stableHash("ORDER_EXPORT"), rowCount: 675, exportedAt: rawExportTimestamp },
    { role: "COST_EXPORT", fileName: "synthetic-costs.xlsx", sha256: stableHash("COST_EXPORT"), rowCount: 6852, exportedAt: rawExportTimestamp },
    { role: "CHECKOUT_EXPORT", fileName: "synthetic-checkouts.xlsx", sha256: stableHash("CHECKOUT_EXPORT"), rowCount: 253, exportedAt: rawExportTimestamp },
    { role: "FEISHU_MATCH_BASELINE", fileName: "synthetic-feishu.xlsx", sha256: stableHash("FEISHU_MATCH_BASELINE"), rowCount: null, exportedAt: null },
    { role: "USER_CONFIRMATION_REVIEW", fileName: "synthetic-user-review.xlsx", sha256: stableHash("USER_CONFIRMATION_REVIEW"), rowCount: null, exportedAt: null },
    { role: "BUSINESS_CONFIRMATION_REVIEW", fileName: "synthetic-business-review.xlsx", sha256: stableHash("BUSINESS_CONFIRMATION_REVIEW"), rowCount: null, exportedAt: null },
    { role: "REVIEW_WORKBOOK", fileName: "synthetic-canonical-review.xlsx", sha256: stableHash("REVIEW_WORKBOOK"), rowCount: 535, exportedAt: CUTOVER_AT }
  ];
}

export function buildHistoricalOrderImportSyntheticManifest(): Record<string, unknown> {
  const records = [
    ...Array.from({ length: 44 }, (_, index) => operationalRecord(index)),
    ...Array.from({ length: 490 }, (_, index) => archiveRecord(index)),
    nonAccommodationRecord()
  ];
  const manifest: Record<string, unknown> = {
    approvedOperationalTuplesSha256: historicalOperationalTupleHash(records as never),
    currency: "CNY",
    cutoverAt: CUTOVER_AT,
    expected: {
      candidateCount: 535,
      historicalAccommodationAmountFen: 22_105_406,
      historicalAccommodationArchives: 490,
      nonAccommodationArchives: 1,
      operationalAccommodationAmountFen: 6_035_032,
      operationalOrders: 44,
      operationalSegmentCount: 50,
      totalAccommodationAmountFen: 28_140_438
    },
    generatorVersion: "historical-order-manifest-v1",
    idempotencyKey: "historical-order-import:synthetic-release-gate",
    importStartDate: "2026-03-13",
    manifestVersion: 1,
    propertyCode: "QTP-XA",
    records,
    source: {
      sourceFiles: sourceFiles(),
      workbook: { fileName: "synthetic-canonical-review.xlsx", sha256: stableHash("REVIEW_WORKBOOK") }
    },
    sourceSystem: "ORDER_LAILE"
  };
  manifest.manifestHash = stableHash(manifest);
  return manifest;
}
