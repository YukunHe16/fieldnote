import { AnimatePresence, motion } from "motion/react";
import { Children, isValidElement, useEffect, useRef, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { api, attachmentDownloadUrl, attachmentOpenUrl } from "../api";
import { getLocale, localeTag, t, useLocale } from "../i18n";
import { Icon } from "../icons";
import type {
  AssistantBlockDto,
  Attachment,
  ChatMessage,
  CollaborationTaskStatus,
  CollaborationTraceDto,
  ConversationDetail
} from "../types";
import type { Workspace } from "../useWorkspace";
import { ReplayBanner } from "./ReplayBanner";
import {
  isAskUserQuestionBlock,
  isConversationBusy,
  isLearningFrameworkBlock,
  isThinkingBlock,
  responseStatusLabel,
  shouldShowMessageStatus,
  shouldShowSyntheticStatus,
  shouldShowThinkingFold
} from "../responseStatus";
import { canConfirmLearningVerification } from "../learningPresentation";

function copyText(text: string) {
  return navigator.clipboard.writeText(text);
}

function usedSkillLabels(message: ChatMessage): string[] {
  if (message.skillReferences?.length) return message.skillReferences;
  const labels: string[] = [];
  const visit = (blocks: AssistantBlockDto[]) => {
    for (const block of blocks) {
      const kind = block.activity?.kind ?? block.type;
      if (kind === "skill") {
        const raw = block.activity?.displayName || block.title || block.name || "";
        const label = raw.replace(/^Skills\s*·\s*/u, "").trim();
        if (label && label !== "Skills") labels.push(label);
      }
      if (block.children?.length) visit(block.children);
    }
  };
  visit(message.blocks ?? []);
  return [...new Set(labels)];
}

async function shareMessage(message: ChatMessage, workspace: Workspace) {
  try {
    if (navigator.share) {
      await navigator.share({ text: message.content });
      return;
    }
    await copyText(message.content);
    workspace.toast(t("shareCopied"), "success");
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") return;
    workspace.toast(t("shareFailed"), "danger");
  }
}

function CodePre({ children }: { children?: ReactNode }) {
  const child = Children.toArray(children)[0];
  const text = isValidElement<{ children?: ReactNode }>(child)
    ? String(child.props.children ?? "").replace(/\n$/, "")
    : "";
  const className = isValidElement<{ className?: string }>(child) ? (child.props.className ?? "") : "";
  const language = className.replace("language-", "") || "code";
  const [copied, setCopied] = useState(false);
  return (
    <div className="code-block">
      <div className="code-toolbar">
        <span>{language}</span>
        <button
          onClick={() => {
            void copyText(text);
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1200);
          }}
        >
          <Icon name={copied ? "check" : "copy"} size={14} />
          {copied ? t("copied") : t("copy")}
        </button>
      </div>
      <pre>{children}</pre>
    </div>
  );
}

function MarkdownBody({ content }: { content: string }) {
  return (
    <div className="markdown-body">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          pre: ({ children }) => <CodePre>{children}</CodePre>,
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noreferrer">
              {children}
            </a>
          )
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

const friendlyIntegrations: Record<string, { zh: string; en: string }> = {
  "local-operator": { zh: "本地执行助手", en: "Local" },
  "lark-calendar": { zh: "飞书日历", en: "Feishu Calendar" },
  "lark-doc": { zh: "飞书文档", en: "Feishu Docs" },
  "lark-drive": { zh: "飞书云空间", en: "Feishu Drive" },
  "lark-mail": { zh: "飞书邮箱", en: "Feishu Mail" },
  "lark-task": { zh: "飞书任务", en: "Feishu Tasks" },
  websearch: { zh: "网页搜索", en: "Web search" },
  webfetch: { zh: "网页读取", en: "Web fetch" },
  browser: { zh: "网页浏览", en: "Browser" }
};

const toolActions: Record<string, { zh: string; en: string }> = {
  present_files: { zh: "分享文件", en: "Share files" },
  websearch: { zh: "检索网页", en: "Search the web" },
  webfetch: { zh: "读取网页", en: "Fetch a page" },
  read: { zh: "读取文件", en: "Read file" },
  write: { zh: "写入文件", en: "Write file" },
  edit: { zh: "编辑文件", en: "Edit file" },
  bash: { zh: "运行命令", en: "Run command" },
  glob: { zh: "查找文件", en: "Find files" },
  grep: { zh: "搜索文件内容", en: "Search file contents" },
  notebookedit: { zh: "编辑笔记本", en: "Edit notebook" }
};

type ActivityFamily = "search" | "fetch" | "skill" | "subagent" | "workspace" | "memory" | "generic";

export function friendlyIntegrationName(name = "", kind: AssistantBlockDto["type"] = "activity") {
  const normalized = name
    .toLowerCase()
    .replace(/^mcp__/, "")
    .replace(/__/g, " · ");
  if (normalized.includes("lark-calendar")) return t("integrationCalendar");
  if (normalized.includes("websearch")) return t("integrationSearch");
  if (normalized.includes("webfetch")) return t("integrationFetch");
  const known = Object.entries(friendlyIntegrations).find(([key]) => normalized.includes(key))?.[1];
  if (known) return known[getLocale()];
  if (kind === "subagent") return t("integrationCollaborate");
  if (kind === "skill") return t("integrationSkill");
  if (kind === "mcp") return t("integrationService");
  if (kind === "cron") return t("integrationSchedule");
  if (kind === "tool") return t("integrationTool");
  return t("integrationStep");
}

export function redactActivityInput(value: unknown) {
  if (value === undefined || value === null) return "";
  let text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  text = text.replace(/((?:token|secret|password|api[_-]?key)["'\s:=]+)[^\s,"'}]+/gi, "$1••••••");
  text = text.replace(/\/Users\/[^/\s]+/g, "~").replace(/[A-Z]:\\Users\\[^\\\s]+/gi, "~");
  return text.length > 900 ? `${text.slice(0, 900)}…` : text;
}

export function durationMs(block: AssistantBlockDto) {
  const duration =
    block.durationMs ??
    (block.startedAt && block.completedAt ? Date.parse(block.completedAt) - Date.parse(block.startedAt) : undefined);
  return duration !== undefined && Number.isFinite(duration) && duration >= 0 ? duration : undefined;
}

export function durationLabel(block: AssistantBlockDto) {
  const duration = durationMs(block);
  if (duration === undefined) return "";
  return formatDuration(duration);
}

export function formatDuration(duration: number) {
  return duration < 1_000
    ? t("ms", { value: Math.round(duration) })
    : t("sec", { value: (duration / 1_000).toFixed(duration < 10_000 ? 1 : 0) });
}

export function compactDuration(duration: number) {
  return duration < 1_000
    ? t("msCompact", { value: Math.round(duration) })
    : t("secCompact", { value: (duration / 1_000).toFixed(duration < 10_000 ? 1 : 0) });
}

export function isTechnicalDump(value?: string) {
  const text = value?.trim() ?? "";
  return !text || text.startsWith("{") || text.startsWith("[") || /"type"\s*:\s*"text"/.test(text);
}

export function parseActivityValue(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return value;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return value;
  }
}

export function collectActivityUrls(value: unknown, found = new Set<string>()): string[] {
  const parsed = parseActivityValue(value);
  if (typeof parsed === "string") {
    for (const match of parsed.matchAll(/https?:\/\/[^\s"'<>\\]+/gi)) {
      found.add(match[0].replace(/[),.;]+$/g, ""));
    }
  } else if (Array.isArray(parsed)) {
    parsed.forEach((item) => collectActivityUrls(item, found));
  } else if (parsed && typeof parsed === "object") {
    Object.values(parsed).forEach((item) => collectActivityUrls(item, found));
  }
  return [...found];
}

export function activityToolKey(block: AssistantBlockDto) {
  return (block.technicalName ?? block.name ?? "").split("__").filter(Boolean).at(-1)?.toLowerCase() ?? "";
}

export function activityFamily(block: AssistantBlockDto): ActivityFamily {
  const hay = `${block.title ?? ""} ${block.technicalName ?? ""} ${block.name ?? ""}`.toLowerCase();
  if (hay.includes("websearch") || hay.includes("网页搜索")) return "search";
  if (hay.includes("webfetch") || hay.includes("网页读取")) return "fetch";
  if (hay.includes("memory")) return "memory";
  if (block.type === "skill") return "skill";
  if (block.type === "subagent") return "subagent";
  if (
    hay.includes("read") ||
    hay.includes("write") ||
    hay.includes("edit") ||
    hay.includes("bash") ||
    hay.includes("glob") ||
    hay.includes("grep") ||
    hay.includes("工作区")
  )
    return "workspace";
  return "generic";
}

export function activityStepTitle(block: AssistantBlockDto) {
  const action = toolActions[activityToolKey(block)];
  if (action) return action[getLocale()];
  if (block.title && block.title !== "Workspace" && block.title !== "工作区") return block.title;
  return friendlyIntegrationName(block.technicalName || block.name, block.type);
}

export function activityStepDetail(block: AssistantBlockDto) {
  const input = parseActivityValue(block.input ?? block.inputSummary);
  if (input && typeof input === "object" && !Array.isArray(input)) {
    const record = input as Record<string, unknown>;
    if (typeof record.query === "string" && record.query.trim()) return record.query.trim();
    if (typeof record.command === "string" && record.command.trim()) return record.command.trim();
    const filePath =
      typeof record.file_path === "string"
        ? record.file_path
        : typeof record.path === "string"
          ? record.path
          : typeof record.filePath === "string"
            ? record.filePath
            : "";
    if (filePath) return filePath.split(/[\\/]/).at(-1) || filePath;
    if (typeof record.pattern === "string" && record.pattern.trim()) return record.pattern.trim();
    if (typeof record.url === "string") return hostnameLabel(record.url);
    if (typeof record.label === "string") return record.label;
    if (typeof record.title === "string") return record.title;
  }
  const urls = collectActivityUrls(block.input ?? block.inputSummary);
  return urls[0] ? hostnameLabel(urls[0]) : "";
}

export function activityPills(block: AssistantBlockDto) {
  const input = parseActivityValue(block.input ?? block.inputSummary);
  const pills: string[] = [];
  if (input && typeof input === "object" && !Array.isArray(input)) {
    const record = input as Record<string, unknown>;
    const domains = record.domains;
    if (Array.isArray(domains)) {
      for (const domain of domains) {
        const host = typeof domain === "string" ? domain.replace(/^www\./, "") : "";
        if (host && !pills.includes(host)) pills.push(host);
      }
    }
  }
  for (const url of collectActivityUrls(block.input ?? block.inputSummary)) {
    const host = hostnameLabel(url);
    if (host && !pills.includes(host)) pills.push(host);
  }
  return pills;
}

const factLabels: Record<string, { zh: string; en: string }> = {
  query: { zh: "查询", en: "Query" },
  domains: { zh: "范围", en: "Scope" },
  url: { zh: "页面", en: "Page" },
  title: { zh: "标题", en: "Title" },
  status: { zh: "状态", en: "Status" }
};

export function activityDetailFacts(block: AssistantBlockDto) {
  const input = parseActivityValue(block.input ?? block.inputSummary);
  if (!input || typeof input !== "object" || Array.isArray(input)) return [];
  const shown = new Set(
    [activityStepDetail(block), ...activityPills(block)].filter(Boolean).map((value) => value.toLowerCase())
  );
  const facts: Array<{ label: string; value: string }> = [];
  for (const [key, raw] of Object.entries(input as Record<string, unknown>)) {
    if (!factLabels[key] || raw === undefined || raw === null || raw === "") continue;
    if (/id$/i.test(key) || /^[0-9a-f-]{36}$/i.test(String(raw))) continue;
    const value = Array.isArray(raw)
      ? raw
          .map((item) => (typeof item === "string" ? item : ""))
          .filter(Boolean)
          .join(getLocale() === "en" ? ", " : "、")
      : typeof raw === "string" || typeof raw === "number" || typeof raw === "boolean"
        ? String(raw)
        : "";
    if (!value || shown.has(value.toLowerCase())) continue;
    facts.push({ label: factLabels[key][getLocale()], value });
  }
  return facts;
}

export function groupAssistantBlocks(blocks: AssistantBlockDto[]) {
  const groups: Array<
    | { type: "text"; block: AssistantBlockDto }
    | { type: "thinking"; block: AssistantBlockDto }
    | { type: "activity"; blocks: AssistantBlockDto[] }
  > = [];
  for (const block of blocks) {
    if (isThinkingBlock(block)) {
      groups.push({ type: "thinking", block });
      continue;
    }
    if (block.type === "text") {
      groups.push({ type: "text", block });
      continue;
    }
    const last = groups.at(-1);
    if (last?.type === "activity") last.blocks.push(block);
    else groups.push({ type: "activity", blocks: [block] });
  }
  return groups;
}

export function clipActivityText(value: string, max = 28) {
  const text = value.replace(/\s+/g, " ").trim();
  if ([...text].length <= max) return text;
  return `${[...text].slice(0, max).join("").trimEnd()}…`;
}

export function activityPreviewText(blocks: AssistantBlockDto[]) {
  const subjects = [...new Set(flattenActivityBlocks(blocks).map(activityStepDetail).filter(Boolean))];
  return {
    brief: subjects
      .slice(0, 2)
      .map((item) => clipActivityText(item))
      .join(" · "),
    full: subjects.join(getLocale() === "en" ? ", " : " · ")
  };
}

export function activityHeadline(blocks: AssistantBlockDto[]) {
  const running = blocks.some((block) => block.status === "running" || block.status === "queued");
  const failed = blocks.some((block) => block.status === "failed" || block.status === "interrupted");
  const families = [...new Set(flattenActivityBlocks(blocks).map(activityFamily))];
  const family = running
    ? activityFamily(blocks.find((block) => block.status === "running" || block.status === "queued") ?? blocks[0])
    : families.length === 1
      ? families[0]
      : "generic";
  const searches = flattenActivityBlocks(blocks).filter(
    (block) => activityFamily(block) === "search" || activityFamily(block) === "fetch"
  );
  const urls = flattenActivityBlocks(blocks).flatMap((block) => collectActivityUrls(block.input ?? block.inputSummary));
  const searchCount = Math.max(urls.length, searches.length);
  const duration = activityGroupDuration(blocks);
  const titles = [...new Set(flattenActivityBlocks(blocks).map(activityStepTitle).filter(Boolean))];
  if (failed && !running) {
    if (titles.length === 1) return `${titles[0]} · ${t("activityIncomplete")}`;
    if (titles.length > 1) return `${titles.slice(0, 2).join(" · ")} · ${t("activityIncomplete")}`;
    return t("activityIncomplete");
  }
  if (running) {
    if (family === "search")
      return searchCount > 1 ? t("activitySearchMany", { count: searchCount }) : t("activitySearchOne");
    if (family === "fetch") return t("activityFetchRun");
    if (family === "workspace") return titles[0] ? titles.slice(0, 2).join(" · ") : t("activityWorkspaceRun");
    if (family === "memory") return t("activityMemoryRun");
    if (family === "skill") return t("activitySkillRun");
    if (family === "subagent") return t("activitySubagentRun");
    return t("activityToolRun");
  }
  if (family === "search")
    return searchCount > 0 ? t("activitySearchDoneMany", { count: searchCount }) : t("activitySearchDone");
  if (family === "fetch") return t("activityFetchDone");
  if (family === "workspace") {
    const label = titles.slice(0, 2).join(" · ") || t("activityWorkspaceDone");
    return duration ? `${label} · ${compactDuration(duration)}` : label;
  }
  if (family === "memory") return t("activityMemoryDone");
  if (family === "skill") return t("activitySkillDone");
  if (family === "subagent") return t("activitySubagentDone");
  return duration ? t("activityGenericDoneFor", { duration: compactDuration(duration) }) : t("activityGenericDone");
}

function flattenActivityBlocks(blocks: AssistantBlockDto[]): AssistantBlockDto[] {
  return blocks.flatMap((block) => [block, ...flattenActivityBlocks(block.children)]);
}

function activityGroupDuration(blocks: AssistantBlockDto[]) {
  const started = blocks
    .map((block) => (block.startedAt ? Date.parse(block.startedAt) : Number.NaN))
    .filter(Number.isFinite);
  const completed = blocks
    .map((block) => (block.completedAt ? Date.parse(block.completedAt) : Number.NaN))
    .filter(Number.isFinite);
  if (!started.length)
    return flattenActivityBlocks(blocks)
      .map(durationMs)
      .find((value) => value !== undefined);
  if (!completed.length) return undefined;
  return Math.max(...completed) - Math.min(...started);
}

function hostnameLabel(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function activityGlyph(
  block: AssistantBlockDto
): "globe" | "search" | "file" | "activity" | "clock" | "memory" | "check" | "warning" {
  if (block.status === "failed" || block.status === "interrupted") return "warning";
  const family = activityFamily(block);
  if (family === "search" || family === "fetch") return "globe";
  if (family === "workspace") return "file";
  if (block.type === "cron") return "clock";
  if (family === "memory") return "memory";
  if (family === "skill" || family === "subagent") return "activity";
  if (block.status === "completed") return "check";
  return "search";
}

export function collapseExactRepeatedHalf(value: string) {
  if (value.length < 40 || value.length % 2 !== 0) return value;
  const half = value.length / 2;
  const first = value.slice(0, half);
  return first === value.slice(half) ? first : value;
}

export function ActivityBlock({
  block,
  depth = 0,
  defaultExpanded = false
}: {
  block: AssistantBlockDto;
  depth?: number;
  defaultExpanded?: boolean;
}) {
  if (block.type === "text") {
    const content = collapseExactRepeatedHalf(block.text ?? block.content ?? "");
    return content ? <MarkdownBody content={content} /> : null;
  }
  if (depth === 0) return <ActivityRun blocks={[block]} defaultExpanded={defaultExpanded} />;
  return <ActivityStep block={block} />;
}

export function ActivityRun({
  blocks,
  defaultExpanded = false
}: {
  blocks: AssistantBlockDto[];
  defaultExpanded?: boolean;
}) {
  const running = blocks.some((block) => block.status === "running" || block.status === "queued");
  const failed = blocks.some((block) => block.status === "failed" || block.status === "interrupted");
  const [expanded, setExpanded] = useState(defaultExpanded);
  const headline = activityHeadline(blocks);
  const duration = activityGroupDuration(blocks);
  const panelId = `activity-run-${blocks[0]?.id ?? "group"}`;
  const preview = activityPreviewText(blocks);
  return (
    <motion.section
      className={`activity-run${running ? " is-live" : ""}${failed ? " is-failed" : ""}`}
      initial={{ opacity: 0, y: 3 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ type: "spring", bounce: 0, duration: 0.28 }}
    >
      <button
        className={`activity-trigger${running ? " is-live" : ""}${expanded ? " is-open" : ""}`}
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
        aria-controls={panelId}
        title={preview.full || undefined}
      >
        <span>{headline}</span>
        {!expanded && preview.brief && <small className="activity-preview">{preview.brief}</small>}
        <Icon name="chevronRight" size={13} />
      </button>
      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            id={panelId}
            className="activity-panel"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ type: "spring", bounce: 0, duration: 0.28 }}
          >
            <p className="activity-phase">
              {running
                ? "Thinking"
                : failed
                  ? t("activityIncomplete")
                  : duration !== undefined
                    ? t("activityPhaseFor", { duration: compactDuration(duration) })
                    : t("activityPhase")}
            </p>
            <ol className="activity-timeline">
              {blocks.map((block) => (
                <ActivityStep key={block.id} block={block} />
              ))}
            </ol>
            <p className="activity-foot">
              {running
                ? headline
                : failed
                  ? t("activityIncomplete")
                  : duration !== undefined
                    ? t("processedFor", { duration: compactDuration(duration) })
                    : t("done")}
            </p>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.section>
  );
}

function ActivityStep({ block }: { block: AssistantBlockDto }) {
  const running = block.status === "running" || block.status === "queued";
  const pills = activityPills(block);
  const overflow = Math.max(0, pills.length - 4);
  const visiblePills = pills.slice(0, 4);
  const detail = activityStepDetail(block);
  const facts = activityDetailFacts(block);
  const prose = !isTechnicalDump(block.text) ? block.text : "";
  const glyph = activityGlyph(block);
  return (
    <li className={`activity-step status-${block.status}`}>
      <span className="activity-glyph" aria-hidden="true">
        {running ? <i /> : <Icon name={glyph} size={13} />}
      </span>
      <div>
        <b>{activityStepTitle(block)}</b>
        {detail && <small>{detail}</small>}
        {visiblePills.length > 0 && (
          <div className="activity-pills">
            {visiblePills.map((pill) => (
              <span key={pill}>
                {activityFamily(block) === "search" || activityFamily(block) === "fetch" ? (
                  <Icon name="globe" size={10} />
                ) : null}
                {pill}
              </span>
            ))}
            {overflow > 0 && <span>{t("moreCount", { count: overflow })}</span>}
          </div>
        )}
        {facts.length > 0 && (
          <dl className="activity-facts">
            {facts.map((fact) => (
              <div key={fact.label}>
                <dt>{fact.label}</dt>
                <dd>{fact.value}</dd>
              </div>
            ))}
          </dl>
        )}
        {prose && (
          <div className="activity-stream-text">
            <MarkdownBody content={prose} />
          </div>
        )}
        {block.error && <p className="activity-error">{block.error}</p>}
        {block.children.length > 0 && (
          <ol className="activity-timeline nested">
            {block.children.map((child) => (
              <ActivityStep key={child.id} block={child} />
            ))}
          </ol>
        )}
      </div>
    </li>
  );
}

function ThinkingFold({ id, tokens, live }: { id: string; tokens: string; live: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const panelId = `thinking-${id}`;
  return (
    <motion.section
      className={`thinking-fold${live ? " is-live" : ""}`}
      initial={{ opacity: 0, y: 3 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ type: "spring", bounce: 0, duration: 0.28 }}
    >
      <button
        className={`activity-trigger${live ? " is-live" : ""}${expanded ? " is-open" : ""}`}
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
        aria-controls={panelId}
      >
        <span>{live ? "Thinking" : t("thinkingDone")}</span>
        <Icon name="chevronRight" size={13} />
      </button>
      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            id={panelId}
            className="thinking-panel"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ type: "spring", bounce: 0, duration: 0.28 }}
          >
            {tokens ? (
              <pre className="thinking-tokens">{collapseExactRepeatedHalf(tokens)}</pre>
            ) : (
              <p className="thinking-empty">{live ? t("thinkingLive") : t("thinkingEmpty")}</p>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </motion.section>
  );
}

function AssistantContent({
  message,
  runState,
  waitingForUser
}: {
  message: ChatMessage;
  runState?: ConversationDetail["runState"];
  waitingForUser?: boolean;
}) {
  const blocks = coalesceAdjacentTextBlocks(
    (message.blocks ?? []).filter((block) => !isAskUserQuestionBlock(block) && !isLearningFrameworkBlock(block))
  );
  const groups = groupAssistantBlocks(blocks);
  const hasTextBlock = blocks.some((block) => block.type === "text");
  const live = message.status === "streaming" && isConversationBusy(runState) && !waitingForUser;
  return (
    <>
      {shouldShowThinkingFold(message, runState, waitingForUser) && (
        <ThinkingFold id={message.id} tokens={message.reasoningSummary?.trim() ?? ""} live={live} />
      )}
      {!hasTextBlock && message.content ? <MarkdownBody content={collapseExactRepeatedHalf(message.content)} /> : null}
      {groups.map((group) => {
        if (group.type === "text") return <ActivityBlock key={group.block.id} block={group.block} />;
        if (group.type === "thinking") {
          const tokens = collapseExactRepeatedHalf((group.block.text ?? group.block.content ?? "").trim());
          const thinkingLive = live && (group.block.status === "running" || group.block.status === "queued");
          if (waitingForUser && (thinkingLive || !tokens)) return null;
          return <ThinkingFold key={group.block.id} id={group.block.id} tokens={tokens} live={thinkingLive} />;
        }
        return <ActivityRun key={group.blocks[0]?.id} blocks={group.blocks} />;
      })}
    </>
  );
}

export function hasCollaborationTrace(trace?: CollaborationTraceDto | null): trace is CollaborationTraceDto {
  return Boolean(trace && (trace.tasks.length || trace.handoffs.length));
}

export function visibleCollaborationText(value?: string | null): string {
  return (value ?? "")
    .replace(/(?:\/Users|\/home|\/private\/var)\/[^\s,;:)}\]]+/giu, "~")
    .replace(/[A-Z]:\\(?:Users|home)\\[^\s,;:)}\]]+/giu, "~")
    .replace(/\s+/gu, " ")
    .trim();
}

function collaborationStatusLabel(status: CollaborationTaskStatus): string {
  if (status === "running") return t("collaborationRunning");
  if (status === "completed") return t("collaborationCompleted");
  if (status === "failed") return t("collaborationFailed");
  if (status === "interrupted") return t("collaborationInterrupted");
  return t("collaborationQueued");
}

function collaborationFindingLabel(status: "verified" | "conflicting" | "unresolved"): string {
  if (status === "verified") return t("collaborationVerified");
  if (status === "conflicting") return t("collaborationConflicting");
  return t("collaborationUnresolved");
}

function safeCollaborationUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function CollaborationTrace({ trace }: { trace: CollaborationTraceDto }) {
  const taskById = new Map(trace.tasks.map((task) => [task.id, task]));
  const metric = (label: string, count: number, kind: string) => (
    <span className={`collaboration-metric ${kind}`} key={kind}>
      <b>{count}</b>
      {label}
    </span>
  );
  return (
    <details className="collaboration-trace">
      <summary>
        <span className="collaboration-trace-heading">
          <span className="collaboration-trace-dot" aria-hidden="true" />
          {t("collaborationTitle")}
        </span>
        <span className="collaboration-trace-summary">
          {t("collaborationSpecialists", { count: trace.summary.specialistCount })}
        </span>
      </summary>
      <div className="collaboration-trace-body">
        <div className="collaboration-metrics" aria-label={t("collaborationSummary")}>
          {metric(t("collaborationSpecialistMetric"), trace.summary.specialistCount, "specialists")}
          {metric(t("collaborationVerified"), trace.summary.verifiedCount, "verified")}
          {metric(t("collaborationConflicting"), trace.summary.conflictingCount, "conflicting")}
          {metric(t("collaborationUnresolved"), trace.summary.unresolvedCount, "unresolved")}
          {metric(t("collaborationSources"), trace.summary.sourceCount, "sources")}
        </div>
        {trace.summary.importantNotice && (
          <p className="collaboration-notice">{visibleCollaborationText(trace.summary.importantNotice)}</p>
        )}
        {trace.tasks.map((task) => (
          <article className="collaboration-task" key={task.id}>
            <header>
              <div>
                <small>{t("collaborationTask")}</small>
                <b>{visibleCollaborationText(task.displayName) || visibleCollaborationText(task.specialistId)}</b>
              </div>
              <span className={`collaboration-status state-${task.status}`}>
                {collaborationStatusLabel(task.status)}
              </span>
            </header>
            {task.requestSummary && (
              <p className="collaboration-request">
                <small>{t("collaborationRequest")}</small>
                {visibleCollaborationText(task.requestSummary)}
              </p>
            )}
            {(task.resultSummary || task.result?.summary) && (
              <p className="collaboration-result">
                <small>{t("collaborationResult")}</small>
                {visibleCollaborationText(task.resultSummary || task.result?.summary)}
              </p>
            )}
            {task.result?.findings.length ? (
              <section className="collaboration-findings">
                <h4>{t("collaborationFindings")}</h4>
                {task.result.findings.map((finding, index) => (
                  <div className="collaboration-finding" key={`${task.id}-${index}`}>
                    <span className={`collaboration-status state-${finding.status}`}>
                      {collaborationFindingLabel(finding.status)}
                    </span>
                    <p>{visibleCollaborationText(finding.claim)}</p>
                    {finding.sourceUrls.map((source) => {
                      const href = safeCollaborationUrl(source);
                      return href ? (
                        <a key={href} href={href} target="_blank" rel="noreferrer noopener">
                          {hostnameLabel(href)}
                        </a>
                      ) : null;
                    })}
                  </div>
                ))}
              </section>
            ) : null}
            {task.result?.openQuestions.length ? (
              <section className="collaboration-questions">
                <h4>{t("collaborationOpenQuestions")}</h4>
                <ul>
                  {task.result.openQuestions.map((question, index) => (
                    <li key={`${task.id}-open-${index}`}>{visibleCollaborationText(question)}</li>
                  ))}
                </ul>
              </section>
            ) : null}
            {task.result?.recommendedFollowups.length ? (
              <section className="collaboration-followups">
                <h4>{t("collaborationRecommendedFollowups")}</h4>
                <ul>
                  {task.result.recommendedFollowups.map((followup, index) => (
                    <li key={`${task.id}-follow-${index}`}>
                      <b>{visibleCollaborationText(followup.specialistId)}</b>
                      {visibleCollaborationText(followup.question)}
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
            {task.error && <p className="collaboration-error">{visibleCollaborationText(task.error)}</p>}
          </article>
        ))}
        {trace.handoffs.length ? (
          <section className="collaboration-handoffs">
            <h4>{t("collaborationHandoffs")}</h4>
            {trace.handoffs.map((handoff) => {
              const source = taskById.get(handoff.sourceTaskId);
              const target = taskById.get(handoff.targetTaskId);
              const chain = `${visibleCollaborationText(source?.displayName || source?.specialistId || handoff.sourceTaskId)} → ${visibleCollaborationText(target?.displayName || target?.specialistId || handoff.targetTaskId)}`;
              return (
                <article key={handoff.id}>
                  <header>
                    <b>{chain}</b>
                    <span className={`collaboration-status state-${handoff.status}`}>
                      {collaborationStatusLabel(handoff.status)}
                    </span>
                  </header>
                  {handoff.question && <p>{visibleCollaborationText(handoff.question)}</p>}
                  {handoff.error && <p className="collaboration-error">{visibleCollaborationText(handoff.error)}</p>}
                </article>
              );
            })}
          </section>
        ) : null}
      </div>
    </details>
  );
}

export function coalesceAdjacentTextBlocks(blocks: AssistantBlockDto[]): AssistantBlockDto[] {
  const result: AssistantBlockDto[] = [];
  for (const original of blocks) {
    const block = { ...original, children: coalesceAdjacentTextBlocks(original.children) };
    const previous = result.at(-1);
    if (previous?.type === "text" && block.type === "text" && previous.owner === block.owner) {
      const content = `${previous.text ?? previous.content ?? ""}${block.text ?? block.content ?? ""}`;
      result[result.length - 1] = { ...previous, content, text: content, status: block.status };
    } else {
      result.push(block);
    }
  }
  return result;
}

function fileSizeLabel(size?: number) {
  if (!size || size < 0) return t("file");
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

export function visibleMessageAttachments(message: ChatMessage) {
  const items = message.attachments ?? [];
  if (message.role !== "assistant") return items;
  return items.filter((item) => item.presented !== false);
}

function AttachmentList({ message }: { message: ChatMessage }) {
  const attachments = visibleMessageAttachments(message);
  if (!attachments.length) return null;
  const generated = message.role === "assistant";
  return (
    <div className={generated ? "generated-files" : "message-attachments"}>
      {attachments.map((item) =>
        generated ? (
          <GeneratedFileCard key={item.id} item={item} />
        ) : (
          <div key={item.id}>
            <span>
              <Icon name="file" />
            </span>
            <span>
              <b>{item.name}</b>
              <small>{item.type || fileSizeLabel(item.size)}</small>
            </span>
          </div>
        )
      )}
    </div>
  );
}

function GeneratedFileCard({ item }: { item: Attachment }) {
  const openUrl = item.url || attachmentOpenUrl(item.id);
  const downloadUrl = attachmentDownloadUrl(item.id);
  return (
    <div className="generated-file">
      <span>
        <Icon name="file" />
      </span>
      <span>
        <b>{item.name}</b>
        <small>{fileSizeLabel(item.size)}</small>
      </span>
      <div>
        <a href={openUrl} target="_blank" rel="noreferrer">
          {t("open")}
        </a>
        <a href={downloadUrl} download={item.name}>
          {t("download")}
        </a>
      </div>
    </div>
  );
}

function MessageActions({
  message,
  workspace,
  onEdit,
  onRetry,
  onReplay
}: {
  message: ChatMessage;
  workspace: Workspace;
  onEdit: () => void;
  onRetry: () => void;
  onReplay: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [rating, setRating] = useState<"up" | "down" | null>(message.rating ?? null);
  const [reasonOpen, setReasonOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [defaultInstruction, setDefaultInstruction] = useState("");
  const [saving, setSaving] = useState(false);
  const user = message.role === "user";
  const playbooks = message.playbookReferences ?? [];
  const skills = usedSkillLabels(message);

  useEffect(() => {
    setRating(message.rating ?? null);
  }, [message.rating]);

  function copy() {
    void copyText(message.content)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1200);
      })
      .catch(() => workspace.toast(t("copyFailed"), "danger"));
  }

  async function rate(polarity: "up" | "down", nextReason?: string) {
    if (saving) return;
    setSaving(true);
    const previous = rating;
    setRating(polarity);
    try {
      await api.createSignal({
        kind: "thumb",
        polarity,
        ...(nextReason?.trim() ? { reason: nextReason.trim() } : {}),
        conversationId: workspace.conversation?.id,
        messageId: message.id,
        runId: message.runId
      });
      if (polarity === "down") setReasonOpen(false);
      if (polarity === "up") setConfirmOpen(true);
    } catch {
      setRating(previous);
      workspace.toast(t("ratingFailed"), "danger");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="message-actions-wrap">
      <div className="message-actions" aria-label={t("messageActions")}>
        <button
          onClick={copy}
          aria-label={copied ? t("copied") : t("copyMessage")}
          title={copied ? t("copied") : t("copy")}
        >
          <Icon name={copied ? "check" : "copy"} size={16} />
        </button>
        {user ? (
          <>
            <button
              onClick={() => void shareMessage(message, workspace)}
              aria-label={t("shareMessage")}
              title={t("shareMessage")}
            >
              <Icon name="share" size={16} />
            </button>
            <button onClick={onEdit} aria-label={t("editMessage")} title={t("edit")}>
              <Icon name="edit" size={16} />
            </button>
          </>
        ) : (
          <>
            <button
              className={rating === "up" ? "is-active" : ""}
              onClick={() => void rate("up")}
              aria-pressed={rating === "up"}
              aria-label={t("helpful")}
              title={t("helpful")}
              disabled={saving}
            >
              <Icon name="thumbUp" size={16} />
            </button>
            <button
              className={rating === "down" ? "is-active" : ""}
              onClick={() => {
                setRating("down");
                setReasonOpen(true);
              }}
              aria-pressed={rating === "down"}
              aria-label={t("notHelpful")}
              title={t("notHelpful")}
              disabled={saving}
            >
              <Icon name="thumbDown" size={16} />
            </button>
            <button
              onClick={() => void shareMessage(message, workspace)}
              aria-label={t("shareMessage")}
              title={t("shareMessage")}
            >
              <Icon name="share" size={16} />
            </button>
            <button onClick={onRetry} aria-label={t("regenerate")} title={t("regenerate")}>
              <Icon name="retry" size={16} />
            </button>
            {message.runId && (
              <button onClick={onReplay} aria-label={t("replayRun")} title={t("replayRun")}>
                <Icon name="replay" size={16} />
              </button>
            )}
          </>
        )}
      </div>
      {reasonOpen && (
        <form
          className="message-rating-reason"
          onSubmit={(event) => {
            event.preventDefault();
            void rate("down", reason);
          }}
        >
          <input
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder={t("feedbackPlaceholder")}
            maxLength={200}
            autoFocus
          />
          <button type="submit" disabled={saving}>
            {t("noteIt")}
          </button>
          <button
            type="button"
            onClick={() => {
              setReasonOpen(false);
              void rate("down");
            }}
          >
            {t("skip")}
          </button>
        </form>
      )}
      {confirmOpen && (
        <form
          className="message-rating-reason"
          onSubmit={(event) => {
            event.preventDefault();
            const instruction = defaultInstruction.trim();
            if (!instruction) {
              setConfirmOpen(false);
              return;
            }
            void api
              .createSignal({
                kind: "thumb",
                polarity: "up",
                conversationId: workspace.conversation?.id,
                messageId: message.id,
                runId: message.runId,
                confirmAsPlaybook: true,
                playbookInstruction: instruction
              })
              .then(() => {
                setConfirmOpen(false);
                workspace.toast(t("playbookNoted"), "success");
              })
              .catch(() => workspace.toast(t("handbookWriteFailed"), "danger"));
          }}
        >
          <input
            value={defaultInstruction}
            onChange={(event) => setDefaultInstruction(event.target.value)}
            placeholder={t("saveAsDefaultPlaceholder")}
            maxLength={200}
          />
          <button type="submit" disabled={saving || !defaultInstruction.trim()}>
            {t("noteIt")}
          </button>
          <button type="button" onClick={() => setConfirmOpen(false)}>
            {t("unused")}
          </button>
        </form>
      )}
      {skills.length > 0 && <p className="message-playbooks">{t("thisRoundUsed", { titles: skills.join(" · ") })}</p>}
      {playbooks.length > 0 && (
        <p className="message-playbooks">
          {t("thisRoundHandbook", { titles: playbooks.map((item) => item.title).join(" · ") })}
        </p>
      )}
    </div>
  );
}

function MemoryReferences({ message, workspace }: { message: ChatMessage; workspace: Workspace }) {
  const [open, setOpen] = useState(false);
  const references = message.memoryReferences ?? [];
  if (!references.length) return null;
  return (
    <div className="memory-references">
      <button
        className="memory-reference-trigger"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-controls={`memory-references-${message.id}`}
      >
        <Icon name="memory" size={14} />
        {t("referencedMemories", { count: references.length })}
        <Icon name="chevronRight" size={13} className={open ? "is-open" : ""} />
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            id={`memory-references-${message.id}`}
            className="memory-reference-list"
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -3 }}
            transition={{ type: "spring", bounce: 0, duration: 0.22 }}
          >
            {references.map((reference) => {
              const source = reference.source;
              const canOpen = Boolean(source?.conversationId && !source.sourceDeleted);
              return (
                <article key={`${reference.memoryId}-${source?.id ?? "saved"}`}>
                  <div>
                    <b>{reference.title}</b>
                    <span>{reference.content}</span>
                  </div>
                  <button
                    disabled={!canOpen}
                    onClick={() => {
                      if (source?.conversationId) workspace.setSelectedId(source.conversationId);
                    }}
                  >
                    {source ? (source.sourceDeleted ? t("sourceDeleted") : source.conversationTitle) : t("savedMemory")}
                    {source?.createdAt && (
                      <time dateTime={source.createdAt}>
                        {new Date(source.createdAt).toLocaleDateString(localeTag(), { month: "short", day: "numeric" })}
                      </time>
                    )}
                    {canOpen && <Icon name="chevronRight" size={13} />}
                  </button>
                </article>
              );
            })}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function ResponseStatus({ state }: { state: ConversationDetail["runState"] }) {
  const { t } = useLocale();
  return (
    <div className="response-status" role="status">
      <span>{t(responseStatusLabel(state))}</span>
    </div>
  );
}

type RewriteAction = { type: "edit"; content: string } | { type: "retry" };

function RewriteConfirmationDialog({
  action,
  trailingMessages,
  onCancel,
  onConfirm
}: {
  action?: RewriteAction;
  trailingMessages: number;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  if (!action) return null;
  const isEdit = action.type === "edit";
  const subject = isEdit ? t("rewriteEditTitle") : t("rewriteRetryTitle");
  const consequence = trailingMessages > 0 ? t("rewriteTrailing", { count: trailingMessages }) : t("rewriteNoTrailing");
  return (
    <AnimatePresence>
      {action && (
        <motion.div
          className="dialog-layer"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) onCancel();
          }}
        >
          <motion.div
            className="confirm-dialog material-light"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="rewrite-title"
            aria-describedby="rewrite-description"
            initial={{ opacity: 0, scale: 0.94, y: 12 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96 }}
            transition={{ type: "spring", bounce: 0, duration: 0.32 }}
          >
            <h2 id="rewrite-title">{subject}</h2>
            <p id="rewrite-description">
              {isEdit ? t("rewriteEditBody") : t("rewriteRetryBody")}
              {consequence}
            </p>
            <div>
              <button className="button-quiet" onClick={onCancel}>
                {t("cancel")}
              </button>
              <button className="button-accent" onClick={onConfirm}>
                {isEdit ? t("confirmEdit") : t("confirmRetry")}
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function MessageItem({
  message,
  workspace,
  runState,
  waitingForUser,
  onRequestRewrite
}: {
  message: ChatMessage;
  workspace: Workspace;
  runState?: ConversationDetail["runState"];
  waitingForUser?: boolean;
  onRequestRewrite: (message: ChatMessage, action: RewriteAction) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [editContent, setEditContent] = useState(message.content);
  const isUser = message.role === "user";
  const learningVerifications = !isUser
    ? (workspace.conversation?.learningSession?.incidents ?? []).flatMap((incident) =>
        incident.verifications.filter((verification) => {
          const ready = canConfirmLearningVerification(
            verification,
            incident.interventions,
            workspace.conversation?.messages ?? [],
            workspace.conversation?.activeRunId
          );
          const intervention = incident.interventions.find((item) => item.id === verification.interventionId);
          return ready && (verification.proposedMessageId ?? intervention?.messageId) === message.id;
        })
      )
    : [];

  function cancelEdit() {
    setEditing(false);
    setEditContent(message.content);
  }

  function submitEdit() {
    const content = editContent.trim();
    if (!content) return;
    setEditing(false);
    onRequestRewrite(message, { type: "edit", content });
  }

  return (
    <motion.article
      className={`message ${isUser ? "message-user" : "message-agent"} ${editing ? "is-editing" : ""} ${message.status === "streaming" ? "is-streaming" : ""}`}
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ type: "spring", bounce: 0, duration: 0.34 }}
      aria-label={isUser ? t("yourMessage") : t("answer")}
    >
      <div className="message-content-wrap">
        {isUser && editing ? (
          <form
            className="edit-message-panel"
            onSubmit={(event) => {
              event.preventDefault();
              submitEdit();
            }}
          >
            <textarea
              value={editContent}
              onChange={(event) => setEditContent(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") cancelEdit();
                if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault();
                  submitEdit();
                }
              }}
              autoFocus
              aria-label={t("editMessage")}
            />
            <div className="edit-message-actions">
              <button type="button" className="edit-cancel" onClick={cancelEdit}>
                {t("cancel")}
              </button>
              <button type="submit" className="edit-send" disabled={!editContent.trim()}>
                {t("sendMessage")}
              </button>
            </div>
          </form>
        ) : isUser ? (
          <p className="user-copy">{message.content}</p>
        ) : (
          <AssistantContent message={message} runState={runState} waitingForUser={waitingForUser} />
        )}
        {learningVerifications.map((verification) => (
          <div className="learning-message-outcome" key={verification.id}>
            <span>{t("learningOutcomePrompt")}</span>
            <button onClick={() => void workspace.confirmLearningVerification(verification.id, "resolved")}>
              {t("learningUnderstood")}
            </button>
            <button onClick={() => void workspace.confirmLearningVerification(verification.id, "partial")}>
              {t("learningPartlyUnderstood")}
            </button>
            <button onClick={() => void workspace.confirmLearningVerification(verification.id, "unresolved")}>
              {workspace.conversation?.learningSession?.condition === "one-shot"
                ? t("learningStillStuckFinal")
                : t("learningStillStuck")}
            </button>
          </div>
        ))}
        {!isUser && hasCollaborationTrace(message.collaboration) && (
          <CollaborationTrace trace={message.collaboration} />
        )}
        {shouldShowMessageStatus(message, runState, waitingForUser) && <ResponseStatus state={runState} />}
        {isUser && !editing && <AttachmentList message={message} />}
        {message.status === "failed" && <div className="interrupted-note is-error">{t("replyIncomplete")}</div>}
        {!isUser && !editing && <MemoryReferences message={message} workspace={workspace} />}
        {!isUser && !editing && <AttachmentList message={message} />}
        {!editing &&
          (isUser ||
            ((message.status === "completed" || message.status === "interrupted" || message.status === "failed") &&
              !waitingForUser &&
              (Boolean(message.content.trim()) ||
                Boolean(
                  message.blocks?.some(
                    (block) =>
                      !isAskUserQuestionBlock(block) &&
                      !isLearningFrameworkBlock(block) &&
                      (!isThinkingBlock(block) || (block.text ?? block.content ?? "").trim())
                  )
                )))) && (
            <div className="message-lower-row">
              <MessageActions
                message={message}
                workspace={workspace}
                onEdit={() => setEditing(true)}
                onRetry={() => onRequestRewrite(message, { type: "retry" })}
                onReplay={() => void workspace.replayRun(message)}
              />
            </div>
          )}
      </div>
    </motion.article>
  );
}

function shouldShowTimeSeparator(messages: ChatMessage[], index: number) {
  const message = messages[index];
  if (message.role !== "user") return false;
  const previous = messages[index - 1];
  if (!previous) return true;
  const currentTime = Date.parse(message.createdAt);
  const previousTime = Date.parse(previous.createdAt);
  if (!Number.isFinite(currentTime) || !Number.isFinite(previousTime)) return false;
  return (
    new Date(currentTime).toDateString() !== new Date(previousTime).toDateString() ||
    currentTime - previousTime > 30 * 60 * 1000
  );
}

function timeSeparatorLabel(value: string) {
  const date = new Date(value);
  const today = new Date();
  const sameDay = date.toDateString() === today.toDateString();
  return sameDay
    ? t("todayAt", { time: date.toLocaleTimeString(localeTag(), { hour: "2-digit", minute: "2-digit" }) })
    : date.toLocaleString(localeTag(), { month: "long", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function assistantBlockRevision(blocks: AssistantBlockDto[]): string {
  return blocks
    .map((block) => `${block.id}:${block.status}:${block.text?.length ?? 0}[${assistantBlockRevision(block.children)}]`)
    .join("|");
}

export function EmptyConversation({ onPrompt }: { onPrompt: (prompt: string) => void }) {
  const { t } = useLocale();
  return (
    <motion.div
      className="empty-conversation"
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ type: "spring", bounce: 0, duration: 0.4 }}
    >
      <div className="empty-score" aria-hidden="true">
        <span className="score-note note-leaf" />
        <span className="score-note note-sky" />
        <span className="score-note note-red" />
        <span className="score-note note-sun" />
        <span className="score-note note-tangerine" />
        <span className="score-step step-one" />
        <span className="score-step step-two" />
        <span className="score-step step-three" />
      </div>
      <div className="empty-orbit">
        <span />
        <div>
          <Icon name="brand" size={29} />
        </div>
      </div>
      <p className="eyebrow">{t("emptyLocalEyebrow")}</p>
      <h1>
        {t("emptyLocalTitle")}
        <br />
        <em>{t("emptyLocalEm")}</em>
      </h1>
      <p>{t("emptyLocalBody")}</p>
      <div className="prompt-suggestions">
        <button onClick={() => onPrompt(t("promptExplainText"))}>
          <span>{t("promptExplain")}</span>
          <small>{t("promptExplainHint")}</small>
          <Icon name="arrowUp" />
        </button>
        <button onClick={() => onPrompt(t("promptCheckText"))}>
          <span>{t("promptCheck")}</span>
          <small>{t("promptCheckHint")}</small>
          <Icon name="arrowUp" />
        </button>
        <button onClick={() => onPrompt(t("promptMaterialText"))}>
          <span>{t("promptMaterial")}</span>
          <small>{t("promptMaterialHint")}</small>
          <Icon name="arrowUp" />
        </button>
      </div>
    </motion.div>
  );
}

export function isViewportPinnedToBottom(
  node: Pick<HTMLElement, "scrollHeight" | "scrollTop" | "clientHeight">,
  threshold = 8
) {
  return node.scrollHeight - node.scrollTop - node.clientHeight <= threshold;
}

export function MessageViewport({
  conversation,
  workspace,
  onSeedPrompt
}: {
  conversation?: ConversationDetail;
  workspace: Workspace;
  onSeedPrompt: (prompt: string) => void;
}) {
  const { t } = useLocale();
  const viewport = useRef<HTMLDivElement>(null);
  const pinIgnoreUntil = useRef(0);
  const [announcement, setAnnouncement] = useState("");
  const [following, setFollowing] = useState(true);
  const [rewriteRequest, setRewriteRequest] = useState<{ message: ChatMessage; action: RewriteAction }>();
  const queuedRunIds = new Set((conversation?.queuedRuns ?? []).map((run) => run.runId));
  const messages = (conversation?.messages ?? []).filter(
    (message) => !message.runId || !queuedRunIds.has(message.runId)
  );
  const lastAssistant = [...messages]
    .reverse()
    .find((message) => message.role === "assistant" && message.content.trim());
  const lastUserId = [...messages].reverse().find((message) => message.role === "user")?.id;
  const rewriteMessageIndex = rewriteRequest
    ? messages.findIndex((message) => message.id === rewriteRequest.message.id)
    : -1;
  const trailingMessages = rewriteMessageIndex >= 0 ? messages.length - rewriteMessageIndex - 1 : 0;
  const activityRevision = assistantBlockRevision(messages.at(-1)?.blocks ?? []);
  const streaming =
    messages.some((message) => message.status === "streaming") || isConversationBusy(conversation?.runState);

  useEffect(() => {
    setFollowing(true);
  }, [conversation?.id, lastUserId]);

  useEffect(() => {
    const node = viewport.current;
    if (!node) return;
    const onScroll = () => {
      if (isViewportPinnedToBottom(node)) {
        if (Date.now() >= pinIgnoreUntil.current) setFollowing(true);
        return;
      }
      setFollowing(false);
    };
    const onWheel = (event: WheelEvent) => {
      if (event.deltaY < 0) {
        pinIgnoreUntil.current = Date.now() + 450;
        setFollowing(false);
      }
    };
    const onTouch = () => {
      if (!isViewportPinnedToBottom(node, 24)) {
        pinIgnoreUntil.current = Date.now() + 450;
        setFollowing(false);
      }
    };
    node.addEventListener("scroll", onScroll, { passive: true });
    node.addEventListener("wheel", onWheel, { passive: true });
    node.addEventListener("touchmove", onTouch, { passive: true });
    return () => {
      node.removeEventListener("scroll", onScroll);
      node.removeEventListener("wheel", onWheel);
      node.removeEventListener("touchmove", onTouch);
    };
  }, [conversation?.id]);

  useEffect(() => {
    const node = viewport.current;
    if (!node || !following) return;
    node.scrollTo({ top: node.scrollHeight, behavior: streaming ? "auto" : "smooth" });
  }, [
    following,
    streaming,
    messages.length,
    messages.at(-1)?.content,
    messages.at(-1)?.reasoningSummary,
    activityRevision
  ]);

  useEffect(() => {
    if (!lastAssistant?.content) {
      setAnnouncement("");
      return;
    }
    const timer = window.setTimeout(() => setAnnouncement(lastAssistant.content.slice(-1_000)), 700);
    return () => window.clearTimeout(timer);
  }, [conversation?.id, lastAssistant?.content]);

  function confirmRewrite() {
    if (!rewriteRequest) return;
    if (rewriteRequest.action.type === "edit")
      void workspace.branchMessage(rewriteRequest.message, rewriteRequest.action.content, false);
    else void workspace.retryMessage(rewriteRequest.message);
    setRewriteRequest(undefined);
  }

  function jumpToLatest() {
    const node = viewport.current;
    setFollowing(true);
    if (node) node.scrollTo({ top: node.scrollHeight, behavior: "smooth" });
  }

  return (
    <>
      <div className="message-viewport-shell">
        <div className="message-viewport" ref={viewport} aria-busy={isConversationBusy(conversation?.runState)}>
          <div className="sr-only" aria-live="polite">
            {announcement}
          </div>
          <div className={`message-column ${messages.length ? "" : "is-empty"}`}>
            {conversation?.replay && (
              <ReplayBanner
                mode={conversation.replay.mode}
                prompt={conversation.replay.prompt}
                playbooks={conversation.replay.overlay.playbooks}
              />
            )}
            <AnimatePresence mode="popLayout">
              {messages.length ? (
                messages.map((message, index) => (
                  <motion.div className="turn-group" key={message.id} layout={streaming ? false : "position"}>
                    {shouldShowTimeSeparator(messages, index) && (
                      <div className="turn-time-separator">
                        <span>{timeSeparatorLabel(message.createdAt)}</span>
                      </div>
                    )}
                    <MessageItem
                      message={message}
                      workspace={workspace}
                      runState={conversation?.runState}
                      waitingForUser={Boolean(conversation?.pendingQuestion)}
                      onRequestRewrite={(selectedMessage, action) =>
                        setRewriteRequest({ message: selectedMessage, action })
                      }
                    />
                  </motion.div>
                ))
              ) : (
                <EmptyConversation key="empty" onPrompt={onSeedPrompt} />
              )}
              {messages.length > 0 &&
                shouldShowSyntheticStatus(messages, conversation?.runState, Boolean(conversation?.pendingQuestion)) && (
                  <motion.div
                    className="turn-group pending-turn"
                    key="pending-assistant"
                    initial={{ opacity: 0, y: 5 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0 }}
                  >
                    <div className="message message-agent">
                      <div className="message-content-wrap">
                        <ResponseStatus state={conversation?.runState} />
                      </div>
                    </div>
                  </motion.div>
                )}
            </AnimatePresence>
          </div>
        </div>
        <AnimatePresence>
          {!following && messages.length > 0 && (
            <div className="scroll-latest-wrap">
              <motion.button
                className="scroll-latest"
                type="button"
                onClick={jumpToLatest}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: 6 }}
                transition={{ type: "spring", bounce: 0, duration: 0.24 }}
              >
                <Icon name="arrowUp" size={15} />
                {t("jumpToLatest")}
              </motion.button>
            </div>
          )}
        </AnimatePresence>
      </div>
      <RewriteConfirmationDialog
        action={rewriteRequest?.action}
        trailingMessages={trailingMessages}
        onCancel={() => setRewriteRequest(undefined)}
        onConfirm={confirmRewrite}
      />
    </>
  );
}
