import type { AvailabilityDto, UnitAvailabilityDto } from "./types";

type JsonRecord = Record<string, unknown>;

export interface ExpectedAvailabilityQuery {
  propertyId: string;
  arrivalDate: string;
  departureDate: string;
  unitKind?: "ROOM" | "BED";
}

export class AvailabilityValidationError extends Error {
  constructor(path: string, message: string) {
    super(`可用房源数据 ${path}${message}`);
    this.name = "AvailabilityValidationError";
  }
}

function fail(path: string, message: string): never {
  throw new AvailabilityValidationError(path, message);
}

function record(value: unknown, path: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(path, "必须是对象");
  return value as JsonRecord;
}

function exactKeys(value: JsonRecord, path: string, keys: readonly string[]) {
  const allowed = new Set(keys);
  const unexpected = Object.keys(value).find((key) => !allowed.has(key));
  if (unexpected) fail(`${path}.${unexpected}`, "不是允许的字段");
  const missing = keys.find((key) => !(key in value));
  if (missing) fail(`${path}.${missing}`, "缺失");
}

function stringValue(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim() === "") fail(path, "必须是非空文字");
  return value;
}

function nullableString(value: unknown, path: string): string | null {
  if (value === null) return null;
  return stringValue(value, path);
}

function localDate(value: unknown, path: string): string {
  const result = stringValue(value, path);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(result)) fail(path, "必须是有效营业日期");
  const parsed = new Date(`${result}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== result) fail(path, "必须是有效营业日期");
  return result;
}

function dateRange(arrivalDate: string, departureDate: string): string[] {
  const result: string[] = [];
  const cursor = new Date(`${arrivalDate}T00:00:00.000Z`);
  const end = new Date(`${departureDate}T00:00:00.000Z`);
  if (Number.isNaN(cursor.getTime()) || Number.isNaN(end.getTime()) || cursor >= end) fail("查询日期", "区间无效");
  while (cursor < end) {
    result.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return result;
}

function optionalCatalogValue(value: unknown, path: string): string | null {
  return nullableString(value, path);
}

export function parseAvailability(value: unknown, expected: ExpectedAvailabilityQuery): AvailabilityDto {
  const result = record(value, "根节点");
  exactKeys(result, "根节点", ["propertyId", "units"]);
  const propertyId = stringValue(result.propertyId, "propertyId");
  if (propertyId !== expected.propertyId) fail("propertyId", "与查询物业不一致");
  if (!Array.isArray(result.units)) fail("units", "必须是数组");
  const expectedDates = dateRange(expected.arrivalDate, expected.departureDate);
  const seenUnitIds = new Set<string>();

  const units = result.units.map((item, index): UnitAvailabilityDto => {
    const path = `units[${index}]`;
    const unit = record(item, path);
    exactKeys(unit, path, [
      "id", "propertyId", "kind", "roomId", "code", "name", "catalogVersion", "buildingCode", "roomTypeCode",
      "pricingProductCode", "inventoryBasis", "codeProvenance", "physicalBedCount", "occupancyCapacity", "nights", "available"
    ]);
    const id = stringValue(unit.id, `${path}.id`);
    if (seenUnitIds.has(id)) fail(`${path}.id`, "重复");
    seenUnitIds.add(id);
    if (stringValue(unit.propertyId, `${path}.propertyId`) !== propertyId) fail(`${path}.propertyId`, "与查询物业不一致");
    const kind = unit.kind;
    if (kind !== "ROOM" && kind !== "BED") fail(`${path}.kind`, "不是支持的库存类型");
    if (expected.unitKind && kind !== expected.unitKind) fail(`${path}.kind`, "与查询库存类型不一致");
    const roomId = stringValue(unit.roomId, `${path}.roomId`);
    if (kind === "ROOM" && roomId !== id) fail(`${path}.roomId`, "整房必须指向自身房间");
    const inventoryBasis = unit.inventoryBasis;
    if (inventoryBasis !== null && inventoryBasis !== "INDEPENDENT" && inventoryBasis !== "WHOLE_ROOM_COMBINATION") {
      fail(`${path}.inventoryBasis`, "不是支持的库存口径");
    }
    const codeProvenance = unit.codeProvenance;
    if (codeProvenance !== null && codeProvenance !== "SOURCE_EXPLICIT" && codeProvenance !== "USER_CONFIRMED_RENAMED" && codeProvenance !== "PMS_GENERATED") {
      fail(`${path}.codeProvenance`, "不是支持的编码来源");
    }
    if (unit.physicalBedCount !== null && (!Number.isSafeInteger(unit.physicalBedCount) || Number(unit.physicalBedCount) < 1 || Number(unit.physicalBedCount) > 4)) {
      fail(`${path}.physicalBedCount`, "必须是 1 至 4 的整数");
    }
    if (!Number.isSafeInteger(unit.occupancyCapacity) || Number(unit.occupancyCapacity) < 1 || Number(unit.occupancyCapacity) > 1000) {
      fail(`${path}.occupancyCapacity`, "必须是 1 至 1000 的整数");
    }
    if (!Array.isArray(unit.nights) || unit.nights.length !== expectedDates.length) fail(`${path}.nights`, "没有完整覆盖查询日期");
    const nights = unit.nights.map((nightValue, nightIndex) => {
      const nightPath = `${path}.nights[${nightIndex}]`;
      const night = record(nightValue, nightPath);
      exactKeys(night, nightPath, ["serviceDate", "available", "blockingClaimIds"]);
      const serviceDate = localDate(night.serviceDate, `${nightPath}.serviceDate`);
      if (serviceDate !== expectedDates[nightIndex]) fail(`${nightPath}.serviceDate`, "没有按查询日期连续覆盖");
      if (typeof night.available !== "boolean") fail(`${nightPath}.available`, "必须是布尔值");
      if (!Array.isArray(night.blockingClaimIds) || night.blockingClaimIds.some((claimId) => typeof claimId !== "string" || claimId.trim() === "")) {
        fail(`${nightPath}.blockingClaimIds`, "必须是有效占用编号数组");
      }
      if (night.available && night.blockingClaimIds.length > 0) fail(nightPath, "可用状态与阻断占用不一致");
      return { serviceDate, available: night.available, blockingClaimIds: [...night.blockingClaimIds] };
    });
    if (typeof unit.available !== "boolean" || unit.available !== nights.every((night) => night.available)) {
      fail(`${path}.available`, "与逐日可用状态不一致");
    }
    return {
      id,
      propertyId,
      kind,
      roomId,
      code: stringValue(unit.code, `${path}.code`),
      name: stringValue(unit.name, `${path}.name`),
      catalogVersion: optionalCatalogValue(unit.catalogVersion, `${path}.catalogVersion`),
      buildingCode: optionalCatalogValue(unit.buildingCode, `${path}.buildingCode`),
      roomTypeCode: optionalCatalogValue(unit.roomTypeCode, `${path}.roomTypeCode`),
      pricingProductCode: optionalCatalogValue(unit.pricingProductCode, `${path}.pricingProductCode`),
      inventoryBasis,
      codeProvenance,
      physicalBedCount: unit.physicalBedCount as number | null,
      occupancyCapacity: unit.occupancyCapacity as number,
      nights,
      available: unit.available
    };
  });
  return { propertyId, units };
}
