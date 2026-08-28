import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface BuildInfo {
  version: string;
  gitSha: string;
  gitDirty: boolean | null;
}

const unknownBuild: BuildInfo = {
  version: "unknown",
  gitSha: "unknown",
  gitDirty: null
};

/** Load metadata written next to the compiled server by the repository build. */
export function loadBuildInfo(): BuildInfo {
  const file = path.join(path.dirname(fileURLToPath(import.meta.url)), "build-info.json");
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<BuildInfo>;
    if (typeof parsed.version !== "string" || typeof parsed.gitSha !== "string") return unknownBuild;
    return {
      version: parsed.version,
      gitSha: parsed.gitSha,
      gitDirty: typeof parsed.gitDirty === "boolean" ? parsed.gitDirty : null
    };
  } catch {
    return unknownBuild;
  }
}
