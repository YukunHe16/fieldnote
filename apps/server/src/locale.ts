import type { AgentStore } from "./store.js";

export type UiLocale = "zh" | "en";

export function parseUiLocale(value?: string | string[] | null): UiLocale {
  const raw = Array.isArray(value) ? value[0] : value;
  if (raw?.toLowerCase().startsWith("en")) return "en";
  return "zh";
}

export function readUiLocale(store: AgentStore): UiLocale {
  const stored = store.getSetting<string>("ui.locale");
  return stored === "en" || stored === "zh" ? stored : "zh";
}

export function rememberUiLocale(store: AgentStore, value?: string | string[] | null): UiLocale {
  const locale = parseUiLocale(value);
  store.setSetting("ui.locale", locale);
  return locale;
}

export function uiLocaleInstruction(locale?: UiLocale): string {
  if (locale === "en") {
    return "\n\nThe user interface language is English. Reply in English unless the user writes in another language.\n";
  }
  return "\n\n界面语言为中文。除非用户使用其他语言，否则请用中文回复。\n";
}
