import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ExternalToolStatus } from "../src/capability-probe.js";
import {
  MISSING_SOFFICE_MESSAGE,
  MISSING_ZIP_MESSAGE,
  exportTextDocument,
  markdownToHtml,
  markdownToPlain,
  type DocumentExportEnvironment
} from "../src/document-export.js";

interface RecordedCommand {
  command: string;
  args: string[];
  cwd?: string;
  outputPath?: string;
}

function toolStatuses(tools: Record<string, boolean>): ExternalToolStatus[] {
  return Object.entries(tools).map(([id, present]) =>
    present ? { id, present: true, location: `/usr/local/bin/${id}` } : { id, present: false }
  );
}

/** Writes whatever the real binary would have produced, so the surrounding file work is exercised. */
async function simulateOutput(command: string, args: string[]): Promise<void> {
  const name = path.basename(command);
  if (name === "textutil") {
    await fs.writeFile(args[args.indexOf("-output") + 1]!, "PK textutil docx");
    return;
  }
  if (name === "zip") {
    await fs.writeFile(args[2]!, "PK minimal docx");
    return;
  }
  if (name === "soffice") {
    const directory = args[args.indexOf("--outdir") + 1]!;
    const input = args[args.length - 1]!;
    await fs.writeFile(path.join(directory, `${path.basename(input, path.extname(input))}.pdf`), "%PDF-1.4 soffice");
  }
}

function fakeEnvironment(options: { platform: NodeJS.Platform; tools?: Record<string, boolean>; failing?: string[] }): {
  environment: Partial<DocumentExportEnvironment>;
  calls: RecordedCommand[];
} {
  const calls: RecordedCommand[] = [];
  const failing = new Set(options.failing ?? []);
  const environment: Partial<DocumentExportEnvironment> = {
    platform: options.platform,
    externalTools: () => toolStatuses(options.tools ?? {}),
    run: async (command, args, cwd) => {
      calls.push({ command, args, ...(cwd === undefined ? {} : { cwd }) });
      if (failing.has(path.basename(command))) throw new Error(`${path.basename(command)} failed: exit 1`);
      await simulateOutput(command, args);
    },
    runToFile: async (command, args, outputPath) => {
      calls.push({ command, args, outputPath });
      if (failing.has(path.basename(command))) throw new Error(`${path.basename(command)} failed: exit 1`);
      await fs.writeFile(outputPath, "%PDF-1.4 cupsfilter");
    }
  };
  return { environment, calls };
}

const temporaryRoots: string[] = [];

async function workspace(): Promise<{ root: string; sourcePath: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "document-export-"));
  temporaryRoots.push(root);
  const sourcePath = path.join(root, "statement.md");
  await fs.writeFile(sourcePath, "# 申请文书\n\n这是一段中文测试。\n\n- 第一条", "utf8");
  return { root, sourcePath };
}

afterEach(async () => {
  await Promise.allSettled(temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("managed document export", () => {
  it("renders a conservative HTML and plain-text representation", () => {
    const markdown = "# Statement\n\n**Research** & fit\n\n- First item";
    expect(markdownToHtml(markdown)).toContain("<h1>Statement</h1>");
    expect(markdownToHtml(markdown)).toContain("<strong>Research</strong> &amp; fit");
    expect(markdownToPlain(markdown)).toContain("• First item");
  });

  it("exports real DOCX and PDF files on the supported local macOS runtime", async () => {
    if (process.platform !== "darwin") return;
    const { root, sourcePath } = await workspace();
    const outputs = await exportTextDocument({
      sourcePath,
      outputDirectory: root,
      baseName: "statement",
      formats: ["docx", "pdf"]
    });
    const docx = await fs.readFile(outputs.find((item) => item.format === "docx")!.path);
    const pdf = await fs.readFile(outputs.find((item) => item.format === "pdf")!.path);
    expect(docx.subarray(0, 2).toString()).toBe("PK");
    expect(pdf.subarray(0, 4).toString()).toBe("%PDF");
  });
});

describe("document export platform dispatch", () => {
  it("keeps textutil and cupsfilter on macOS", async () => {
    const { root, sourcePath } = await workspace();
    const { environment, calls } = fakeEnvironment({ platform: "darwin", tools: { zip: true, soffice: true } });
    const outputs = await exportTextDocument({
      sourcePath,
      outputDirectory: root,
      baseName: "statement",
      formats: ["docx", "pdf"],
      environment
    });
    expect(calls.map((call) => path.basename(call.command))).toEqual(["textutil", "cupsfilter"]);
    expect(calls[0]!.args).toContain("-convert");
    expect(calls[1]!.args).toEqual(["-i", "text/plain", "-m", "application/pdf", path.join(root, ".statement.txt")]);
    expect(outputs.map((item) => item.format)).toEqual(["docx", "pdf"]);
    await expect(fs.readFile(path.join(root, "statement.docx"), "utf8")).resolves.toContain("textutil");
  });

  it("falls back to LibreOffice when cupsfilter fails on macOS", async () => {
    const { root, sourcePath } = await workspace();
    const { environment, calls } = fakeEnvironment({
      platform: "darwin",
      tools: { zip: true, soffice: true },
      failing: ["cupsfilter"]
    });
    await exportTextDocument({
      sourcePath,
      outputDirectory: root,
      baseName: "statement",
      formats: ["pdf"],
      environment
    });
    expect(calls.map((call) => path.basename(call.command))).toEqual(["cupsfilter", "soffice"]);
    await expect(fs.readFile(path.join(root, "statement.pdf"), "utf8")).resolves.toContain("soffice");
  });

  it("surfaces the cupsfilter failure on macOS when LibreOffice is not installed", async () => {
    const { root, sourcePath } = await workspace();
    const { environment } = fakeEnvironment({
      platform: "darwin",
      tools: { zip: true, soffice: false },
      failing: ["cupsfilter"]
    });
    await expect(
      exportTextDocument({ sourcePath, outputDirectory: root, baseName: "statement", formats: ["pdf"], environment })
    ).rejects.toThrow(/cupsfilter failed/);
  });

  it("uses the packaged DOCX writer and LibreOffice off macOS", async () => {
    const { root, sourcePath } = await workspace();
    const { environment, calls } = fakeEnvironment({ platform: "linux", tools: { zip: true, soffice: true } });
    const outputs = await exportTextDocument({
      sourcePath,
      outputDirectory: root,
      baseName: "statement",
      formats: ["docx", "pdf"],
      environment
    });
    expect(calls.map((call) => path.basename(call.command))).toEqual(["zip", "soffice"]);
    expect(calls[0]!.command).toBe("/usr/local/bin/zip");
    expect(calls[0]!.cwd).toMatch(/\.docx-/);
    const soffice = calls[1]!;
    expect(soffice.args).toEqual(expect.arrayContaining(["--headless", "--convert-to", "pdf", "--outdir"]));
    expect(soffice.args[0]).toMatch(/^-env:UserInstallation=file:\/\//);
    // The HTML rendering is the intermediate, so headings and Chinese text survive the conversion.
    expect(soffice.args[soffice.args.length - 1]).toBe(path.join(root, ".statement.html"));
    expect(soffice.args[soffice.args.indexOf("--outdir") + 1]).toMatch(/\.pdf-/);
    expect(outputs.map((item) => item.path)).toEqual([
      path.join(root, "statement.docx"),
      path.join(root, "statement.pdf")
    ]);
    // Intermediate renderings and staging directories are cleaned up after a successful run.
    expect((await fs.readdir(root)).sort()).toEqual(["statement.docx", "statement.md", "statement.pdf"]);
  });

  it("asks the user to install LibreOffice when no PDF converter exists off macOS", async () => {
    const { root, sourcePath } = await workspace();
    const { environment, calls } = fakeEnvironment({ platform: "linux", tools: { zip: true, soffice: false } });
    await expect(
      exportTextDocument({ sourcePath, outputDirectory: root, baseName: "statement", formats: ["pdf"], environment })
    ).rejects.toThrow(MISSING_SOFFICE_MESSAGE);
    expect(MISSING_SOFFICE_MESSAGE).toContain("PDF 导出需要 LibreOffice");
    expect(MISSING_SOFFICE_MESSAGE).toContain("PDF export requires LibreOffice (soffice)");
    expect(calls).toEqual([]);
  });

  it("asks the user to install zip when the DOCX package cannot be written", async () => {
    const { root, sourcePath } = await workspace();
    const { environment, calls } = fakeEnvironment({ platform: "linux", tools: { zip: false, soffice: true } });
    await expect(
      exportTextDocument({ sourcePath, outputDirectory: root, baseName: "statement", formats: ["docx"], environment })
    ).rejects.toThrow(MISSING_ZIP_MESSAGE);
    expect(MISSING_ZIP_MESSAGE).toContain("DOCX 导出需要 zip 命令");
    expect(MISSING_ZIP_MESSAGE).toContain("DOCX export requires the `zip` command");
    // The failure happens before anything is staged or spawned.
    expect(calls).toEqual([]);
    expect((await fs.readdir(root)).sort()).toEqual(["statement.md"]);
  });
});
