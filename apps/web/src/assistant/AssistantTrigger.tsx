import { Sparkles } from "lucide-react";
import { useAssistant } from "./context";

export function AssistantTrigger({ mobile = false, compact = false }: { mobile?: boolean; compact?: boolean }) {
  const assistant = useAssistant();
  if (!assistant) return null;
  return <button type="button" className={`assistant-trigger${mobile ? " assistant-trigger-mobile" : ""}${compact ? " assistant-trigger-compact" : ""}`} onClick={assistant.toggle} aria-expanded={assistant.open} aria-controls="ai-assistant-panel" aria-label="AI 助手" title="AI 助手"><Sparkles size={18} aria-hidden="true" /><span>AI 助手</span></button>;
}
