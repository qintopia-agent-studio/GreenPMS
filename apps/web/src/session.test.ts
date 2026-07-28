import { describe, expect, it, vi } from "vitest";
import { availableLocalStorage, persistSidebarCollapsed, sidebarStorageKey, storedSidebarCollapsed } from "./session";

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
