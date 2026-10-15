import { describe, expect, it } from "vitest";
import { resolveCommunityIdentities, type CommunityIdentityInput } from "./community-identity";
const guest = (id: string, overrides: Partial<CommunityIdentityInput> = {}): CommunityIdentityInput => ({
  id, orderId: `order-${id}`, nickname: "小番茄", fullName: null, documentNumber: null, ...overrides
});
const keys = (rows: CommunityIdentityInput[]) => [...resolveCommunityIdentities(rows).values()].map(row => row.personKey);

describe("nickname-first operating identity estimate", () => {
  it("matches nickname-only residents across orders without documents", () => {
    const result = resolveCommunityIdentities([guest("a"), guest("b")]);
    expect(result.get("a")?.personKey).toBe(result.get("b")?.personKey);
    expect(result.get("b")?.approximate).toBe(true);
  });
  it("ignores case, full-width forms, spaces, and punctuation", () => {
    expect(new Set(keys([guest("a", { nickname: " Ｃａｔｈｙ · " }), guest("b", { nickname: "cathy" })])).size).toBe(1);
  });
  it.each(["小番茹", "小番茄呀", "番茄"])("handles a small nickname spelling variation: %s", nickname => {
    const result = resolveCommunityIdentities([guest("a", { fullName: "陈晓" }), guest("b", { nickname, fullName: "陈晓" })]);
    expect(result.get("a")?.personKey).toBe(result.get("b")?.personKey);
  });
  it("allows one-character changes in longer nicknames without requiring a name", () => {
    expect(new Set(keys([guest("a", { nickname: "Patrick" }), guest("b", { nickname: "Patric" })])).size).toBe(1);
  });
  it("does not merge short similar nicknames without supporting names", () => {
    expect(new Set(keys([guest("a", { nickname: "阿东" }), guest("b", { nickname: "阿冬" })])).size).toBe(2);
  });
  it("uses the same name as support when a nickname was changed", () => {
    expect(new Set(keys([guest("a", { fullName: "陈晓" }), guest("b", { nickname: "小太阳", fullName: "陈晓" })])).size).toBe(1);
  });
  it("matches a nickname that was previously recorded in the name field", () => {
    expect(new Set(keys([guest("a"), guest("b", { nickname: null, fullName: "小番茄" })])).size).toBe(1);
  });
  it("keeps identical nicknames with clearly different names separate", () => {
    expect(new Set(keys([guest("a", { fullName: "王明" }), guest("b", { fullName: "李华" })])).size).toBe(2);
  });
  it("keeps conflicting explicit documents separate even when nickname and name match", () => {
    const result = resolveCommunityIdentities([guest("a", { documentNumber: "A" }), guest("b", { documentNumber: "B" }), guest("c")]);
    expect(new Set([...result.values()].map(row => row.personKey)).size).toBe(3);
  });
  it("still trusts matching documents after a nickname changes", () => {
    expect(new Set(keys([guest("a", { documentNumber: " id-a " }), guest("b", { documentNumber: "ID-A", nickname: "different", fullName: "different" })])).size).toBe(1);
  });
  it("does not collapse two roommates whose nickname was copied", () => {
    expect(new Set(keys([guest("a", { orderId: "shared" }), guest("b", { orderId: "shared" })])).size).toBe(2);
  });
  it("does not use blank or placeholder labels as a shared person", () => {
    const result = resolveCommunityIdentities([guest("a", { nickname: "未填写" }), guest("b", { nickname: null, fullName: "客人" })]);
    expect(result.get("a")?.personKey).toBeNull();
    expect(result.get("b")?.personKey).toBeNull();
  });
  it("prevents approximate match chains from drifting into unrelated names", () => {
    const result = resolveCommunityIdentities([guest("a", { nickname: "aaaa" }), guest("b", { nickname: "aaab" }), guest("c", { nickname: "aabb" })]);
    expect(result.get("a")?.personKey).toBe(result.get("b")?.personKey);
    expect(result.get("c")?.personKey).not.toBe(result.get("a")?.personKey);
  });
  it("is independent of SQL row order", () => {
    const rows = [guest("a"), guest("b", { nickname: "小番茹" }), guest("c", { documentNumber: "ID-X", nickname: "小番茄" })];
    expect(resolveCommunityIdentities(rows)).toEqual(resolveCommunityIdentities([...rows].reverse()));
  });
  it("future bookings may attach, but do not change the identities of actual stays", () => {
    const actual = [guest("a", { nickname: "aaaa" }), guest("c", { nickname: "aabb" })];
    const before = resolveCommunityIdentities(actual);
    const after = resolveCommunityIdentities(actual, [guest("b", { nickname: "aaab" }), guest("d", { nickname: "aaaa" })]);
    expect(after.get("a")).toEqual(before.get("a"));
    expect(after.get("c")).toEqual(before.get("c"));
    expect(after.get("d")?.personKey).toBe(after.get("a")?.personKey);
  });
});


it("accepts an adjacent nickname typo without needing a document", () => {
 expect(new Set(keys([guest("a",{nickname:"Cathy"}),guest("b",{nickname:"Cahty"})])).size).toBe(1);
});
