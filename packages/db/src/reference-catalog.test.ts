import { describe, expect, it } from "vitest";
import {
  loadBundledQintopia2026Catalog,
  referenceCatalogSummary,
  validateQintopia2026ReferenceCatalogSnapshot
} from "./reference-catalog.ts";
import { buildQintopia2026OperationalCatalogRows } from "./seed.ts";

describe("QinTopia 2026 reference catalog snapshot", () => {
  it("preserves the verified inventory and published-price totals", async () => {
    const snapshot = await loadBundledQintopia2026Catalog();
    expect(referenceCatalogSummary(snapshot)).toMatchObject({
      importId: "qintopia-2026-feishu-revision-561-user-confirmed-v5",
      sourceRevision: 561,
      physicalRoomCount: 44,
      physicalBedCount: 91,
      baseInventoryUnitCount: 77,
      wholeRoomCombinationCount: 13,
      salesEntryCount: 90,
      inventoryCategoryCount: 8,
      publicRateCount: 32,
      membershipProductCount: 3,
      executionState: "REFERENCE_ONLY"
    });
    expect(snapshot.inventory.summary).toMatchObject({
      roomSaleUnitCount: 31,
      bedSaleUnitCount: 46
    });
  });

  it("imports only the externally published rates, not the floor-price worksheet", async () => {
    const snapshot = await loadBundledQintopia2026Catalog();
    const publishedRows = snapshot.publicRates.rates.map((rate) => Number(/\d+$/.exec(rate.sourceCell)?.[0]));
    expect(publishedRows.every((row) => !Number.isNaN(row) && row >= 31 && row <= 44)).toBe(true);
    expect(snapshot.source.sheets.find((sheet) => sheet.sheetName === "2026价格表")).toMatchObject({
      publicPriceRange: "A28:F44",
      excludedPriceRanges: [expect.objectContaining({ range: "A9:F25" })]
    });
    expect(snapshot.publicRates.rates.find((rate) => rate.roomTypeKey === "shared_bath_quad" && rate.nights === 30)?.amountMinor).toBe(78_000);
    expect(snapshot.publicRates.rates.find((rate) => rate.roomTypeKey === "private_bath_suite" && rate.nights === 1)?.amountMinor).toBe(32_000);
  });

  it("keeps generated identities explicit and the latest membership policy authoritative", async () => {
    const snapshot = await loadBundledQintopia2026Catalog();
    const unresolved = JSON.stringify(snapshot.unresolvedIssues);
    expect(unresolved).toContain("OPERATING_TARGET_WINDOWS_MISSING");
    expect(unresolved).toContain("ANCILLARY_CHARGES_NOT_SPECIFIED");
    expect(unresolved).not.toContain("MEMBERSHIP_REFUND_CALCULATION_AMBIGUOUS");
    expect(unresolved).not.toContain("FREE_PRICING_CASES_MISSING");
    expect(snapshot.inventory.rooms.filter((room) => ["D", "E"].includes(room.buildingCode)).every((room) => room.codeProvenance === "PMS_GENERATED" && room.sourceCode === null)).toBe(true);
    expect(snapshot.inventory.rooms.filter((room) => room.buildingCode === "D").map((room) => room.operationalCode)).toEqual(["D01", "D02", "D03", "D04", "D05"]);
    expect(snapshot.inventory.rooms.filter((room) => room.buildingCode === "E").map((room) => room.operationalCode)).toEqual(["E01", "E02", "E03"]);
    expect(JSON.stringify(snapshot.inventory.rooms)).not.toMatch(/D-GEN-|E-GEN-/);
    expect(snapshot.membershipRules.refundPolicy).toBe("NON_REFUNDABLE_MEMBERSHIP");
    expect(snapshot.membershipRules.refundCalculation).toBeNull();
    expect(snapshot.membershipProducts.every((product) => product.validity.period === "P1Y")).toBe(true);
    expect(snapshot.membershipProducts.reduce((sum, product) => sum + product.quota, 0)).toBe(30);
  });

  it("keeps generated-room internal IDs stable after the operational-code rename", async () => {
    const catalog = await buildQintopia2026OperationalCatalogRows();
    expect(catalog.rooms.find((room) => room.code === "D01")).toMatchObject({ id: "unit_room_d_gen_01", code_provenance: "PMS_GENERATED" });
    expect(catalog.rooms.find((room) => room.code === "E03")).toMatchObject({ id: "unit_room_e_gen_03", code_provenance: "PMS_GENERATED" });
    expect(catalog.rooms).toHaveLength(44);
    expect(catalog.beds).toHaveLength(46);
  });

  it("applies the prelaunch room-type corrections without changing totals", async () => {
    const snapshot = await loadBundledQintopia2026Catalog();
    const rooms = new Map(snapshot.inventory.rooms.map((room) => [room.operationalCode, room]));

    expect(rooms.get("104")).toMatchObject({ roomTypeKey: "shared_bath_quad", physicalBedCount: 4, physicalBedCodes: ["A", "B", "C", "D"] });
    expect(rooms.get("105")).toMatchObject({ roomTypeKey: "shared_bath_double", physicalBedCount: 2, physicalBedCodes: ["A", "B"] });
    expect(rooms.get("106")).toMatchObject({ roomTypeKey: "shared_bath_quad", physicalBedCount: 4, physicalBedCodes: ["A", "B", "C", "D"] });
    expect(rooms.get("108")).toMatchObject({ roomTypeKey: "shared_bath_double", physicalBedCount: 2, physicalBedCodes: ["A", "B"] });
    expect(rooms.get("204")).toMatchObject({ roomTypeKey: "shared_bath_quad", physicalBedCount: 4, physicalBedCodes: ["A", "B", "C", "D"] });
    expect(rooms.get("206")).toMatchObject({ roomTypeKey: "shared_bath_double", physicalBedCount: 2, physicalBedCodes: ["A", "B"] });
    expect(rooms.get("301")).toMatchObject({ roomTypeKey: "shared_bath_standard", physicalBedCount: 2, physicalBedCodes: ["A", "B"] });
    expect(rooms.get("303")).toMatchObject({ roomTypeKey: "shared_bath_standard", physicalBedCount: 2, physicalBedCodes: ["A", "B"] });
    expect(rooms.get("305")).toMatchObject({ roomTypeKey: "shared_bath_single", physicalBedCount: 1, physicalBedCodes: null });
    expect(rooms.get("308")).toMatchObject({ roomTypeKey: "shared_bath_single", physicalBedCount: 1, physicalBedCodes: null });
    expect(rooms.get("D02")).toMatchObject({ roomTypeKey: "shared_bath_standard", physicalBedCount: 2, physicalBedCodes: ["A", "B"] });
    expect(rooms.get("D04")).toMatchObject({ roomTypeKey: "shared_bath_single", physicalBedCount: 1, physicalBedCodes: null });
    expect(referenceCatalogSummary(snapshot)).toMatchObject({ physicalRoomCount: 44, physicalBedCount: 91 });
  });

  it("rejects malformed operating facts instead of coercing them", async () => {
    const source = await loadBundledQintopia2026Catalog();

    const invalidElectricity = structuredClone(source) as unknown as {
      inventory: { categories: Array<{ separateElectricityCharge: boolean }> };
    };
    invalidElectricity.inventory.categories[0]!.separateElectricityCharge = true;
    expect(() => validateQintopia2026ReferenceCatalogSnapshot(invalidElectricity)).toThrow(/electricity must not be charged separately/);

    const invalidEntitlement = structuredClone(source) as unknown as {
      membershipProducts: Array<{ entitlementUnit: string }>;
    };
    invalidEntitlement.membershipProducts[0]!.entitlementUnit = "BED_NIGHT";
    expect(() => validateQintopia2026ReferenceCatalogSnapshot(invalidEntitlement)).toThrow(/does not match ROOM/);

    const wrongDurationColumn = structuredClone(source) as unknown as {
      publicRates: { rates: Array<{ sourceCell: string }> };
    };
    wrongDurationColumn.publicRates.rates[0]!.sourceCell = "F31";
    expect(() => validateQintopia2026ReferenceCatalogSnapshot(wrongDurationColumn)).toThrow(/wrong duration column/);

    const duplicateSourceCell = structuredClone(source) as unknown as {
      publicRates: { rates: Array<{ sourceCell: string }> };
    };
    duplicateSourceCell.publicRates.rates[4]!.sourceCell = "C31";
    expect(() => validateQintopia2026ReferenceCatalogSnapshot(duplicateSourceCell)).toThrow(/duplicate public rate source cell/);
  });

  it("locks the import identity to the user-confirmed Feishu revision", async () => {
    const source = await loadBundledQintopia2026Catalog();

    const wrongImportId = structuredClone(source);
    wrongImportId.importId = "qintopia-2026-feishu-revision-561-rewritten";
    expect(() => validateQintopia2026ReferenceCatalogSnapshot(wrongImportId)).toThrow(/importId must remain .*revision-561-user-confirmed-v5/);

    const wrongRevision = structuredClone(source);
    wrongRevision.source.revision = 562;
    expect(() => validateQintopia2026ReferenceCatalogSnapshot(wrongRevision)).toThrow(/source revision must remain 561/);

    const wrongVersionDate = structuredClone(source);
    wrongVersionDate.source.publicPriceVersionDate = "2026-03-01";
    expect(() => validateQintopia2026ReferenceCatalogSnapshot(wrongVersionDate)).toThrow(/public price version date changed from revision 561/);
  });

  it("rejects room-type and building swaps even when every aggregate still closes", async () => {
    const swapped = structuredClone(await loadBundledQintopia2026Catalog());
    const a03 = swapped.inventory.rooms.find((room) => room.operationalCode === "A03")!;
    const b01 = swapped.inventory.rooms.find((room) => room.operationalCode === "B01")!;

    [a03.buildingCode, b01.buildingCode] = [b01.buildingCode, a03.buildingCode];
    [a03.roomTypeKey, b01.roomTypeKey] = [b01.roomTypeKey, a03.roomTypeKey];

    expect(() => validateQintopia2026ReferenceCatalogSnapshot(swapped)).toThrow(/canonical room A03 changed from revision 561/);
  });

  it("rejects synchronized rate and product-anchor tampering", async () => {
    const tampered = structuredClone(await loadBundledQintopia2026Catalog());
    const oneNightRate = tampered.publicRates.rates.find((rate) => rate.roomTypeKey === "private_bath_suite" && rate.nights === 1)!;
    const roomProduct = tampered.publicRates.products.find((product) => product.productCode === "private_bath_suite_room")!;

    oneNightRate.amountMinor += 100;
    roomProduct.anchorsMinor["1"] += 100;

    expect(() => validateQintopia2026ReferenceCatalogSnapshot(tampered)).toThrow(/canonical public rate private_bath_suite:1 changed from revision 561/);
  });

  it("rejects a coordinated two-person and four-person whole-room multiplier swap", async () => {
    const swapped = structuredClone(await loadBundledQintopia2026Catalog());
    const doubleRoom = swapped.publicRates.products.find((product) => product.productCode === "shared_bath_double_whole_room")!;
    const quadRoom = swapped.publicRates.products.find((product) => product.productCode === "shared_bath_quad_whole_room")!;

    doubleRoom.anchorMultiplier = 4;
    doubleRoom.anchorsMinor = { "1": 27_200, "7": 152_000, "14": 220_000, "30": 360_000 };
    quadRoom.anchorMultiplier = 2;
    quadRoom.anchorsMinor = { "1": 11_600, "7": 61_600, "14": 96_000, "30": 156_000 };

    expect(() => validateQintopia2026ReferenceCatalogSnapshot(swapped)).toThrow(/canonical pricing product shared_bath_double_whole_room changed from revision 561/);
  });
});
