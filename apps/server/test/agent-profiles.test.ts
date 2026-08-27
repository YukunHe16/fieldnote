import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AGENT_PROFILE_REGISTRY,
  formatSkillCatalog,
  getAgentProfile,
  listAgentProfileSummaries,
  officeSkillRoutingHint,
  skillMissingTools
} from "../src/agent-profiles.js";

describe("built-in agent profile registry", () => {
  it("ships the local-operator profile as the single safe, versioned manifest", () => {
    expect(Object.keys(AGENT_PROFILE_REGISTRY)).toEqual(["local-operator"]);

    const local = getAgentProfile("local-operator");
    expect(local.revision).toBeGreaterThan(0);
    expect(local.skills).toEqual([]);
    // Every delegate is now an evolved/managed subagent; nothing ships pre-installed.
    expect(local.delegates).toEqual([]);
    expect(local.systemPrompt).toContain("local-operator");
    expect(local.systemPrompt).toContain("AskUserQuestion");
    expect(local.systemPrompt).toContain("Available skills");
    // The office skills (pdf/docx/xlsx) are optional, so the catalogue is asserted on a
    // skill that always ships with the repository.
    expect(local.systemPrompt).toContain("docx-creator (Word 排版)");
    expect(local.systemPrompt).toContain("humanizer-zh");
    expect(local.channelPolicy).toEqual({ web: true, feishu: true });
  });

  it("returns a UI-safe summary without system or runtime configuration", () => {
    const summaries = listAgentProfileSummaries();
    expect(summaries.map((profile) => profile.id)).toEqual(["local-operator"]);
    const summary = summaries.find((profile) => profile.id === "local-operator");
    expect(summary).toEqual(expect.objectContaining({ name: "本地助手", channels: ["web", "feishu"] }));
    expect(JSON.stringify(summary)).not.toContain("systemPrompt");
    expect(JSON.stringify(summary)).not.toContain("mcpFactories");
    expect(JSON.stringify(summary)).not.toContain("delegates");
  });
});

describe("skill catalogue availability notes", () => {
  const extraSkills = [
    { id: "pdf-creator", name: "Markdown 转 PDF", description: "把文书排成 PDF。" },
    { id: "doc-to-markdown", name: "文档转 Markdown", description: "把 PDF / Word 转成 Markdown。" },
    { id: "docx-creator", name: "Word 排版", description: "把 Markdown 排成正式中文 Word。" }
  ];

  it("marks skills whose external tool is missing without removing them", () => {
    const missing = skillMissingTools([
      { id: "uv", present: false },
      { id: "dotnet", present: true, location: "/usr/local/bin/dotnet" },
      { id: "python3", present: true, location: "/usr/bin/python3" }
    ]);
    expect(missing.get("pdf-creator")).toBe("uv");
    expect(missing.get("doc-to-markdown")).toBe("uv");
    expect(missing.has("docx-creator")).toBe(false);

    const catalog = formatSkillCatalog(extraSkills, missing);
    expect(catalog).toContain("- pdf-creator (Markdown 转 PDF): 把文书排成 PDF。（需要安装 uv，当前不可用）");
    expect(catalog).toContain(
      "- doc-to-markdown (文档转 Markdown): 把 PDF / Word 转成 Markdown。（需要安装 uv，当前不可用）"
    );
    // Present tools keep their description exactly as written.
    expect(catalog.split("\n")).toContain("- docx-creator (Word 排版): 把 Markdown 排成正式中文 Word。");
    // The catalogue is assembled purely from the skills it is handed; nothing is injected.
    expect(catalog.split("\n").filter((line) => line.startsWith("- "))).toHaveLength(extraSkills.length);
  });

  it("leaves every description untouched when the external tools are installed", () => {
    const present = skillMissingTools([
      { id: "uv", present: true, location: "/usr/local/bin/uv" },
      { id: "dotnet", present: true, location: "/usr/local/bin/dotnet" },
      { id: "python3", present: true, location: "/usr/bin/python3" }
    ]);
    expect(present.size).toBe(0);
    const catalog = formatSkillCatalog(extraSkills, present);
    expect(catalog).not.toContain("当前不可用");
    expect(catalog).toContain("- pdf-creator (Markdown 转 PDF): 把文书排成 PDF。");
  });

  it("stays silent instead of advertising an empty skill list", () => {
    expect(formatSkillCatalog([], new Map())).toBe("");
  });

  it("annotates the local-operator system prompt at run time rather than at import time", () => {
    const missing = skillMissingTools([
      { id: "uv", present: false },
      { id: "dotnet", present: false }
    ]);
    expect([...missing.keys()]).toEqual(
      expect.arrayContaining(["pdf-creator", "doc-to-markdown", "docx-creator", "pdf", "docx", "xlsx"])
    );
    // The registry entry is a getter, so a freshly installed tool is reflected on the next read.
    const descriptor = Object.getOwnPropertyDescriptor(AGENT_PROFILE_REGISTRY["local-operator"], "systemPrompt");
    expect(typeof descriptor?.get).toBe("function");
    expect(getAgentProfile("local-operator").systemPrompt).toContain("Available skills");
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
