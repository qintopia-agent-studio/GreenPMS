import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { sql, type Kysely, type Transaction } from "kysely";
import type { ReferenceCatalogDto } from "@qintopia/contracts";
import { stableHash } from "@qintopia/domain";
import { createDatabase } from "./database.ts";
import type { Database } from "./schema.ts";

const bundledCatalogUrl = new URL("../catalog/qintopia-2026-reference-catalog.json", import.meta.url);
const defaultPropertyId = "prop_qintopia_demo";
const defaultPropertyCode = "QTP-XA";
const referenceOnly = "REFERENCE_ONLY" as const;

type DbExecutor = Kysely<Database> | Transaction<Database>;
type PackageNights = 1 | 7 | 14 | 30;

interface InventoryCategorySnapshot {
  roomTypeKey: string;
  sourceName: string;
  bathroom: "PRIVATE" | "SHARED";
  roomLayout: string;
  saleUnit: "ROOM" | "BED";
  physicalRoomCount: number;
  physicalBedCount: number;
  sellableUnitCount: number;
  separateElectricityCharge: false;
}

export interface PhysicalRoomSnapshot {
  operationalCode: string;
  buildingCode: string;
  roomTypeKey: string;
  sourceCode: string | null;
  sourceLabel: string;
  codeProvenance: "SOURCE_EXPLICIT" | "USER_CONFIRMED_RENAMED" | "PMS_GENERATED";
  physicalBedCount: number;
  physicalBedCodes: string[] | null;
  saleMode: "INDEPENDENT_ROOM" | "BED_WITH_WHOLE_ROOM_COMBINATION";
}

interface RateSnapshot {
  roomTypeKey: string;
  saleUnit: "ROOM" | "BED";
  nights: PackageNights;
  amountMinor: number;
  sourceCell: string;
}

export interface PricingProductSnapshot {
  productCode: string;
  roomTypeKey: string;
  inventoryUnitKind: "ROOM" | "BED";
  anchorMultiplier: 1 | 2 | 4;
  anchorsMinor: { "1": number; "7": number; "14": number; "30": number };
  derivation: "SOURCE_PUBLISHED" | "BED_ANCHORS_TIMES_PHYSICAL_BEDS";
}

interface MembershipProductSnapshot {
  productKey: string;
  sourceName: string;
  roomTypeKey: string;
  entitlementUnit: "ROOM_NIGHT" | "BED_NIGHT";
  entitlementNightCount: number;
  priceMinor: number;
  currency: string;
  quota: number;
  quotaMeaning: string;
  validity: { startsAt: string; period: string };
  sourceRange: string;
}

type CanonicalRoomTuple = readonly [
  operationalCode: string,
  buildingCode: string,
  roomTypeKey: string,
  sourceCode: string | null,
  sourceLabel: string,
  codeProvenance: PhysicalRoomSnapshot["codeProvenance"],
  physicalBedCount: number,
  physicalBedCodes: readonly string[] | null,
  saleMode: PhysicalRoomSnapshot["saleMode"]
];

type CanonicalRateTuple = readonly [
  roomTypeKey: string,
  nights: PackageNights,
  amountMinor: number,
  sourceCell: string,
  saleUnit: RateSnapshot["saleUnit"]
];

type CanonicalPricingProductTuple = readonly [
  productCode: string,
  roomTypeKey: string,
  inventoryUnitKind: PricingProductSnapshot["inventoryUnitKind"],
  anchorMultiplier: PricingProductSnapshot["anchorMultiplier"],
  anchorsMinor: readonly [oneNight: number, sevenNights: number, fourteenNights: number, thirtyNights: number],
  derivation: PricingProductSnapshot["derivation"]
];

const revision561ImportId = "qintopia-2026-feishu-revision-561-user-confirmed-v4";
const revision561SourceRevision = 561;

// These tuples are the independent data seal for the user-confirmed revision, not derived totals.
const revision561RoomTuples = [
  ["A01", "A", "private_bath_standard", "A01", "A01", "SOURCE_EXPLICIT", 2, ["A", "B"], "INDEPENDENT_ROOM"],
  ["A02", "A", "private_bath_standard", "A02", "A02", "SOURCE_EXPLICIT", 2, ["A", "B"], "INDEPENDENT_ROOM"],
  ["A03", "A", "private_bath_king", "A03", "A03", "SOURCE_EXPLICIT", 1, null, "INDEPENDENT_ROOM"],
  ["A04", "A", "private_bath_king", "A04", "A04", "SOURCE_EXPLICIT", 1, null, "INDEPENDENT_ROOM"],
  ["B01", "B", "private_bath_single", "B01", "B01", "SOURCE_EXPLICIT", 1, null, "INDEPENDENT_ROOM"],
  ["B02", "B", "private_bath_single", "B02", "B02", "SOURCE_EXPLICIT", 1, null, "INDEPENDENT_ROOM"],
  ["B03", "B", "private_bath_standard", "B03", "B03", "SOURCE_EXPLICIT", 2, ["A", "B"], "INDEPENDENT_ROOM"],
  ["B04", "B", "private_bath_standard", "B04", "B04", "SOURCE_EXPLICIT", 2, ["A", "B"], "INDEPENDENT_ROOM"],
  ["C01", "C", "private_bath_single", "I01", "I01", "USER_CONFIRMED_RENAMED", 1, null, "INDEPENDENT_ROOM"],
  ["C02", "C", "private_bath_single", "I02", "I02", "USER_CONFIRMED_RENAMED", 1, null, "INDEPENDENT_ROOM"],
  ["C03", "C", "private_bath_single", "I03", "I03", "USER_CONFIRMED_RENAMED", 1, null, "INDEPENDENT_ROOM"],
  ["C04", "C", "private_bath_single", "I04", "I04", "USER_CONFIRMED_RENAMED", 1, null, "INDEPENDENT_ROOM"],
  ["D01", "D", "shared_bath_single", null, "养蜂 单", "PMS_GENERATED", 1, null, "INDEPENDENT_ROOM"],
  ["D02", "D", "shared_bath_single", null, "养蜂 单", "PMS_GENERATED", 1, null, "INDEPENDENT_ROOM"],
  ["D03", "D", "shared_bath_standard", null, "养蜂 双", "PMS_GENERATED", 2, ["A", "B"], "INDEPENDENT_ROOM"],
  ["D04", "D", "shared_bath_standard", null, "养蜂 双", "PMS_GENERATED", 2, ["A", "B"], "INDEPENDENT_ROOM"],
  ["D05", "D", "shared_bath_standard", null, "养蜂 双", "PMS_GENERATED", 2, ["A", "B"], "INDEPENDENT_ROOM"],
  ["E01", "E", "private_bath_standard", null, "蝴蝶 标间", "PMS_GENERATED", 2, ["A", "B"], "INDEPENDENT_ROOM"],
  ["E02", "E", "private_bath_single", null, "蝴蝶 单人间", "PMS_GENERATED", 1, null, "INDEPENDENT_ROOM"],
  ["E03", "E", "private_bath_suite", null, "蝴蝶 套房", "PMS_GENERATED", 2, ["A", "B"], "INDEPENDENT_ROOM"],
  ["101", "1", "shared_bath_quad", "101", "101", "SOURCE_EXPLICIT", 4, ["A", "B", "C", "D"], "BED_WITH_WHOLE_ROOM_COMBINATION"],
  ["102", "1", "shared_bath_quad", "102", "102", "SOURCE_EXPLICIT", 4, ["A", "B", "C", "D"], "BED_WITH_WHOLE_ROOM_COMBINATION"],
  ["103", "1", "shared_bath_quad", "103", "103", "SOURCE_EXPLICIT", 4, ["A", "B", "C", "D"], "BED_WITH_WHOLE_ROOM_COMBINATION"],
  ["104", "1", "shared_bath_double", "104", "104", "SOURCE_EXPLICIT", 2, ["A", "B"], "BED_WITH_WHOLE_ROOM_COMBINATION"],
  ["105", "1", "shared_bath_quad", "105", "105", "SOURCE_EXPLICIT", 4, ["A", "B", "C", "D"], "BED_WITH_WHOLE_ROOM_COMBINATION"],
  ["106", "1", "shared_bath_double", "106", "106", "SOURCE_EXPLICIT", 2, ["A", "B"], "BED_WITH_WHOLE_ROOM_COMBINATION"],
  ["107", "1", "shared_bath_quad", "107", "107", "SOURCE_EXPLICIT", 4, ["A", "B", "C", "D"], "BED_WITH_WHOLE_ROOM_COMBINATION"],
  ["108", "1", "shared_bath_quad", "108", "108", "SOURCE_EXPLICIT", 4, ["A", "B", "C", "D"], "BED_WITH_WHOLE_ROOM_COMBINATION"],
  ["109", "1", "shared_bath_quad", "109", "109", "SOURCE_EXPLICIT", 4, ["A", "B", "C", "D"], "BED_WITH_WHOLE_ROOM_COMBINATION"],
  ["201", "2", "shared_bath_single", "201", "201", "SOURCE_EXPLICIT", 1, null, "INDEPENDENT_ROOM"],
  ["202", "2", "shared_bath_quad", "202", "202", "SOURCE_EXPLICIT", 4, ["A", "B", "C", "D"], "BED_WITH_WHOLE_ROOM_COMBINATION"],
  ["203", "2", "shared_bath_quad", "203", "203", "SOURCE_EXPLICIT", 4, ["A", "B", "C", "D"], "BED_WITH_WHOLE_ROOM_COMBINATION"],
  ["204", "2", "shared_bath_double", "204", "204", "SOURCE_EXPLICIT", 2, ["A", "B"], "BED_WITH_WHOLE_ROOM_COMBINATION"],
  ["205", "2", "shared_bath_single", "205", "205", "SOURCE_EXPLICIT", 1, null, "INDEPENDENT_ROOM"],
  ["206", "2", "shared_bath_quad", "206", "206", "SOURCE_EXPLICIT", 4, ["A", "B", "C", "D"], "BED_WITH_WHOLE_ROOM_COMBINATION"],
  ["301", "3", "shared_bath_single", "301", "301 单", "SOURCE_EXPLICIT", 1, null, "INDEPENDENT_ROOM"],
  ["302", "3", "shared_bath_single", "302", "302 单", "SOURCE_EXPLICIT", 1, null, "INDEPENDENT_ROOM"],
  ["303", "3", "shared_bath_single", "303", "303 单", "SOURCE_EXPLICIT", 1, null, "INDEPENDENT_ROOM"],
  ["304", "3", "shared_bath_single", "304", "304 单", "SOURCE_EXPLICIT", 1, null, "INDEPENDENT_ROOM"],
  ["305", "3", "shared_bath_standard", "305", "305 双", "SOURCE_EXPLICIT", 2, ["A", "B"], "INDEPENDENT_ROOM"],
  ["306", "3", "shared_bath_standard", "306", "306 双", "SOURCE_EXPLICIT", 2, ["A", "B"], "INDEPENDENT_ROOM"],
  ["307", "3", "shared_bath_standard", "307", "307 双", "SOURCE_EXPLICIT", 2, ["A", "B"], "INDEPENDENT_ROOM"],
  ["308", "3", "shared_bath_standard", "308", "308 双", "SOURCE_EXPLICIT", 2, ["A", "B"], "INDEPENDENT_ROOM"],
  ["309", "3", "shared_bath_standard", "309", "309 双", "SOURCE_EXPLICIT", 2, ["A", "B"], "INDEPENDENT_ROOM"]
] satisfies readonly CanonicalRoomTuple[];

const revision561RateTuples = [
  ["shared_bath_quad", 30, 78_000, "C31", "BED"],
  ["shared_bath_quad", 14, 48_000, "D31", "BED"],
  ["shared_bath_quad", 7, 30_800, "E31", "BED"],
  ["shared_bath_quad", 1, 5_800, "F31", "BED"],
  ["shared_bath_double", 30, 90_000, "C32", "BED"],
  ["shared_bath_double", 14, 55_000, "D32", "BED"],
  ["shared_bath_double", 7, 38_000, "E32", "BED"],
  ["shared_bath_double", 1, 6_800, "F32", "BED"],
  ["shared_bath_single", 30, 135_000, "C36", "ROOM"],
  ["shared_bath_single", 14, 82_000, "D36", "ROOM"],
  ["shared_bath_single", 7, 59_000, "E36", "ROOM"],
  ["shared_bath_single", 1, 13_000, "F36", "ROOM"],
  ["shared_bath_standard", 30, 195_000, "C37", "ROOM"],
  ["shared_bath_standard", 14, 120_000, "D37", "ROOM"],
  ["shared_bath_standard", 7, 79_000, "E37", "ROOM"],
  ["shared_bath_standard", 1, 18_000, "F37", "ROOM"],
  ["private_bath_single", 30, 180_000, "C41", "ROOM"],
  ["private_bath_single", 14, 119_000, "D41", "ROOM"],
  ["private_bath_single", 7, 72_000, "E41", "ROOM"],
  ["private_bath_single", 1, 17_000, "F41", "ROOM"],
  ["private_bath_standard", 30, 258_000, "C42", "ROOM"],
  ["private_bath_standard", 14, 168_000, "D42", "ROOM"],
  ["private_bath_standard", 7, 102_000, "E42", "ROOM"],
  ["private_bath_standard", 1, 24_000, "F42", "ROOM"],
  ["private_bath_king", 30, 258_000, "C43", "ROOM"],
  ["private_bath_king", 14, 168_000, "D43", "ROOM"],
  ["private_bath_king", 7, 102_000, "E43", "ROOM"],
  ["private_bath_king", 1, 24_000, "F43", "ROOM"],
  ["private_bath_suite", 30, 320_000, "C44", "ROOM"],
  ["private_bath_suite", 14, 188_000, "D44", "ROOM"],
  ["private_bath_suite", 7, 128_000, "E44", "ROOM"],
  ["private_bath_suite", 1, 32_000, "F44", "ROOM"]
] satisfies readonly CanonicalRateTuple[];

const revision561PricingProductTuples = [
  ["shared_bath_quad_bed", "shared_bath_quad", "BED", 1, [5_800, 30_800, 48_000, 78_000], "SOURCE_PUBLISHED"],
  ["shared_bath_double_bed", "shared_bath_double", "BED", 1, [6_800, 38_000, 55_000, 90_000], "SOURCE_PUBLISHED"],
  ["shared_bath_single_room", "shared_bath_single", "ROOM", 1, [13_000, 59_000, 82_000, 135_000], "SOURCE_PUBLISHED"],
  ["shared_bath_standard_room", "shared_bath_standard", "ROOM", 1, [18_000, 79_000, 120_000, 195_000], "SOURCE_PUBLISHED"],
  ["private_bath_single_room", "private_bath_single", "ROOM", 1, [17_000, 72_000, 119_000, 180_000], "SOURCE_PUBLISHED"],
  ["private_bath_standard_room", "private_bath_standard", "ROOM", 1, [24_000, 102_000, 168_000, 258_000], "SOURCE_PUBLISHED"],
  ["private_bath_king_room", "private_bath_king", "ROOM", 1, [24_000, 102_000, 168_000, 258_000], "SOURCE_PUBLISHED"],
  ["private_bath_suite_room", "private_bath_suite", "ROOM", 1, [32_000, 128_000, 188_000, 320_000], "SOURCE_PUBLISHED"],
  ["shared_bath_double_whole_room", "shared_bath_double", "ROOM", 2, [13_600, 76_000, 110_000, 180_000], "BED_ANCHORS_TIMES_PHYSICAL_BEDS"],
  ["shared_bath_quad_whole_room", "shared_bath_quad", "ROOM", 4, [23_200, 123_200, 192_000, 312_000], "BED_ANCHORS_TIMES_PHYSICAL_BEDS"]
] satisfies readonly CanonicalPricingProductTuple[];

const revision561RoomTupleByCode = new Map<string, CanonicalRoomTuple>(
  revision561RoomTuples.map((tuple) => [tuple[0], tuple] as const)
);
const revision561RateTupleByKey = new Map<string, CanonicalRateTuple>(
  revision561RateTuples.map((tuple) => [`${tuple[0]}:${tuple[1]}`, tuple] as const)
);
const revision561PricingProductTupleByCode = new Map<string, CanonicalPricingProductTuple>(
  revision561PricingProductTuples.map((tuple) => [tuple[0], tuple] as const)
);

export interface Qintopia2026ReferenceCatalogSnapshot {
  schemaVersion: string;
  importId: string;
  property: { name: string; timezone: string; currency: string; sourcePropertyCode: string | null };
  source: {
    kind: string;
    url: string;
    revision: number;
    sheets: Array<{
      sheetId: string;
      sheetName: string;
      inventoryDetailRange?: string;
      inventorySummaryRange?: string;
      operatingNotesRange?: string;
      publicPriceRange?: string;
      membershipRange?: string;
      excludedPriceRanges?: Array<{ range: string; reason: string }>;
    }>;
    publicPriceVersionLabel: string;
    publicPriceVersionDate: string;
    effectiveFrom: string;
    effectiveUntil: string | null;
  };
  inventory: {
    summary: {
      physicalRoomCount: number;
      physicalBedCount: number;
      roomSaleUnitCount: number;
      bedSaleUnitCount: number;
      baseInventoryUnitCount: number;
      wholeRoomCombinationCount: number;
      salesEntryCount: number;
    };
    rejectedSourceFigures: Array<{ name: string; value: number; reason: string }>;
    categories: InventoryCategorySnapshot[];
    rooms: PhysicalRoomSnapshot[];
  };
  pricingRule: {
    code: string;
    version: number;
    calculationKind: "DURATION_BAND_TOTAL";
    effectiveFrom: string;
    effectiveUntil: null;
    transientMaximumNightsExclusive: 7;
    bands: Array<{ minimumNights: number; maximumNightsExclusive: number | null; anchorNights: PackageNights }>;
    rounding: { stage: "FINAL_STAY_TOTAL"; unit: "CNY_YUAN"; mode: "HALF_UP_POSITIVE" };
    shorteningBasis: "FULL_STAY_FROM_ORIGINAL_ARRIVAL";
    extensionBasis: "FULL_STAY_FROM_ORIGINAL_ARRIVAL";
    crossCalendarMonthTreatment: "NO_SPLIT";
    antiInversionRule: "NONE";
    separateElectricityCharge: false;
  };
  publicRates: {
    currency: string;
    amountRepresentation: string;
    anchorKind: string;
    durationUnit: string;
    rates: RateSnapshot[];
    products: PricingProductSnapshot[];
  };
  membershipProducts: MembershipProductSnapshot[];
  membershipRules: {
    bookingRule: string;
    refundPolicy: "NON_REFUNDABLE_MEMBERSHIP";
    refundRule: string;
    overriddenSourceRefundRule: string;
    refundCalculation: null;
    sourceRange: string;
  };
  operatingNotes: unknown[];
  unresolvedIssues: Array<{ code: string; description: string }>;
}

export interface ReferenceCatalogImportOptions {
  propertyId?: string;
  propertyCode?: string;
}

function assertCatalog(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Invalid 2026 reference catalog: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) > 0;
}

function isPackageNights(value: unknown): value is PackageNights {
  return value === 1 || value === 7 || value === 14 || value === 30;
}

function roomTuple(room: PhysicalRoomSnapshot): CanonicalRoomTuple {
  return [
    room.operationalCode,
    room.buildingCode,
    room.roomTypeKey,
    room.sourceCode,
    room.sourceLabel,
    room.codeProvenance,
    room.physicalBedCount,
    room.physicalBedCodes,
    room.saleMode
  ];
}

function rateTuple(rate: RateSnapshot): CanonicalRateTuple {
  return [rate.roomTypeKey, rate.nights, rate.amountMinor, rate.sourceCell, rate.saleUnit];
}

function pricingProductTuple(product: PricingProductSnapshot): CanonicalPricingProductTuple {
  return [
    product.productCode,
    product.roomTypeKey,
    product.inventoryUnitKind,
    product.anchorMultiplier,
    [product.anchorsMinor["1"], product.anchorsMinor["7"], product.anchorsMinor["14"], product.anchorsMinor["30"]],
    product.derivation
  ];
}

function tuplesMatch(actual: readonly unknown[], expected: readonly unknown[]): boolean {
  return JSON.stringify(actual) === JSON.stringify(expected);
}

export function validateQintopia2026ReferenceCatalogSnapshot(value: unknown): Qintopia2026ReferenceCatalogSnapshot {
  assertCatalog(isRecord(value), "top-level value must be an object");
  const snapshot = value as unknown as Qintopia2026ReferenceCatalogSnapshot;
  assertCatalog(snapshot.schemaVersion === "2.0.0", "unsupported schemaVersion");
  assertCatalog(snapshot.importId === revision561ImportId, `importId must remain ${revision561ImportId}`);
  assertCatalog(isRecord(snapshot.property), "property is required");
  assertCatalog(snapshot.property.timezone === "Asia/Shanghai", "property timezone must be Asia/Shanghai");
  assertCatalog(snapshot.property.currency === "CNY", "property currency must be CNY");
  assertCatalog(isRecord(snapshot.source), "source is required");
  assertCatalog(snapshot.source.kind === "FEISHU_SPREADSHEET", "source kind must be FEISHU_SPREADSHEET");
  assertCatalog(snapshot.source.revision === revision561SourceRevision, `source revision must remain ${revision561SourceRevision}`);
  assertCatalog(snapshot.source.publicPriceVersionLabel === "2026年对外公布秦托邦定价表（2026.2.25）", "public price version label changed from revision 561");
  assertCatalog(snapshot.source.publicPriceVersionDate === "2026-02-25", "public price version date changed from revision 561");
  assertCatalog(snapshot.source.effectiveFrom === "2026-02-25", "public pricing must not be effective before 2026-02-25");
  assertCatalog(snapshot.source.effectiveUntil === null, "unconfirmed effective end must remain open");
  assertCatalog(Array.isArray(snapshot.source.sheets), "source sheets are required");
  const inventorySheet = snapshot.source.sheets.find((sheet) => sheet.sheetName === "2026定价");
  const pricingSheet = snapshot.source.sheets.find((sheet) => sheet.sheetName === "2026价格表");
  assertCatalog(inventorySheet?.sheetId === "1Sztbi", "2026 inventory sheet identity changed");
  assertCatalog(pricingSheet?.sheetId === "nKHq63", "2026 public price sheet identity changed");
  assertCatalog(pricingSheet.publicPriceRange === "A28:F44", "only the published price range A28:F44 may be imported");
  assertCatalog(pricingSheet.excludedPriceRanges?.some((item) => item.range === "A9:F25"), "the floor-price range A9:F25 must be explicitly excluded");

  assertCatalog(isRecord(snapshot.inventory) && isRecord(snapshot.inventory.summary), "inventory summary is required");
  assertCatalog(Array.isArray(snapshot.inventory.categories) && snapshot.inventory.categories.length === 8, "exactly 8 inventory categories are required");
  const categoryKeys = new Set<string>();
  let physicalRoomCount = 0;
  let physicalBedCount = 0;
  let roomSaleUnitCount = 0;
  let bedSaleUnitCount = 0;
  for (const category of snapshot.inventory.categories) {
    assertCatalog(isRecord(category), "each inventory category must be an object");
    assertCatalog(typeof category.roomTypeKey === "string" && category.roomTypeKey.length > 0, "category roomTypeKey is required");
    assertCatalog(!categoryKeys.has(category.roomTypeKey), `duplicate category ${category.roomTypeKey}`);
    categoryKeys.add(category.roomTypeKey);
    assertCatalog(category.bathroom === "PRIVATE" || category.bathroom === "SHARED", `invalid bathroom for ${category.roomTypeKey}`);
    assertCatalog(category.saleUnit === "ROOM" || category.saleUnit === "BED", `invalid sale unit for ${category.roomTypeKey}`);
    assertCatalog(category.separateElectricityCharge === false, `electricity must not be charged separately for ${category.roomTypeKey}`);
    assertCatalog(isPositiveInteger(category.physicalRoomCount), `physical room count is invalid for ${category.roomTypeKey}`);
    assertCatalog(isPositiveInteger(category.physicalBedCount), `physical bed count is invalid for ${category.roomTypeKey}`);
    assertCatalog(isPositiveInteger(category.sellableUnitCount), `sellable unit count is invalid for ${category.roomTypeKey}`);
    if (category.saleUnit === "ROOM") {
      assertCatalog(category.sellableUnitCount === category.physicalRoomCount, `room-sale count mismatch for ${category.roomTypeKey}`);
      roomSaleUnitCount += category.sellableUnitCount;
    } else {
      assertCatalog(category.sellableUnitCount % category.physicalRoomCount === 0, `bed-sale count mismatch for ${category.roomTypeKey}`);
      bedSaleUnitCount += category.sellableUnitCount;
    }
    physicalRoomCount += category.physicalRoomCount;
    physicalBedCount += category.physicalBedCount;
  }
  const summary = snapshot.inventory.summary;
  assertCatalog(summary.physicalRoomCount === 44 && physicalRoomCount === 44, "physical room total must be 44");
  assertCatalog(summary.physicalBedCount === 91 && physicalBedCount === 91, "physical bed total must be 91");
  assertCatalog(summary.roomSaleUnitCount === 31 && roomSaleUnitCount === 31, "room-sale unit total must be 31");
  assertCatalog(summary.bedSaleUnitCount === 46 && bedSaleUnitCount === 46, "bed-sale unit total must be 46");
  assertCatalog(summary.baseInventoryUnitCount === 77 && roomSaleUnitCount + bedSaleUnitCount === 77, "base inventory total must be 77");
  assertCatalog(summary.wholeRoomCombinationCount === 13, "whole-room combination count must be 13");
  assertCatalog(summary.salesEntryCount === 90, "sales-entry count must be 90 without increasing base inventory");
  assertCatalog(!Object.hasOwn(summary, "statedMaximumOccupancy"), "rejected occupancy 97 must not remain in the inventory summary");
  assertCatalog(Array.isArray(snapshot.inventory.rejectedSourceFigures), "rejected source figures are required");
  assertCatalog(snapshot.inventory.rejectedSourceFigures.some((item) => item.name === "statedMaximumOccupancy" && item.value === 97), "the rejected 97 figure must retain explicit provenance");

  assertCatalog(Array.isArray(snapshot.inventory.rooms) && snapshot.inventory.rooms.length === 44, "exactly 44 physical rooms are required");
  const roomCodes = new Set<string>();
  const roomCountsByType = new Map<string, number>();
  const bedCountsByType = new Map<string, number>();
  const bedCountsByBuilding = new Map<string, number>();
  let combinationRooms = 0;
  for (const room of snapshot.inventory.rooms) {
    assertCatalog(isRecord(room), "each physical room must be an object");
    assertCatalog(typeof room.operationalCode === "string" && room.operationalCode.length > 0, "room operationalCode is required");
    assertCatalog(!roomCodes.has(room.operationalCode), `duplicate room operationalCode ${room.operationalCode}`);
    roomCodes.add(room.operationalCode);
    assertCatalog(categoryKeys.has(room.roomTypeKey), `room ${room.operationalCode} references unknown type ${room.roomTypeKey}`);
    assertCatalog(["SOURCE_EXPLICIT", "USER_CONFIRMED_RENAMED", "PMS_GENERATED"].includes(room.codeProvenance), `invalid provenance for ${room.operationalCode}`);
    assertCatalog(isPositiveInteger(room.physicalBedCount), `room ${room.operationalCode} physical bed count is invalid`);
    if (room.physicalBedCount === 1) {
      assertCatalog(room.physicalBedCodes === null, `single-bed room ${room.operationalCode} must not invent a source bed label`);
    } else {
      const expectedBedCodes = room.physicalBedCount === 2 ? ["A", "B"] : ["A", "B", "C", "D"];
      assertCatalog(room.physicalBedCount === 2 || room.physicalBedCount === 4, `unsupported physical bed count for ${room.operationalCode}`);
      assertCatalog(JSON.stringify(room.physicalBedCodes) === JSON.stringify(expectedBedCodes), `room ${room.operationalCode} bed codes must follow the confirmed rule`);
    }
    const category = snapshot.inventory.categories.find((item) => item.roomTypeKey === room.roomTypeKey)!;
    const expectedSaleMode = category.saleUnit === "BED" ? "BED_WITH_WHOLE_ROOM_COMBINATION" : "INDEPENDENT_ROOM";
    assertCatalog(room.saleMode === expectedSaleMode, `room ${room.operationalCode} sale mode does not match ${room.roomTypeKey}`);
    const expectedRoomTuple = revision561RoomTupleByCode.get(room.operationalCode);
    assertCatalog(expectedRoomTuple !== undefined && tuplesMatch(roomTuple(room), expectedRoomTuple), `canonical room ${room.operationalCode} changed from revision 561`);
    if (room.saleMode === "BED_WITH_WHOLE_ROOM_COMBINATION") combinationRooms += 1;
    roomCountsByType.set(room.roomTypeKey, (roomCountsByType.get(room.roomTypeKey) ?? 0) + 1);
    bedCountsByType.set(room.roomTypeKey, (bedCountsByType.get(room.roomTypeKey) ?? 0) + room.physicalBedCount);
    bedCountsByBuilding.set(room.buildingCode, (bedCountsByBuilding.get(room.buildingCode) ?? 0) + room.physicalBedCount);
  }
  for (const category of snapshot.inventory.categories) {
    assertCatalog(roomCountsByType.get(category.roomTypeKey) === category.physicalRoomCount, `room count mismatch for ${category.roomTypeKey}`);
    assertCatalog(bedCountsByType.get(category.roomTypeKey) === category.physicalBedCount, `physical bed count mismatch for ${category.roomTypeKey}`);
  }
  assertCatalog(combinationRooms === 13, "exactly 13 rooms may be sold as bed inventory or a whole-room combination");
  const confirmedBuildingBeds: Record<string, number> = { A: 6, B: 6, C: 4, D: 8, E: 5, "1": 32, "2": 16, "3": 14 };
  assertCatalog(JSON.stringify(Object.fromEntries([...bedCountsByBuilding.entries()].sort())) === JSON.stringify(Object.fromEntries(Object.entries(confirmedBuildingBeds).sort())), "building bed totals must close to 91");
  assertCatalog(snapshot.inventory.rooms.filter((room) => room.buildingCode === "C").every((room) => room.operationalCode.startsWith("C") && room.sourceCode?.startsWith("I")), "I building rooms must be exposed as confirmed C codes with source provenance");
  assertCatalog(snapshot.inventory.rooms.filter((room) => room.buildingCode === "D" || room.buildingCode === "E").every((room) => room.codeProvenance === "PMS_GENERATED" && room.sourceCode === null), "D/E operational room codes must be explicitly generated");

  assertCatalog(isRecord(snapshot.pricingRule), "pricingRule is required");
  assertCatalog(snapshot.pricingRule.code === "QINTOPIA_PUBLIC_2026_REV561" && snapshot.pricingRule.version === 1, "pricing rule identity changed");
  assertCatalog(snapshot.pricingRule.calculationKind === "DURATION_BAND_TOTAL", "pricing rule must use the confirmed duration bands");
  assertCatalog(snapshot.pricingRule.effectiveFrom === "2026-02-25" && snapshot.pricingRule.effectiveUntil === null, "pricing rule effective interval changed");
  assertCatalog(snapshot.pricingRule.transientMaximumNightsExclusive === 7, "TRANSIENT must be strictly shorter than 7 nights");
  const confirmedBands = [
    { minimumNights: 1, maximumNightsExclusive: 7, anchorNights: 1 },
    { minimumNights: 7, maximumNightsExclusive: 14, anchorNights: 7 },
    { minimumNights: 14, maximumNightsExclusive: 30, anchorNights: 14 },
    { minimumNights: 30, maximumNightsExclusive: null, anchorNights: 30 }
  ] as const;
  assertCatalog(snapshot.pricingRule.bands.length === confirmedBands.length
    && snapshot.pricingRule.bands.every((band, index) => {
      const expected = confirmedBands[index];
      return expected !== undefined
        && band.minimumNights === expected.minimumNights
        && band.maximumNightsExclusive === expected.maximumNightsExclusive
        && band.anchorNights === expected.anchorNights;
    }), "pricing duration bands changed");
  assertCatalog(snapshot.pricingRule.rounding.stage === "FINAL_STAY_TOTAL" && snapshot.pricingRule.rounding.unit === "CNY_YUAN" && snapshot.pricingRule.rounding.mode === "HALF_UP_POSITIVE", "final whole-yuan half-up rounding changed");
  assertCatalog(snapshot.pricingRule.shorteningBasis === "FULL_STAY_FROM_ORIGINAL_ARRIVAL" && snapshot.pricingRule.extensionBasis === "FULL_STAY_FROM_ORIGINAL_ARRIVAL", "amendments must reprice the complete stay");
  assertCatalog(snapshot.pricingRule.crossCalendarMonthTreatment === "NO_SPLIT" && snapshot.pricingRule.antiInversionRule === "NONE", "cross-month or inversion behavior changed");
  assertCatalog(snapshot.pricingRule.separateElectricityCharge === false, "pricing must not create a separate electricity charge");

  assertCatalog(isRecord(snapshot.publicRates), "publicRates is required");
  assertCatalog(snapshot.publicRates.currency === "CNY", "public rates must use CNY");
  assertCatalog(snapshot.publicRates.amountRepresentation === "MINOR_UNITS", "public rates must use minor units");
  assertCatalog(snapshot.publicRates.anchorKind === "FIXED_STAY_TOTAL", "public rate anchors must remain fixed-stay totals");
  assertCatalog(snapshot.publicRates.durationUnit === "NIGHT", "public rate duration must be nights");
  assertCatalog(Array.isArray(snapshot.publicRates.rates) && snapshot.publicRates.rates.length === 32, "exactly 32 public rates are required");
  const rateKeys = new Set<string>();
  const rateSourceCells = new Set<string>();
  const sourceColumnByNights: Record<PackageNights, string> = { 1: "F", 7: "E", 14: "D", 30: "C" };
  for (const rate of snapshot.publicRates.rates) {
    assertCatalog(isRecord(rate), "each public rate must be an object");
    const category = snapshot.inventory.categories.find((item) => item.roomTypeKey === rate.roomTypeKey);
    assertCatalog(category !== undefined, `rate references unknown category ${rate.roomTypeKey}`);
    assertCatalog(rate.saleUnit === category.saleUnit, `rate sale unit mismatch for ${rate.roomTypeKey}`);
    assertCatalog(isPackageNights(rate.nights), `invalid package nights for ${rate.roomTypeKey}`);
    assertCatalog(isPositiveInteger(rate.amountMinor), `invalid amount for ${rate.roomTypeKey}/${rate.nights}`);
    assertCatalog(typeof rate.sourceCell === "string" && /^[C-F](3[1-2]|3[6-7]|4[1-4])$/.test(rate.sourceCell), `rate ${rate.roomTypeKey}/${rate.nights} is outside the published rows`);
    assertCatalog(rate.sourceCell.startsWith(sourceColumnByNights[rate.nights]), `rate ${rate.roomTypeKey}/${rate.nights} points to the wrong duration column`);
    assertCatalog(!rateSourceCells.has(rate.sourceCell), `duplicate public rate source cell ${rate.sourceCell}`);
    rateSourceCells.add(rate.sourceCell);
    const key = `${rate.roomTypeKey}:${rate.nights}`;
    assertCatalog(!rateKeys.has(key), `duplicate rate ${key}`);
    rateKeys.add(key);
    const expectedRateTuple = revision561RateTupleByKey.get(key);
    assertCatalog(expectedRateTuple !== undefined && tuplesMatch(rateTuple(rate), expectedRateTuple), `canonical public rate ${key} changed from revision 561`);
  }
  for (const categoryKey of categoryKeys) {
    for (const nights of [1, 7, 14, 30] as const) {
      assertCatalog(rateKeys.has(`${categoryKey}:${nights}`), `missing rate ${categoryKey}/${nights}`);
    }
  }

  assertCatalog(Array.isArray(snapshot.publicRates.products) && snapshot.publicRates.products.length === 10, "exactly 10 price products are required");
  const productCodes = new Set<string>();
  for (const product of snapshot.publicRates.products) {
    assertCatalog(isRecord(product), "each pricing product must be an object");
    assertCatalog(!productCodes.has(product.productCode), `duplicate pricing product ${product.productCode}`);
    productCodes.add(product.productCode);
    const category = snapshot.inventory.categories.find((item) => item.roomTypeKey === product.roomTypeKey);
    assertCatalog(category !== undefined, `pricing product ${product.productCode} references an unknown room type`);
    assertCatalog(product.inventoryUnitKind === "ROOM" || product.inventoryUnitKind === "BED", `pricing product ${product.productCode} has an invalid inventory kind`);
    assertCatalog(product.anchorMultiplier === 1 || product.anchorMultiplier === 2 || product.anchorMultiplier === 4, `pricing product ${product.productCode} has an invalid multiplier`);
    assertCatalog(isRecord(product.anchorsMinor), `pricing product ${product.productCode} anchors are required`);
    const expectedProductTuple = revision561PricingProductTupleByCode.get(product.productCode);
    assertCatalog(expectedProductTuple !== undefined && tuplesMatch(pricingProductTuple(product), expectedProductTuple), `canonical pricing product ${product.productCode} changed from revision 561`);
    for (const nights of [1, 7, 14, 30] as const) {
      const baseRate = snapshot.publicRates.rates.find((rate) => rate.roomTypeKey === product.roomTypeKey && rate.nights === nights);
      assertCatalog(baseRate !== undefined, `pricing product ${product.productCode} has no ${nights}-night anchor source`);
      assertCatalog(product.anchorsMinor[String(nights) as keyof PricingProductSnapshot["anchorsMinor"]] === baseRate.amountMinor * product.anchorMultiplier, `pricing product ${product.productCode} ${nights}-night anchor is not the confirmed multiplier`);
    }
    if (product.anchorMultiplier === 1) {
      assertCatalog(product.derivation === "SOURCE_PUBLISHED" && product.inventoryUnitKind === category.saleUnit, `base pricing product ${product.productCode} provenance changed`);
    } else {
      assertCatalog(product.derivation === "BED_ANCHORS_TIMES_PHYSICAL_BEDS" && category.saleUnit === "BED" && product.inventoryUnitKind === "ROOM", `combination pricing product ${product.productCode} provenance changed`);
    }
  }

  assertCatalog(Array.isArray(snapshot.membershipProducts) && snapshot.membershipProducts.length === 3, "exactly 3 membership products are required");
  assertCatalog(isRecord(snapshot.membershipRules), "membership rules must be preserved");
  assertCatalog(typeof snapshot.membershipRules.bookingRule === "string" && snapshot.membershipRules.bookingRule.length > 0, "membership booking rule is required");
  assertCatalog(snapshot.membershipRules.refundPolicy === "NON_REFUNDABLE_MEMBERSHIP", "membership purchase must remain non-refundable");
  assertCatalog(typeof snapshot.membershipRules.refundRule === "string" && snapshot.membershipRules.refundRule.length > 0, "membership refund rule is required");
  assertCatalog(typeof snapshot.membershipRules.overriddenSourceRefundRule === "string" && snapshot.membershipRules.overriddenSourceRefundRule.length > 0, "overridden source refund wording must retain provenance");
  assertCatalog(snapshot.membershipRules.refundCalculation === null, "ambiguous membership refund calculation must remain null");
  assertCatalog(typeof snapshot.membershipRules.sourceRange === "string" && snapshot.membershipRules.sourceRange.length > 0, "membership rule source range is required");
  const membershipKeys = new Set<string>();
  for (const product of snapshot.membershipProducts) {
    assertCatalog(isRecord(product), "each membership product must be an object");
    assertCatalog(typeof product.productKey === "string" && product.productKey.length > 0, "membership productKey is required");
    assertCatalog(!membershipKeys.has(product.productKey), `duplicate membership product ${product.productKey}`);
    membershipKeys.add(product.productKey);
    const category = snapshot.inventory.categories.find((item) => item.roomTypeKey === product.roomTypeKey);
    assertCatalog(category !== undefined, `membership references unknown category ${product.roomTypeKey}`);
    assertCatalog(product.entitlementUnit === "ROOM_NIGHT" || product.entitlementUnit === "BED_NIGHT", `membership ${product.productKey} entitlement unit is invalid`);
    const expectedEntitlementUnit = category.saleUnit === "ROOM" ? "ROOM_NIGHT" : "BED_NIGHT";
    assertCatalog(product.entitlementUnit === expectedEntitlementUnit, `membership ${product.productKey} entitlement unit does not match ${category.saleUnit}`);
    assertCatalog(product.currency === "CNY", `membership ${product.productKey} must use CNY`);
    assertCatalog(isPositiveInteger(product.priceMinor), `membership ${product.productKey} price is invalid`);
    assertCatalog(product.entitlementNightCount === 30, `membership ${product.productKey} must preserve the 30-night entitlement`);
    assertCatalog(product.quota === 10 && product.quotaMeaning === "MEMBERSHIP_SLOTS_NOT_INVENTORY", `membership ${product.productKey} quota semantics changed`);
    assertCatalog(product.validity?.startsAt === "PAYMENT_DATE" && product.validity.period === "P1Y", `membership ${product.productKey} validity must remain one calendar year from payment`);
  }
  assertCatalog(Array.isArray(snapshot.operatingNotes), "operating notes must be preserved");
  assertCatalog(Array.isArray(snapshot.unresolvedIssues) && snapshot.unresolvedIssues.length > 0, "unresolved issues must be preserved");
  const unresolvedCodes = new Set(snapshot.unresolvedIssues.flatMap((issue) => (
    isRecord(issue) && typeof issue.code === "string" ? [issue.code] : []
  )));
  for (const resolvedCode of [
    "FREE_PRICING_CASES_MISSING",
    "PARTIAL_MEMBER_COVERAGE_PRICING_CASES_MISSING",
    "MANUAL_ADJUSTMENT_CASES_MISSING",
    "MOVE_ACROSS_PRICE_PRODUCTS_CASES_MISSING",
    "MEMBERSHIP_REFUND_CALCULATION_AMBIGUOUS"
  ]) {
    assertCatalog(!unresolvedCodes.has(resolvedCode), `${resolvedCode} was superseded by confirmed business facts`);
  }
  for (const issue of snapshot.unresolvedIssues) {
    assertCatalog(isRecord(issue), "each unresolved issue must be an object");
    assertCatalog(typeof issue.code === "string" && issue.code.length > 0, "each unresolved issue needs a code");
    assertCatalog(typeof issue.description === "string" && issue.description.length > 0, `unresolved issue ${issue.code} needs a description`);
  }
  return snapshot;
}

export async function loadBundledQintopia2026Catalog(): Promise<Qintopia2026ReferenceCatalogSnapshot> {
  return validateQintopia2026ReferenceCatalogSnapshot(JSON.parse(await readFile(bundledCatalogUrl, "utf8")) as unknown);
}

function sourceDocumentToken(snapshot: Qintopia2026ReferenceCatalogSnapshot): string {
  const match = /\/wiki\/([^/?]+)/.exec(snapshot.source.url);
  assertCatalog(match?.[1], "source URL does not contain a wiki document token");
  return match[1];
}

function inventorySourceRange(typeCode: string): string {
  const ranges: Record<string, string> = {
    private_bath_standard: "B9:C13",
    private_bath_single: "B14:C20",
    private_bath_king: "B21:C22",
    private_bath_suite: "B23:C23",
    shared_bath_single: "B24:C25,B72:C75,B81:C82",
    shared_bath_double: "B26:C31",
    shared_bath_quad: "B32:C71",
    shared_bath_standard: "B76:C80,B83:C85"
  };
  const range = ranges[typeCode];
  assertCatalog(range, `missing inventory source range for ${typeCode}`);
  return range;
}

function inventoryEntryId(importId: string, typeCode: string): string {
  return `${importId}:inventory:${typeCode}`;
}

function rateEntryId(importId: string, rate: RateSnapshot): string {
  return `${importId}:rate:${rate.roomTypeKey}:${rate.nights}`;
}

function membershipEntryId(importId: string, productKey: string): string {
  return `${importId}:membership:${productKey}`;
}

function referenceCatalogRows(snapshot: Qintopia2026ReferenceCatalogSnapshot) {
  const inventoryEntries = snapshot.inventory.categories.map((category) => ({
    id: inventoryEntryId(snapshot.importId, category.roomTypeKey),
    import_batch_id: snapshot.importId,
    type_code: category.roomTypeKey,
    type_name: category.sourceName,
    bathroom_type: category.bathroom === "PRIVATE" ? "ENSUITE" as const : "SHARED" as const,
    sell_unit_kind: category.saleUnit,
    physical_room_count: category.physicalRoomCount,
    units_per_room: category.saleUnit === "BED" ? category.sellableUnitCount / category.physicalRoomCount : null,
    sellable_unit_count: category.sellableUnitCount,
    electricity_included: !category.separateElectricityCharge,
    execution_state: referenceOnly,
    source_sheet: "2026定价",
    source_range: inventorySourceRange(category.roomTypeKey)
  }));
  const rates = snapshot.publicRates.rates.map((rate) => ({
    id: rateEntryId(snapshot.importId, rate),
    import_batch_id: snapshot.importId,
    inventory_catalog_entry_id: inventoryEntryId(snapshot.importId, rate.roomTypeKey),
    package_nights: rate.nights,
    package_amount_minor: rate.amountMinor,
    currency: snapshot.publicRates.currency,
    execution_state: referenceOnly,
    source_sheet: "2026价格表",
    source_range: rate.sourceCell
  }));
  const membershipProducts = snapshot.membershipProducts.map((product) => ({
    id: membershipEntryId(snapshot.importId, product.productKey),
    import_batch_id: snapshot.importId,
    inventory_catalog_entry_id: inventoryEntryId(snapshot.importId, product.roomTypeKey),
    product_code: product.productKey,
    product_name: product.sourceName,
    price_minor: product.priceMinor,
    currency: product.currency,
    sales_limit: product.quota,
    entitlement_nights: product.entitlementNightCount,
    validity_period: product.validity.period,
    terms: {
      entitlementUnit: product.entitlementUnit,
      quotaMeaning: product.quotaMeaning,
      validityStartsAt: product.validity.startsAt,
      membershipRules: snapshot.membershipRules
    },
    execution_state: referenceOnly,
    source_sheet: "2026价格表",
    source_range: product.sourceRange
  }));
  return { inventoryEntries, rates, membershipProducts };
}

function comparableRows(rows: object[]): Record<string, unknown>[] {
  return rows
    .map((row) => Object.fromEntries(Object.entries(row).filter(([key]) => key !== "created_at")))
    .sort((left, right) => String(left.id).localeCompare(String(right.id)));
}

function assertPersistedCatalogRows(
  actual: { inventoryEntries: object[]; rates: object[]; membershipProducts: object[] },
  expected: ReturnType<typeof referenceCatalogRows>
): void {
  assertCatalog(
    stableHash(comparableRows(actual.inventoryEntries)) === stableHash(comparableRows(expected.inventoryEntries)),
    "sealed inventory rows do not match the source snapshot"
  );
  assertCatalog(
    stableHash(comparableRows(actual.rates)) === stableHash(comparableRows(expected.rates)),
    "sealed rate rows do not match the source snapshot"
  );
  assertCatalog(
    stableHash(comparableRows(actual.membershipProducts)) === stableHash(comparableRows(expected.membershipProducts)),
    "sealed membership rows do not match the source snapshot"
  );
}

function createdAtIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export async function loadReferenceCatalog(db: DbExecutor, propertyId: string, importBatchId?: string): Promise<ReferenceCatalogDto | undefined> {
  let batchQuery = db.selectFrom("catalog_import_batches")
    .selectAll()
    .where("property_id", "=", propertyId)
    .where("sealed_at", "is not", null);
  if (importBatchId) batchQuery = batchQuery.where("id", "=", importBatchId);
  const batch = await batchQuery
    .orderBy("created_at", "desc")
    .orderBy("id", "desc")
    .executeTakeFirst();
  if (!batch) return undefined;
  const snapshot = validateQintopia2026ReferenceCatalogSnapshot(typeof batch.source_snapshot === "string" ? JSON.parse(batch.source_snapshot) as unknown : batch.source_snapshot);
  assertCatalog(batch.id === snapshot.importId, `sealed batch ${batch.id} does not match snapshot importId ${snapshot.importId}`);
  assertCatalog(batch.source_document_token === sourceDocumentToken(snapshot), `sealed batch ${batch.id} provenance token does not match its snapshot`);
  assertCatalog(batch.source_revision === snapshot.source.revision, `sealed batch ${batch.id} revision does not match its snapshot`);
  assertCatalog(batch.source_version_date === snapshot.source.publicPriceVersionDate, `sealed batch ${batch.id} version date does not match its snapshot`);
  assertCatalog(batch.content_hash === stableHash(snapshot), `sealed batch ${batch.id} content hash does not match its snapshot`);
  const expectedRows = referenceCatalogRows(snapshot);
  const [property, inventoryEntries, rates, membershipProducts] = await Promise.all([
    db.selectFrom("properties").select(["timezone", "currency"]).where("id", "=", propertyId).executeTakeFirst(),
    db.selectFrom("inventory_catalog_entries").selectAll().where("import_batch_id", "=", batch.id).orderBy("type_code").execute(),
    db.selectFrom("reference_rate_entries").selectAll().where("import_batch_id", "=", batch.id).orderBy("inventory_catalog_entry_id").orderBy("package_nights").execute(),
    db.selectFrom("reference_membership_products").selectAll().where("import_batch_id", "=", batch.id).orderBy("product_code").execute()
  ]);
  assertCatalog(property?.timezone === snapshot.property.timezone, `property ${propertyId} timezone does not match sealed batch ${batch.id}`);
  assertCatalog(property.currency === snapshot.property.currency, `property ${propertyId} currency does not match sealed batch ${batch.id}`);
  assertPersistedCatalogRows({ inventoryEntries, rates, membershipProducts }, expectedRows);
  return {
    batch: {
      id: batch.id,
      propertyId: batch.property_id,
      sourceRevision: batch.source_revision,
      sourceVersionDate: batch.source_version_date,
      contentHash: batch.content_hash,
      executionState: batch.execution_state,
      createdAt: createdAtIso(batch.created_at)
    },
    inventoryEntries: inventoryEntries.map((entry) => ({
      id: entry.id,
      typeCode: entry.type_code,
      typeName: entry.type_name,
      bathroomType: entry.bathroom_type,
      sellUnitKind: entry.sell_unit_kind,
      physicalRoomCount: entry.physical_room_count,
      physicalBedCount: snapshot.inventory.categories.find((category) => category.roomTypeKey === entry.type_code)!.physicalBedCount,
      unitsPerRoom: entry.units_per_room,
      sellableUnitCount: entry.sellable_unit_count,
      separateElectricityCharge: false,
      executionState: entry.execution_state,
      sourceSheet: entry.source_sheet,
      sourceRange: entry.source_range
    })),
    rates: rates.map((rate) => ({
      id: rate.id,
      inventoryCatalogEntryId: rate.inventory_catalog_entry_id,
      packageNights: rate.package_nights,
      packageAmountMinor: rate.package_amount_minor,
      currency: rate.currency,
      executionState: rate.execution_state,
      sourceSheet: rate.source_sheet,
      sourceRange: rate.source_range
    })),
    rooms: snapshot.inventory.rooms.map((room) => ({ ...room })),
    pricingRule: { ...snapshot.pricingRule, bands: snapshot.pricingRule.bands.map((band) => ({ ...band })), rounding: { ...snapshot.pricingRule.rounding } },
    pricingProducts: snapshot.publicRates.products.map((product) => ({ ...product, anchorsMinor: { ...product.anchorsMinor } })),
    rejectedSourceFigures: snapshot.inventory.rejectedSourceFigures.map((figure) => ({ ...figure })),
    membershipProducts: membershipProducts.map((product) => ({
      id: product.id,
      inventoryCatalogEntryId: product.inventory_catalog_entry_id,
      code: product.product_code,
      name: product.product_name,
      priceMinor: product.price_minor,
      currency: product.currency,
      salesLimit: product.sales_limit,
      entitlementNights: product.entitlement_nights,
      validityPeriod: product.validity_period,
      executionState: product.execution_state,
      terms: product.terms as ReferenceCatalogDto["membershipProducts"][number]["terms"],
      sourceSheet: product.source_sheet,
      sourceRange: product.source_range
    })),
    unresolvedIssues: snapshot.unresolvedIssues
  };
}

export async function importQintopia2026ReferenceCatalog(
  db: Kysely<Database>,
  options: ReferenceCatalogImportOptions = {}
): Promise<ReferenceCatalogDto> {
  const snapshot = await loadBundledQintopia2026Catalog();
  const propertyId = options.propertyId ?? defaultPropertyId;
  const propertyCode = options.propertyCode ?? defaultPropertyCode;
  const contentHash = stableHash(snapshot);
  const rows = referenceCatalogRows(snapshot);

  return db.transaction().execute(async (trx) => {
    await sql`select pg_advisory_xact_lock(hashtextextended(${snapshot.importId}, 0::bigint))`.execute(trx);
    const property = await trx.selectFrom("properties").selectAll().where("id", "=", propertyId).executeTakeFirst();
    assertCatalog(property !== undefined, `property ${propertyId} must exist before importing the reference catalog`);
    assertCatalog(property.code === propertyCode, `property ${propertyId} code does not match ${propertyCode}`);
    assertCatalog(property.timezone === snapshot.property.timezone, `property ${propertyId} timezone does not match the catalog`);
    assertCatalog(property.currency === snapshot.property.currency, `property ${propertyId} currency does not match the catalog`);

    const existing = await trx.selectFrom("catalog_import_batches").selectAll().where("id", "=", snapshot.importId).executeTakeFirst();
    if (existing) {
      assertCatalog(existing.property_id === propertyId, `batch ${snapshot.importId} already belongs to another property`);
      assertCatalog(existing.content_hash === contentHash, `batch ${snapshot.importId} already exists with different content`);
      const loaded = await loadReferenceCatalog(trx, propertyId, snapshot.importId);
      assertCatalog(loaded?.batch.id === snapshot.importId, `batch ${snapshot.importId} could not be reloaded for ${propertyId}`);
      return loaded;
    }

    await trx.insertInto("catalog_import_batches").values({
      id: snapshot.importId,
      property_id: propertyId,
      source_document_token: sourceDocumentToken(snapshot),
      source_revision: snapshot.source.revision,
      source_version_date: snapshot.source.publicPriceVersionDate,
      source_snapshot: JSON.stringify(snapshot),
      content_hash: contentHash,
      execution_state: referenceOnly,
      sealed_at: null
    }).execute();

    await trx.insertInto("inventory_catalog_entries").values(rows.inventoryEntries).execute();

    await trx.insertInto("reference_rate_entries").values(rows.rates).execute();

    await trx.insertInto("reference_membership_products").values(rows.membershipProducts).execute();

    const seal = await trx.updateTable("catalog_import_batches")
      .set({ sealed_at: sql<Date>`CURRENT_TIMESTAMP` })
      .where("id", "=", snapshot.importId)
      .where("sealed_at", "is", null)
      .executeTakeFirst();
    assertCatalog(seal.numUpdatedRows === 1n, `batch ${snapshot.importId} could not be sealed`);

    const loaded = await loadReferenceCatalog(trx, propertyId, snapshot.importId);
    assertCatalog(loaded?.batch.id === snapshot.importId, "catalog import did not round-trip");
    assertCatalog(loaded.inventoryEntries.length === 8, "catalog import did not persist 8 inventory categories");
    assertCatalog(loaded.rates.length === 32, "catalog import did not persist 32 public rates");
    assertCatalog(loaded.membershipProducts.length === 3, "catalog import did not persist 3 membership products");
    return loaded;
  });
}

export function referenceCatalogSummary(snapshot: Qintopia2026ReferenceCatalogSnapshot) {
  return {
    importId: snapshot.importId,
    sourceRevision: snapshot.source.revision,
    physicalRoomCount: snapshot.inventory.summary.physicalRoomCount,
    physicalBedCount: snapshot.inventory.summary.physicalBedCount,
    baseInventoryUnitCount: snapshot.inventory.summary.baseInventoryUnitCount,
    wholeRoomCombinationCount: snapshot.inventory.summary.wholeRoomCombinationCount,
    salesEntryCount: snapshot.inventory.summary.salesEntryCount,
    inventoryCategoryCount: snapshot.inventory.categories.length,
    publicRateCount: snapshot.publicRates.rates.length,
    pricingProductCount: snapshot.publicRates.products.length,
    membershipProductCount: snapshot.membershipProducts.length,
    executionState: referenceOnly,
    contentHash: stableHash(snapshot)
  };
}

async function runImport(): Promise<void> {
  const snapshot = await loadBundledQintopia2026Catalog();
  if (process.argv.includes("--dry-run")) {
    process.stdout.write(`${JSON.stringify(referenceCatalogSummary(snapshot), null, 2)}\n`);
    return;
  }
  const db = createDatabase();
  try {
    const catalog = await importQintopia2026ReferenceCatalog(db, {
      propertyId: process.env.REFERENCE_CATALOG_PROPERTY_ID ?? defaultPropertyId,
      propertyCode: process.env.REFERENCE_CATALOG_PROPERTY_CODE ?? defaultPropertyCode
    });
    process.stdout.write(`Imported ${catalog.batch.id}: ${catalog.inventoryEntries.length} inventory categories, ${catalog.rates.length} public rates, ${catalog.membershipProducts.length} membership products (${catalog.batch.executionState}).\n`);
  } finally {
    await db.destroy();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void runImport().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
