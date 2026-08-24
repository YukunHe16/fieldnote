import path from "node:path";
import { fileURLToPath } from "node:url";
import { probeExternalTools, type ExternalToolStatus } from "./capability-probe.js";
import { documentSkillsInstallPath, installedExternalSkillBlurbs } from "./document-skills.js";
import { systemSchedulerTimeZone } from "./scheduler-time.js";

export type AgentProfileId = "local-operator" | "graduate-admissions";
export type AgentChannel = "web" | "feishu";
export type AgentEffort = "low" | "medium" | "high";
export type ScheduleCatchUpPolicy = "merge-on-startup";

/** The profile suggested for newly-created conversations. */
export const DEFAULT_PROFILE_ID: AgentProfileId = "graduate-admissions";
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

export interface ScheduleTemplate {
  id: "weekly-application-review" | "daily-application-plan";
  name: string;
  description: string;
  cron: string;
  timezone: string;
  enabledByDefault: false;
  catchUpPolicy: ScheduleCatchUpPolicy;
  allowedChannels: readonly AgentChannel[];
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
  scheduleTemplates: readonly ScheduleTemplate[];
}

export interface AgentProfileSummary {
  id: AgentProfileId;
  name: string;
  description: string;
  capabilities: readonly string[];
  suggestedPrompts: readonly string[];
  channels: readonly AgentChannel[];
}

/** Path passed to the SDK's local-plugin configuration for the admissions profile. */
const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
export const GRADUATE_ADMISSIONS_PLUGIN_PATH = path.resolve(moduleDirectory, "../plugins/graduate-admissions");

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

const admissionsSystemPrompt = `You are the Graduate Admissions Assistant for applicants to master's, MPhil, and PhD programmes in the United States, Canada, Hong Kong, and Singapore. You help with research, strategy, writing, interviews, and application progress.

Understand the user's goal before choosing whether to answer directly, use a skill, read structured application data, research sources, or delegate a bounded independent task. Keep the conversation natural and use the user's language. Briefly communicate meaningful progress in ordinary assistant prose; never expose hidden reasoning, model configuration, raw tool output, or internal worker instructions.

Choose a skill when the request matches it; skip skills for casual chat or facts the user just confirmed in this turn. Unverified deadlines, tuition, language requirements, scholarships, visa or examination policy, and faculty availability must go through official-source-research (项目调研) before you state them as current — do not answer those from memory or ranking sites. Use program-comparison for comparing programmes, faculty-fit for advisors or labs, application-strategy for school lists and sequencing, cv-resume-writing for CVs, statement-writing for SOP/PS/RS, evidence-consistency-review to check a draft against a fact ledger, outreach-and-interview for outreach or interviews, and application-tracker only to read or change saved programmes, requirements, or deadlines. When the user uploads or asks to convert a PDF, Word, or Excel file — including 转 PDF、转 markdown、导出 docx/xlsx — use pdf-creator or doc-to-markdown for Chinese Markdown conversion. Draft SOP and CV in Markdown first, then convert. Use humanizer-zh to remove AI-sounding prose. Chinese cues: 截止/学费/语言要求/奖学金 → 项目调研; 比较项目 → 项目比较; 导师/实验室 → 导师匹配; SOP/文书 → 文书写作; 去AI腔 → humanizer-zh; 套磁/面试 → 套磁与面试; 加入看板/改状态 → 申请进度; 转PDF → pdf-creator; 读PDF/转markdown → doc-to-markdown; Word/docx → docx-creator.${officeSkillRoutingHint()}

Treat deadlines, costs, language requirements, scholarships, visa or examination policy, and faculty availability as dynamic facts: research them before presenting them as current. Prefer official school, department, graduate-school, laboratory, faculty, government, and examination-provider pages. Cite the official URL and verification date for factual conclusions; clearly mark an item as unverified when it cannot be confirmed. Academic metadata may help find publications, but current affiliation, admissions status, and programme requirements require official confirmation.

Discover pages with the built-in WebSearch tool. Write a specific query from the school and programme names the user gave; do not invent or hardcode institution domains. If a host is already known from the user or a previous official page, you may pass it as WebSearch allowed_domains, but search still works without any domain list. After WebSearch, read official pages with admissions_evidence.fetch_official_page (or WebFetch if you only need a quick look). If a page is JavaScript-rendered, follow candidateLinks or search again for a static or PDF official page. Use admissions_evidence.search_official_sources only when native search is unavailable or returns no useful leads. Never treat a search snippet as verified evidence, and do not describe ordinary fetch fallback as a security or network failure to the user.

Do not promise admission or fabricate admission probabilities. Do not invent grades, test scores, experience, publications, citations, recommendation-letter opinions, faculty interactions, funding, or any other user fact. Keep writing factual and in the user's voice. Do not retain transcripts, passports, financial evidence, or recommendation-letter text as automatic memory. Treat the user's current statement as more authoritative than old notes. Whenever you need the user to choose, confirm, or supply a missing preference, call AskUserQuestion. Put the full choice in the option labels (add a short description when the label is not self-explanatory). Do not ask them to type the answer in chat. Ask one focused question with at most six complete options. For destructive tracker or artifact actions, confirm with AskUserQuestion first.`;

const OFFICIAL_SKILL_BLURBS: Record<string, { name: string; description: string }> = {
  "official-source-research": {
    name: "项目调研",
    description: "核验截止日期、学费、语言要求和奖学金；闲聊或用户刚确认的事实不用。"
  },
  "program-comparison": { name: "项目比较", description: "按官方事实比较多个项目；查单个截止日期或做选校策略时不用。" },
  "faculty-fit": { name: "导师匹配", description: "评估导师和实验室匹配；查是否招生或写套磁信时先用对应技能。" },
  "application-strategy": { name: "申请策略", description: "规划选校组合和下一步；查单个费用或写文书时不用。" },
  "cv-resume-writing": { name: "CV 写作", description: "整理和改写学术简历；SOP 和个人陈述用文书写作。" },
  "statement-writing": { name: "文书写作", description: "起草和修改 SOP / 个人陈述；简历、套磁和审校用对应技能。" },
  "evidence-consistency-review": {
    name: "事实审校",
    description: "对照事实台账检查近完成稿；从头起草或查官网时不用。"
  },
  "outreach-and-interview": {
    name: "套磁与面试",
    description: "准备套磁邮件、推荐人材料和面试练习；评估匹配用导师匹配。"
  },
  "application-tracker": { name: "申请进度", description: "读写已保存的项目、材料和截止日期；未知官网事实先调研。" }
};

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
export function admissionsSkillMissingTools(tools?: readonly ExternalToolStatus[]): Map<string, string> {
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

export function formatAdmissionsSkillCatalog(
  extraSkills: Array<{ id: string; name: string; description: string }> = installedExternalSkillBlurbs(),
  missingTools: ReadonlyMap<string, string> = admissionsSkillMissingTools()
): string {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const item of [
    ...Object.entries(OFFICIAL_SKILL_BLURBS).map(([id, blurb]) => ({ id, ...blurb })),
    ...extraSkills
  ]) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    const missing = missingTools.get(item.id);
    const note = missing ? `（需要安装 ${missing}，当前不可用）` : "";
    lines.push(`- ${item.id} (${item.name}): ${item.description}${note}`);
  }
  return `\n\nAvailable skills. Invoke the matching skill when the request fits; skip this list for casual chat:\n${lines.join("\n")}`;
}

const researcher: DelegateDefinition = {
  id: "admissions-researcher",
  toolName: "delegate_researcher",
  name: "项目研究员",
  description: "Researches programmes, faculty, laboratories, and policy from primary sources.",
  systemPrompt:
    "Research the assigned admissions question using built-in WebSearch first, then read official pages with fetch_official_page or WebFetch. Do not invent institution domains. Separate verified facts from inferences, attach source URLs and verification dates, and report missing or conflicting fields. Do not modify tracker data, create artifacts, or delegate work.",
  skills: ["official-source-research", "program-comparison", "faculty-fit"],
  mcpFactories: ["admissions_evidence", "academic_research"],
  maxTurns: 10,
  effort: "high",
  allowDelegation: false
};

const verifier: DelegateDefinition = {
  id: "source-verifier",
  toolName: "delegate_source_verifier",
  name: "资料核验员",
  description: "Independently checks key admissions facts, source authority, and freshness.",
  systemPrompt:
    "Independently verify only the supplied claims and sources. Use built-in WebSearch and fetch_official_page or WebFetch to reach the responsible official page. Do not invent institution domains. Report conflicts or staleness, and distinguish verified facts from unresolved questions. Do not change data, write documents, or delegate work.",
  skills: ["official-source-research", "evidence-consistency-review"],
  mcpFactories: ["admissions_evidence", "academic_research"],
  maxTurns: 8,
  effort: "high",
  allowDelegation: false
};

const writer: DelegateDefinition = {
  id: "admissions-writer",
  toolName: "delegate_writer",
  name: "文书写作",
  description: "Produces evidence-grounded CV, statement, and outreach drafts.",
  systemPrompt:
    "Draft only from the supplied fact ledger and task requirements. Preserve the applicant's voice and mark missing facts as questions rather than inventing them. Check the requested programme and institution names exactly. Do not browse unrelated data, change tracker records, or delegate work.",
  skills: ["cv-resume-writing", "statement-writing", "outreach-and-interview"],
  mcpFactories: ["admissions_artifacts"],
  maxTurns: 12,
  effort: "high",
  allowDelegation: false
};

const evaluator: DelegateDefinition = {
  id: "admissions-evaluator",
  toolName: "delegate_evaluator",
  name: "文书审校",
  description: "Reviews factual consistency, programme fit, requirements, and clarity.",
  systemPrompt:
    "Review the supplied document against its fact ledger, prompt, and programme requirements. Identify unsupported claims, name or requirement errors, gaps in personalisation, and concrete improvements. Never rewrite user facts, change artifacts, or delegate work.",
  skills: ["evidence-consistency-review", "statement-writing", "cv-resume-writing"],
  mcpFactories: ["admissions_artifacts"],
  maxTurns: 10,
  effort: "high",
  allowDelegation: false
};

export const AGENT_PROFILE_REGISTRY: Readonly<Record<AgentProfileId, AgentProfileManifest>> = {
  "local-operator": {
    id: "local-operator",
    revision: 2,
    name: "本地助手",
    description: "用于日常本地任务、文件与通用问题的通用助手。",
    suggestedPrompts: ["帮我整理这个工作区", "分析这份文件并给出下一步"],
    systemPrompt:
      "You are the local-operator profile. Work only inside the provided conversation workspace. Be helpful, clear, and use the user's language. Do not reveal hidden reasoning, model configuration, or raw tool output. When you need the user to choose, confirm, or fill in a missing fact, call AskUserQuestion instead of asking them to type the answer.",
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
    channelPolicy: { web: true, feishu: true },
    scheduleTemplates: []
  },
  "graduate-admissions": {
    id: "graduate-admissions",
    revision: 7,
    name: "申学助手",
    description: "协助海外硕博申请的项目调研、文书、导师匹配与进度管理。",
    suggestedPrompts: [
      "帮我比较美国和新加坡的计算机硕士项目",
      "根据我的研究经历筛选适合的 PhD 导师",
      "帮我为 SOP 建立事实台账和提纲",
      "整理本周申请材料和临近截止日期"
    ],
    /**
     * Assembled on access, never at module load. The catalogue marks skills whose external
     * binary is missing, and that probe must describe the machine as it is when a run starts —
     * baking it into module-level text would freeze an import-time snapshot into every process
     * (and make the static prompt depend on the environment that happened to import this file).
     * `runtime.ts` reads `profile.systemPrompt` while building each run, so this getter is the
     * runtime injection point; installing a missing tool takes effect on the next run.
     */
    get systemPrompt(): string {
      return admissionsSystemPrompt + formatAdmissionsSkillCatalog();
    },
    skills: [
      "official-source-research",
      "program-comparison",
      "faculty-fit",
      "application-strategy",
      "cv-resume-writing",
      "statement-writing",
      "evidence-consistency-review",
      "outreach-and-interview",
      "application-tracker"
    ],
    delegates: [researcher, verifier, writer, evaluator],
    mcpFactories: [
      "admissions_evidence",
      "academic_research",
      "application_tracker",
      "admissions_artifacts",
      "admissions_delegation",
      "admissions_schedule"
    ],
    capabilityBundles: [
      {
        id: "programme-research",
        uiLabel: "项目与学校调研",
        description: "用官方来源研究项目要求、费用、截止日期与资助。",
        skillNames: ["official-source-research", "program-comparison"],
        delegateTools: ["delegate_researcher", "delegate_source_verifier"],
        mcpTools: ["admissions_evidence", "academic_research"]
      },
      {
        id: "faculty-fit",
        uiLabel: "导师与实验室匹配",
        description: "从研究方向、论文和官方任职信息评估导师匹配。",
        skillNames: ["faculty-fit", "official-source-research"],
        delegateTools: ["delegate_researcher", "delegate_source_verifier"],
        mcpTools: ["academic_research", "admissions_evidence"]
      },
      {
        id: "application-strategy",
        uiLabel: "选校与申请策略",
        description: "基于背景、目标与约束规划申请组合和节奏。",
        skillNames: ["application-strategy", "program-comparison"],
        delegateTools: [],
        mcpTools: ["application_tracker"]
      },
      {
        id: "application-writing",
        uiLabel: "CV 与申请文书",
        description: "基于事实台账起草、审校并管理申请材料。",
        skillNames: ["cv-resume-writing", "statement-writing", "evidence-consistency-review"],
        delegateTools: ["delegate_writer", "delegate_evaluator"],
        mcpTools: ["admissions_artifacts"]
      },
      {
        id: "outreach-and-interview",
        uiLabel: "套磁、推荐与面试",
        description: "准备套磁邮件、推荐人 briefing 和面试练习。",
        skillNames: ["outreach-and-interview"],
        delegateTools: ["delegate_writer", "delegate_evaluator"],
        mcpTools: ["admissions_artifacts"]
      },
      {
        id: "application-progress",
        uiLabel: "申请进度与提醒",
        description: "维护项目、材料、任务、截止日期和安全的定时总结。",
        skillNames: ["application-tracker"],
        delegateTools: [],
        mcpTools: ["application_tracker", "admissions_schedule"]
      }
    ],
    channelPolicy: { web: true, feishu: true },
    scheduleTemplates: [
      {
        id: "weekly-application-review",
        name: "每周申请回顾",
        description: "汇总本周完成项、卡点、未来七天前三项和临近截止日期。",
        cron: "0 8 * * 1",
        timezone: systemSchedulerTimeZone(),
        enabledByDefault: false,
        catchUpPolicy: "merge-on-startup",
        allowedChannels: ["web", "feishu"]
      },
      {
        id: "daily-application-plan",
        name: "每日申请计划",
        description: "在有活跃申请季时汇总未来 30 天截止日期、材料缺口和当天行动项。",
        cron: "0 8 * * *",
        timezone: systemSchedulerTimeZone(),
        enabledByDefault: false,
        catchUpPolicy: "merge-on-startup",
        allowedChannels: ["web", "feishu"]
      }
    ]
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
  const documentSkills = profileId === "graduate-admissions" ? installedExternalSkillBlurbs() : [];
  return {
    skills: [
      ...profile.skills.map((id) => ({
        id,
        name: OFFICIAL_SKILL_BLURBS[id]?.name ?? id,
        description:
          OFFICIAL_SKILL_BLURBS[id]?.description ??
          profile.capabilityBundles.find((bundle) => bundle.skillNames.includes(id))?.description ??
          ""
      })),
      ...documentSkills
    ],
    delegates: profile.delegates.map((delegate) => ({
      id: delegate.id,
      name: delegate.name,
      description: delegate.description
    }))
  };
}
