/**
 * Shared visual language for the two human-readable research surfaces: the corpus browser
 * (`export-html.ts`) and the per-loop report (`loop-report-html.ts`).
 *
 * Two rules carry the whole design, and both encode something true about this project:
 *  - Type: the monospace face is what the SYSTEM recorded; the sans face is what a PERSON
 *    wrote (goal, hypothesis, task text, rationale). You can tell them apart without reading.
 *  - Color: amber means "a gate acted" — never "bad". Green and red are reserved for the
 *    learner's own verdict, because in this loop the learner's judgment is the outcome.
 *
 * Both pages are single self-contained files: no external fonts, scripts, or stylesheets,
 * so an exported page still reads with the machine offline.
 */

/** Bilingual string. The research surfaces ship both languages and switch without a reload. */
export interface Bi {
  zh: string;
  en: string;
}

export const bi = (zh: string, en: string): Bi => ({ zh, en });

/**
 * Server-rendered bilingual text: both languages sit in the DOM and CSS hides one, so the
 * language switch survives printing and works with scripting off.
 */
export function biSpan(value: Bi, tag = "span"): string {
  return `<${tag} class="lang-zh">${escapeHtml(value.zh)}</${tag}><${tag} class="lang-en">${escapeHtml(value.en)}</${tag}>`;
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/**
 * Learner-authored text reaches the browser as a JSON island rather than as markup. `<`,
 * `>` and `&` are escaped to their \u form so no payload can close the script element;
 * the reader parses with JSON.parse and writes every value through textContent.
 */
export function jsonIsland(id: string, value: unknown): string {
  const json = JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
  return `<script type="application/json" id="${id}">${json}</script>`;
}

/** Every enum the two pages surface, in both languages. One source of truth for both. */
export const LEXICON = {
  difficultyType: {
    planning_gap: bi("规划缺口", "Planning gap"),
    conceptual_misconception: bi("概念误解", "Conceptual misconception"),
    procedural_gap: bi("步骤缺口", "Procedural gap"),
    feedback_uncertainty: bi("反馈不确定", "Feedback uncertainty"),
    prerequisite_gap: bi("前置缺口", "Prerequisite gap"),
    other: bi("其他", "Other")
  },
  strategy: {
    socratic_question: bi("苏格拉底提问", "Socratic question"),
    conceptual_hint: bi("概念提示", "Conceptual hint"),
    contrastive_example: bi("对比例子", "Contrastive example"),
    worked_example: bi("范例演示", "Worked example"),
    analogical_example: bi("类比例子", "Analogical example"),
    direct_explanation: bi("直接讲解", "Direct explanation"),
    evidence_check: bi("证据核查", "Evidence check"),
    abstain_escalate: bi("交给人", "Hand off")
  },
  method: {
    self_explanation: bi("自述", "Self-explanation"),
    transfer_example: bi("迁移题", "Transfer task"),
    prediction: bi("预测", "Prediction"),
    comparison: bi("对比", "Comparison"),
    user_report: bi("自评", "Self-report")
  },
  incidentStatus: {
    observing: bi("观察中", "Observing"),
    diagnosed: bi("已诊断", "Diagnosed"),
    intervening: bi("教学中", "Teaching"),
    verifying: bi("待确认", "Awaiting your call"),
    resolved: bi("学会了", "Learned"),
    unresolved: bi("没学会", "Not yet"),
    escalated: bi("交给人", "Handed off"),
    abandoned: bi("放弃", "Abandoned")
  },
  outcome: {
    resolved: bi("学会了", "Learned"),
    partial: bi("会一半", "Partly"),
    unresolved: bi("没学会", "Not yet"),
    unknown: bi("未知", "Unknown"),
    escalated: bi("交给人", "Handed off"),
    open: bi("进行中", "In progress")
  },
  gate: {
    programmatic: bi("程序门", "Program gate"),
    novelty: bi("查重门", "Novelty gate"),
    evaluator: bi("评审门", "Reviewer gate"),
    none: bi("三门全过", "Passed all three")
  },
  practiceStatus: {
    approved: bi("过审待用", "Approved"),
    rejected: bi("被拒", "Rejected"),
    consumed: bi("已出给学习者", "Delivered"),
    expired: bi("作废", "Expired")
  },
  practiceSource: {
    tutor: bi("导师起草", "Tutor draft"),
    review: bi("回访起草", "Revisit draft")
  },
  condition: {
    "on-call": bi("自适应回路", "Adaptive loop"),
    "one-shot": bi("单次反馈对照", "One-shot baseline"),
    "multi-turn": bi("多轮对照", "Multi-turn baseline")
  },
  datasetKind: {
    live: bi("真实", "Live"),
    demo: bi("演示", "Demo"),
    replay: bi("回放", "Replay"),
    eval: bi("评测", "Eval")
  },
  sessionStatus: {
    suggested: bi("已建议", "Suggested"),
    active: bi("进行中", "Active"),
    paused: bi("暂停", "Paused"),
    completed: bi("已结束", "Completed"),
    dismissed: bi("已忽略", "Dismissed")
  },
  reviewStatus: {
    pending: bi("待触发", "Scheduled"),
    fired: bi("已回访", "Fired"),
    completed: bi("已完成", "Completed"),
    cancelled: bi("已取消", "Cancelled")
  },
  variantStatus: {
    pending: bi("待审", "Pending"),
    trial: bi("试用", "Trial"),
    enabled: bi("启用", "Enabled"),
    rejected: bi("已拒", "Rejected"),
    retired: bi("已退役", "Retired")
  },
  policyStatus: {
    pending: bi("待审", "Pending"),
    enabled: bi("已启用", "Enabled"),
    rejected: bi("已拒", "Rejected"),
    disabled: bi("已停用", "Disabled")
  },
  watchdogAction: {
    nudged: bi("已提醒", "Nudged"),
    gave_up: bi("提醒无效", "Gave up")
  }
} as const;

/**
 * Plain-language glosses for the learner's own report. `LEXICON` holds the research
 * vocabulary a codebook can be written against; these say the same thing to the person who
 * just finished the loop. A student should never have to learn our enum names to read their
 * own page, so the report leads with these and keeps the formal term as a quiet second chip.
 */
export const PLAIN = {
  difficultyType: {
    planning_gap: bi("不知道从哪儿下手", "Not sure where to start"),
    conceptual_misconception: bi("有个概念理解反了", "A concept was understood backwards"),
    procedural_gap: bi("步骤会漏掉或做错", "A step kept going wrong"),
    feedback_uncertainty: bi("拿不准自己做得对不对", "Hard to tell if your own answer was right"),
    prerequisite_gap: bi("前面的基础没跟上", "An earlier building block was missing"),
    other: bi("别的原因", "Something else")
  },
  strategy: {
    socratic_question: bi("用问题带你自己想出来", "Asked questions until you got there"),
    conceptual_hint: bi("给你一句关键提示", "Gave you one key hint"),
    contrastive_example: bi("拿两个例子做对比", "Put two examples side by side"),
    worked_example: bi("完整演一遍给你看", "Worked one all the way through"),
    analogical_example: bi("换个你熟悉的东西打比方", "Used something familiar as an analogy"),
    direct_explanation: bi("直接讲清楚", "Just explained it"),
    evidence_check: bi("回去核对原始材料", "Went back and checked the source"),
    abstain_escalate: bi("交给真人", "Handed it to a person")
  },
  method: {
    self_explanation: bi("让你自己讲一遍", "Asked you to explain it back"),
    transfer_example: bi("换个新情境再做一题", "A fresh problem in a new setting"),
    prediction: bi("先让你猜结果", "Asked you to predict the result"),
    comparison: bi("让你比较两种情况", "Asked you to compare two cases"),
    user_report: bi("直接问你会没会", "Just asked how it felt")
  },
  gate: {
    programmatic: bi("题面里夹带了答案", "The task gave its own answer away"),
    novelty: bi("跟你做过的题太像", "Too close to something you had already seen"),
    evaluator: bi("另一个 AI 审下来觉得不合格", "A second AI reviewer turned it down"),
    none: bi("三关都过了", "Cleared all three checks")
  }
} as const;

/** Plain wording where we have it, the research label where we do not. */
export function plain(group: keyof typeof PLAIN, code: string | null | undefined): Bi {
  if (!code) return bi("—", "—");
  const table = PLAIN[group] as Record<string, Bi | undefined>;
  return table[code] ?? label(group as LexiconGroup, code);
}

export type LexiconGroup = keyof typeof LEXICON;

/** Look a code up in the lexicon, falling back to the raw code so new enum values still read. */
export function label(group: LexiconGroup, code: string | null | undefined): Bi {
  if (!code) return bi("—", "—");
  const table = LEXICON[group] as Record<string, Bi | undefined>;
  return table[code] ?? bi(code, code);
}

/**
 * Design tokens and the primitives both pages share. Light is the base; dark is a token
 * swap so a researcher reading at night gets the same instrument, not a second design.
 */
export const BASE_CSS = `
:root {
  color-scheme: light dark;
  --ground: #f3f5f8;
  --panel: #ffffff;
  --rule: #d7dde5;
  --rule-soft: #e7ebf0;
  --ink: #131a22;
  --dust: #5f6a78;
  --pen: #1d5b93;
  --pen-soft: #e4edf6;
  --tag: #9d5910;
  --tag-soft: #f7ecdd;
  --moss: #2b6c4f;
  --moss-soft: #e2f0e8;
  --rust: #a63a3a;
  --rust-soft: #f8e5e5;
  --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, "Cascadia Mono", "Liberation Mono", monospace;
  --sans: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
  --gutter: clamp(1rem, 4vw, 2.5rem);
}
@media (prefers-color-scheme: dark) {
  :root {
    --ground: #0f141b;
    --panel: #151d27;
    --rule: #27323f;
    --rule-soft: #1d2731;
    --ink: #e6ecf3;
    --dust: #8b96a5;
    --pen: #6ba7de;
    --pen-soft: #17293a;
    --tag: #dd9448;
    --tag-soft: #2e2318;
    --moss: #5fbb8c;
    --moss-soft: #16281f;
    --rust: #e07a7a;
    --rust-soft: #2c1a1a;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--ground);
  color: var(--ink);
  font-family: var(--sans);
  font-size: 15px;
  line-height: 1.6;
  -webkit-font-smoothing: antialiased;
}
/* Anything the system recorded is set in mono; prose the tutor or learner wrote is sans. */
.rec, code, th, .eyebrow, .chip, .num { font-family: var(--mono); }
.eyebrow {
  font-size: .625rem;
  letter-spacing: .11em;
  text-transform: uppercase;
  color: var(--dust);
  font-weight: 600;
}
.prose { font-family: var(--sans); overflow-wrap: anywhere; }
a { color: var(--pen); }
:focus-visible { outline: 2px solid var(--pen); outline-offset: 2px; border-radius: 3px; }
.chip {
  display: inline-flex;
  align-items: center;
  gap: .3em;
  padding: .1em .45em;
  border: 1px solid var(--rule);
  border-radius: 3px;
  font-size: .68rem;
  line-height: 1.5;
  white-space: nowrap;
  color: var(--dust);
}
.chip-pen { color: var(--pen); border-color: color-mix(in srgb, var(--pen) 40%, transparent); background: var(--pen-soft); }
.chip-tag { color: var(--tag); border-color: color-mix(in srgb, var(--tag) 40%, transparent); background: var(--tag-soft); }
.chip-moss { color: var(--moss); border-color: color-mix(in srgb, var(--moss) 40%, transparent); background: var(--moss-soft); }
.chip-rust { color: var(--rust); border-color: color-mix(in srgb, var(--rust) 40%, transparent); background: var(--rust-soft); }
.lang-en { display: none; }
:root[data-lang="en"] .lang-zh { display: none; }
:root[data-lang="en"] .lang-en { display: inline; }
:root[data-lang="en"] p.lang-en, :root[data-lang="en"] div.lang-en, :root[data-lang="en"] h1.lang-en,
:root[data-lang="en"] h2.lang-en, :root[data-lang="en"] h3.lang-en, :root[data-lang="en"] li.lang-en { display: block; }
.langswitch {
  display: inline-flex;
  border: 1px solid var(--rule);
  border-radius: 4px;
  overflow: hidden;
  font-family: var(--mono);
  font-size: .68rem;
}
.langswitch button {
  appearance: none;
  border: 0;
  background: transparent;
  color: var(--dust);
  padding: .25rem .55rem;
  cursor: pointer;
  font: inherit;
}
.langswitch button[aria-pressed="true"] { background: var(--pen); color: var(--panel); }
@media (prefers-reduced-motion: no-preference) {
  .fade { animation: fade .14s ease-out; }
  @keyframes fade { from { opacity: 0; } to { opacity: 1; } }
}
`;

/** The language switch. Remembers the choice per browser; defaults to Chinese. */
export const LANG_SWITCH_HTML = `<div class="langswitch" role="group" aria-label="Language / 语言">
<button type="button" data-lang-set="zh" aria-pressed="true">中文</button>
<button type="button" data-lang-set="en" aria-pressed="false">EN</button>
</div>`;

export const LANG_SWITCH_JS = `
(function () {
  var root = document.documentElement;
  var KEY = "fieldnote-report-lang";
  function apply(lang) {
    root.setAttribute("data-lang", lang);
    root.setAttribute("lang", lang === "en" ? "en" : "zh");
    var buttons = document.querySelectorAll("[data-lang-set]");
    for (var i = 0; i < buttons.length; i += 1) {
      buttons[i].setAttribute("aria-pressed", String(buttons[i].getAttribute("data-lang-set") === lang));
    }
    if (window.fieldnoteOnLang) window.fieldnoteOnLang(lang);
  }
  var stored = null;
  try { stored = window.localStorage.getItem(KEY); } catch (error) { stored = null; }
  apply(stored === "en" ? "en" : "zh");
  document.addEventListener("click", function (event) {
    var target = event.target.closest ? event.target.closest("[data-lang-set]") : null;
    if (!target) return;
    var lang = target.getAttribute("data-lang-set");
    try { window.localStorage.setItem(KEY, lang); } catch (error) { /* private mode: switch still applies */ }
    apply(lang);
  });
})();
`;

/** Wrap page content in the shared document shell. `head` carries page-specific CSS. */
export function pageShell(options: { title: Bi; css: string; body: string; script: string }): string {
  return `<!doctype html>
<html lang="zh" data-lang="zh">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="referrer" content="no-referrer" />
<title>${escapeHtml(options.title.zh)} · ${escapeHtml(options.title.en)}</title>
<style>${BASE_CSS}${options.css}</style>
</head>
<body>
${options.body}
<script>${LANG_SWITCH_JS}${options.script}</script>
</body>
</html>`;
}

/** Short id for display; the full value stays in the title attribute so joins stay checkable. */
export function shortId(value: string | null | undefined): string {
  if (!value) return "—";
  return `<code title="${escapeHtml(value)}">${escapeHtml(value.slice(0, 8))}</code>`;
}

export function stamp(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  const iso = typeof value === "number" ? new Date(value).toISOString() : value;
  return iso.replace("T", " ").slice(0, 16);
}
