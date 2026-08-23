import { spawnSync } from "node:child_process";
import fs from "node:fs";

export interface ExternalToolStatus {
  id: string;
  present: boolean;
  version?: string;
  location?: string;
}

const PROBE_CACHE_MS = 5 * 60_000;

interface ToolSpec {
  id: string;
  command: string;
  versionArgs?: string[];
  platforms?: NodeJS.Platform[];
  extraPaths?: string[];
}

const TOOL_SPECS: ToolSpec[] = [
  { id: "uv", command: "uv", versionArgs: ["--version"] },
  { id: "python3", command: "python3", versionArgs: ["--version"] },
  { id: "dotnet", command: "dotnet", versionArgs: ["--version"] },
  {
    id: "soffice",
    command: "soffice",
    versionArgs: ["--version"],
    extraPaths: ["/Applications/LibreOffice.app/Contents/MacOS/soffice"]
  },
  { id: "tesseract", command: "tesseract", versionArgs: ["--version"] },
  { id: "zip", command: "zip", versionArgs: ["-v"] },
  { id: "textutil", command: "textutil", platforms: ["darwin"], extraPaths: ["/usr/bin/textutil"] },
  { id: "cupsfilter", command: "cupsfilter", platforms: ["darwin"], extraPaths: ["/usr/sbin/cupsfilter"] }
];

let cached: { at: number; tools: ExternalToolStatus[] } | undefined;

function locateOnPath(command: string): string | undefined {
  try {
    const finder = process.platform === "win32" ? "where" : "which";
    const result = spawnSync(finder, [command], { encoding: "utf8", timeout: 3_000 });
    if (result.status === 0) {
      const first = result.stdout.split(/\r?\n/).find((line) => line.trim().length > 0);
      return first?.trim();
    }
  } catch {
    // fall through
  }
  return undefined;
}

function readVersion(executable: string, args: string[]): string | undefined {
  try {
    const result = spawnSync(executable, args, { encoding: "utf8", timeout: 3_000 });
    if (result.status !== 0) return undefined;
    const line = `${result.stdout}\n${result.stderr}`.split(/\r?\n/).find((entry) => entry.trim().length > 0);
    return line?.trim().slice(0, 80);
  } catch {
    return undefined;
  }
}

function probeTool(spec: ToolSpec): ExternalToolStatus {
  let location = locateOnPath(spec.command);
  if (!location) {
    location = spec.extraPaths?.find((candidate) => {
      try {
        return fs.existsSync(candidate);
      } catch {
        return false;
      }
    });
  }
  if (!location) return { id: spec.id, present: false };
  const status: ExternalToolStatus = { id: spec.id, present: true, location };
  if (spec.versionArgs) {
    const version = readVersion(location, spec.versionArgs);
    if (version) status.version = version;
  }
  return status;
}

export function probeExternalTools(options: { force?: boolean } = {}): ExternalToolStatus[] {
  if (!options.force && cached && Date.now() - cached.at < PROBE_CACHE_MS) return cached.tools;
  const tools = TOOL_SPECS.filter((spec) => !spec.platforms || spec.platforms.includes(process.platform)).map(
    probeTool
  );
  cached = { at: Date.now(), tools };
  return tools;
}

export function resetExternalToolProbeCache(): void {
  cached = undefined;
}
