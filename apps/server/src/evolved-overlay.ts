import fs from "node:fs/promises";
import path from "node:path";
import type { EvolvedArtifactDto } from "@fieldnote/contracts";
import type { AgentEffort, DelegateDefinition } from "./agent-profiles.js";

export function evolvedRoot(workspaceRoot: string, profileId: string): string {
  return path.resolve(workspaceRoot, "..", "evolved", profileId);
}

export async function syncEvolvedOverlay(workspaceRoot: string, artifact: EvolvedArtifactDto): Promise<void> {
  const root = evolvedRoot(workspaceRoot, artifact.profileId);
  await fs.mkdir(path.join(root, ".claude-plugin"), { recursive: true });
  await fs.writeFile(
    path.join(root, ".claude-plugin", "plugin.json"),
    JSON.stringify(
      {
        name: `evolved-${artifact.profileId}`,
        version: "1.0.0"
      },
      null,
      2
    )
  );
  if (artifact.kind !== "skill") return;
  const skillDir = path.join(root, "skills", artifact.slug);
  if (artifact.status !== "enabled") {
    await fs.rm(skillDir, { recursive: true, force: true });
    return;
  }
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(path.join(skillDir, "SKILL.md"), skillMarkdown(artifact));
}

function skillMarkdown(artifact: EvolvedArtifactDto): string {
  return artifact.body.startsWith("---")
    ? artifact.body
    : `---\nname: ${artifact.slug}\ndescription: ${artifact.description}\n---\n\n# ${artifact.name}\n\n${artifact.body}\n`;
}

export async function writePreviewOverlay(targetRoot: string, artifacts: EvolvedArtifactDto[]): Promise<string | null> {
  const skills = artifacts.filter((item) => item.kind === "skill");
  if (skills.length === 0) return null;
  const root = path.join(targetRoot, ".preview-overlay");
  await fs.mkdir(path.join(root, ".claude-plugin"), { recursive: true });
  await fs.writeFile(
    path.join(root, ".claude-plugin", "plugin.json"),
    JSON.stringify(
      {
        name: "evolved-preview",
        version: "1.0.0"
      },
      null,
      2
    )
  );
  for (const artifact of skills) {
    const skillDir = path.join(root, "skills", artifact.slug);
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(path.join(skillDir, "SKILL.md"), skillMarkdown(artifact));
  }
  return root;
}

export function delegateFromArtifact(artifact: EvolvedArtifactDto, preview = false): DelegateDefinition | null {
  if (artifact.kind !== "subagent" || (!preview && artifact.status !== "enabled")) return null;
  try {
    const spec = JSON.parse(artifact.body) as {
      systemPrompt?: string;
      skills?: string[];
      mcpFactories?: string[];
      maxTurns?: number;
      effort?: unknown;
      toolName?: string;
    };
    if (
      !spec.systemPrompt?.trim() ||
      (spec.effort !== undefined && !new Set(["low", "medium", "high"]).has(String(spec.effort)))
    )
      return null;
    return {
      id: artifact.slug,
      toolName: spec.toolName?.trim() || `delegate_${artifact.slug.replace(/-/g, "_")}`,
      name: artifact.name,
      description: artifact.description,
      systemPrompt: spec.systemPrompt,
      skills: spec.skills ?? [],
      mcpFactories: spec.mcpFactories ?? [],
      maxTurns: Math.min(12, spec.maxTurns ?? 8),
      effort: (spec.effort as AgentEffort | undefined) ?? "high",
      allowDelegation: false
    };
  } catch {
    return null;
  }
}

export function evolvedSkillDescription(steps: string[]): string {
  const when = steps
    .map((step) => step.replace(/^[\d.、．)\-\s]+/u, "").trim())
    .filter(Boolean)
    .slice(0, 2);
  if (when.length === 0) return "按用户确认过的个人工作方法处理同类请求。";
  return `当用户的请求涉及这些做法时使用：${when.join("；")}`.slice(0, 180);
}

export function renderEvolvedSkillBody(input: {
  slug: string;
  name: string;
  description: string;
  steps: string[];
}): string {
  return `---
name: ${input.slug}
description: ${input.description}
---

# ${input.name}

Use this evolved skill when the user's current request matches this personal working method.

## Method

${input.steps.map((step, index) => `${index + 1}. ${step}`).join("\n")}

## Safety

Do not invent user facts. Prefer official sources for admissions facts. Current user input always wins over this skill.
`;
}
