import { describe, expect, it } from "vitest";
import type { AssistantSettings } from "../../../../packages/contracts/src/assistant.ts";
import { canEnableAssistant, canEnableProvider, canPromoteProvider, connectionChanged, providerDirty, providerDraft, providerPayload, providerSettings } from "./provider-settings";

const settings: AssistantSettings = { version: 7, enabled: true, canManage: true, keyReady: true, managementPropertyId: "property-a", updatedAt: null,
  baseUrl: "https://primary.example/v1", model: "primary-model", hasKey: true,
  providers: {
    primary: { name: "原主供应商", enabled: true, baseUrl: "https://primary.example/v1", model: "primary-model", hasKey: true, testedAt: null },
    backup: { name: "备用", enabled: false, baseUrl: "https://backup.example/v1", model: "backup-model", hasKey: true, testedAt: null }
  }
};

describe("provider form connection test boundaries", () => {
  it("keeps an unchanged existing primary usable without pretending it has passed a test", () => {
    const primary = providerSettings(settings, "primary"), draft = providerDraft(primary);
    expect(primary.testedAt).toBeNull();
    expect(canEnableProvider(draft, primary)).toBe(true);
    expect(canEnableProvider({ ...draft, name: "新名称" }, primary)).toBe(true);
    expect(canEnableProvider({ ...draft, model: "changed-model" }, primary)).toBe(false);
    expect(canEnableProvider({ ...draft, baseUrl: "https://another.example/v1" }, primary)).toBe(false);
    expect(canEnableProvider({ ...draft, apiKey: "replacement" }, primary)).toBe(false);
  });
  it("requires a successful current connection test before enabling an untested backup", () => {
    const backup = providerSettings(settings, "backup"), draft = providerDraft(backup);
    expect(canEnableProvider(draft, backup)).toBe(false);
    expect(canEnableProvider({ ...draft, testToken: "server-bound-proof", enabled: true }, backup)).toBe(true);
    const tested = { ...backup, testedAt: "2026-11-05T00:00:00Z" };
    expect(canEnableProvider(draft, tested)).toBe(true);
    expect(canEnableProvider({ ...draft, model: "another" }, tested)).toBe(false);
  });
  it("keeps a migrated enabled connection usable in either role without inventing a test", () => {
    const enabledBackup = { ...providerSettings(settings, "primary"), name: "已降为备用的原主供应商" };
    const draft = providerDraft(enabledBackup);
    expect(canEnableProvider(draft, enabledBackup)).toBe(true);
    expect(canPromoteProvider(enabledBackup)).toBe(true);
    expect(enabledBackup.testedAt).toBeNull();
    expect(canEnableProvider({ ...draft, model: "changed" }, enabledBackup)).toBe(false);
    expect(canEnableProvider(draft, { ...enabledBackup, enabled: false })).toBe(false);
  });
  it("requires an enabled complete saved connection for promotion, independent of historical test timestamps", () => {
    const provider = providerSettings(settings, "primary");
    expect(canPromoteProvider(provider)).toBe(true);
    expect(canPromoteProvider({ ...provider, enabled: false })).toBe(false);
    expect(canPromoteProvider({ ...provider, hasKey: false })).toBe(false);
    expect(canPromoteProvider({ ...provider, baseUrl: " " })).toBe(false);
    expect(canPromoteProvider({ ...provider, model: "" })).toBe(false);
  });
  it("binds a single-card save to the current configuration version and never borrows the other provider's key", () => {
    const draft = { ...providerDraft(providerSettings(settings, "backup")), enabled: true, testToken: "proof" };
    const body = providerPayload("property-a", settings, "backup", draft);
    expect(body).toEqual({ propertyId: "property-a", expectedVersion: 7, enabled: true, provider: "backup", name: "备用", providerEnabled: true,
      baseUrl: "https://backup.example/v1", model: "backup-model", testToken: "proof" });
    expect(body).not.toHaveProperty("apiKey");
    expect(providerPayload("property-a", settings, "backup", { ...draft, apiKey: "new-backup-key" }).apiKey).toBe("new-backup-key");
  });
  it("detects unsaved connection and role-enablement edits without requiring a new test for a display name", () => {
    const backup = providerSettings(settings, "backup"), draft = providerDraft(backup);
    expect(providerDirty(draft, backup)).toBe(false);
    expect(providerDirty({ ...draft, enabled: true }, backup)).toBe(true);
    expect(providerDirty({ ...draft, name: "更贵但稳定" }, backup)).toBe(true);
    expect(connectionChanged({ ...draft, name: "更贵但稳定" }, backup)).toBe(false);
    expect(connectionChanged({ ...draft, baseUrl: " https://backup.example/v1/ " }, backup)).toBe(false);
  });
  it("requires tests for enabled providers before turning a stopped assistant back on", () => {
    const disabled = { ...settings, enabled: false };
    expect(canEnableAssistant(disabled)).toBe(false);
    expect(canEnableAssistant({ ...disabled, providers: { ...settings.providers!, primary: { ...settings.providers!.primary, testedAt: "2026-11-05T00:00:00Z" } } })).toBe(true);
    expect(canEnableAssistant({ ...disabled, providers: { primary: { ...settings.providers!.primary, enabled: false }, backup: { ...settings.providers!.backup, enabled: true, testedAt: "2026-11-05T00:00:00Z" } } })).toBe(true);
  });
  it("renders legacy settings as one existing provider with an unconfigured disabled backup", () => {
    const { providers: _providers, ...legacy } = settings;
    expect(providerSettings(legacy, "primary")).toMatchObject({ enabled: true, hasKey: true, testedAt: null });
    expect(providerSettings(legacy, "backup")).toMatchObject({ enabled: false, hasKey: false, baseUrl: "", testedAt: null });
  });
});
