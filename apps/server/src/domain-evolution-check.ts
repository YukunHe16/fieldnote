import fs from "node:fs";
import path from "node:path";
import type { EvolvedArtifactDto } from "@fieldnote/contracts";
import { scoreOverlayText } from "./overlay-context.js";

export type DomainShadowResult = {
  ok: boolean;
  reason: string;
  replayRunId: string | null;
};

export function evaluateArtifactDomain(
  artifact: Pick<EvolvedArtifactDto, "kind" | "slug" | "name" | "description" | "body">
): {
  ok: boolean;
  reason: string;
} {
  const text = `${artifact.name}\n${artifact.description}\n${artifact.body}`;
  if (/按用户刚才确认的流程|按用户确认过的个人工作方法处理同类请求/.test(text)) {
    return { ok: false, reason: "空壳个人工作方法不能直接待审，需要具体步骤。" };
  }
  if (/简历|resume|pdf|docx/i.test(text)) {
    const hasSafety = /不编造|不得编造|do not invent/i.test(text);
    const hasDeliverable = /present_files|交付|pdf/i.test(text);
    if (!hasSafety || !hasDeliverable) {
      return { ok: false, reason: "简历类 skill 必须包含不编造规则和交付物约定。" };
    }
  }
  if (/截止|学费|奖学金|语言要求|deadline|tuition/i.test(text) && !/官方|url|http|核验|verified|source/i.test(text)) {
    return { ok: false, reason: "资料核验影子任务：截止日期或费用类做法必须约定官方来源。" };
  }
  const steps = (artifact.body.match(/^\s*(?:\d+\.|- )/gm) ?? []).length;
  if (steps < 2 && artifact.kind === "skill") {
    return { ok: false, reason: "skill 步骤过少，不能证明做法可复用。" };
  }
  return { ok: true, reason: "通过领域影子检查。" };
}

export function inspectShadowWorkspace(
  workspaceDir: string | undefined,
  artifact: Pick<EvolvedArtifactDto, "name" | "description" | "body">
): string | null {
  if (!workspaceDir || !fs.existsSync(workspaceDir)) return null;
  const names: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 3) return;
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const next = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(next, depth + 1);
      else names.push(entry.name.toLowerCase());
    }
  };
  walk(workspaceDir, 0);
  const text = `${artifact.name}\n${artifact.description}\n${artifact.body}`;
  if (/简历|resume|pdf|docx/i.test(text)) {
    const hasResume = names.some((name) => /resume|cv|简历|\.pdf$|\.docx$|\.md$/i.test(name));
    if (!hasResume) return "对照工作区没有简历或 PDF 样本。";
  }
  return null;
}

export function runShadowCheck(
  artifact: Pick<EvolvedArtifactDto, "kind" | "slug" | "name" | "description" | "body">,
  snapshot?: { runId: string; prompt: string; workspaceDir?: string } | null
): DomainShadowResult {
  const domain = evaluateArtifactDomain(artifact);
  const matched = Boolean(snapshot && skillMatchesPrompt(artifact, snapshot.prompt));
  const replayRunId = matched && snapshot ? snapshot.runId : null;
  const workspaceNote = inspectShadowWorkspace(matched ? snapshot?.workspaceDir : undefined, artifact);
  if (!domain.ok) {
    return {
      ok: false,
      reason: workspaceNote ? `${domain.reason} ${workspaceNote}` : domain.reason,
      replayRunId
    };
  }
  const reason = workspaceNote ? `静态领域检查通过。${workspaceNote}` : "静态领域检查通过。";
  return { ok: true, reason, replayRunId };
}

export function skillMatchesPrompt(
  artifact: Pick<EvolvedArtifactDto, "name" | "description" | "body">,
  prompt: string
): boolean {
  return scoreOverlayText(`${artifact.name} ${artifact.description} ${artifact.body}`, prompt) >= 2;
}
