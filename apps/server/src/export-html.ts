import type { LearningStore } from "./learning-store.js";

type ResearchExport = ReturnType<LearningStore["exportResearch"]>;

/**
 * Human-readable rendering of the research export. Same payload as the JSON endpoint
 * (already redacted by the caller), laid out as one self-contained HTML page: a browser
 * tab for reading, while the JSON + codebook stay the machine-readable source of truth.
 * Every interpolated string goes through escapeHtml — task texts and goals are learner
 * input and must never execute in the researcher's browser.
 */
export function renderResearchExportHtml(
  data: ResearchExport,
  meta: { exportedAt: string; participantId: string | null }
): string {
  const esc = escapeHtml;
  const shortId = (value: string | null | undefined): string =>
    value ? `<code title="${esc(value)}">${esc(value.slice(0, 8))}</code>` : "—";
  const text = (value: string | null | undefined, cap = 240): string => {
    const raw = (value ?? "").trim();
    if (!raw) return "—";
    if (raw.length <= cap) return esc(raw);
    return `<details><summary>${esc(raw.slice(0, cap))}…</summary><div class="full">${esc(raw)}</div></details>`;
  };
  const when = (value: string | null | undefined): string => (value ? esc(value.replace("T", " ").slice(0, 19)) : "—");
  const table = (title: string, note: string, headers: string[], rows: string[][]): string => `
    <section>
      <h2>${esc(title)} <small>${rows.length} 条</small></h2>
      ${note ? `<p class="note">${esc(note)}</p>` : ""}
      ${
        rows.length === 0
          ? '<p class="empty">（无记录）</p>'
          : `<div class="scroll"><table><thead><tr>${headers
              .map((header) => `<th>${esc(header)}</th>`)
              .join("")}</tr></thead><tbody>${rows
              .map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join("")}</tr>`)
              .join("")}</tbody></table></div>`
      }
    </section>`;

  const counts: Array<[string, number]> = [
    ["会话", data.sessions.length],
    ["工单", data.incidents.length],
    ["干预", data.interventions.length],
    ["验证", data.verifications.length],
    ["练习题记", data.practiceItems.length],
    ["经验", data.experiences.length],
    ["讲法", data.strategyVariants.length],
    ["策略修订", data.policyRevisions.length],
    ["复习任务", data.reviewTasks.length],
    ["看门狗事件", data.watchdogEvents.length],
    ["交接报告", data.handoffs.length]
  ];

  const verdictBadge = (verdict: unknown): string => {
    if (!verdict || typeof verdict !== "object") return "—";
    const raw = verdict as { status?: string; reasons?: string[] };
    const reasons = (raw.reasons ?? []).join("；");
    return `${esc(raw.status ?? "—")}${reasons ? ` <small title="${esc(reasons)}">(${esc(reasons.slice(0, 60))}${reasons.length > 60 ? "…" : ""})</small>` : ""}`;
  };

  const body = [
    table(
      "会话 sessions",
      "每条学习会话:研究条件是分组变量;participantId 标记谁在学(default 混有加列前的全部历史)。",
      ["ID", "参与者", "条件", "数据集", "执行", "状态", "学习目标", "创建时间"],
      data.sessions.map((session) => [
        shortId(session.id),
        esc(session.participantId),
        esc(session.condition),
        esc(session.datasetKind),
        esc(session.executionMode),
        esc(session.status),
        text(session.goal, 120),
        when(session.createdAt)
      ])
    ),
    table(
      "工单 incidents",
      "一次被诊断的学习困难:假设是导师对误解的判断,置信度 0–1。",
      ["ID", "会话", "困难类型", "状态", "诊断假设", "置信度", "创建时间"],
      data.incidents.map((incident) => [
        shortId(incident.id),
        shortId(incident.sessionId),
        esc(incident.difficultyType),
        esc(incident.status),
        text(incident.hypothesis, 160),
        esc(String(incident.confidence)),
        when(incident.createdAt)
      ])
    ),
    table(
      "干预 interventions",
      "每轮教学动作:策略八选一,round 是轮次(on-call ≤3)。",
      ["工单", "轮", "策略", "理由", "预期信号"],
      data.interventions.map((intervention) => [
        shortId(intervention.incidentId),
        esc(String(intervention.round)),
        esc(intervention.strategy),
        text(intervention.rationale, 160),
        text(intervention.expectedSignal, 120)
      ])
    ),
    table(
      "练习题记 practiceItems",
      "回路内出题的完整台账——含被拒草稿。gate 是拦下它的门(programmatic/novelty/evaluator;通过为 none);novelty 是与学习者已见文本的最高相似度(>0.6 硬拒)。",
      ["ID", "工单", "轮", "来源", "状态", "门", "查重分", "Evaluator", "方法", "题面", "预期答案要点"],
      data.practiceItems.map((item) => [
        shortId(item.id),
        shortId(item.incidentId),
        esc(String(item.round)),
        esc(item.source),
        esc(item.status),
        esc(item.gate),
        esc(item.noveltyScore.toFixed(3)),
        verdictBadge(item.evaluatorVerdict),
        esc(item.method),
        text(item.taskText, 200),
        text(item.expectedAnswerSketch, 120)
      ])
    ),
    table(
      "验证 verifications",
      "发给学习者的理解检查。题记✓表示题面由宿主从过审题记逐字复制;系统判定之后仍需学习者确认(finalVerdict)。",
      ["工单", "方法", "题记", "题面", "系统判定", "置信度", "最终判定", "创建时间"],
      data.verifications.map((verification) => [
        shortId(verification.incidentId),
        esc(verification.method),
        verification.practiceItemId ? `✓ ${shortId(verification.practiceItemId)}` : "散文",
        text(verification.prompt, 200),
        esc(verification.systemVerdict ?? "—"),
        verification.systemConfidence === null ? "—" : esc(String(verification.systemConfidence)),
        esc(verification.finalVerdict ?? "待确认"),
        when(verification.createdAt)
      ])
    ),
    table(
      "经验 experiences",
      "只有学习者确认的结果才会写入,是策略自进化的唯一燃料;按参与者隔离。",
      ["工单", "参与者", "策略", "结果", "数据集", "讲法", "时间"],
      data.experiences.map((experience) => [
        shortId(experience.incidentId),
        esc(experience.participantId),
        esc(experience.strategy),
        esc(experience.outcome),
        esc(experience.datasetKind),
        experience.strategyVariantId ? shortId(experience.strategyVariantId) : "—",
        when(experience.createdAt)
      ])
    ),
    table(
      "讲法 strategyVariants",
      "自发明的具体教学方式(挂在八个基础策略下),每次状态变更都过人审。",
      ["ID", "参与者", "基础策略", "标题", "状态", "归因数", "建议"],
      data.strategyVariants.map((variant) => [
        shortId(variant.id),
        esc(variant.participantId),
        esc(variant.baseStrategy),
        text(variant.title, 60),
        esc(variant.status),
        esc(String(variant.attributedCount)),
        esc(variant.recommendation ?? "—")
      ])
    ),
    table(
      "策略修订 policyRevisions",
      "受控策略演进:候选顺序由证据生成,启用/拒绝/回滚都是人的决定。",
      ["ID", "参与者", "困难类型", "数据集", "状态", "说明"],
      data.policyRevisions.map((policy) => [
        shortId(policy.id),
        esc(policy.participantId),
        esc(policy.difficultyType),
        esc(policy.datasetKind),
        esc(policy.status),
        text(policy.evaluationSummary, 160)
      ])
    ),
    table(
      "复习任务 reviewTasks",
      "间隔复习:resolved 后预订的回访,到期由真实 Agent 回到原对话出新迁移题。",
      ["工单", "参与者", "轮", "到期时间", "状态"],
      data.reviewTasks.map((task) => [
        shortId(task.incidentId),
        esc(task.participantId),
        esc(String(task.round)),
        when(new Date(task.dueAt).toISOString()),
        esc(task.status)
      ])
    ),
    table(
      "看门狗事件 watchdogEvents",
      "回路停摆台账:nudged=已提醒,gave_up=提醒后仍停摆;会话健康指标全部可由本表复算。",
      ["会话", "工单", "签名", "动作", "时间"],
      data.watchdogEvents.map((event) => [
        shortId(event.sessionId),
        shortId(event.incidentId),
        esc(event.signature),
        esc(event.action),
        when(event.createdAt)
      ])
    )
  ].join("\n");

  return `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Fieldnote 研究数据(浏览版)</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 14px/1.55 -apple-system, "PingFang SC", "Segoe UI", sans-serif; margin: 2rem auto; max-width: 1200px; padding: 0 1rem; }
  h1 { font-size: 1.4rem; }
  h2 { font-size: 1.05rem; margin: 2rem 0 .4rem; }
  h2 small { font-weight: normal; opacity: .6; }
  .meta, .note { opacity: .75; font-size: .85rem; margin: .2rem 0; }
  .counts { display: flex; flex-wrap: wrap; gap: .5rem 1.5rem; margin: 1rem 0; padding: .8rem 1rem; border: 1px solid rgba(127,127,127,.35); border-radius: .6rem; }
  .counts b { font-size: 1.1rem; margin-right: .3rem; }
  .scroll { overflow-x: auto; }
  table { border-collapse: collapse; width: 100%; font-size: .82rem; }
  th, td { border: 1px solid rgba(127,127,127,.3); padding: .3rem .5rem; text-align: left; vertical-align: top; }
  th { position: sticky; top: 0; background: rgba(127,127,127,.12); backdrop-filter: blur(4px); }
  td { max-width: 26rem; overflow-wrap: anywhere; }
  code { font-size: .78rem; }
  details summary { cursor: pointer; }
  details .full { white-space: pre-wrap; margin-top: .3rem; opacity: .9; }
  .empty { opacity: .5; }
</style>
</head>
<body>
<h1>Fieldnote 研究数据(浏览版)</h1>
<p class="meta">导出时间 ${esc(meta.exportedAt)} · 范围:${
    meta.participantId ? `参与者 <code>${esc(meta.participantId)}</code>` : "全库(所有参与者)"
  } · 字段口径见 <code>docs/RESEARCH_EXPORT.md</code></p>
<p class="meta">所有文本已经过与 JSON 导出相同的脱敏;本页只为人类阅读,机器分析请用 JSON 端点。数据从不离开本机;分享截图前请自行复查。</p>
<div class="counts">${counts.map(([label, count]) => `<span><b>${count}</b>${esc(label)}</span>`).join("")}</div>
${body}
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
