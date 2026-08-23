import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { loadConfig } from "./config.js";
import { runDoctor, type DoctorCheck } from "./doctor.js";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
dotenv.config({ path: path.join(repositoryRoot, ".env"), quiet: true });

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code: string, text: string): string => (useColor ? `\u001b[${code}m${text}\u001b[0m` : text);
const english = (process.env.LANG ?? "").toLowerCase().startsWith("en");

function statusIcon(status: DoctorCheck["status"]): string {
  if (status === "ok") return paint("32", "✓");
  if (status === "warn") return paint("33", "!");
  return paint("31", "✗");
}

const config = loadConfig(process.env, repositoryRoot);
const report = await runDoctor(config, { probePorts: true, includeExternalTools: true });

for (const check of report.checks) {
  const label = english ? check.labelEn : check.label;
  const hint = english ? check.hintEn : check.hint;
  console.log(`${statusIcon(check.status)} ${label}${check.detail ? paint("2", ` — ${check.detail}`) : ""}`);
  if (hint && check.status !== "ok") console.log(`  ${paint("2", hint)}`);
}

const failed = report.checks.some((check) => check.status === "fail");
process.exit(failed ? 1 : 0);
