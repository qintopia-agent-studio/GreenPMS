import { describe, expect, it, vi } from "vitest";
import { availableLocalStorage, canManageTokens, commandRecoveryAvailable, navigationItemsForAccess, persistSidebarCollapsed, principalCan, sidebarStorageKey, storedSidebarCollapsed } from "./session";
import type { PrincipalDto } from "./types";

function principal(allowedActions: PrincipalDto["allowedActions"], overrides: Partial<PrincipalDto> = {}): PrincipalDto {
  return {
    subjectId: "subject_operator",
    displayName: "前台",
    credentialType: "SESSION",
    propertyAccess: { property_test: "WRITE" },
    propertyCommandGrants: allowedActions,
    allowedActions,
    ...overrides
  };
}

describe("permission-aware staff navigation", () => {
  it("uses staff language and exposes Token management only with exact Token grants", () => {
    const staff = principal({ property_test: ["CREATE_ORDER", "REPRICE_ORDER", "RECORD_REFUND", "REVOKE_CHECK_IN"] });
    const tokenManager = principal({ property_test: ["ISSUE_TOKEN"] });
    const staffItems = navigationItemsForAccess(staff, "property_test").map(({ label, to }) => ({ label, to }));
    const managerItems = navigationItemsForAccess(tokenManager, "property_test").map(({ label, to }) => ({ label, to }));

    expect(staffItems).toContainEqual({ label: "今日履约", to: "/today" });
    expect(staffItems).not.toContainEqual({ label: "Token", to: "/tokens" });
    expect(managerItems).toContainEqual({ label: "今日履约", to: "/today" });
    expect(managerItems).toContainEqual({ label: "Token", to: "/tokens" });
    expect(principalCan(staff, "property_test", "REPRICE_ORDER")).toBe(true);
    expect(canManageTokens(staff, "property_test")).toBe(false);
    expect(canManageTokens(tokenManager, "property_test")).toBe(true);
  });

  it("keeps recovery permissions tied to the smallest relevant fact", () => {
    const readOnlyQuote = principal({}, {
      propertyAccess: { property_test: "READ" },
      propertyCommandGrants: { property_test: [] }
    });
    const historicalRecovery = principal({}, {
      propertyCommandGrants: { property_test: ["BACKFILL_COMPLETED_STAY"] }
    });
    const writeRecovery = principal({ property_test: ["REPRICE_ORDER"] }, {
      propertyCommandGrants: { property_test: ["REPRICE_ORDER"] }
    });

    expect(commandRecoveryAvailable(readOnlyQuote, "property_test", "CREATE_QUOTE")).toBe(true);
    expect(commandRecoveryAvailable(readOnlyQuote, "property_missing", "CREATE_QUOTE")).toBe(false);
    expect(commandRecoveryAvailable(historicalRecovery, "property_test", "BACKFILL_COMPLETED_STAY")).toBe(true);
    expect(commandRecoveryAvailable(historicalRecovery, "property_test", "REPRICE_ORDER")).toBe(false);
    expect(commandRecoveryAvailable(writeRecovery, "property_test", "REPRICE_ORDER")).toBe(true);
  });
});

describe("desktop sidebar persistence", () => {
  it("defaults to expanded unless the versioned value is exactly true", () => {
    expect(storedSidebarCollapsed(undefined, "operator-a")).toBe(false);
    expect(storedSidebarCollapsed({ getItem: () => null }, "operator-a")).toBe(false);
    expect(storedSidebarCollapsed({ getItem: () => "broken" }, "operator-a")).toBe(false);
    expect(storedSidebarCollapsed({ getItem: () => "false" }, "operator-a")).toBe(false);
    expect(storedSidebarCollapsed({ getItem: () => "true" }, "operator-a")).toBe(true);
  });

  it("does not break navigation when browser storage is unavailable", () => {
    expect(storedSidebarCollapsed({ getItem: () => { throw new Error("denied"); } }, "operator-a")).toBe(false);
    expect(() => persistSidebarCollapsed({ setItem: () => { throw new Error("denied"); } }, "operator-a", true)).not.toThrow();
  });

  it("fails open when reading the localStorage getter itself is denied", () => {
    const owner = Object.defineProperty({}, "localStorage", {
      get() { throw new DOMException("denied", "SecurityError"); }
    }) as { readonly localStorage: Storage };

    expect(availableLocalStorage(owner)).toBeUndefined();
  });

  it("persists both expanded and collapsed choices", () => {
    const setItem = vi.fn();
    persistSidebarCollapsed({ setItem }, "operator-a", true);
    persistSidebarCollapsed({ setItem }, "operator-a", false);
    expect(setItem.mock.calls.map((call) => call[1])).toEqual(["true", "false"]);
  });

  it("isolates the preference by authenticated principal", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); }
    };

    persistSidebarCollapsed(storage, "operator/a", true);

    expect(sidebarStorageKey("operator/a")).not.toBe(sidebarStorageKey("operator/b"));
    expect(storedSidebarCollapsed(storage, "operator/a")).toBe(true);
    expect(storedSidebarCollapsed(storage, "operator/b")).toBe(false);
  });
});
