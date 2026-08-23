import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AGENT_PROFILE_REGISTRY,
  GRADUATE_ADMISSIONS_PLUGIN_PATH,
  admissionsSkillMissingTools,
  formatAdmissionsSkillCatalog,
  getAgentProfile,
  listAgentProfileSummaries,
  officeSkillRoutingHint
} from "../src/agent-profiles.js";

const expectedSkills = [
  "official-source-research",
  "program-comparison",
  "faculty-fit",
  "application-strategy",
  "cv-resume-writing",
  "statement-writing",
  "evidence-consistency-review",
  "outreach-and-interview",
  "application-tracker"
];

describe("built-in agent profile registry", () => {
  it("ships the local and admissions profiles with safe, versioned manifests", () => {
    expect(Object.keys(AGENT_PROFILE_REGISTRY).sort()).toEqual(["graduate-admissions", "local-operator"]);
    expect(getAgentProfile("local-operator").revision).toBeGreaterThan(0);

    const admissions = getAgentProfile("graduate-admissions");
    expect(admissions.revision).toBeGreaterThan(0);
    expect(admissions.skills).toEqual(expectedSkills);
    expect(admissions.systemPrompt).toContain("official");
    expect(admissions.systemPrompt).toContain("official-source-research");
    expect(admissions.systemPrompt).toContain("项目调研");
    expect(admissions.systemPrompt).toContain("docx");
    expect(admissions.systemPrompt).toContain("pdf-creator");
    expect(admissions.systemPrompt).toContain("humanizer-zh");
    expect(admissions.systemPrompt).toContain("Available skills");
    // The office skills (pdf/docx/xlsx) are optional, so the catalogue is asserted on a
    // skill that always ships with the repository.
    expect(admissions.systemPrompt).toContain("docx-creator (Word 排版)");
    expect(admissions.systemPrompt).toContain("AskUserQuestion");
    expect(admissions.channelPolicy).toEqual({ web: true, feishu: true });
    expect(admissions.scheduleTemplates.map((template) => template.id)).toEqual([
      "weekly-application-review",
      "daily-application-plan"
    ]);
    expect(admissions.scheduleTemplates.every((template) => !template.enabledByDefault)).toBe(true);
    expect(admissions.scheduleTemplates.every((template) => template.catchUpPolicy === "merge-on-startup")).toBe(true);
  });

  it("limits specialist delegates to high effort without re-delegation", () => {
    const delegates = getAgentProfile("graduate-admissions").delegates;
    expect(delegates.map((delegate) => delegate.id)).toEqual([
      "admissions-researcher",
      "source-verifier",
      "admissions-writer",
      "admissions-evaluator"
    ]);
    expect(delegates.every((delegate) => delegate.effort !== "max")).toBe(true);
    expect(delegates.every((delegate) => delegate.allowDelegation === false)).toBe(true);
    expect(delegates.every((delegate) => delegate.maxTurns > 0)).toBe(true);
  });

  it("returns a UI-safe summary without system or runtime configuration", () => {
    const summary = listAgentProfileSummaries().find((profile) => profile.id === "graduate-admissions");
    expect(summary).toEqual(expect.objectContaining({ name: "申学助手", channels: ["web", "feishu"] }));
    expect(JSON.stringify(summary)).not.toContain("systemPrompt");
    expect(JSON.stringify(summary)).not.toContain("mcpFactories");
    expect(JSON.stringify(summary)).not.toContain("delegates");
  });

  it("includes every admissions skill in a controlled local plugin", () => {
    expect(fs.existsSync(path.join(GRADUATE_ADMISSIONS_PLUGIN_PATH, ".claude-plugin", "plugin.json"))).toBe(true);
    for (const skill of expectedSkills) {
      const skillPath = path.join(GRADUATE_ADMISSIONS_PLUGIN_PATH, "skills", skill, "SKILL.md");
      expect(fs.existsSync(skillPath), skillPath).toBe(true);
      const content = fs.readFileSync(skillPath, "utf8");
      expect(content).toContain("---");
      expect(content).toContain("## When to use");
      expect(content).toContain("## When not to use");
      expect(content).toContain("## Safety");
    }
  });

  it("ships representative admissions evals for all four launch regions and writing/schedules", () => {
    const evalPath = path.join(GRADUATE_ADMISSIONS_PLUGIN_PATH, "evals", "evals.json");
    const evals = JSON.parse(fs.readFileSync(evalPath, "utf8")) as { cases: Array<{ id: string }> };
    expect(evals.cases).toHaveLength(8);
    expect(evals.cases.map((item) => item.id).join(" ")).toMatch(/us-/);
    expect(evals.cases.map((item) => item.id).join(" ")).toMatch(/canada-/);
    expect(evals.cases.map((item) => item.id).join(" ")).toMatch(/hong-kong-/);
    expect(evals.cases.map((item) => item.id).join(" ")).toMatch(/singapore-/);
    expect(evals.cases.map((item) => item.id)).toEqual(
      expect.arrayContaining(["statement-fact-ledger", "schedule-weekly-review"])
    );
  });
});

describe("skill catalogue availability notes", () => {
  const extraSkills = [
    { id: "pdf-creator", name: "Markdown 转 PDF", description: "把文书排成 PDF。" },
    { id: "doc-to-markdown", name: "文档转 Markdown", description: "把 PDF / Word 转成 Markdown。" },
    { id: "docx-creator", name: "Word 排版", description: "把 Markdown 排成正式中文 Word。" }
  ];

  it("marks skills whose external tool is missing without removing them", () => {
    const missing = admissionsSkillMissingTools([
      { id: "uv", present: false },
      { id: "dotnet", present: true, location: "/usr/local/bin/dotnet" },
      { id: "python3", present: true, location: "/usr/bin/python3" }
    ]);
    expect(missing.get("pdf-creator")).toBe("uv");
    expect(missing.get("doc-to-markdown")).toBe("uv");
    expect(missing.has("docx-creator")).toBe(false);

    const catalog = formatAdmissionsSkillCatalog(extraSkills, missing);
    expect(catalog).toContain("- pdf-creator (Markdown 转 PDF): 把文书排成 PDF。（需要安装 uv，当前不可用）");
    expect(catalog).toContain(
      "- doc-to-markdown (文档转 Markdown): 把 PDF / Word 转成 Markdown。（需要安装 uv，当前不可用）"
    );
    // Present tools and the official admissions skills keep their description exactly as written.
    expect(catalog.split("\n")).toContain("- docx-creator (Word 排版): 把 Markdown 排成正式中文 Word。");
    expect(catalog.split("\n")).toContain(
      "- official-source-research (项目调研): 核验截止日期、学费、语言要求和奖学金；闲聊或用户刚确认的事实不用。"
    );
  });

  it("leaves every description untouched when the external tools are installed", () => {
    const present = admissionsSkillMissingTools([
      { id: "uv", present: true, location: "/usr/local/bin/uv" },
      { id: "dotnet", present: true, location: "/usr/local/bin/dotnet" },
      { id: "python3", present: true, location: "/usr/bin/python3" }
    ]);
    expect(present.size).toBe(0);
    const catalog = formatAdmissionsSkillCatalog(extraSkills, present);
    expect(catalog).not.toContain("当前不可用");
    expect(catalog).toContain("- pdf-creator (Markdown 转 PDF): 把文书排成 PDF。");
  });

  it("annotates the admissions system prompt at run time rather than at import time", () => {
    const missing = admissionsSkillMissingTools([
      { id: "uv", present: false },
      { id: "dotnet", present: false }
    ]);
    expect([...missing.keys()]).toEqual(
      expect.arrayContaining(["pdf-creator", "doc-to-markdown", "docx-creator", "pdf", "docx", "xlsx"])
    );
    // The registry entry is a getter, so a freshly installed tool is reflected on the next read.
    const descriptor = Object.getOwnPropertyDescriptor(AGENT_PROFILE_REGISTRY["graduate-admissions"], "systemPrompt");
    expect(typeof descriptor?.get).toBe("function");
    expect(getAgentProfile("graduate-admissions").systemPrompt).toContain("Available skills");
  });
});

describe("office skill routing hint", () => {
  const previousRuntimeRoot = process.env.FIELDNOTE_RUNTIME_PLUGINS;
  let temporaryRoot: string;

  beforeEach(() => {
    temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fieldnote-office-hint-"));
    process.env.FIELDNOTE_RUNTIME_PLUGINS = temporaryRoot;
  });

  afterEach(() => {
    if (previousRuntimeRoot === undefined) delete process.env.FIELDNOTE_RUNTIME_PLUGINS;
    else process.env.FIELDNOTE_RUNTIME_PLUGINS = previousRuntimeRoot;
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  });

  it("stays silent when the office skills are not installed", () => {
    expect(officeSkillRoutingHint()).toBe("");
  });

  it("routes pdf, docx and xlsx once the office skills are installed", () => {
    for (const name of ["pdf", "docx", "xlsx"]) {
      const skillDirectory = path.join(temporaryRoot, "document-skills", "skills", name);
      fs.mkdirSync(skillDirectory, { recursive: true });
      fs.writeFileSync(path.join(skillDirectory, "SKILL.md"), `---\nname: ${name}\n---\n`);
    }
    const hint = officeSkillRoutingHint();
    expect(hint).toContain("pdf / docx / xlsx");
    expect(hint).toContain("Excel/xlsx → xlsx");
    expect(hint.startsWith(" ")).toBe(true);
  });
});
