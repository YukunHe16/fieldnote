import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const DOCUMENT_SKILL_NAMES = ["pdf", "docx", "xlsx"] as const;

export type DocumentSkillsBundle = {
  pluginPath: string;
  installPath: string;
  skillNames: string[];
};

type BundledPluginSpec = {
  directory: string;
  skills: Array<{ name: string; from: string; blurb: { name: string; description: string } }>;
};

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));

/**
 * Plugins that ship inside the repository. Resolves to `apps/server/plugins`
 * from both `apps/server/src` (tsx / vitest) and `apps/server/dist` (built).
 */
export const BUNDLED_PLUGIN_ROOT = path.resolve(moduleDirectory, "../plugins");

/** Default location for plugins installed on demand: `<repo>/data/.runtime-plugins`. */
export const DEFAULT_RUNTIME_PLUGIN_ROOT = path.resolve(moduleDirectory, "../../../data/.runtime-plugins");

/**
 * Where on-demand plugins live. Read lazily so an installer (or a test) can
 * point `FIELDNOTE_RUNTIME_PLUGINS` somewhere else without a module reload.
 */
export function runtimePluginRoot(): string {
  return process.env.FIELDNOTE_RUNTIME_PLUGINS ?? DEFAULT_RUNTIME_PLUGIN_ROOT;
}

/** Search roots in priority order; the first root that holds a bundle wins for that bundle. */
export function pluginSearchRoots(): string[] {
  return [BUNDLED_PLUGIN_ROOT, runtimePluginRoot()];
}

const BUNDLED_PLUGINS: BundledPluginSpec[] = [
  {
    directory: "document-skills",
    skills: [
      { name: "pdf", from: "skills/pdf", blurb: { name: "PDF", description: "读取、抽取和导出 PDF。" } },
      { name: "docx", from: "skills/docx", blurb: { name: "Word", description: "读取和生成 Word 文书、简历。" } },
      { name: "xlsx", from: "skills/xlsx", blurb: { name: "Excel", description: "读取和生成选校表、截止日期表。" } }
    ]
  },
  {
    directory: "daymade-docs",
    skills: [
      {
        name: "pdf-creator",
        from: "skills/pdf-creator",
        blurb: { name: "Markdown 转 PDF", description: "把文书和简历 Markdown 排成带中文的 PDF。" }
      },
      {
        name: "doc-to-markdown",
        from: "skills/doc-to-markdown",
        blurb: { name: "文档转 Markdown", description: "把 PDF / Word 转成可改的 Markdown。" }
      },
      {
        name: "docx-creator",
        from: "skills/docx-creator",
        blurb: { name: "Word 排版", description: "把 Markdown 排成正式中文 Word。" }
      }
    ]
  },
  {
    directory: "humanizer-zh",
    skills: [
      {
        name: "humanizer-zh",
        from: "skills/humanizer-zh",
        blurb: { name: "去 AI 痕迹", description: "把文书改得更像人写的，去掉套话和 AI 腔。" }
      }
    ]
  }
];

export const DOCUMENT_SKILL_BLURBS = Object.fromEntries(
  BUNDLED_PLUGINS.flatMap((plugin) => plugin.skills.map((skill) => [skill.name, skill.blurb]))
) as Record<string, { name: string; description: string }>;

function skillExists(pluginPath: string, relative: string): boolean {
  return fs.existsSync(path.join(pluginPath, relative, "SKILL.md"));
}

/** Resolve one plugin spec against the search roots; returns null when no root holds any of its skills. */
function resolvePlugin(plugin: BundledPluginSpec): DocumentSkillsBundle | null {
  for (const root of pluginSearchRoots()) {
    const pluginPath = path.join(root, plugin.directory);
    const skillNames = plugin.skills.filter((skill) => skillExists(pluginPath, skill.from)).map((skill) => skill.name);
    if (skillNames.length === 0) continue;
    return { pluginPath, installPath: pluginPath, skillNames };
  }
  return null;
}

export function bundledDocumentSkillPlugins(): DocumentSkillsBundle[] {
  const bundles: DocumentSkillsBundle[] = [];
  for (const plugin of BUNDLED_PLUGINS) {
    const bundle = resolvePlugin(plugin);
    if (bundle) bundles.push(bundle);
  }
  return bundles;
}

function documentSkillsBundle(): DocumentSkillsBundle | null {
  return bundledDocumentSkillPlugins().find((item) => item.pluginPath.endsWith(`${path.sep}document-skills`)) ?? null;
}

export function documentSkillsInstallPath(): string | null {
  const bundle = documentSkillsBundle();
  return bundle && DOCUMENT_SKILL_NAMES.every((name) => bundle.skillNames.includes(name)) ? bundle.pluginPath : null;
}

export function prepareDocumentSkillsPlugin(): Promise<DocumentSkillsBundle | null> {
  return Promise.resolve(documentSkillsBundle());
}

export function prepareExternalSkillPlugins(): Promise<DocumentSkillsBundle[]> {
  return Promise.resolve(bundledDocumentSkillPlugins());
}

export function installedExternalSkillBlurbs(): Array<{ id: string; name: string; description: string }> {
  return bundledDocumentSkillPlugins().flatMap((bundle) =>
    bundle.skillNames.map((id) => ({
      id,
      name: DOCUMENT_SKILL_BLURBS[id]?.name ?? id,
      description: DOCUMENT_SKILL_BLURBS[id]?.description ?? ""
    }))
  );
}
