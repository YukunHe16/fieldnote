import { probeExternalTools, type ExternalToolStatus } from "./capability-probe.js";
import { documentSkillsInstallPath, installedExternalSkillBlurbs } from "./document-skills.js";

export type AgentProfileId = "local-operator";
export type AgentChannel = "web" | "feishu";
export type AgentEffort = "low" | "medium" | "high";

/** The profile suggested for newly-created conversations. */
export const DEFAULT_PROFILE_ID: AgentProfileId = "local-operator";
/** The profile assigned to conversations created before profile support existed. */
export const LEGACY_PROFILE_ID: AgentProfileId = "local-operator";

export interface DelegateDefinition {
  id: string;
  toolName: string;
  name: string;
  description: string;
  systemPrompt: string;
  skills: readonly string[];
  mcpFactories: readonly string[];
  maxTurns: number;
  effort: AgentEffort;
  allowDelegation: false;
}

export interface CapabilityBundle {
  id: string;
  uiLabel: string;
  description: string;
  skillNames: readonly string[];
  delegateTools: readonly string[];
  mcpTools: readonly string[];
}

export interface AgentProfileManifest {
  id: AgentProfileId;
  revision: number;
  name: string;
  description: string;
  suggestedPrompts: readonly string[];
  systemPrompt: string;
  skills: readonly string[];
  delegates: readonly DelegateDefinition[];
  mcpFactories: readonly string[];
  capabilityBundles: readonly CapabilityBundle[];
  channelPolicy: Readonly<Record<AgentChannel, boolean>>;
}

export interface AgentProfileSummary {
  id: AgentProfileId;
  name: string;
  description: string;
  capabilities: readonly string[];
  suggestedPrompts: readonly string[];
  channels: readonly AgentChannel[];
}

/**
 * Routing text for the Anthropic office skills (pdf / docx / xlsx). Those skills are not
 * distributed with this repository; they are installed on demand by
 * `pnpm skills:office`. Returns an empty string when they are absent so the prompt never
 * points the model at a skill it cannot invoke.
 */
export function officeSkillRoutingHint(): string {
  if (documentSkillsInstallPath() === null) return "";
  return " The office skills pdf / docx / xlsx are also installed for reading and producing office files directly: 直接读写 PDF → pdf; Word/docx → docx; Excel/xlsx → xlsx.";
}

/**
 * External binary each optional document skill shells out to. A skill whose binary is missing
 * stays in the catalogue — the model still needs to recognise the request — but is marked
 * unavailable so it explains the gap instead of failing halfway through a conversion.
 */
const SKILL_EXTERNAL_TOOLS: Record<string, string> = {
  "pdf-creator": "uv",
  "doc-to-markdown": "uv",
  "docx-creator": "dotnet",
  pdf: "python3",
  docx: "python3",
  xlsx: "python3"
};

/**
 * skillId → missing tool id, for every catalogued skill whose external tool is absent.
 * `tools` is injected by tests; the default path reads the shared five-minute probe cache.
 * A probe failure yields no annotations rather than marking working skills as broken.
 */
export function skillMissingTools(tools?: readonly ExternalToolStatus[]): Map<string, string> {
  let statuses = tools;
  if (!statuses) {
    try {
      statuses = probeExternalTools();
    } catch {
      return new Map();
    }
  }
  const present = new Set(statuses.filter((tool) => tool.present).map((tool) => tool.id));
  const missing = new Map<string, string>();
  for (const [skillId, toolId] of Object.entries(SKILL_EXTERNAL_TOOLS)) {
    if (!present.has(toolId)) missing.set(skillId, toolId);
  }
  return missing;
}

export function formatSkillCatalog(
  skills: Array<{ id: string; name: string; description: string }> = installedExternalSkillBlurbs(),
  missingTools: ReadonlyMap<string, string> = skillMissingTools()
): string {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const item of skills) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    const missing = missingTools.get(item.id);
    const note = missing ? `（需要安装 ${missing}，当前不可用）` : "";
    lines.push(`- ${item.id} (${item.name}): ${item.description}${note}`);
  }
  if (lines.length === 0) return "";
  return `\n\nAvailable skills. Invoke the matching skill when the request fits; skip this list for casual chat:\n${lines.join("\n")}`;
}

export const AGENT_PROFILE_REGISTRY: Readonly<Record<AgentProfileId, AgentProfileManifest>> = {
  "local-operator": {
    id: "local-operator",
    revision: 2,
    name: "本地助手",
    description: "用于日常本地任务、文件与通用问题的通用助手。",
    suggestedPrompts: ["帮我整理这个工作区", "分析这份文件并给出下一步"],
    /**
     * Assembled on access, never at module load. The catalogue marks skills whose external
     * binary is missing, and that probe must describe the machine as it is when a run starts —
     * baking it into module-level text would freeze an import-time snapshot into every process.
     * `runtime.ts` reads `profile.systemPrompt` while building each run, so this getter is the
     * runtime injection point; installing a missing tool takes effect on the next run.
     */
    get systemPrompt(): string {
      return (
        "You are the local-operator profile. Work only inside the provided conversation workspace. Be helpful, clear, and use the user's language. Do not reveal hidden reasoning, model configuration, or raw tool output. When you need the user to choose, confirm, or fill in a missing fact, call AskUserQuestion instead of asking them to type the answer." +
        officeSkillRoutingHint() +
        formatSkillCatalog()
      );
    },
    skills: [],
    delegates: [],
    mcpFactories: ["memory"],
    capabilityBundles: [
      {
        id: "local-workspace",
        uiLabel: "本地工作区",
        description: "分析和处理当前对话工作区中的任务与文件。",
        skillNames: [],
        delegateTools: [],
        mcpTools: ["memory"]
      }
    ],
    channelPolicy: { web: true, feishu: true }
  }
};

export function getAgentProfile(profileId: AgentProfileId): AgentProfileManifest {
  return AGENT_PROFILE_REGISTRY[profileId];
}

export function isAgentProfileId(value: string): value is AgentProfileId {
  return value in AGENT_PROFILE_REGISTRY;
}

export function listAgentProfiles(): readonly AgentProfileManifest[] {
  return Object.values(AGENT_PROFILE_REGISTRY);
}

export function getAgentProfileSummary(profileId: AgentProfileId): AgentProfileSummary {
  const profile = getAgentProfile(profileId);
  return {
    id: profile.id,
    name: profile.name,
    description: profile.description,
    capabilities: profile.capabilityBundles.map((bundle) => bundle.uiLabel),
    suggestedPrompts: profile.suggestedPrompts,
    channels: (["web", "feishu"] as const).filter((channel) => profile.channelPolicy[channel])
  };
}

export function listAgentProfileSummaries(): readonly AgentProfileSummary[] {
  return listAgentProfiles().map((profile) => getAgentProfileSummary(profile.id));
}

export function officialEquipment(profileId: AgentProfileId): {
  skills: Array<{ id: string; name: string; description: string }>;
  delegates: Array<{ id: string; name: string; description: string }>;
} {
  const profile = getAgentProfile(profileId);
  return {
    skills: [
      ...profile.skills.map((id) => ({
        id,
        name: id,
        description: profile.capabilityBundles.find((bundle) => bundle.skillNames.includes(id))?.description ?? ""
      })),
      ...installedExternalSkillBlurbs()
    ],
    delegates: profile.delegates.map((delegate) => ({
      id: delegate.id,
      name: delegate.name,
      description: delegate.description
    }))
  };
}
