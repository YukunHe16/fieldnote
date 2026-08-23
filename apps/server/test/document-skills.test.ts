import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BUNDLED_PLUGIN_ROOT,
  DOCUMENT_SKILL_NAMES,
  bundledDocumentSkillPlugins,
  documentSkillsInstallPath,
  installedExternalSkillBlurbs,
  prepareDocumentSkillsPlugin,
  prepareExternalSkillPlugins
} from "../src/document-skills.js";

const REPO_SKILLS = ["pdf-creator", "doc-to-markdown", "docx-creator", "humanizer-zh"];

let temporaryRoot: string;
let previousRuntimeRoot: string | undefined;

/** Write a plugin that looks like an installed document-skills bundle with the given skills. */
function writeRuntimeDocumentSkills(root: string, skillNames: string[]): void {
  fs.mkdirSync(path.join(root, "document-skills", ".claude-plugin"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "document-skills", ".claude-plugin", "plugin.json"),
    JSON.stringify({ name: "document-skills", version: "1.0.0", description: "test fixture" }, null, 2)
  );
  for (const name of skillNames) {
    const skillDirectory = path.join(root, "document-skills", "skills", name);
    fs.mkdirSync(skillDirectory, { recursive: true });
    fs.writeFileSync(path.join(skillDirectory, "SKILL.md"), `---\nname: ${name}\n---\n`);
  }
}

beforeEach(() => {
  // Every test points the runtime root at an empty temp directory so the developer's own
  // data/.runtime-plugins never leaks in and no test ever reaches the network.
  temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fieldnote-doc-skills-"));
  previousRuntimeRoot = process.env.FIELDNOTE_RUNTIME_PLUGINS;
  process.env.FIELDNOTE_RUNTIME_PLUGINS = temporaryRoot;
});

afterEach(() => {
  if (previousRuntimeRoot === undefined) delete process.env.FIELDNOTE_RUNTIME_PLUGINS;
  else process.env.FIELDNOTE_RUNTIME_PLUGINS = previousRuntimeRoot;
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
});

describe("document skills discovery", () => {
  it("does not ship Anthropic's document skills in the repository", () => {
    for (const name of DOCUMENT_SKILL_NAMES) {
      expect(fs.existsSync(path.join(BUNDLED_PLUGIN_ROOT, "document-skills", "skills", name))).toBe(false);
    }
  });

  it("degrades gracefully when the office skills are not installed", async () => {
    expect(documentSkillsInstallPath()).toBeNull();
    expect(await prepareDocumentSkillsPlugin()).toBeNull();
    expect(installedExternalSkillBlurbs().map((item) => item.id)).toEqual(REPO_SKILLS);
    const bundles = await prepareExternalSkillPlugins();
    expect(bundles.flatMap((item) => item.skillNames)).toEqual(REPO_SKILLS);
    expect(bundles.every((item) => item.pluginPath.startsWith(BUNDLED_PLUGIN_ROOT))).toBe(true);
  });

  it("keeps a blurb for every skill it reports as installed", () => {
    const blurbs = installedExternalSkillBlurbs();
    expect(blurbs.map((item) => item.id)).toEqual(bundledDocumentSkillPlugins().flatMap((item) => item.skillNames));
    expect(blurbs.every((item) => item.name.length > 0 && item.description.length > 0)).toBe(true);
  });

  it("discovers a single office skill installed under the runtime root", async () => {
    writeRuntimeDocumentSkills(temporaryRoot, ["pdf"]);

    const bundle = await prepareDocumentSkillsPlugin();
    expect(bundle).toMatchObject({
      pluginPath: path.join(temporaryRoot, "document-skills"),
      installPath: path.join(temporaryRoot, "document-skills"),
      skillNames: ["pdf"]
    });
    expect(installedExternalSkillBlurbs().map((item) => item.id)).toEqual(["pdf", ...REPO_SKILLS]);
    // A partial install is usable but is not a complete office bundle.
    expect(documentSkillsInstallPath()).toBeNull();
  });

  it("reports a complete runtime install as the office skills install path", async () => {
    writeRuntimeDocumentSkills(temporaryRoot, [...DOCUMENT_SKILL_NAMES]);

    expect(documentSkillsInstallPath()).toBe(path.join(temporaryRoot, "document-skills"));
    const bundles = await prepareExternalSkillPlugins();
    expect(bundles.flatMap((item) => item.skillNames)).toEqual([...DOCUMENT_SKILL_NAMES, ...REPO_SKILLS]);
  });

  it("re-reads the runtime root on every call so a fresh install is picked up without a restart", () => {
    expect(documentSkillsInstallPath()).toBeNull();
    writeRuntimeDocumentSkills(temporaryRoot, [...DOCUMENT_SKILL_NAMES]);
    expect(documentSkillsInstallPath()).toBe(path.join(temporaryRoot, "document-skills"));
  });
});
