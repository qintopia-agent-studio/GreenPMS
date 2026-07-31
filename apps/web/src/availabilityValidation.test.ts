import { describe, expect, it } from "vitest";
import { parseAvailability } from "./availabilityValidation";

const expected = {
  propertyId: "property_qintopia",
  arrivalDate: "2026-07-30",
  departureDate: "2026-08-01"
} as const;

function availability() {
  return {
    propertyId: expected.propertyId,
    units: [{
      id: "room_101",
      propertyId: expected.propertyId,
      kind: "ROOM",
      roomId: "room_101",
      code: "101",
      name: "101",
      catalogVersion: "2026",
      buildingCode: "1",
      roomTypeCode: "STANDARD",
      pricingProductCode: "STANDARD_ROOM",
      inventoryBasis: "INDEPENDENT",
      codeProvenance: "SOURCE_EXPLICIT",
      physicalBedCount: 2,
      occupancyCapacity: 2,
      nights: [
        { serviceDate: "2026-07-30", available: true, blockingClaimIds: [] },
        { serviceDate: "2026-07-31", available: false, blockingClaimIds: ["claim_1"] }
      ],
      available: false
    }]
  };
}

describe("parseAvailability", () => {
  it("accepts an exact response covering the complete target interval", () => {
    expect(parseAvailability(availability(), expected)).toEqual(availability());
  });

  it("accepts a non-Claim operational blocker as unavailable without blocking Claim ids", () => {
    const value = availability();
    value.units[0]!.nights[1]!.blockingClaimIds = [];
    expect(parseAvailability(value, expected)).toEqual(value);
  });

  it.each([
    ["root extra field", (value: ReturnType<typeof availability>) => Object.assign(value, { raw: true }), "根节点.raw不是允许的字段"],
    ["wrong property", (value: ReturnType<typeof availability>) => { (value as { propertyId: string }).propertyId = "property_other"; }, "propertyId与查询物业不一致"],
    ["unit extra field", (value: ReturnType<typeof availability>) => Object.assign(value.units[0]!, { claim: {} }), "units[0].claim不是允许的字段"],
    ["missing night", (value: ReturnType<typeof availability>) => { value.units[0]!.nights.pop(); }, "没有完整覆盖查询日期"],
    ["wrong night order", (value: ReturnType<typeof availability>) => { value.units[0]!.nights[0]!.serviceDate = "2026-07-31"; }, "没有按查询日期连续覆盖"],
    ["available night with a blocking Claim", (value: ReturnType<typeof availability>) => { value.units[0]!.nights[1]!.available = true; }, "可用状态与阻断占用不一致"],
    ["inconsistent unit availability", (value: ReturnType<typeof availability>) => { value.units[0]!.available = true; }, "与逐日可用状态不一致"]
  ])("fails closed for %s", (_label, damage, message) => {
    const value = availability();
    damage(value);
    expect(() => parseAvailability(value, expected)).toThrow(message);
  });
});
