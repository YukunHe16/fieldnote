/**
 * One-click presets for Anthropic-compatible model providers.
 *
 * Fieldnote asks the agent for model *aliases*, not just the model shown in this dialog: background
 * work (auto-titling, memory upkeep) requests `sonnet`, and subagents use CLAUDE_CODE_SUBAGENT_MODEL.
 * A provider that has never heard of those aliases answers chat fine while titles and memory quietly
 * fail, so every preset carries a full alias map, not just a base URL.
 */

export type ModelProviderId = "anthropic" | "deepseek" | "kimi" | "glm" | "custom";

interface ProviderModel {
  /** Value sent as the model, including any context-window suffix the provider expects. */
  id: string;
  /** Display name variant the CLI expects in the *_MODEL_NAME variables. */
  name: string;
}

export interface ModelProviderPreset {
  id: ModelProviderId;
  label: string;
  /** Empty for the official endpoint, which needs no override. */
  baseUrl: string;
  /** Model used for conversations; the strong model, where a provider offers a choice. */
  defaultModel: string;
  strong?: ProviderModel;
  /** Cheaper, faster model used for background analysis and subagents. */
  fast?: ProviderModel;
  docsUrl?: string;
}

/**
 * Expand a provider's two models into the alias variables the agent child reads.
 * Strong serves conversation aliases, fast serves background and subagent work.
 */
export function aliasMappings(preset: ModelProviderPreset): Record<string, string> {
  const { strong, fast } = preset;
  if (!strong || !fast) return {};
  return {
    ANTHROPIC_MODEL: strong.id,
    ANTHROPIC_DEFAULT_FABLE_MODEL: strong.id,
    ANTHROPIC_DEFAULT_FABLE_MODEL_NAME: strong.name,
    ANTHROPIC_DEFAULT_OPUS_MODEL: strong.id,
    ANTHROPIC_DEFAULT_OPUS_MODEL_NAME: strong.name,
    ANTHROPIC_DEFAULT_SONNET_MODEL: fast.id,
    ANTHROPIC_DEFAULT_SONNET_MODEL_NAME: fast.name,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: fast.id,
    ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME: fast.name,
    CLAUDE_CODE_SUBAGENT_MODEL: fast.id
  };
}

export const MODEL_PROVIDERS: ModelProviderPreset[] = [
  {
    id: "anthropic",
    label: "Anthropic",
    baseUrl: "",
    defaultModel: "sonnet",
    docsUrl: "https://console.anthropic.com/"
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    baseUrl: "https://api.deepseek.com/anthropic",
    defaultModel: "deepseek-v4-pro[1M]",
    strong: { id: "deepseek-v4-pro[1M]", name: "deepseek-v4-pro" },
    fast: { id: "deepseek-v4-flash-vision-exp[1M]", name: "deepseek-v4-flash-vision-exp" },
    docsUrl: "https://platform.deepseek.com/"
  },
  {
    id: "kimi",
    label: "Kimi",
    baseUrl: "https://api.moonshot.cn/anthropic",
    defaultModel: "kimi-k3",
    strong: { id: "kimi-k3", name: "kimi-k3" },
    fast: { id: "kimi-k3", name: "kimi-k3" },
    docsUrl: "https://platform.moonshot.cn/"
  },
  {
    id: "glm",
    label: "GLM",
    baseUrl: "https://open.bigmodel.cn/api/anthropic",
    defaultModel: "glm-4.7",
    strong: { id: "glm-4.7", name: "glm-4.7" },
    fast: { id: "glm-4.7", name: "glm-4.7" },
    docsUrl: "https://open.bigmodel.cn/"
  },
  { id: "custom", label: "", baseUrl: "", defaultModel: "" }
];

export function providerById(id: string | undefined): ModelProviderPreset | undefined {
  return MODEL_PROVIDERS.find((preset) => preset.id === id);
}

/**
 * Which preset a saved configuration corresponds to. Falls back to `custom` for a base URL we
 * do not ship a preset for, and to `anthropic` for the official endpoint.
 */
export function detectProvider(baseUrl: string, saved?: string): ModelProviderId {
  if (saved && providerById(saved)) return saved as ModelProviderId;
  const normalized = baseUrl.trim().replace(/\/+$/, "");
  if (!normalized) return "anthropic";
  const match = MODEL_PROVIDERS.find((preset) => preset.baseUrl && preset.baseUrl.replace(/\/+$/, "") === normalized);
  return match?.id ?? "custom";
}

/**
 * Alias map to send for a provider. A preset carries its own strong/fast split; anything else
 * points every alias at the single model the user entered, so background work never falls back to
 * an alias the provider has never heard of.
 */
export function mappingsFor(provider: ModelProviderId, model: string): Record<string, string> {
  if (provider === "anthropic") return {};
  const preset = providerById(provider);
  if (preset?.strong && model.trim() === preset.defaultModel) return aliasMappings(preset);
  const value = model.trim();
  if (!value) return {};
  return aliasMappings({
    id: provider,
    label: preset?.label ?? "",
    baseUrl: preset?.baseUrl ?? "",
    defaultModel: value,
    strong: { id: value, name: value },
    fast: { id: value, name: value }
  });
}
