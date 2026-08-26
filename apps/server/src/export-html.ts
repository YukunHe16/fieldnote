import type { LearningStore } from "./learning-store.js";
import { BASE_CSS, jsonIsland, LANG_SWITCH_HTML, LANG_SWITCH_JS, LEXICON } from "./report-ui.js";

type ResearchExport = ReturnType<LearningStore["exportResearch"]>;

/**
 * The research corpus, laid out for a person rather than a parser. Same payload as the JSON
 * endpoint (already redacted by the caller), rendered as one self-contained page.
 *
 * The unit on screen is the LOOP, not the table: one learning difficulty with its diagnosis,
 * the rounds spent on it, every practice draft it burned (the rejected ones included), the
 * learner's own verdict, and whether the spaced revisit happened. The ten raw tables are one
 * toggle away because the codebook maps to them.
 *
 * Learner-authored text never enters this file as markup — it ships as a JSON island with
 * `<`, `>` and `&` escaped, and the reader writes every value through textContent.
 */
export function renderResearchExportHtml(
  data: ResearchExport,
  meta: { exportedAt: string; participantId: string | null }
): string {
  const payload = {
    sessions: data.sessions,
    incidents: data.incidents.map((incident) => ({
      id: incident.id,
      sessionId: incident.sessionId,
      difficultyType: incident.difficultyType,
      hypothesis: incident.hypothesis,
      confidence: incident.confidence,
      severity: incident.severity,
      status: incident.status,
      evidenceCount: incident.evidenceMessageIds.length,
      createdAt: incident.createdAt,
      closedAt: incident.closedAt
    })),
    interventions: data.interventions,
    verifications: data.verifications,
    practiceItems: data.practiceItems,
    experiences: data.experiences,
    strategyVariants: data.strategyVariants,
    policyRevisions: data.policyRevisions.map((policy) => ({
      id: policy.id,
      participantId: policy.participantId,
      difficultyType: policy.difficultyType,
      datasetKind: policy.datasetKind,
      status: policy.status,
      orderedStrategies: policy.orderedStrategies,
      evaluationSummary: policy.evaluationSummary,
      createdAt: policy.createdAt
    })),
    reviewTasks: data.reviewTasks,
    watchdogEvents: data.watchdogEvents
  };

  return `<!doctype html>
<html lang="zh" data-lang="zh">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="referrer" content="no-referrer" />
<title>Fieldnote 研究数据 · Research corpus</title>
<style>${BASE_CSS}${CORPUS_CSS}</style>
</head>
<body>
${SHELL_HTML}
${jsonIsland("fieldnote-data", payload)}
${jsonIsland("fieldnote-lex", LEXICON)}
${jsonIsland("fieldnote-ui", UI_STRINGS)}
${jsonIsland("fieldnote-meta", { exportedAt: meta.exportedAt, participantId: meta.participantId })}
<script>${LANG_SWITCH_JS}${CORPUS_JS}</script>
</body>
</html>`;
}

const CORPUS_CSS = `
.topbar {
  position: sticky; top: 0; z-index: 20;
  display: flex; flex-wrap: wrap; gap: .75rem 1rem; align-items: center; justify-content: space-between;
  padding: .55rem var(--gutter);
  background: color-mix(in srgb, var(--panel) 92%, transparent);
  border-bottom: 1px solid var(--rule);
  backdrop-filter: blur(8px);
}
.wordmark { display: flex; align-items: baseline; gap: .55rem; font-family: var(--mono); }
.wordmark b { letter-spacing: .16em; font-size: .82rem; }
.topbar-actions { display: flex; align-items: center; gap: .6rem; flex-wrap: wrap; }
.jsonlink { font-family: var(--mono); font-size: .68rem; text-decoration: none; border: 1px solid var(--rule); border-radius: 4px; padding: .25rem .5rem; }
main { max-width: 1180px; margin: 0 auto; padding: 0 var(--gutter) 5rem; }
.thesis { padding: 1.9rem 0 1.15rem; border-bottom: 1px solid var(--rule); }
.thesis p { margin: 0 0 .45rem; max-width: 58ch; font-size: .95rem; }
.thesis .meta { font-family: var(--mono); font-size: .66rem; color: var(--dust); max-width: none; margin-top: .7rem; }
.thesis .typelegend { font-size: .74rem; color: var(--dust); margin: .35rem 0 0; max-width: 66ch; }
.thesis .typelegend .rec { color: var(--ink); }
.overview { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 1px; background: var(--rule); border: 1px solid var(--rule); border-radius: 6px; margin: 1.5rem 0; overflow: hidden; }
.card { background: var(--panel); padding: .9rem 1.1rem 1.1rem; display: flex; flex-direction: column; }
.card svg { margin-top: .2rem; }
.legend { display: grid; grid-template-columns: auto 1fr; gap: .3rem .55rem; align-items: center; font-size: .72rem; margin-top: .1rem; }
.legend i { display: inline-block; width: 11px; height: 11px; border-radius: 2px; }
.legend .hollow { border: 1.5px solid var(--tag); background: transparent; }
.legend span { color: var(--dust); }
.card h3 { margin: 0 0 .1rem; font-size: .74rem; font-family: var(--mono); font-weight: 600; letter-spacing: .04em; }
.card .hint { margin: 0 0 .6rem; font-size: .66rem; color: var(--dust); }
.card svg { display: block; width: 100%; height: auto; }
.f-moss { fill: var(--moss); } .f-pen { fill: var(--pen); } .f-rust { fill: var(--rust); }
.f-tag { fill: var(--tag); } .f-dust { fill: var(--dust); } .f-rule { fill: var(--rule); }
.s-tag { stroke: var(--tag); } .s-rule { stroke: var(--rule); } .s-pen { stroke: var(--pen); }
.axis { font-family: var(--mono); font-size: 8.5px; fill: var(--dust); }
.tick-label { font-family: var(--mono); font-size: 8.5px; fill: var(--dust); }
.filters { display: flex; flex-wrap: wrap; gap: .5rem; align-items: center; padding: .75rem 0; border-bottom: 1px solid var(--rule); position: sticky; top: 42px; background: var(--ground); z-index: 10; }
.filters select, .filters input {
  font-family: var(--mono); font-size: .72rem; padding: .3rem .45rem;
  background: var(--panel); color: var(--ink); border: 1px solid var(--rule); border-radius: 4px;
}
.filters input[type="search"] { min-width: 13rem; flex: 1 1 13rem; }
.filters button { font-family: var(--mono); font-size: .72rem; padding: .3rem .55rem; background: transparent; color: var(--dust); border: 1px solid var(--rule); border-radius: 4px; cursor: pointer; }
.filters button:hover { color: var(--ink); }
.tally { font-family: var(--mono); font-size: .72rem; color: var(--dust); margin-left: auto; }
.viewswitch { display: inline-flex; border: 1px solid var(--rule); border-radius: 4px; overflow: hidden; }
.viewswitch button { border: 0; background: transparent; color: var(--dust); font-family: var(--mono); font-size: .72rem; padding: .3rem .6rem; cursor: pointer; }
.viewswitch button[aria-pressed="true"] { background: var(--pen); color: var(--panel); }
.spinekey { margin: 1rem 0 0; font-size: .72rem; }
.spinekey summary { cursor: pointer; font-family: var(--mono); font-size: .68rem; color: var(--dust); }
.spinekey ul { margin: .5rem 0 0; padding-left: 1.1rem; color: var(--dust); }
.spinekey li { margin: .2rem 0; }
.loop { border: 1px solid var(--rule); border-radius: 6px; background: var(--panel); margin: 1rem 0; padding: .9rem 1rem 1rem; }
.loop-head { display: flex; flex-wrap: wrap; gap: .4rem .6rem; align-items: center; }
.loop-head .grow { flex: 1 1 auto; }
.loop h2 { margin: .5rem 0 .35rem; font-size: 1rem; font-weight: 600; line-height: 1.45; }
.loop .goal { margin: 0 0 .4rem; font-size: .78rem; color: var(--dust); }
.spine-wrap { overflow-x: auto; margin: .35rem 0 .1rem; }
.spine { display: block; width: 100%; min-width: 640px; height: auto; }
.spine text { font-family: var(--mono); }
.loop-foot { display: flex; flex-wrap: wrap; gap: .4rem .7rem; align-items: center; font-size: .72rem; color: var(--dust); font-family: var(--mono); }
.loop-foot a { text-decoration: none; border-bottom: 1px solid color-mix(in srgb, var(--pen) 45%, transparent); }
.drafts { margin: .6rem 0 0; }
.drafts summary { cursor: pointer; font-family: var(--mono); font-size: .68rem; color: var(--dust); }
.draft { border-left: 2px solid var(--rule); padding: .35rem 0 .35rem .7rem; margin: .5rem 0; }
.draft.rejected { border-left-color: var(--tag); }
.draft .line { display: flex; flex-wrap: wrap; gap: .35rem; align-items: center; margin-bottom: .25rem; }
.draft p { margin: .15rem 0; font-size: .82rem; }
.draft .why { font-size: .74rem; color: var(--tag); }
.more { display: block; width: 100%; margin: .5rem 0 0; padding: .7rem; background: transparent; color: var(--pen); border: 1px dashed var(--rule); border-radius: 6px; font-family: var(--mono); font-size: .74rem; cursor: pointer; }
.more:hover { border-color: var(--pen); }
.empty { padding: 3rem 1rem; text-align: center; color: var(--dust); border: 1px dashed var(--rule); border-radius: 6px; margin: 1.5rem 0; }
.tablewrap { margin: 1.75rem 0; }
.tablewrap h2 { font-size: .84rem; font-family: var(--mono); margin: 0 0 .15rem; font-weight: 600; }
.tablewrap .hint { margin: 0 0 .5rem; font-size: .7rem; color: var(--dust); max-width: 78ch; }
.scroll { overflow-x: auto; border: 1px solid var(--rule); border-radius: 6px; background: var(--panel); }
table { border-collapse: collapse; width: 100%; font-size: .76rem; }
th, td { padding: .35rem .55rem; text-align: left; vertical-align: top; border-bottom: 1px solid var(--rule-soft); }
th { position: sticky; top: 0; background: var(--panel); font-size: .66rem; letter-spacing: .05em; text-transform: uppercase; color: var(--dust); border-bottom: 1px solid var(--rule); }
td { max-width: 24rem; overflow-wrap: anywhere; }
td details .full { white-space: pre-wrap; margin-top: .25rem; }
tr:last-child td { border-bottom: 0; }
noscript .empty { color: var(--ink); }
@media (max-width: 720px) {
  .filters { position: static; }
  .tally { margin-left: 0; }
}
@media print {
  .topbar, .filters, .viewswitch, .langswitch { display: none; }
  .loop { break-inside: avoid; }
}
`;

const SHELL_HTML = `<header class="topbar">
  <div class="wordmark"><b>FIELDNOTE</b><span class="eyebrow"><span class="lang-zh">研究数据</span><span class="lang-en">Research corpus</span></span></div>
  <div class="topbar-actions">
    <span class="eyebrow" id="scope"></span>
    ${LANG_SWITCH_HTML}
    <a class="jsonlink" id="jsonlink" href="/api/learning/export?includeMessages=true">JSON</a>
  </div>
</header>
<main>
  <section class="thesis">
    <p class="lang-zh">每一条都是一次学习困难的完整证据链：诊断出的误解、试过哪些讲法、为它出过哪些题（含被三道门拦下的草稿）、学习者自己怎么判、之后有没有回访。</p>
    <p class="lang-en">Each entry is one learning difficulty end to end: the misconception diagnosed, the teaching moves tried, every practice task drafted for it (including the ones the three gates stopped), how the learner judged it, and whether the revisit happened.</p>
    <p class="meta" id="meta"></p>
    <p class="typelegend"><span class="lang-zh"><span class="rec">等宽字</span>是系统记录的值，无衬线字是人写的话。琥珀色只表示“某道门动作了”，绿/红留给学习者自己的判定。</span><span class="lang-en"><span class="rec">Mono</span> is what the system recorded; the sans face is what a person wrote. Amber only ever means a gate acted — green and red are reserved for the learner's own verdict.</span></p>
  </section>
  <section class="overview" id="overview"></section>
  <form class="filters" id="filters" role="search">
    <select id="f-participant" aria-label="participant"></select>
    <select id="f-dataset" aria-label="dataset"></select>
    <select id="f-condition" aria-label="condition"></select>
    <select id="f-difficulty" aria-label="difficulty"></select>
    <select id="f-outcome" aria-label="outcome"></select>
    <input id="f-q" type="search" autocomplete="off" />
    <select id="f-sort" aria-label="sort"></select>
    <button type="button" id="f-reset"></button>
    <span class="tally" id="tally"></span>
  </form>
  <div style="display:flex;gap:.6rem;align-items:center;margin:.9rem 0 0;flex-wrap:wrap">
    <div class="viewswitch" role="group">
      <button type="button" data-view="loops" aria-pressed="true"></button>
      <button type="button" data-view="tables" aria-pressed="false"></button>
    </div>
  </div>
  <details class="spinekey" id="spinekey"><summary></summary><ul></ul></details>
  <section id="loops" aria-live="polite"></section>
  <section id="tables" hidden></section>
  <noscript><div class="empty">这一页用浏览器脚本渲染筛选和图表。请开启脚本，或直接取 <code>/api/learning/export</code> 的 JSON。<br />This page renders its filters and charts in the browser. Enable scripting, or take the JSON at <code>/api/learning/export</code>.</div></noscript>
</main>`;

/** Every string the reader can show. Data stays in whatever language the learner wrote it. */
const UI_STRINGS = {
  zh: {
    scopeAll: "全库 · 所有参与者",
    scopeOne: "参与者 ",
    metaLine: "导出于 {t} · 与 JSON 端点同一份脱敏数据 · 字段口径见 docs/RESEARCH_EXPORT.md · 数据不出本机",
    anyParticipant: "全部参与者",
    anyDataset: "全部数据集",
    anyCondition: "全部条件",
    anyDifficulty: "全部困难类型",
    anyOutcome: "全部结果",
    search: "搜目标、假设、题面…",
    reset: "清空筛选",
    sortNew: "按时间：新→旧",
    sortOld: "按时间：旧→新",
    sortDrafts: "按草稿数",
    sortRounds: "按轮次",
    tally: "显示 {n} / {total} 个回路",
    viewLoops: "回路",
    viewTables: "原始表",
    keyTitle: "怎么读这条线",
    key1: "线上方的菱形＝一轮教学，标注用的讲法；线尾的圆＝学习者最后的判定。",
    key2: "线下方每一根竖条＝一份练习题草稿，高度就是查重分；虚线是 0.6 的硬拒线。",
    key3: "空心条＝被拒的草稿，下面的字母是拦它的门：P 程序门、N 查重门、E 评审门；实心条＝过审或已出给学习者。",
    key4: "最右的小圆＝间隔回访：空心是已预订，实心是已触发。",
    more: "还有 {n} 条 · 再显示 {step} 条",
    chartLegend: "怎么看颜色",
    chartLegendHint: "全页通用：琥珀色只说明某道门动作了，绿/红是学习者自己的判定",
    legendGate: "琥珀＝某道门动作了",
    legendHollow: "空心＝被拒的草稿，学习者没见过",
    emptyTitle: "没有符合条件的回路。",
    emptyHint: "放宽筛选，或清空后重看全部。",
    chartOutcome: "结果 × 条件",
    chartOutcomeHint: "自适应回路与两个对照，各自收尾成什么样",
    chartRounds: "几轮讲明白",
    chartRoundsHint: "已经收尾的回路，各花了几轮教学",
    chartGates: "草稿卡在哪一关",
    chartGatesHint: "三关各拦下多少道题；「三门全过」是全部通过的",
    chartNovelty: "新题有多新",
    chartNoveltyHint: "每一点是一道草稿：越靠左越不像学习者做过的题；越过 0.6 就当成旧题直接拒",
    chartStrategy: "哪种讲法管用",
    chartStrategyHint: "只统计学习者已经确认过结果的回路",
    noveltyLow: "← 全新",
    noveltyHigh: "越像旧题 →",
    noData: "还没有数据",
    rounds: "{n} 轮",
    roundNo: "第 {n} 轮",
    drafts: "{n} 份草稿",
    rejected: "{n} 份被拒",
    evidence: "{n} 条证据",
    confidence: "置信度 {n}%",
    openReport: "打开这次的学习报告",
    draftsTitle: "展开这一回路的全部草稿（含被拒的）",
    draftNovelty: "查重分 {n}",
    failedOpen: "评审员当时没能答复，按放行处理。",
    draftAnswer: "预期答案要点",
    reviewBooked: "已预订回访",
    reviewFired: "已回访",
    outcomeOpen: "进行中",
    colId: "ID",
    tabSessions: "会话",
    tabSessionsHint: "每条学习会话。条件是分组变量；participantId 标记谁在学（default 混有加列之前的全部历史）。",
    tabIncidents: "工单",
    tabIncidentsHint: "一次被诊断的学习困难。假设是导师对误解的判断，置信度 0–1。",
    tabInterventions: "干预",
    tabInterventionsHint: "每轮教学动作。策略八选一，round 是轮次（自适应回路最多 3 轮）。",
    tabPractice: "练习题记",
    tabPracticeHint:
      "回路内出题的完整台账，含被拒草稿。门＝拦下它的那道门（通过记 none）；查重分＝与学习者已见文本的最高相似度，>0.6 硬拒。",
    tabVerifications: "验证",
    tabVerificationsHint: "发给学习者的理解检查。题记✓表示题面由宿主从过审题记逐字复制；系统判定之后仍需学习者确认。",
    tabExperiences: "经验",
    tabExperiencesHint: "只有学习者确认过的结果才写入，是策略自进化的唯一燃料；按参与者隔离。",
    tabVariants: "讲法",
    tabVariantsHint: "自发明的具体教学方式，挂在八个基础策略下，每次状态变更都过人审。",
    tabPolicies: "策略修订",
    tabPoliciesHint: "受控策略演进：候选顺序由证据生成，启用/拒绝/回滚都是人的决定。",
    tabReviews: "复习任务",
    tabReviewsHint: "间隔复习：学会之后预订的回访，到期由真实 Agent 回到原对话出新迁移题。",
    tabWatchdog: "看门狗事件",
    tabWatchdogHint: "回路停摆台账：nudged 是已提醒，gave_up 是提醒后仍停摆。会话健康指标可由本表复算。",
    hParticipant: "参与者",
    hCondition: "条件",
    hDataset: "数据集",
    hStatus: "状态",
    hGoal: "学习目标",
    hCreated: "创建",
    hSession: "会话",
    hIncident: "工单",
    hDifficulty: "困难类型",
    hHypothesis: "诊断假设",
    hConfidence: "置信度",
    hRound: "轮",
    hStrategy: "讲法",
    hRationale: "理由",
    hSignal: "预期信号",
    hSource: "来源",
    hGate: "门",
    hNovelty: "查重分",
    hEvaluator: "评审员",
    hMethod: "方法",
    hTask: "题面",
    hAnswer: "预期答案要点",
    hFromDraft: "题记",
    hPrompt: "题面",
    hSystem: "系统判定",
    hFinal: "最终判定",
    hOutcome: "结果",
    hVariant: "讲法",
    hTitle: "标题",
    hUsed: "归因数",
    hAdvice: "建议",
    hSummary: "说明",
    hOrder: "候选顺序",
    hDue: "到期",
    hSignature: "签名",
    hAction: "动作",
    hTime: "时间",
    fromDraftYes: "✓ 来自题记",
    fromDraftNo: "散文",
    awaiting: "待确认",
    none: "无记录"
  },
  en: {
    scopeAll: "Whole corpus · all participants",
    scopeOne: "Participant ",
    metaLine:
      "Exported {t} · same redacted data as the JSON endpoint · field reference docs/RESEARCH_EXPORT.md · never leaves this machine",
    anyParticipant: "All participants",
    anyDataset: "All datasets",
    anyCondition: "All conditions",
    anyDifficulty: "All difficulty types",
    anyOutcome: "All outcomes",
    search: "Search goals, hypotheses, task text…",
    reset: "Clear filters",
    sortNew: "Newest first",
    sortOld: "Oldest first",
    sortDrafts: "Most drafts",
    sortRounds: "Most rounds",
    tally: "Showing {n} of {total} loops",
    viewLoops: "Loops",
    viewTables: "Raw tables",
    keyTitle: "How to read the spine",
    key1: "Diamonds above the line are teaching rounds, labelled with the move used; the circle at the end is the learner's own verdict.",
    key2: "Each bar below the line is one practice draft, its height the novelty score; the dashed line is the 0.6 hard-reject threshold.",
    key3: "Hollow bars are rejected drafts, lettered by the gate that stopped them: P program, N novelty, E reviewer. Solid bars passed or were delivered.",
    key4: "The small circle on the right is the spaced revisit: hollow means booked, solid means it fired.",
    more: "{n} more · show {step} of them",
    chartLegend: "Reading the colors",
    chartLegendHint: "Used throughout: amber only means a gate acted; green and red are the learner's own verdict",
    legendGate: "Amber — a gate acted",
    legendHollow: "Hollow — a rejected draft the learner never saw",
    emptyTitle: "No loops match these filters.",
    emptyHint: "Loosen a filter, or clear them to see everything.",
    chartOutcome: "Outcome × condition",
    chartOutcomeHint: "How loops ended in the adaptive arm and the two baselines",
    chartRounds: "How many rounds it took",
    chartRoundsHint: "Teaching rounds spent on each closed loop",
    chartGates: "Which check stopped it",
    chartGatesHint: "Drafts stopped by each of the three checks; \u201cpassed all three\u201d cleared them",
    chartNovelty: "How new each question was",
    chartNoveltyHint:
      "Each dot is one draft: further left means less like anything the learner has done. Past 0.6 it counts as a repeat and is rejected",
    chartStrategy: "Which move worked",
    chartStrategyHint: "Only loops the learner has already confirmed are counted",
    noveltyLow: "\u2190 brand new",
    noveltyHigh: "more like a repeat \u2192",
    noData: "Nothing recorded yet",
    rounds: "rounds: {n}",
    roundNo: "round {n}",
    drafts: "drafts: {n}",
    rejected: "rejected: {n}",
    evidence: "evidence: {n}",
    confidence: "confidence: {n}%",
    openReport: "Open this loop's report",
    draftsTitle: "Show every draft in this loop, rejected ones included",
    draftNovelty: "Novelty {n}",
    failedOpen: "The reviewer did not answer in time, so the draft was let through.",
    draftAnswer: "Expected answer",
    reviewBooked: "Revisit booked",
    reviewFired: "Revisit fired",
    outcomeOpen: "In progress",
    colId: "ID",
    tabSessions: "Sessions",
    tabSessionsHint:
      "One learning session per row. Condition is the grouping variable; participantId says who was learning (default also holds everything from before the column existed).",
    tabIncidents: "Incidents",
    tabIncidentsHint:
      "One diagnosed learning difficulty. The hypothesis is the tutor's read of the misconception; confidence is 0–1.",
    tabInterventions: "Interventions",
    tabInterventionsHint:
      "One teaching move per row, chosen from the eight; round counts the attempt (the adaptive arm spends at most three).",
    tabPractice: "Practice drafts",
    tabPracticeHint:
      "The full ledger of in-loop task generation, rejected drafts included. Gate names the check that stopped it (none means it passed all three); novelty is the highest similarity to text the learner has already seen, hard-rejected above 0.6.",
    tabVerifications: "Verifications",
    tabVerificationsHint:
      "The understanding check sent to the learner. ✓ means the host copied the text verbatim from an approved draft. The system's verdict is a proposal — the learner still confirms.",
    tabExperiences: "Experiences",
    tabExperiencesHint:
      "Only learner-confirmed outcomes are written here, and they are the only fuel for strategy evolution. Isolated per participant.",
    tabVariants: "Invented moves",
    tabVariantsHint:
      "Concrete teaching approaches invented under one of the eight base strategies. Every status change passes a human.",
    tabPolicies: "Policy revisions",
    tabPoliciesHint:
      "Controlled strategy evolution: evidence generates the candidate order; enabling, rejecting and rolling back stay human decisions.",
    tabReviews: "Spaced reviews",
    tabReviewsHint:
      "The revisit booked once a loop resolves. On its due date a real agent returns to the original thread with a fresh transfer task.",
    tabWatchdog: "Watchdog events",
    tabWatchdogHint:
      "The stall ledger: nudged means reminded, gave_up means still stalled after the reminder. Session-health numbers can be recomputed from this table.",
    hParticipant: "Participant",
    hCondition: "Condition",
    hDataset: "Dataset",
    hStatus: "Status",
    hGoal: "Goal",
    hCreated: "Created",
    hSession: "Session",
    hIncident: "Incident",
    hDifficulty: "Difficulty",
    hHypothesis: "Hypothesis",
    hConfidence: "Confidence",
    hRound: "Round",
    hStrategy: "Move",
    hRationale: "Rationale",
    hSignal: "Expected signal",
    hSource: "Source",
    hGate: "Gate",
    hNovelty: "Novelty",
    hEvaluator: "Reviewer",
    hMethod: "Method",
    hTask: "Task text",
    hAnswer: "Expected answer",
    hFromDraft: "From draft",
    hPrompt: "Prompt",
    hSystem: "System verdict",
    hFinal: "Final verdict",
    hOutcome: "Outcome",
    hVariant: "Move",
    hTitle: "Title",
    hUsed: "Attributed",
    hAdvice: "Recommendation",
    hSummary: "Summary",
    hOrder: "Candidate order",
    hDue: "Due",
    hSignature: "Signature",
    hAction: "Action",
    hTime: "Time",
    fromDraftYes: "✓ from draft",
    fromDraftNo: "prose",
    awaiting: "awaiting learner",
    none: "No rows"
  }
} as const;

/**
 * The reader. Joins the flat tables into loops, keeps filters and charts in sync, and writes
 * every learner-authored value through textContent — no data ever becomes markup.
 */
const CORPUS_JS = `
(function () {
  function island(id) { var node = document.getElementById(id); return node ? JSON.parse(node.textContent) : null; }
  var D = island("fieldnote-data"), LEX = island("fieldnote-lex"), UI = island("fieldnote-ui"), META = island("fieldnote-meta");
  var lang = document.documentElement.getAttribute("data-lang") === "en" ? "en" : "zh";
  var NS = "http://www.w3.org/2000/svg";

  function T(key, vars) {
    var s = (UI[lang] && UI[lang][key]) || UI.zh[key] || key;
    if (vars) { for (var k in vars) { s = s.split("{" + k + "}").join(String(vars[k])); } }
    return s;
  }
  function L(group, code) {
    var g = LEX[group] || {}, v = g[code];
    if (v) return v[lang] || v.zh;
    return code === null || code === undefined || code === "" ? "\\u2014" : String(code);
  }
  function append(node, kids) {
    if (kids === null || kids === undefined || kids === false) return;
    if (Array.isArray(kids)) { for (var i = 0; i < kids.length; i += 1) append(node, kids[i]); return; }
    node.appendChild(typeof kids === "object" ? kids : document.createTextNode(String(kids)));
  }
  function el(tag, attrs, kids) {
    var node = document.createElement(tag);
    if (attrs) {
      for (var k in attrs) {
        var v = attrs[k];
        if (v === null || v === undefined) continue;
        if (k === "class") node.className = v;
        else if (k === "text") node.textContent = String(v);
        else node.setAttribute(k, String(v));
      }
    }
    append(node, kids);
    return node;
  }
  function sv(tag, attrs, kids) {
    var node = document.createElementNS(NS, tag);
    if (attrs) { for (var k in attrs) { if (attrs[k] !== null && attrs[k] !== undefined) node.setAttribute(k, String(attrs[k])); } }
    if (kids !== undefined && kids !== null) node.textContent = String(kids);
    return node;
  }
  function clip(value, max) {
    var raw = String(value === null || value === undefined ? "" : value);
    return raw.length > max ? raw.slice(0, max - 1) + "\\u2026" : raw;
  }
  function fmtTime(value) {
    if (value === null || value === undefined) return "\\u2014";
    var iso = typeof value === "number" ? new Date(value).toISOString() : String(value);
    return iso.replace("T", " ").slice(0, 16);
  }
  function chip(text, tone) { return el("span", { class: tone ? "chip " + tone : "chip", text: text }); }
  function idCell(value) {
    if (!value) return document.createTextNode("\\u2014");
    return el("code", { title: value, text: String(value).slice(0, 8) });
  }
  function proseCell(value, cap) {
    var raw = String(value === null || value === undefined ? "" : value).trim();
    if (!raw) return document.createTextNode("\\u2014");
    if (raw.length <= cap) return el("span", { class: "prose", text: raw });
    var d = el("details");
    d.appendChild(el("summary", { class: "prose", text: raw.slice(0, cap) + "\\u2026" }));
    d.appendChild(el("div", { class: "full prose", text: raw }));
    return d;
  }
  function groupBy(rows, key) {
    var m = {};
    for (var i = 0; i < rows.length; i += 1) { var k = rows[i][key]; (m[k] = m[k] || []).push(rows[i]); }
    return m;
  }
  function indexBy(rows, key) { var m = {}; for (var i = 0; i < rows.length; i += 1) m[rows[i][key]] = rows[i]; return m; }
  function cmp(a, b) { return a < b ? -1 : a > b ? 1 : 0; }

  var sessionById = indexBy(D.sessions, "id");
  var ivBy = groupBy(D.interventions, "incidentId");
  var vfBy = groupBy(D.verifications, "incidentId");
  var piBy = groupBy(D.practiceItems, "incidentId");
  var rtBy = groupBy(D.reviewTasks, "incidentId");
  var exBy = groupBy(D.experiences, "incidentId");
  var wdBy = groupBy(D.watchdogEvents, "incidentId");

  var LOOPS = D.incidents.map(function (inc) {
    var session = sessionById[inc.sessionId] || null;
    var vfs = (vfBy[inc.id] || []).slice().sort(function (a, b) { return cmp(a.createdAt, b.createdAt); });
    var confirmed = vfs.filter(function (v) { return v.finalVerdict; });
    var last = confirmed.length ? confirmed[confirmed.length - 1] : null;
    var outcome = last ? last.finalVerdict : inc.status === "escalated" ? "escalated" : inc.status === "unresolved" ? "unresolved" : "open";
    var drafts = (piBy[inc.id] || []).slice().sort(function (a, b) { return a.round - b.round || cmp(a.createdAt, b.createdAt); });
    var ivs = (ivBy[inc.id] || []).slice().sort(function (a, b) { return a.round - b.round || cmp(a.createdAt, b.createdAt); });
    var hay = [inc.hypothesis, session ? session.goal : "", session ? session.topicKey : ""];
    ivs.forEach(function (x) { hay.push(x.rationale, x.expectedSignal); });
    drafts.forEach(function (x) { hay.push(x.taskText, x.expectedAnswerSketch); });
    vfs.forEach(function (x) { hay.push(x.prompt, x.rubric); });
    return {
      incident: inc, session: session, interventions: ivs, verifications: vfs, drafts: drafts,
      reviews: rtBy[inc.id] || [], experiences: exBy[inc.id] || [], watchdog: wdBy[inc.id] || [],
      confirmedVerification: last,
      outcome: outcome,
      rejected: drafts.filter(function (d) { return d.status === "rejected"; }),
      haystack: hay.join(" ").toLowerCase()
    };
  });

  var TONE = { resolved: "chip-moss", partial: "chip-pen", unresolved: "chip-rust", escalated: "chip-rust", open: "" };
  var FILL = { resolved: "f-moss", partial: "f-pen", unresolved: "f-rust", escalated: "f-rust", open: "f-dust" };
  var SWATCH = { resolved: "moss", partial: "pen", unresolved: "rust", escalated: "rust", open: "dust" };

  // ---- filters ---------------------------------------------------------------------------
  var PAGE_SIZE = 40;
  var state = { participant: "", dataset: "", condition: "", difficulty: "", outcome: "", q: "", sort: "new", view: "loops", shown: PAGE_SIZE };
  function uniq(values) {
    var seen = {}, out = [];
    values.forEach(function (v) { if (v && !seen[v]) { seen[v] = 1; out.push(v); } });
    return out.sort();
  }
  function fillSelect(node, anyKey, options, current) {
    node.textContent = "";
    node.appendChild(el("option", { value: "", text: T(anyKey) }));
    options.forEach(function (opt) { node.appendChild(el("option", { value: opt.value, text: opt.text })); });
    node.value = current;
  }
  function syncControls() {
    fillSelect(document.getElementById("f-participant"), "anyParticipant",
      uniq(D.sessions.map(function (s) { return s.participantId; })).map(function (v) { return { value: v, text: v }; }), state.participant);
    fillSelect(document.getElementById("f-dataset"), "anyDataset",
      uniq(D.sessions.map(function (s) { return s.datasetKind; })).map(function (v) { return { value: v, text: L("datasetKind", v) }; }), state.dataset);
    fillSelect(document.getElementById("f-condition"), "anyCondition",
      uniq(D.sessions.map(function (s) { return s.condition; })).map(function (v) { return { value: v, text: L("condition", v) }; }), state.condition);
    fillSelect(document.getElementById("f-difficulty"), "anyDifficulty",
      uniq(D.incidents.map(function (i) { return i.difficultyType; })).map(function (v) { return { value: v, text: L("difficultyType", v) }; }), state.difficulty);
    fillSelect(document.getElementById("f-outcome"), "anyOutcome",
      ["resolved", "partial", "unresolved", "escalated", "open"].map(function (v) { return { value: v, text: L("outcome", v) }; }), state.outcome);
    fillSelect(document.getElementById("f-sort"), "sortNew",
      [{ value: "old", text: T("sortOld") }, { value: "drafts", text: T("sortDrafts") }, { value: "rounds", text: T("sortRounds") }], state.sort === "new" ? "" : state.sort);
    var q = document.getElementById("f-q");
    q.placeholder = T("search");
    q.value = state.q;
    document.getElementById("f-reset").textContent = T("reset");
    var views = document.querySelectorAll("[data-view]");
    for (var i = 0; i < views.length; i += 1) {
      var v = views[i].getAttribute("data-view");
      views[i].textContent = v === "loops" ? T("viewLoops") : T("viewTables");
      views[i].setAttribute("aria-pressed", String(v === state.view));
    }
    document.getElementById("scope").textContent = META.participantId ? T("scopeOne") + META.participantId : T("scopeAll");
    document.getElementById("meta").textContent = T("metaLine", { t: fmtTime(META.exportedAt) });
    var link = document.getElementById("jsonlink");
    link.href = "/api/learning/export?includeMessages=true" + (META.participantId ? "&participantId=" + encodeURIComponent(META.participantId) : "");
    var keyNode = document.getElementById("spinekey");
    keyNode.querySelector("summary").textContent = T("keyTitle");
    var list = keyNode.querySelector("ul");
    list.textContent = "";
    ["key1", "key2", "key3", "key4"].forEach(function (k) { list.appendChild(el("li", { text: T(k) })); });
  }
  function visible() {
    var q = state.q.trim().toLowerCase();
    var rows = LOOPS.filter(function (loop) {
      var s = loop.session;
      if (state.participant && (!s || s.participantId !== state.participant)) return false;
      if (state.dataset && (!s || s.datasetKind !== state.dataset)) return false;
      if (state.condition && (!s || s.condition !== state.condition)) return false;
      if (state.difficulty && loop.incident.difficultyType !== state.difficulty) return false;
      if (state.outcome && loop.outcome !== state.outcome) return false;
      if (q && loop.haystack.indexOf(q) === -1) return false;
      return true;
    });
    rows.sort(function (a, b) {
      if (state.sort === "drafts") return b.drafts.length - a.drafts.length || cmp(b.incident.createdAt, a.incident.createdAt);
      if (state.sort === "rounds") return b.interventions.length - a.interventions.length || cmp(b.incident.createdAt, a.incident.createdAt);
      if (state.sort === "old") return cmp(a.incident.createdAt, b.incident.createdAt);
      return cmp(b.incident.createdAt, a.incident.createdAt);
    });
    return rows;
  }

  // ---- charts ----------------------------------------------------------------------------
  function card(titleKey, hintKey, body) {
    if (body && body.tagName === "svg") body.setAttribute("aria-label", T(titleKey) + " \u2014 " + T(hintKey));
    return el("div", { class: "card" }, [el("h3", { text: T(titleKey) }), el("p", { class: "hint", text: T(hintKey) }), body]);
  }
  function noData() { return el("p", { class: "hint", text: T("noData") }); }
  function stackedBars(rows) {
    var live = rows.filter(function (r) { return r.total > 0; });
    if (!live.length) return noData();
    var W = 320, rowH = 22, labelW = 108, barX = labelW + 4, barW = W - barX - 26;
    var max = 0;
    live.forEach(function (r) { if (r.total > max) max = r.total; });
    var svg = sv("svg", { viewBox: "0 0 " + W + " " + (live.length * rowH + 4), role: "img" });
    live.forEach(function (r, i) {
      var y = i * rowH + 4;
      var label = sv("text", { x: labelW, y: y + 11, "text-anchor": "end", class: "tick-label" }, clip(r.label, 16));
      label.appendChild(sv("title", {}, r.label));
      svg.appendChild(label);
      var x = barX;
      r.segs.forEach(function (g) {
        if (!g.n) return;
        var w = (g.n / max) * barW;
        var rect = sv("rect", { x: x, y: y + 2, width: Math.max(w, 1.5), height: 11, class: g.cls, rx: 1 });
        rect.appendChild(sv("title", {}, g.label + ": " + g.n));
        svg.appendChild(rect);
        x += w;
      });
      svg.appendChild(sv("text", { x: W - 22, y: y + 11, class: "tick-label" }, String(r.total)));
    });
    return svg;
  }
  function histogram(bins) {
    var total = bins.reduce(function (a, b) { return a + b.n; }, 0);
    if (!total) return noData();
    var W = 320, H = 86, padL = 6, barW = (W - padL * 2) / bins.length;
    var max = 0;
    bins.forEach(function (b) { if (b.n > max) max = b.n; });
    var svg = sv("svg", { viewBox: "0 0 " + W + " " + H, role: "img" });
    bins.forEach(function (b, i) {
      var h = max ? (b.n / max) * 46 : 0;
      var x = padL + i * barW + 3;
      svg.appendChild(sv("rect", { x: x, y: 62 - h, width: barW - 6, height: Math.max(h, b.n ? 2 : 0), class: b.cls || "f-pen", rx: 1 }));
      svg.appendChild(sv("text", { x: x + (barW - 6) / 2, y: Math.max(10, 58 - h), "text-anchor": "middle", class: "tick-label" }, b.n ? String(b.n) : ""));
      svg.appendChild(sv("text", { x: x + (barW - 6) / 2, y: 76, "text-anchor": "middle", class: "tick-label" }, b.label));
    });
    return svg;
  }
  function stripPlot(points) {
    if (!points.length) return noData();
    var W = 320, H = 92, x0 = 16, x1 = W - 12, axis = 62;
    var svg = sv("svg", { viewBox: "0 0 " + W + " " + H, role: "img" });
    var tx = x0 + 0.6 * (x1 - x0);
    // Shading the reject side means the reader never has to hold "above 0.6 is bad" in mind.
    svg.appendChild(sv("rect", { x: tx, y: 8, width: x1 - tx, height: axis - 8, class: "f-tag", "fill-opacity": "0.09" }));
    svg.appendChild(sv("line", { x1: x0, y1: axis, x2: x1, y2: axis, class: "s-rule", "stroke-width": "1" }));
    svg.appendChild(sv("line", { x1: tx, y1: 8, x2: tx, y2: axis, class: "s-tag", "stroke-width": "1", "stroke-dasharray": "3 3" }));
    svg.appendChild(sv("text", { x: tx + 3, y: 14, class: "tick-label" }, "0.6"));
    points.forEach(function (p, i) {
      var cx = x0 + Math.max(0, Math.min(1, p.v)) * (x1 - x0);
      var cy = 22 + ((i * 11) % 34);
      var dot = sv("circle", { cx: cx, cy: cy, r: 3.2, class: p.rejected ? "f-tag" : "f-pen", "fill-opacity": p.rejected ? "0.5" : "0.8" });
      dot.appendChild(sv("title", {}, p.title));
      svg.appendChild(dot);
    });
    [0, 0.5, 1].forEach(function (v) {
      svg.appendChild(sv("text", { x: x0 + v * (x1 - x0), y: 73, "text-anchor": "middle", class: "tick-label" }, String(v)));
    });
    svg.appendChild(sv("text", { x: x0, y: 86, "text-anchor": "start", class: "tick-label" }, T("noveltyLow")));
    svg.appendChild(sv("text", { x: x1, y: 86, "text-anchor": "end", class: "tick-label" }, T("noveltyHigh")));
    return svg;
  }
  function renderCharts(rows) {
    var host = document.getElementById("overview");
    host.textContent = "";
    var OUT = ["resolved", "partial", "unresolved", "escalated", "open"];
    var conditions = uniq(rows.map(function (r) { return r.session ? r.session.condition : ""; }));
    host.appendChild(card("chartOutcome", "chartOutcomeHint", stackedBars(conditions.map(function (c) {
      var mine = rows.filter(function (r) { return r.session && r.session.condition === c; });
      var segs = OUT.map(function (o) {
        return { n: mine.filter(function (r) { return r.outcome === o; }).length, cls: FILL[o], label: L("outcome", o) };
      });
      return { label: L("condition", c), segs: segs, total: mine.length };
    }))));

    var closed = rows.filter(function (r) { return r.incident.closedAt; });
    host.appendChild(card("chartRounds", "chartRoundsHint", histogram([1, 2, 3, 4].map(function (k) {
      var n = closed.filter(function (r) { return k === 4 ? r.interventions.length >= 4 : r.interventions.length === k; }).length;
      return { label: k === 4 ? "4+" : String(k), n: n };
    }))));

    var drafts = [];
    rows.forEach(function (r) { drafts = drafts.concat(r.drafts); });
    host.appendChild(card("chartGates", "chartGatesHint", stackedBars(["programmatic", "novelty", "evaluator", "none"].map(function (g) {
      var n = drafts.filter(function (d) { return d.gate === g; }).length;
      return { label: L("gate", g), segs: [{ n: n, cls: g === "none" ? "f-moss" : "f-tag", label: L("gate", g) }], total: n };
    }))));

    host.appendChild(card("chartNovelty", "chartNoveltyHint", stripPlot(drafts.map(function (d) {
      return { v: d.noveltyScore, rejected: d.gate === "novelty", title: L("gate", d.gate) + " \\u00b7 " + d.noveltyScore.toFixed(3) };
    }))));

    var byStrategy = {};
    rows.forEach(function (r) {
      if (!r.confirmedVerification) return;
      r.interventions.forEach(function (iv) {
        var slot = byStrategy[iv.strategy] || (byStrategy[iv.strategy] = { resolved: 0, partial: 0, unresolved: 0, total: 0 });
        var o = r.outcome === "escalated" ? "unresolved" : r.outcome;
        if (slot[o] !== undefined) { slot[o] += 1; slot.total += 1; }
      });
    });
    var legend = el("div", { class: "legend" });
    ["resolved", "partial", "unresolved", "escalated", "open"].forEach(function (o) {
      legend.appendChild(el("i", { class: FILL[o], style: "background:var(--" + SWATCH[o] + ")" }));
      legend.appendChild(el("span", { text: L("outcome", o) }));
    });
    legend.appendChild(el("i", { style: "background:var(--tag)" }));
    legend.appendChild(el("span", { text: T("legendGate") }));
    legend.appendChild(el("i", { class: "hollow" }));
    legend.appendChild(el("span", { text: T("legendHollow") }));
    host.appendChild(card("chartLegend", "chartLegendHint", legend));

    host.appendChild(card("chartStrategy", "chartStrategyHint", stackedBars(Object.keys(byStrategy)
      .sort(function (a, b) { return byStrategy[b].total - byStrategy[a].total; })
      .map(function (k) {
        var slot = byStrategy[k];
        return {
          label: L("strategy", k), total: slot.total,
          segs: [
            { n: slot.resolved, cls: "f-moss", label: L("outcome", "resolved") },
            { n: slot.partial, cls: "f-pen", label: L("outcome", "partial") },
            { n: slot.unresolved, cls: "f-rust", label: L("outcome", "unresolved") }
          ]
        };
      }))));
  }

  // ---- the spine: this project's picture of one loop --------------------------------------
  function spineSummary(loop) {
    return [T("rounds", { n: loop.interventions.length }), T("drafts", { n: loop.drafts.length }),
      T("rejected", { n: loop.rejected.length }), L("outcome", loop.outcome)].join(" \\u00b7 ");
  }
  function spine(loop) {
    var base = 52, x0 = 44, xEnd = 660;
    var svg = sv("svg", { viewBox: "0 0 720 100", class: "spine", preserveAspectRatio: "xMidYMid meet", role: "img", "aria-label": spineSummary(loop) });
    svg.appendChild(sv("title", {}, spineSummary(loop)));
    svg.appendChild(sv("line", { x1: x0, y1: base, x2: xEnd, y2: base, class: "s-rule", "stroke-width": "2" }));
    svg.appendChild(sv("rect", { x: x0 - 4, y: base - 4, width: 8, height: 8, class: "f-pen" }));
    var ivs = loop.interventions, n = ivs.length;
    // Rounds spread evenly between "noticed" and the verdict, so a one-round loop does not
    // leave most of the track empty.
    var xs = [];
    for (var i = 0; i < n; i += 1) xs.push(x0 + ((i + 1) * (xEnd - x0)) / (n + 1));
    ivs.forEach(function (iv, i) {
      var x = xs[i];
      svg.appendChild(sv("path", { d: "M" + x + " " + (base - 6) + "L" + (x + 6) + " " + base + "L" + x + " " + (base + 6) + "L" + (x - 6) + " " + base + "Z", class: "f-pen" }));
      var label = sv("text", { x: x, y: base - 13, "text-anchor": "middle", class: "tick-label" }, clip(L("strategy", iv.strategy), lang === "en" ? 16 : 11));
      label.appendChild(sv("title", {}, L("strategy", iv.strategy) + " \\u00b7 " + iv.rationale));
      svg.appendChild(label);
    });
    var byRound = groupBy(loop.drafts, "round");
    var tickXs = [];
    Object.keys(byRound).forEach(function (round) {
      var group = byRound[round];
      var idx = Math.max(0, Math.min(xs.length - 1, Number(round) - 1));
      var mx = xs.length ? xs[idx] : (x0 + xEnd) / 2;
      group.forEach(function (d, j) {
        var x = mx + (j - (group.length - 1) / 2) * 10;
        var h = Math.max(2.5, Math.min(1, d.noveltyScore) * 30);
        var rejected = d.status === "rejected";
        tickXs.push(x);
        var attrs = { x: x - 3, y: base + 8, width: 6, height: h, rx: 0.5 };
        if (rejected) { attrs.class = "s-tag"; attrs.fill = "none"; attrs["stroke-width"] = "1"; }
        else { attrs.class = d.status === "expired" ? "f-dust" : "f-tag"; attrs["fill-opacity"] = d.status === "expired" ? "0.4" : "0.85"; }
        var rect = sv("rect", attrs);
        rect.appendChild(sv("title", {}, L("practiceStatus", d.status) + " \\u00b7 " + L("gate", d.gate) + " \\u00b7 " + T("draftNovelty", { n: d.noveltyScore.toFixed(3) })));
        svg.appendChild(rect);
        if (rejected) {
          var letter = d.gate === "programmatic" ? "P" : d.gate === "novelty" ? "N" : d.gate === "evaluator" ? "E" : "?";
          svg.appendChild(sv("text", { x: x, y: base + 48, "text-anchor": "middle", class: "tick-label" }, letter));
        }
      });
    });
    if (tickXs.length) {
      // The threshold is a local reference for the bars beneath it, not a rule across the page.
      var lo = Math.min.apply(null, tickXs) - 14, hi = Math.max.apply(null, tickXs) + 14;
      var ty = base + 8 + 0.6 * 30;
      svg.appendChild(sv("line", { x1: lo, y1: ty, x2: hi, y2: ty, class: "s-tag", "stroke-width": "0.75", "stroke-dasharray": "3 4", "stroke-opacity": "0.7" }));
      svg.appendChild(sv("text", { x: lo - 4, y: ty + 3, "text-anchor": "end", class: "tick-label" }, ".6"));
    }
    svg.appendChild(sv("circle", { cx: xEnd, cy: base, r: 7, class: FILL[loop.outcome] || "f-dust", "fill-opacity": loop.outcome === "open" ? "0.35" : "1" }));
    svg.appendChild(sv("text", { x: xEnd, y: base + 21, "text-anchor": "middle", class: "tick-label" }, clip(L("outcome", loop.outcome), lang === "en" ? 14 : 12)));
    if (loop.reviews.length) {
      var fired = loop.reviews.some(function (t) { return t.status === "fired" || t.status === "completed"; });
      var glyph = sv("circle", fired
        ? { cx: 702, cy: base, r: 5, class: "f-pen" }
        : { cx: 702, cy: base, r: 5, class: "s-pen", fill: "none", "stroke-width": "1.2" });
      glyph.appendChild(sv("title", {}, fired ? T("reviewFired") : T("reviewBooked")));
      svg.appendChild(glyph);
    }
    return svg;
  }

  // ---- loop cards ------------------------------------------------------------------------
  function draftBlock(d) {
    var rejected = d.status === "rejected";
    var verdict = d.evaluatorVerdict && typeof d.evaluatorVerdict === "object" ? d.evaluatorVerdict : null;
    // Reviewer reasons explain a rejection. A fail-open verdict means the reviewer never
    // answered and the draft was let through — a note about the run, not about the task.
    var failedOpen = Boolean(verdict) && verdict.status === "error";
    var reasons = !failedOpen && d.gate !== "none" && verdict && Array.isArray(verdict.reasons) ? verdict.reasons.join(" \\u00b7 ") : "";
    return el("div", { class: rejected ? "draft rejected" : "draft" }, [
      el("div", { class: "line" }, [
        chip(T("roundNo", { n: d.round }), ""),
        chip(L("practiceStatus", d.status), rejected ? "chip-tag" : "chip-moss"),
        chip(L("gate", d.gate), d.gate === "none" ? "" : "chip-tag"),
        chip(T("draftNovelty", { n: d.noveltyScore.toFixed(3) }), d.gate === "novelty" ? "chip-tag" : ""),
        chip(L("method", d.method), ""),
        chip(L("practiceSource", d.source), "")
      ]),
      el("p", { class: "prose", text: d.taskText }),
      d.expectedAnswerSketch ? el("p", { class: "prose", text: T("draftAnswer") + ": " + d.expectedAnswerSketch }) : null,
      reasons ? el("p", { class: "why", text: reasons }) : null,
      failedOpen ? el("p", { class: "hint", text: T("failedOpen") }) : null
    ]);
  }
  function loopCard(loop) {
    var inc = loop.incident, ses = loop.session;
    var headChips = [];
    if (loop.outcome === "open") headChips.push(chip(L("incidentStatus", inc.status), ""));
    else {
      headChips.push(chip(L("outcome", loop.outcome), TONE[loop.outcome] || ""));
      if (inc.status !== loop.outcome) headChips.push(chip(L("incidentStatus", inc.status), ""));
    }
    var head = el("div", { class: "loop-head" }, [
      headChips,
      chip(L("difficultyType", inc.difficultyType), ""),
      ses ? chip(L("condition", ses.condition), "chip-pen") : null,
      ses ? chip(L("datasetKind", ses.datasetKind), "") : null,
      ses ? chip(ses.participantId, "") : null,
      el("span", { class: "grow" }),
      el("span", { class: "eyebrow", text: fmtTime(inc.createdAt) })
    ]);
    var foot = el("div", { class: "loop-foot" }, [
      el("span", { text: T("rounds", { n: loop.interventions.length }) }),
      el("span", { text: T("drafts", { n: loop.drafts.length }) + (loop.rejected.length ? " / " + T("rejected", { n: loop.rejected.length }) : "") }),
      el("span", { text: T("evidence", { n: inc.evidenceCount }) }),
      el("span", { text: T("confidence", { n: Math.round(inc.confidence * 100) }) }),
      loop.confirmedVerification
        ? el("a", { href: "/api/learning/incidents/" + encodeURIComponent(inc.id) + "/report.html", target: "_blank", rel: "noreferrer", text: T("openReport") })
        : null
    ]);
    var kids = [head, el("h2", { class: "prose", text: inc.hypothesis })];
    if (ses && ses.goal) kids.push(el("p", { class: "goal prose", text: ses.goal }));
    kids.push(el("div", { class: "spine-wrap" }, [spine(loop)]));
    kids.push(foot);
    if (loop.drafts.length) {
      var box = el("details", { class: "drafts" });
      box.appendChild(el("summary", { text: T("draftsTitle") }));
      loop.drafts.forEach(function (d) { box.appendChild(draftBlock(d)); });
      kids.push(box);
    }
    return el("article", { class: "loop", id: "loop-" + inc.id }, kids);
  }
  function renderLoops(rows) {
    var host = document.getElementById("loops");
    host.textContent = "";
    if (!rows.length) {
      host.appendChild(el("div", { class: "empty" }, [el("p", { text: T("emptyTitle") }), el("p", { class: "hint", text: T("emptyHint") })]));
      return;
    }
    // Paged, never silently truncated: the button says exactly how many are still out of view.
    var page = rows.slice(0, state.shown);
    var frag = document.createDocumentFragment();
    page.forEach(function (loop) { frag.appendChild(loopCard(loop)); });
    host.appendChild(el("div", { class: "fade" }, [frag]));
    if (rows.length > page.length) {
      var rest = rows.length - page.length;
      var more = el("button", { type: "button", class: "more", text: T("more", { n: rest, step: Math.min(PAGE_SIZE, rest) }) });
      more.addEventListener("click", function () { state.shown += PAGE_SIZE; renderAll(); });
      host.appendChild(more);
    }
  }

  // ---- raw tables ------------------------------------------------------------------------
  function verdictCell(value) {
    if (!value || typeof value !== "object") return document.createTextNode("\\u2014");
    var reasons = Array.isArray(value.reasons) ? value.reasons.join(" \\u00b7 ") : "";
    var wrap = el("span", {}, [chip(String(value.status || "\\u2014"), value.status === "reject" ? "chip-tag" : "")]);
    if (reasons) wrap.appendChild(proseCell(reasons, 60));
    return wrap;
  }
  var TABLES = [
    { id: "sessions", title: "tabSessions", hint: "tabSessionsHint",
      rows: function (c) { return D.sessions.filter(function (r) { return c.sessions[r.id]; }); },
      cols: [
        { h: "colId", c: function (r) { return idCell(r.id); } },
        { h: "hParticipant", c: function (r) { return r.participantId; } },
        { h: "hCondition", c: function (r) { return L("condition", r.condition); } },
        { h: "hDataset", c: function (r) { return L("datasetKind", r.datasetKind); } },
        { h: "hStatus", c: function (r) { return L("sessionStatus", r.status); } },
        { h: "hGoal", c: function (r) { return proseCell(r.goal, 110); } },
        { h: "hCreated", c: function (r) { return fmtTime(r.createdAt); } }
      ] },
    { id: "incidents", title: "tabIncidents", hint: "tabIncidentsHint",
      rows: function (c) { return D.incidents.filter(function (r) { return c.incidents[r.id]; }); },
      cols: [
        { h: "colId", c: function (r) { return idCell(r.id); } },
        { h: "hSession", c: function (r) { return idCell(r.sessionId); } },
        { h: "hDifficulty", c: function (r) { return L("difficultyType", r.difficultyType); } },
        { h: "hStatus", c: function (r) { return L("incidentStatus", r.status); } },
        { h: "hHypothesis", c: function (r) { return proseCell(r.hypothesis, 150); } },
        { h: "hConfidence", c: function (r) { return String(r.confidence); } },
        { h: "hCreated", c: function (r) { return fmtTime(r.createdAt); } }
      ] },
    { id: "interventions", title: "tabInterventions", hint: "tabInterventionsHint",
      rows: function (c) { return D.interventions.filter(function (r) { return c.incidents[r.incidentId]; }); },
      cols: [
        { h: "hIncident", c: function (r) { return idCell(r.incidentId); } },
        { h: "hRound", c: function (r) { return String(r.round); } },
        { h: "hStrategy", c: function (r) { return L("strategy", r.strategy); } },
        { h: "hRationale", c: function (r) { return proseCell(r.rationale, 150); } },
        { h: "hSignal", c: function (r) { return proseCell(r.expectedSignal, 110); } }
      ] },
    { id: "practiceItems", title: "tabPractice", hint: "tabPracticeHint",
      rows: function (c) { return D.practiceItems.filter(function (r) { return c.incidents[r.incidentId]; }); },
      cols: [
        { h: "colId", c: function (r) { return idCell(r.id); } },
        { h: "hIncident", c: function (r) { return idCell(r.incidentId); } },
        { h: "hRound", c: function (r) { return String(r.round); } },
        { h: "hSource", c: function (r) { return L("practiceSource", r.source); } },
        { h: "hStatus", c: function (r) { return chip(L("practiceStatus", r.status), r.status === "rejected" ? "chip-tag" : ""); } },
        { h: "hGate", c: function (r) { return chip(L("gate", r.gate), r.gate === "none" ? "chip-moss" : "chip-tag"); } },
        { h: "hNovelty", c: function (r) { return r.noveltyScore.toFixed(3); } },
        { h: "hEvaluator", c: function (r) { return verdictCell(r.evaluatorVerdict); } },
        { h: "hMethod", c: function (r) { return L("method", r.method); } },
        { h: "hTask", c: function (r) { return proseCell(r.taskText, 170); } },
        { h: "hAnswer", c: function (r) { return proseCell(r.expectedAnswerSketch, 110); } }
      ] },
    { id: "verifications", title: "tabVerifications", hint: "tabVerificationsHint",
      rows: function (c) { return D.verifications.filter(function (r) { return c.incidents[r.incidentId]; }); },
      cols: [
        { h: "hIncident", c: function (r) { return idCell(r.incidentId); } },
        { h: "hMethod", c: function (r) { return L("method", r.method); } },
        { h: "hFromDraft", c: function (r) { return r.practiceItemId ? chip(T("fromDraftYes"), "chip-moss") : chip(T("fromDraftNo"), ""); } },
        { h: "hPrompt", c: function (r) { return proseCell(r.prompt, 170); } },
        { h: "hSystem", c: function (r) { return L("outcome", r.systemVerdict); } },
        { h: "hConfidence", c: function (r) { return r.systemConfidence === null ? "\\u2014" : String(r.systemConfidence); } },
        { h: "hFinal", c: function (r) { return r.finalVerdict ? chip(L("outcome", r.finalVerdict), TONE[r.finalVerdict] || "") : chip(T("awaiting"), ""); } },
        { h: "hCreated", c: function (r) { return fmtTime(r.createdAt); } }
      ] },
    { id: "experiences", title: "tabExperiences", hint: "tabExperiencesHint",
      rows: function (c) { return D.experiences.filter(function (r) { return c.incidents[r.incidentId]; }); },
      cols: [
        { h: "hIncident", c: function (r) { return idCell(r.incidentId); } },
        { h: "hParticipant", c: function (r) { return r.participantId; } },
        { h: "hStrategy", c: function (r) { return L("strategy", r.strategy); } },
        { h: "hOutcome", c: function (r) { return chip(L("outcome", r.outcome), TONE[r.outcome] || ""); } },
        { h: "hDataset", c: function (r) { return L("datasetKind", r.datasetKind); } },
        { h: "hVariant", c: function (r) { return idCell(r.strategyVariantId); } },
        { h: "hTime", c: function (r) { return fmtTime(r.createdAt); } }
      ] },
    { id: "strategyVariants", title: "tabVariants", hint: "tabVariantsHint",
      rows: function (c) { return D.strategyVariants.filter(function (r) { return !c.participantFilter || r.participantId === c.participantFilter; }); },
      cols: [
        { h: "colId", c: function (r) { return idCell(r.id); } },
        { h: "hParticipant", c: function (r) { return r.participantId; } },
        { h: "hStrategy", c: function (r) { return L("strategy", r.baseStrategy); } },
        { h: "hTitle", c: function (r) { return proseCell(r.title, 70); } },
        { h: "hStatus", c: function (r) { return L("variantStatus", r.status); } },
        { h: "hUsed", c: function (r) { return String(r.attributedCount); } },
        { h: "hAdvice", c: function (r) { return r.recommendation || "\\u2014"; } }
      ] },
    { id: "policyRevisions", title: "tabPolicies", hint: "tabPoliciesHint",
      rows: function (c) { return D.policyRevisions.filter(function (r) { return !c.participantFilter || r.participantId === c.participantFilter; }); },
      cols: [
        { h: "colId", c: function (r) { return idCell(r.id); } },
        { h: "hParticipant", c: function (r) { return r.participantId; } },
        { h: "hDifficulty", c: function (r) { return L("difficultyType", r.difficultyType); } },
        { h: "hDataset", c: function (r) { return L("datasetKind", r.datasetKind); } },
        { h: "hStatus", c: function (r) { return L("policyStatus", r.status); } },
        { h: "hOrder", c: function (r) { return proseCell((r.orderedStrategies || []).map(function (x) { return L("strategy", x); }).join(" \\u203a "), 90); } },
        { h: "hSummary", c: function (r) { return proseCell(r.evaluationSummary, 120); } }
      ] },
    { id: "reviewTasks", title: "tabReviews", hint: "tabReviewsHint",
      rows: function (c) { return D.reviewTasks.filter(function (r) { return c.incidents[r.incidentId]; }); },
      cols: [
        { h: "hIncident", c: function (r) { return idCell(r.incidentId); } },
        { h: "hParticipant", c: function (r) { return r.participantId; } },
        { h: "hRound", c: function (r) { return String(r.round); } },
        { h: "hDue", c: function (r) { return fmtTime(r.dueAt); } },
        { h: "hStatus", c: function (r) { return chip(L("reviewStatus", r.status), r.status === "fired" || r.status === "completed" ? "chip-pen" : ""); } }
      ] },
    { id: "watchdogEvents", title: "tabWatchdog", hint: "tabWatchdogHint",
      rows: function (c) { return D.watchdogEvents.filter(function (r) { return c.incidents[r.incidentId]; }); },
      cols: [
        { h: "hSession", c: function (r) { return idCell(r.sessionId); } },
        { h: "hIncident", c: function (r) { return idCell(r.incidentId); } },
        { h: "hSignature", c: function (r) { return el("code", { text: clip(r.signature, 28), title: r.signature }); } },
        { h: "hAction", c: function (r) { return chip(L("watchdogAction", r.action), r.action === "gave_up" ? "chip-rust" : ""); } },
        { h: "hTime", c: function (r) { return fmtTime(r.createdAt); } }
      ] }
  ];
  function renderTables(rows) {
    var host = document.getElementById("tables");
    host.textContent = "";
    var ctx = { incidents: {}, sessions: {}, participantFilter: "" };
    rows.forEach(function (loop) {
      ctx.incidents[loop.incident.id] = 1;
      if (loop.session) ctx.sessions[loop.session.id] = 1;
    });
    // Participant-owned tables answer to the participant filter alone: a person's invented
    // moves and policy revisions outlive any single loop, so a loop filter must not hide them.
    ctx.participantFilter = state.participant;
    TABLES.forEach(function (spec) {
      var data = spec.rows(ctx);
      var wrap = el("section", { class: "tablewrap" }, [
        el("h2", {}, [T(spec.title), el("span", { class: "hint", style: "font-weight:400", text: " " + data.length })]),
        el("p", { class: "hint", text: T(spec.hint) })
      ]);
      if (!data.length) { wrap.appendChild(el("p", { class: "hint", text: T("none") })); host.appendChild(wrap); return; }
      var thead = el("thead", {}, [el("tr", {}, spec.cols.map(function (col) { return el("th", { text: T(col.h) }); }))]);
      var tbody = el("tbody", {}, data.map(function (row) {
        return el("tr", {}, spec.cols.map(function (col) { return el("td", {}, col.c(row)); }));
      }));
      wrap.appendChild(el("div", { class: "scroll" }, [el("table", {}, [thead, tbody])]));
      host.appendChild(wrap);
    });
  }

  function renderAll() {
    syncControls();
    var rows = visible();
    document.getElementById("tally").textContent = T("tally", { n: rows.length, total: LOOPS.length });
    renderCharts(rows);
    var loopsHost = document.getElementById("loops"), tablesHost = document.getElementById("tables");
    loopsHost.hidden = state.view !== "loops";
    tablesHost.hidden = state.view !== "tables";
    document.getElementById("spinekey").hidden = state.view !== "loops";
    if (state.view === "loops") { renderLoops(rows); tablesHost.textContent = ""; }
    else { renderTables(rows); loopsHost.textContent = ""; }
  }

  var BIND = { "f-participant": "participant", "f-dataset": "dataset", "f-condition": "condition", "f-difficulty": "difficulty", "f-outcome": "outcome" };
  Object.keys(BIND).forEach(function (id) {
    document.getElementById(id).addEventListener("change", function (event) { state[BIND[id]] = event.target.value; state.shown = PAGE_SIZE; renderAll(); });
  });
  document.getElementById("f-sort").addEventListener("change", function (event) { state.sort = event.target.value || "new"; state.shown = PAGE_SIZE; renderAll(); });
  var debounce;
  document.getElementById("f-q").addEventListener("input", function (event) {
    var value = event.target.value;
    window.clearTimeout(debounce);
    debounce = window.setTimeout(function () { state.q = value; state.shown = PAGE_SIZE; renderAll(); }, 140);
  });
  document.getElementById("f-reset").addEventListener("click", function () {
    state.participant = ""; state.dataset = ""; state.condition = ""; state.difficulty = ""; state.outcome = ""; state.q = ""; state.sort = "new"; state.shown = PAGE_SIZE;
    renderAll();
  });
  document.getElementById("filters").addEventListener("submit", function (event) { event.preventDefault(); });
  var viewButtons = document.querySelectorAll("[data-view]");
  for (var b = 0; b < viewButtons.length; b += 1) {
    viewButtons[b].addEventListener("click", function (event) { state.view = event.currentTarget.getAttribute("data-view"); renderAll(); });
  }
  window.fieldnoteOnLang = function (next) { lang = next === "en" ? "en" : "zh"; renderAll(); };
  renderAll();
})();
`;
