import type { AssistantProviderRole, AssistantProviderSettings, AssistantSettings, AssistantSettingsInput } from "../../../../packages/contracts/src/assistant.ts";

export interface ProviderDraft { name: string; enabled: boolean; baseUrl: string; model: string; apiKey: string; testToken?: string }
export const providerTitles: Record<AssistantProviderRole, string> = { primary: "主用供应商", backup: "备用供应商" };
const normalizedUrl = (value: string) => value.trim().replace(/\/+$/, "");

export function providerSettings(settings: AssistantSettings, role: AssistantProviderRole): AssistantProviderSettings {
  return settings.providers?.[role] ?? (role === "primary"
    ? { name: providerTitles.primary, enabled: settings.enabled, baseUrl: settings.baseUrl, model: settings.model, hasKey: settings.hasKey, testedAt: null }
    : { name: providerTitles.backup, enabled: false, baseUrl: "", model: "", hasKey: false, testedAt: null });
}
export function providerDraft(provider: AssistantProviderSettings): ProviderDraft {
  return { name: provider.name, enabled: provider.enabled, baseUrl: provider.baseUrl, model: provider.model, apiKey: "" };
}
export function connectionChanged(draft: ProviderDraft, saved: AssistantProviderSettings) {
  return normalizedUrl(draft.baseUrl) !== normalizedUrl(saved.baseUrl) || draft.model.trim() !== saved.model || Boolean(draft.apiKey);
}
export function providerDirty(draft: ProviderDraft, saved: AssistantProviderSettings) {
  return connectionChanged(draft, saved) || draft.name.trim() !== saved.name || draft.enabled !== saved.enabled;
}
export function canEnableProvider(draft: ProviderDraft, saved: AssistantProviderSettings, role: AssistantProviderRole) {
  if (draft.testToken) return true;
  if (connectionChanged(draft, saved) || !saved.hasKey) return false;
  // Preserve the already-running primary through the additive migration without
  // inventing a historical successful test. A new or changed connection still needs one.
  return Boolean(saved.testedAt) || role === "primary" && saved.enabled;
}
export function canEnableAssistant(settings: AssistantSettings) {
  const enabled = (["primary", "backup"] as const).map(role => providerSettings(settings, role)).filter(provider => provider.enabled);
  return enabled.length > 0 && enabled.every(provider => provider.hasKey && Boolean(provider.testedAt));
}
export function providerPayload(propertyId: string, settings: AssistantSettings, role: AssistantProviderRole, draft: ProviderDraft): AssistantSettingsInput {
  return { propertyId, expectedVersion: settings.version, enabled: settings.enabled, provider: role,
    name: draft.name.trim(), providerEnabled: draft.enabled, baseUrl: draft.baseUrl.trim(), model: draft.model.trim(),
    ...(draft.apiKey ? { apiKey: draft.apiKey } : {}), ...(draft.testToken ? { testToken: draft.testToken } : {}) };
}
