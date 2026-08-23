import type { EvolvedArtifactDto, EvolutionReviewVerdict } from "@fieldnote/contracts";
import { getAgentProfile, isAgentProfileId, type AgentProfileId } from "./agent-profiles.js";

const FORBIDDEN = [
  /ignore (all|any|previous|above) instructions?/i,
  /you are now /i,
  /disable safety/i,
  /allowDelegation\s*:\s*true/i,
  /new MCP/i
];

export interface EvolutionEvaluation {
  verdict: EvolutionReviewVerdict;
  reason: string;
}

export function evaluateArtifactProgrammatically(
  artifact: Pick<EvolvedArtifactDto, "kind" | "slug" | "name" | "description" | "body" | "profileId">
): EvolutionEvaluation {
  if (!isAgentProfileId(artifact.profileId)) {
    return { verdict: "reject", reason: "未知助手，不能挂载进化产物。" };
  }
  if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(artifact.slug)) {
    return { verdict: "reject", reason: "slug 只能是小写字母、数字和连字符。" };
  }
  if (artifact.name.trim().length < 2 || artifact.description.trim().length < 8) {
    return { verdict: "needs_human", reason: "名称或简介太短，需要确认它到底做什么。" };
  }
  if (artifact.body.trim().length < 20) {
    return { verdict: "reject", reason: "产物正文过短，无法构成可用的 skill 或子代理。" };
  }
  if (artifact.body.length > 8_000) {
    return { verdict: "reject", reason: "产物正文过长。" };
  }
  for (const pattern of FORBIDDEN) {
    if (pattern.test(`${artifact.name}\n${artifact.description}\n${artifact.body}`)) {
      return { verdict: "reject", reason: "正文包含不安全或指令腔内容。" };
    }
  }
  const profile = getAgentProfile(artifact.profileId as AgentProfileId);
  const allowedSkills = new Set(profile.skills);
  const allowedMcp = new Set(profile.mcpFactories);
  if (artifact.kind === "subagent") {
    let spec: {
      skills?: unknown;
      mcpFactories?: unknown;
      maxTurns?: unknown;
      effort?: unknown;
      allowDelegation?: unknown;
    };
    try {
      spec = JSON.parse(artifact.body) as typeof spec;
    } catch {
      return { verdict: "reject", reason: "子代理正文必须是 JSON 配置。" };
    }
    if (spec.allowDelegation === true) {
      return { verdict: "reject", reason: "进化子代理不能再委托。" };
    }
    if (typeof spec.maxTurns === "number" && spec.maxTurns > 12) {
      return { verdict: "reject", reason: "子代理 maxTurns 不能超过 12。" };
    }
    if (spec.effort !== undefined && !new Set(["low", "medium", "high"]).has(String(spec.effort))) {
      return { verdict: "reject", reason: "子代理 effort 只能是 low、medium 或 high。" };
    }
    const skills = Array.isArray(spec.skills)
      ? spec.skills.filter((item): item is string => typeof item === "string")
      : [];
    if (skills.some((skill) => !allowedSkills.has(skill) && !skill.startsWith("evolved-"))) {
      return { verdict: "reject", reason: "子代理引用了当前助手没有的 skill。" };
    }
    const mcps = Array.isArray(spec.mcpFactories)
      ? spec.mcpFactories.filter((item): item is string => typeof item === "string")
      : [];
    if (mcps.some((name) => !allowedMcp.has(name))) {
      return { verdict: "reject", reason: "子代理引用了当前助手没有的工具。" };
    }
  }
  return { verdict: "pass", reason: "通过程序硬检查。" };
}
