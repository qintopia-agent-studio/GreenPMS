import { describe, expect, it } from "vitest";
import { membershipProductAllowsTemporaryUpgrade, membershipProductMatchesCurrentStay } from "./stayMembershipUpgrade";
import type { MembershipProductDto, OrderViewDto, InventoryUnitDto } from "./types";

describe("shared private-bath membership applicability", () => {
  const shared = { allowed_room_type_code: "private_bath_standard", allowed_room_type_codes: ["private_bath_standard", "private_bath_king"], allowed_inventory_kind: "ROOM", entitlement_unit_kind: "ROOM_NIGHT" } as MembershipProductDto;
  const units = new Map([
    ["standard", { id: "standard", kind: "ROOM", room_type_code: "private_bath_standard" } as InventoryUnitDto],
    ["king", { id: "king", kind: "ROOM", room_type_code: "private_bath_king" } as InventoryUnitDto],
    ["single", { id: "single", kind: "ROOM", room_type_code: "private_bath_single" } as InventoryUnitDto]
  ]);
  const stay = (ids: string[]) => ({ order: { status: "CHECKED_IN" }, effectiveArrangement: { intervals: ids.map((inventoryUnitId) => ({ inventoryUnitId })) } }) as OrderViewDto;
  it("treats both types and their sequence as ordinary matching", () => {
    for (const ids of [["standard"], ["king"], ["standard", "king"]]) {
      expect(membershipProductMatchesCurrentStay(shared, stay(ids), units)).toBe(true);
      expect(membershipProductAllowsTemporaryUpgrade(shared, stay(ids), units)).toBe(false);
    }
  });
  it("preserves the explicit other-room exception and never broadens a singleton", () => {
    expect(membershipProductMatchesCurrentStay(shared, stay(["standard", "single"]), units)).toBe(false);
    expect(membershipProductAllowsTemporaryUpgrade(shared, stay(["standard", "single"]), units)).toBe(true);
    expect(membershipProductMatchesCurrentStay({ ...shared, allowed_room_type_codes: null }, stay(["king"]), units)).toBe(false);
  });
});
