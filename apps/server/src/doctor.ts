import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { AppConfig } from "./config.js";
import { probeExternalTools, type ExternalToolStatus } from "./capability-probe.js";

export type DoctorStatus = "ok" | "warn" | "fail";

export interface DoctorCheck {
  id: string;
  status: DoctorStatus;
  label: string;
  labelEn: string;
  detail?: string;
  hint?: string;
  hintEn?: string;
}

export interface DoctorReport {
  generatedAt: string;
  checks: DoctorCheck[];
}

export interface DoctorExtras {
  feishuConfigured?: boolean;
  feishuConnected?: boolean;
  allowedOpenIdsCount?: number;
  probePorts?: boolean;
  includeExternalTools?: boolean;
  externalToolsOverride?: ExternalToolStatus[];
  webDistPresent?: boolean;
}

const TOOL_PURPOSE: Record<string, { zh: string; en: string }> = {
  uv: {
    zh: "Python 文档技能（PDF 转换、Markdown 提取）",
    en: "Python document skills (PDF conversion, Markdown extraction)"
  },
  python3: { zh: "docx/xlsx/pdf 办公技能脚本", en: "docx/xlsx/pdf office skill scripts" },
  dotnet: { zh: "docx-creator 技能", en: "the docx-creator skill" },
  soffice: { zh: "xlsx 公式重算与跨平台 PDF 导出", en: "xlsx recalculation and cross-platform PDF export" },
  tesseract: { zh: "扫描 PDF 的 OCR（可选）", en: "OCR for scanned PDFs (optional)" },
  zip: { zh: "DOCX 打包导出", en: "DOCX packaging during export" },
  textutil: { zh: "macOS 原生 DOCX 导出", en: "native DOCX export on macOS" },
  cupsfilter: { zh: "macOS 原生 PDF 导出", en: "native PDF export on macOS" }
};

function authSourceLabel(config: AppConfig): { zh: string; en: string } {
  switch (config.claudeAuthSource) {
    case "process-env":
      return { zh: "环境变量提供的令牌", en: "token from process environment" };
    case "user-settings":
      return { zh: "~/.claude/settings.json 中的令牌", en: "token from ~/.claude/settings.json" };
    case "oauth-credentials":
      return { zh: "本机 Claude 登录（OAuth 凭据）", en: "local Claude login (OAuth credentials)" };
    case "local-settings":
      return { zh: "网页保存的模型服务配置", en: "model service saved in the web UI" };
    default:
      return { zh: "未配置", en: "not configured" };
  }
}

function checkRuntime(config: AppConfig): DoctorCheck {
  const source = authSourceLabel(config);
  if (config.runtime === "demo") {
    return {
      id: "runtime",
      status: "warn",
      label: "运行时：演示模式（已显式指定）",
      labelEn: "Runtime: demo mode (explicitly selected)",
      hint: "将 AGENT_RUNTIME 设为 auto 并配置认证后可使用真实模型。",
      hintEn: "Set AGENT_RUNTIME=auto and configure credentials to use the real model."
    };
  }
  if (config.claudeAuthConfigured) {
    return {
      id: "runtime",
      status: "ok",
      label: `运行时：Claude（${source.zh}）`,
      labelEn: `Runtime: Claude (${source.en})`
    };
  }
  return {
    id: "runtime",
    status: "warn",
    label: "运行时：演示模式（未检测到 Claude 认证）",
    labelEn: "Runtime: demo mode (no Claude credentials detected)",
    hint: "在“个人工作区 → 模型服务”粘贴令牌，或在本机完成 claude 登录。",
    hintEn: "Paste a token in Workspace → Model service, or sign in with the Claude CLI on this machine."
  };
}

function checkSettingsMode(config: AppConfig): DoctorCheck {
  if (config.claudeSettingsMode === "inherit-user") {
    return {
      id: "settings-mode",
      status: "ok",
      label: "设置模式：沿用本机 Claude 配置（inherit-user）",
      labelEn: "Settings mode: inheriting local Claude configuration (inherit-user)",
      detail: config.claudeConfigDir
    };
  }
  return {
    id: "settings-mode",
    status: "ok",
    label: "设置模式：隔离（isolated）",
    labelEn: "Settings mode: isolated",
    detail: config.claudeConfigDir
  };
}

function checkDataDir(config: AppConfig): DoctorCheck {
  try {
    fs.mkdirSync(config.workspaceRoot, { recursive: true });
    const probe = path.join(config.workspaceRoot, `.doctor-${randomUUID()}`);
    fs.writeFileSync(probe, "ok");
    fs.rmSync(probe, { force: true });
    return {
      id: "data-dir",
      status: "ok",
      label: "数据目录可写",
      labelEn: "Data directory is writable",
      detail: path.dirname(config.workspaceRoot)
    };
  } catch (error) {
    return {
      id: "data-dir",
      status: "fail",
      label: "数据目录不可写",
      labelEn: "Data directory is not writable",
      detail: `${path.dirname(config.workspaceRoot)} — ${(error as Error).message}`,
      hint: "检查目录权限，或通过 FIELDNOTE_HOME 指定其他数据目录。",
      hintEn: "Check directory permissions, or point FIELDNOTE_HOME at a different data directory."
    };
  }
}

function checkDatabase(config: AppConfig): DoctorCheck {
  try {
    const stats = fs.statSync(config.databasePath);
    const sizeMb = (stats.size / (1024 * 1024)).toFixed(1);
    return {
      id: "database",
      status: "ok",
      label: `数据库已存在（${sizeMb} MB）`,
      labelEn: `Database present (${sizeMb} MB)`,
      detail: config.databasePath
    };
  } catch {
    return {
      id: "database",
      status: "ok",
      label: "数据库将在首次启动时创建",
      labelEn: "Database will be created on first start",
      detail: config.databasePath
    };
  }
}

async function probePort(port: number, host: string): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const socket = net.connect({ port, host, timeout: 800 });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    const fail = () => {
      socket.destroy();
      resolve(false);
    };
    socket.once("error", fail);
    socket.once("timeout", fail);
  });
}

async function checkPorts(config: AppConfig): Promise<DoctorCheck> {
  const apiInUse = await probePort(config.port, "127.0.0.1");
  if (apiInUse) {
    return {
      id: "ports",
      status: "ok",
      label: `端口 ${config.port} 已有服务在监听（可能是正在运行的 Fieldnote）`,
      labelEn: `Port ${config.port} is already serving (possibly a running Fieldnote)`
    };
  }
  return {
    id: "ports",
    status: "ok",
    label: `端口 ${config.port} 空闲`,
    labelEn: `Port ${config.port} is free`
  };
}

function checkFeishu(extras: DoctorExtras): DoctorCheck[] {
  if (extras.feishuConfigured === undefined) return [];
  if (!extras.feishuConfigured) {
    return [
      {
        id: "feishu",
        status: "ok",
        label: "飞书：未配置（可选）",
        labelEn: "Feishu: not configured (optional)"
      }
    ];
  }
  const checks: DoctorCheck[] = [
    extras.feishuConnected === false
      ? {
          id: "feishu",
          status: "warn",
          label: "飞书：已配置但长连接未建立",
          labelEn: "Feishu: configured but the long connection is down",
          hint: "查看“个人工作区 → 飞书”的连接状态与错误信息。",
          hintEn: "Check connection status and errors in Workspace → Feishu."
        }
      : {
          id: "feishu",
          status: "ok",
          label: "飞书：已配置",
          labelEn: "Feishu: configured"
        }
  ];
  if (extras.allowedOpenIdsCount === 0) {
    checks.push({
      id: "feishu-allowlist",
      status: "warn",
      label: "飞书允许列表为空：应用可用范围内的任何人都能使用此机器人，并共享同一份本机记忆",
      labelEn:
        "Feishu allowlist is empty: anyone within the app's availability can drive this bot and shares the same local memory",
      hint: "如需限制使用者，在“个人工作区 → 飞书”填入允许的 open_id。",
      hintEn: "To restrict access, add allowed open_ids in Workspace → Feishu."
    });
  }
  return checks;
}

function checkExternalTools(extras: DoctorExtras): DoctorCheck[] {
  const tools = extras.externalToolsOverride ?? probeExternalTools();
  return tools.map((tool) => {
    const purpose = TOOL_PURPOSE[tool.id] ?? { zh: "可选外部工具", en: "optional external tool" };
    if (tool.present) {
      return {
        id: `tool:${tool.id}`,
        status: "ok" as const,
        label: `外部工具 ${tool.id} 可用`,
        labelEn: `External tool ${tool.id} available`,
        detail: tool.version ?? tool.location ?? ""
      };
    }
    return {
      id: `tool:${tool.id}`,
      status: "warn" as const,
      label: `外部工具 ${tool.id} 未安装（影响：${purpose.zh}）`,
      labelEn: `External tool ${tool.id} missing (affects: ${purpose.en})`,
      hint: "对应的文档能力会不可用或降级；不影响其他功能。",
      hintEn: "The related document capabilities degrade or become unavailable; everything else keeps working."
    };
  });
}

export async function runDoctor(config: AppConfig, extras: DoctorExtras = {}): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  checks.push(checkRuntime(config));
  checks.push(checkSettingsMode(config));
  checks.push(checkDataDir(config));
  checks.push(checkDatabase(config));
  if (extras.probePorts) checks.push(await checkPorts(config));
  checks.push(...checkFeishu(extras));
  if (extras.includeExternalTools !== false) checks.push(...checkExternalTools(extras));
  return { generatedAt: new Date().toISOString(), checks };
}
