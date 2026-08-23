import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { probeExternalTools, type ExternalToolStatus } from "./capability-probe.js";

export type DocumentExportFormat = "docx" | "pdf";

/**
 * Everything platform-dependent the exporter touches, so tests can exercise the dispatch
 * without macOS binaries, LibreOffice, or a real `zip`. Production always uses the defaults.
 */
export interface DocumentExportEnvironment {
  platform: NodeJS.Platform;
  externalTools: () => ExternalToolStatus[];
  run: (command: string, args: string[], cwd?: string) => Promise<void>;
  runToFile: (command: string, args: string[], outputPath: string) => Promise<void>;
}

/** Surfaced verbatim to the user through the tool layer, so both languages stay in the text. */
export const MISSING_SOFFICE_MESSAGE =
  "PDF 导出需要 LibreOffice（soffice）。安装后重试 / PDF export requires LibreOffice (soffice).";
export const MISSING_ZIP_MESSAGE = "DOCX 导出需要 zip 命令。安装后重试 / DOCX export requires the `zip` command.";
const SOFFICE_NO_OUTPUT_MESSAGE =
  "PDF 导出失败：LibreOffice 没有生成文件 / PDF export failed: LibreOffice produced no output.";

export async function exportTextDocument(input: {
  sourcePath: string;
  outputDirectory: string;
  baseName: string;
  formats: DocumentExportFormat[];
  environment?: Partial<DocumentExportEnvironment>;
}): Promise<Array<{ format: DocumentExportFormat; path: string }>> {
  const environment = resolveEnvironment(input.environment);
  const source = await readRegularTextFile(input.sourcePath);
  await fs.mkdir(input.outputDirectory, { recursive: true });
  const outputDirectoryStat = await fs.lstat(input.outputDirectory);
  if (outputDirectoryStat.isSymbolicLink() || !outputDirectoryStat.isDirectory()) {
    throw new Error("Document output directory must be a real directory");
  }
  const workingBase = path.join(input.outputDirectory, `.${input.baseName}`);
  const htmlPath = `${workingBase}.html`;
  const textPath = `${workingBase}.txt`;
  await fs.writeFile(htmlPath, markdownToHtml(source), { mode: 0o600 });
  await fs.writeFile(textPath, markdownToPlain(source), { mode: 0o600 });
  const outputs: Array<{ format: DocumentExportFormat; path: string }> = [];
  try {
    for (const format of [...new Set(input.formats)]) {
      const outputPath = path.join(input.outputDirectory, `${input.baseName}.${format}`);
      if (format === "docx") {
        await exportDocx({ environment, source, htmlPath, outputPath, workingDirectory: input.outputDirectory });
      } else {
        await exportPdf({ environment, htmlPath, textPath, outputPath, workingDirectory: input.outputDirectory });
      }
      outputs.push({ format, path: outputPath });
    }
  } finally {
    await Promise.allSettled([fs.unlink(htmlPath), fs.unlink(textPath)]);
  }
  return outputs;
}

function resolveEnvironment(overrides: Partial<DocumentExportEnvironment> = {}): DocumentExportEnvironment {
  return {
    platform: overrides.platform ?? process.platform,
    externalTools: overrides.externalTools ?? (() => probeExternalTools()),
    run: overrides.run ?? run,
    runToFile: overrides.runToFile ?? runToFile
  };
}

/** Absolute path (or bare command) for an external tool, or undefined when it is not installed. */
function locateTool(environment: DocumentExportEnvironment, id: string): string | undefined {
  const tool = environment.externalTools().find((item) => item.id === id);
  if (!tool?.present) return undefined;
  return tool.location ?? id;
}

/**
 * macOS keeps the textutil path (it renders the styled HTML into a real Word file, with the
 * hand-built package as a safety net). Every other platform writes the minimal package
 * directly: no cross-platform Markdown → DOCX binary is assumed to exist.
 */
async function exportDocx(input: {
  environment: DocumentExportEnvironment;
  source: string;
  htmlPath: string;
  outputPath: string;
  workingDirectory: string;
}): Promise<void> {
  if (input.environment.platform === "darwin") {
    await input.environment.run("textutil", ["-convert", "docx", "-output", input.outputPath, input.htmlPath]);
    if (await exists(input.outputPath)) return;
  }
  await createMinimalDocx(input.source, input.outputPath, input.workingDirectory, input.environment);
}

/**
 * macOS keeps cupsfilter, which needs nothing installed; LibreOffice is only used when
 * cupsfilter fails. Elsewhere LibreOffice is the single supported converter.
 */
async function exportPdf(input: {
  environment: DocumentExportEnvironment;
  htmlPath: string;
  textPath: string;
  outputPath: string;
  workingDirectory: string;
}): Promise<void> {
  const { environment } = input;
  if (environment.platform === "darwin") {
    try {
      await environment.runToFile(
        "cupsfilter",
        ["-i", "text/plain", "-m", "application/pdf", input.textPath],
        input.outputPath
      );
      return;
    } catch (error) {
      const fallback = locateTool(environment, "soffice");
      if (!fallback) throw error;
      await convertWithSoffice({ ...input, executable: fallback });
      return;
    }
  }
  const soffice = locateTool(environment, "soffice");
  if (!soffice) throw new Error(MISSING_SOFFICE_MESSAGE);
  await convertWithSoffice({ ...input, executable: soffice });
}

/**
 * Converts the HTML rendering rather than the plain-text one: the pipeline already writes it,
 * LibreOffice Writer/Web keeps the headings and bullet lists, and its `<meta charset="utf-8">`
 * makes LibreOffice decode UTF-8 so Chinese text survives. A .txt input would need an explicit
 * charset filter option and would flatten the document structure.
 *
 * Output lands in a private staging directory (LibreOffice names the file after the input) and
 * is copied into place afterwards. A dedicated `UserInstallation` profile keeps the headless run
 * from colliding with a LibreOffice window the user already has open.
 */
async function convertWithSoffice(input: {
  environment: DocumentExportEnvironment;
  executable: string;
  htmlPath: string;
  outputPath: string;
  workingDirectory: string;
}): Promise<void> {
  const stage = path.join(input.workingDirectory, `.pdf-${randomUUID()}`);
  await fs.mkdir(stage, { recursive: true });
  try {
    await input.environment.run(input.executable, [
      `-env:UserInstallation=${pathToFileURL(path.join(stage, "profile")).href}`,
      "--headless",
      "--convert-to",
      "pdf",
      "--outdir",
      stage,
      input.htmlPath
    ]);
    const produced = path.join(stage, `${path.basename(input.htmlPath, path.extname(input.htmlPath))}.pdf`);
    if (!(await exists(produced))) throw new Error(SOFFICE_NO_OUTPUT_MESSAGE);
    await fs.copyFile(produced, input.outputPath);
    await fs.chmod(input.outputPath, 0o600);
  } finally {
    await fs.rm(stage, { recursive: true, force: true });
  }
}

export function markdownToHtml(markdown: string): string {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const body: string[] = [];
  let inList = false;
  const closeList = () => {
    if (inList) {
      body.push("</ul>");
      inList = false;
    }
  };
  for (const raw of lines) {
    const line = raw.trimEnd();
    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    const bullet = line.match(/^[-*]\s+(.+)$/);
    if (heading) {
      closeList();
      body.push(`<h${heading[1]!.length}>${inlineMarkdown(heading[2]!)}</h${heading[1]!.length}>`);
    } else if (bullet) {
      if (!inList) {
        body.push("<ul>");
        inList = true;
      }
      body.push(`<li>${inlineMarkdown(bullet[1]!)}</li>`);
    } else if (!line.trim()) {
      closeList();
    } else {
      closeList();
      body.push(`<p>${inlineMarkdown(line)}</p>`);
    }
  }
  closeList();
  return `<!doctype html><html><head><meta charset="utf-8"><style>body{font:12pt -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;line-height:1.55;margin:54pt}h1{font-size:20pt}h2{font-size:16pt}h3{font-size:13pt}p{margin:0 0 9pt}li{margin:0 0 4pt}</style></head><body>${body.join("\n")}</body></html>`;
}

export function markdownToPlain(markdown: string): string {
  return markdown
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^[-*]\s+/gm, "• ")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/_([^_]+)_/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .trim();
}

function inlineMarkdown(value: string): string {
  return escapeHtml(value)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/_([^_]+)_/g, "<em>$1</em>")
    .replace(/`([^`]+)`/g, "<code>$1</code>");
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
      })[character]!
  );
}

async function createMinimalDocx(
  source: string,
  outputPath: string,
  parent: string,
  environment: DocumentExportEnvironment
): Promise<void> {
  // Resolved through PATH (with the probe's cached lookup) instead of a hardcoded /usr/bin/zip,
  // which only exists on macOS and some Linux images. Checked before any file is staged.
  const zip = locateTool(environment, "zip");
  if (!zip) throw new Error(MISSING_ZIP_MESSAGE);
  const root = path.join(parent, `.docx-${randomUUID()}`);
  await fs.mkdir(path.join(root, "_rels"), { recursive: true });
  await fs.mkdir(path.join(root, "word"), { recursive: true });
  const paragraphs = markdownToPlain(source)
    .split(/\n/)
    .map((line) => `<w:p><w:r><w:t xml:space="preserve">${escapeXml(line)}</w:t></w:r></w:p>`)
    .join("");
  await fs.writeFile(
    path.join(root, "[Content_Types].xml"),
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`
  );
  await fs.writeFile(
    path.join(root, "_rels", ".rels"),
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`
  );
  await fs.writeFile(
    path.join(root, "word", "document.xml"),
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1080" w:right="1080" w:bottom="1080" w:left="1080"/></w:sectPr></w:body></w:document>`
  );
  try {
    await environment.run(zip, ["-q", "-r", outputPath, "[Content_Types].xml", "_rels", "word"], root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

function run(command: string, args: string[], cwd?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "ignore", "pipe"] });
    let error = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      error = `${error}${chunk}`.slice(-4_000);
    });
    child.once("error", reject);
    child.once("close", (code) => (code === 0 ? resolve() : reject(new Error(`${command} failed: ${error || code}`))));
  });
}

async function exists(value: string): Promise<boolean> {
  try {
    await fs.access(value);
    return true;
  } catch {
    return false;
  }
}

async function readRegularTextFile(sourcePath: string): Promise<string> {
  const initial = await fs.lstat(sourcePath);
  if (initial.isSymbolicLink() || !initial.isFile())
    throw new Error("Document source must be a non-symbolic-link file");
  const handle = await fs.open(sourcePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    const afterOpen = await fs.lstat(sourcePath);
    if (
      !opened.isFile() ||
      opened.dev !== afterOpen.dev ||
      opened.ino !== afterOpen.ino ||
      afterOpen.isSymbolicLink()
    ) {
      throw new Error("Document source changed while it was being read");
    }
    const source = await handle.readFile("utf8");
    const afterRead = await fs.lstat(sourcePath);
    if (opened.dev !== afterRead.dev || opened.ino !== afterRead.ino || afterRead.isSymbolicLink()) {
      throw new Error("Document source changed while it was being read");
    }
    return source;
  } finally {
    await handle.close();
  }
}

function escapeXml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&apos;"
      })[character]!
  );
}

function runToFile(command: string, args: string[], outputPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let size = 0;
    let error = "";
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size <= 30 * 1024 * 1024) chunks.push(chunk);
      else child.kill();
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      error = `${error}${chunk}`.slice(-4_000);
    });
    child.once("error", reject);
    child.once("close", async (code) => {
      if (code !== 0 || size > 30 * 1024 * 1024) {
        reject(new Error(`${command} failed: ${error || code}`));
        return;
      }
      try {
        await fs.writeFile(outputPath, Buffer.concat(chunks), { mode: 0o600 });
        resolve();
      } catch (writeError) {
        reject(writeError);
      }
    });
  });
}
