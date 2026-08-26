import type { LearningLoopReportDto } from "./learning-store.js";
import {
  bi,
  type Bi,
  biSpan,
  BASE_CSS,
  escapeHtml,
  LANG_SWITCH_HTML,
  LANG_SWITCH_JS,
  label,
  stamp
} from "./report-ui.js";

/**
 * One learning loop, told in the order it happened, as its own page.
 *
 * Written for the person who just closed it: what they set out to learn, where it stuck, what
 * the tutor tried, every practice task drafted for them — rejected drafts included, because
 * a task that never reached them is still evidence the gates worked — and the verdict they
 * gave themselves. The system's assessment is shown as a proposal next to their decision,
 * never above it.
 *
 * Server-rendered in both languages with CSS hiding one, so the switch survives printing and
 * the page still reads with scripting off.
 */
export function renderLoopReportHtml(report: LearningLoopReportDto, meta: { generatedAt: string }): string {
  const { incident, session, interventions, verifications, practiceItems, variants } = report;
  const confirmed = verifications.filter((entry) => entry.finalVerdict);
  const last = confirmed[confirmed.length - 1] ?? null;
  const verdict = incident.status === "escalated" ? "escalated" : (last?.finalVerdict ?? "unknown");
  const rejected = practiceItems.filter((item) => item.status === "rejected");

  const headline: Bi =
    verdict === "resolved"
      ? bi("你说你学会了。", "You said you had it.")
      : verdict === "partial"
        ? bi("你说还差一点。", "You said it was close.")
        : verdict === "escalated"
          ? bi("这次交给人了。", "This one was handed off.")
          : bi("你说还没学会。", "You said not yet.");

  const tone = verdict === "resolved" ? "moss" : verdict === "partial" ? "pen" : "rust";

  const rounds = interventions
    .map((item) => {
      const variant = variants.find((entry) => entry.baseStrategy === item.strategy) ?? null;
      return `<li class="round">
        <div class="round-head">
          <span class="eyebrow rec">${escapeHtml(String(item.round))}</span>
          ${chip(label("strategy", item.strategy), "chip-pen")}
          ${variant ? `<span class="chip">${escapeHtml(variant.title)}</span>` : ""}
        </div>
        <p class="prose">${escapeHtml(item.rationale)}</p>
        ${
          item.expectedSignal
            ? `<p class="aside">${biSpan(bi("想看到的信号", "Signal it was watching for"))}：<span class="prose">${escapeHtml(item.expectedSignal)}</span></p>`
            : ""
        }
      </li>`;
    })
    .join("");

  const drafts = practiceItems
    .map((item) => {
      const raw = item.evaluatorVerdict as { status?: string; reasons?: string[] } | null;
      const passed = item.gate === "none";
      // The reviewer's reasons explain a rejection. When the reviewer itself failed to
      // answer, the draft was let through — say that plainly instead of surfacing a raw
      // runtime error as if the task were at fault.
      const failedOpen = raw?.status === "error";
      const reasons = !failedOpen && !passed && Array.isArray(raw?.reasons) ? raw.reasons.join(" · ") : "";
      return `<li class="draft ${passed ? "passed" : "stopped"}">
        <div class="draft-head">
          ${chip(bi(`第 ${item.round} 轮`, `Round ${item.round}`), "")}
          ${chip(label("practiceStatus", item.status), passed ? "chip-moss" : "chip-tag")}
          ${chip(label("gate", item.gate), passed ? "chip-moss" : "chip-tag")}
          ${chip(bi(`查重分 ${item.noveltyScore.toFixed(3)}`, `Novelty ${item.noveltyScore.toFixed(3)}`), item.gate === "novelty" ? "chip-tag" : "")}
          ${chip(label("method", item.method), "")}
        </div>
        <p class="prose task">${escapeHtml(item.taskText)}</p>
        ${
          item.expectedAnswerSketch
            ? `<details class="sketch"><summary>${biSpan(bi("这道题想让你说出什么", "What this task was looking for"))}</summary><p class="prose">${escapeHtml(item.expectedAnswerSketch)}</p></details>`
            : ""
        }
        ${reasons ? `<p class="why prose">${escapeHtml(reasons)}</p>` : ""}
        ${failedOpen ? `<p class="aside">${biSpan(bi("评审员当时没能答复，按放行处理。", "The reviewer did not answer in time, so the draft was let through."))}</p>` : ""}
      </li>`;
    })
    .join("");

  const checks = verifications
    .map((entry) => {
      const decided = entry.finalVerdict;
      return `<li class="check">
        <div class="draft-head">
          ${chip(label("method", entry.method), "")}
          ${
            entry.practiceItemId
              ? chip(bi("题面逐字来自过审题记", "Text copied verbatim from an approved draft"), "chip-moss")
              : chip(bi("散文式检查", "Prose check"), "")
          }
          <span class="eyebrow rec">${escapeHtml(stamp(entry.createdAt))}</span>
        </div>
        <p class="prose task">${escapeHtml(entry.prompt)}</p>
        ${
          entry.rubric
            ? `<details class="sketch"><summary>${biSpan(bi("评判标准", "Rubric"))}</summary><p class="prose">${escapeHtml(entry.rubric)}</p></details>`
            : ""
        }
        <div class="verdicts">
          <div class="verdict proposed">
            <span class="eyebrow">${biSpan(bi("系统的提议", "The system proposed"))}</span>
            <b>${entry.systemVerdict ? biSpan(label("outcome", entry.systemVerdict)) : "—"}</b>
            ${entry.systemConfidence === null ? "" : `<small class="rec">${escapeHtml(String(entry.systemConfidence))}</small>`}
          </div>
          <div class="verdict decided ${decided ? `tone-${decided === "resolved" ? "moss" : decided === "partial" ? "pen" : "rust"}` : ""}">
            <span class="eyebrow">${biSpan(bi("你的决定", "You decided"))}</span>
            <b>${decided ? biSpan(label("outcome", decided)) : biSpan(bi("还没确认", "Not confirmed yet"))}</b>
            ${entry.confirmedAt ? `<small class="rec">${escapeHtml(stamp(entry.confirmedAt))}</small>` : ""}
          </div>
        </div>
      </li>`;
    })
    .join("");

  const next = nextSection(report, verdict);

  const body = `<header class="topbar">
  <div class="wordmark"><b>FIELDNOTE</b><span class="eyebrow">${biSpan(bi("学习报告", "Loop report"))}</span></div>
  <div class="topbar-actions">
    ${LANG_SWITCH_HTML}
    <a class="jsonlink" href="/api/learning/incidents/${encodeURIComponent(incident.id)}/report.html?download=true" download>${biSpan(bi("存成文件", "Save a copy"))}</a>
    <a class="jsonlink" href="/api/learning/export/html?participantId=${encodeURIComponent(session.participantId)}">${biSpan(bi("全部记录", "All records"))}</a>
  </div>
</header>
<main>
  <section class="hero tone-${tone}">
    <p class="eyebrow rec">${escapeHtml(stamp(incident.closedAt ?? last?.confirmedAt ?? incident.updatedAt))} · ${escapeHtml(session.participantId)} · ${biSpan(label("condition", session.condition))}</p>
    ${biSpan(headline, "h1")}
    <p class="lede prose">${escapeHtml(incident.hypothesis)}</p>
    <div class="spine-wrap">${spineSvg(report, verdict)}</div>
    <p class="spine-key">${biSpan(bi("线上方是每一轮讲法，线下方每一根是为你起草的一道题——高度就是查重分，空心的那些被门拦下了，你没见过。", "Above the line, each teaching round. Below it, each practice task drafted for you — bar height is the novelty score, and the hollow ones were stopped by a gate before they ever reached you."))}</p>
  </section>

  <section class="block">
    ${biSpan(bi("你想学会什么", "What you set out to learn"), "h2")}
    <p class="prose">${escapeHtml(session.goal)}</p>
    <p class="aside rec">${escapeHtml([session.topicKey, session.datasetKind].filter(Boolean).join(" · "))}</p>
  </section>

  <section class="block">
    ${biSpan(bi("卡在哪", "Where it stuck"), "h2")}
    <div class="draft-head">
      ${chip(label("difficultyType", incident.difficultyType), "chip-pen")}
      ${chip(bi(`置信度 ${Math.round(incident.confidence * 100)}%`, `${Math.round(incident.confidence * 100)}% confidence`), "")}
      ${chip(bi(`${incident.evidenceMessageIds.length} 条对话证据`, `evidence: ${incident.evidenceMessageIds.length}`), "")}
    </div>
    <p class="aside">${biSpan(bi("上面那句就是导师读你的对话得出的判断，不是定论——所以最后由你确认。", "The sentence at the top is the tutor's read of your conversation, not a fact — which is why you get the last word."))}</p>
  </section>

  ${
    interventions.length
      ? `<section class="block">
    ${biSpan(bi("试了哪些讲法", "What was tried"), "h2")}
    <ol class="rounds">${rounds}</ol>
  </section>`
      : ""
  }

  ${
    practiceItems.length
      ? `<section class="block">
    ${biSpan(bi("为你出的题", "The tasks drafted for you"), "h2")}
    <p class="aside">${biSpan(
      rejected.length
        ? bi(
            `起草 ${practiceItems.length} 道，其中 ${rejected.length} 道被门拦下、没发给你。被拦下的也留在这里——它们是三道门在干活的证据。`,
            `${practiceItems.length} drafted, ${rejected.length} stopped before reaching you. The stopped ones stay in the record: they are the evidence the three gates do their job.`
          )
        : bi(
            `起草 ${practiceItems.length} 道，三道门全部放行。被拦下的草稿也会留在这里，这次没有。`,
            `${practiceItems.length} drafted, and all three gates let them through. Stopped drafts would be listed here too; this loop had none.`
          )
    )}</p>
    <ul class="drafts">${drafts}</ul>
  </section>`
      : ""
  }

  ${
    verifications.length
      ? `<section class="block">
    ${biSpan(bi("检查题，和你的判断", "The check, and your call"), "h2")}
    <ul class="checks">${checks}</ul>
  </section>`
      : ""
  }

  ${next}

  <footer class="foot">
    <p class="aside">${biSpan(bi("这份报告只写这一次学习，由本机数据生成，从未上传。文字与研究导出经过同一套脱敏；分享前请自行复查。", "This report covers this one loop, is generated from data on this machine, and is never uploaded. Its text is redacted the same way the research export is — read it once before sharing."))}</p>
    <p class="aside rec">${escapeHtml(`${incident.id} · ${stamp(meta.generatedAt)}`)}</p>
  </footer>
</main>`;

  return `<!doctype html>
<html lang="zh" data-lang="zh">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="referrer" content="no-referrer" />
<title>Fieldnote 学习报告 · Loop report</title>
<style>${BASE_CSS}${REPORT_CSS}</style>
</head>
<body>
${body}
<script>${LANG_SWITCH_JS}</script>
</body>
</html>`;
}

function chip(value: Bi, tone: string): string {
  return `<span class="chip${tone ? ` ${tone}` : ""}">${biSpan(value)}</span>`;
}

function nextSection(report: LearningLoopReportDto, verdict: string): string {
  const { reviewTasks, incident } = report;
  const items: string[] = [];
  for (const task of reviewTasks) {
    const when = stamp(new Date(task.dueAt).toISOString());
    const done = task.status === "fired" || task.status === "completed";
    items.push(
      `<li>${chip(label("reviewStatus", task.status), done ? "chip-pen" : "")} ${biSpan(
        bi(`第 ${task.round} 次间隔回访 · ${when}`, `Spaced revisit ${task.round} · ${when}`)
      )}</li>`
    );
  }
  if (incident.status === "escalated") {
    items.push(
      `<li>${biSpan(bi("这次交给人来接手，回路在这里停住。", "A person takes it from here; the loop stops."))}</li>`
    );
  }
  if (
    !items.length &&
    verdict !== "resolved" &&
    !["resolved", "unresolved", "escalated", "abandoned"].includes(incident.status)
  ) {
    items.push(
      `<li>${biSpan(bi("回路还开着，导师会换一个讲法再来一轮。", "The loop is still open; the tutor will come back with a different move."))}</li>`
    );
  }
  if (!items.length) return "";
  return `<section class="block">
    ${biSpan(bi("接下来", "What happens next"), "h2")}
    <ul class="next">${items.join("")}</ul>
  </section>`;
}

/** The same spine the corpus browser draws, rendered once on the server for this one loop. */
function spineSvg(report: LearningLoopReportDto, verdict: string): string {
  const base = 52;
  const x0 = 44;
  const xEnd = 660;
  const trackA = 90;
  const trackB = 480;
  const parts: string[] = [];
  parts.push(`<line x1="${x0}" y1="${base}" x2="${xEnd}" y2="${base}" class="s-rule" stroke-width="2" />`);
  parts.push(`<rect x="${x0 - 4}" y="${base - 4}" width="8" height="8" class="f-pen" />`);

  const rounds = report.interventions;
  const step = rounds.length > 1 ? Math.min(200, (trackB - trackA) / (rounds.length - 1)) : 0;
  const xs = rounds.map((_, index) => trackA + index * step);
  rounds.forEach((item, index) => {
    const x = xs[index]!;
    parts.push(
      `<path d="M${x} ${base - 6}L${x + 6} ${base}L${x} ${base + 6}L${x - 6} ${base}Z" class="f-pen" />`,
      svgBiText(label("strategy", item.strategy), x, base - 13)
    );
  });

  const byRound = new Map<number, typeof report.practiceItems>();
  for (const item of report.practiceItems) {
    const bucket = byRound.get(item.round) ?? [];
    bucket.push(item);
    byRound.set(item.round, bucket);
  }
  const tickXs: number[] = [];
  for (const [round, group] of byRound) {
    const index = Math.max(0, Math.min(xs.length - 1, round - 1));
    const mx = xs.length ? xs[index]! : trackA;
    group.forEach((item, position) => {
      const x = mx + (position - (group.length - 1) / 2) * 10;
      const height = Math.max(2.5, Math.min(1, item.noveltyScore) * 30);
      const stopped = item.status === "rejected";
      tickXs.push(x);
      parts.push(
        stopped
          ? `<rect x="${px(x - 3)}" y="${base + 8}" width="6" height="${px(height)}" class="s-tag" fill="none" stroke-width="1" />`
          : `<rect x="${px(x - 3)}" y="${base + 8}" width="6" height="${px(height)}" class="f-tag" fill-opacity="0.85" />`
      );
      if (stopped) {
        const letter =
          item.gate === "programmatic" ? "P" : item.gate === "novelty" ? "N" : item.gate === "evaluator" ? "E" : "?";
        parts.push(`<text x="${px(x)}" y="${base + 48}" text-anchor="middle" class="tick-label">${letter}</text>`);
      }
    });
  }
  if (tickXs.length) {
    // The threshold is a local reference for the bars beneath it, not a rule across the page.
    const lo = Math.min(...tickXs) - 14;
    const hi = Math.max(...tickXs) + 14;
    const ty = base + 8 + 0.6 * 30;
    parts.push(
      `<line x1="${px(lo)}" y1="${ty}" x2="${px(hi)}" y2="${ty}" class="s-tag" stroke-width="0.75" stroke-dasharray="3 4" stroke-opacity="0.7" />`,
      `<text x="${px(lo - 4)}" y="${ty + 3}" text-anchor="end" class="tick-label">.6</text>`
    );
  }
  const fill = verdict === "resolved" ? "f-moss" : verdict === "partial" ? "f-pen" : "f-rust";
  parts.push(`<circle cx="${xEnd}" cy="${base}" r="7" class="${fill}" />`);
  parts.push(svgBiText(label("outcome", verdict), xEnd, base + 21));
  if (report.reviewTasks.length) {
    const fired = report.reviewTasks.some((task) => task.status === "fired" || task.status === "completed");
    parts.push(
      fired
        ? `<circle cx="702" cy="${base}" r="5" class="f-pen" />`
        : `<circle cx="702" cy="${base}" r="5" class="s-pen" fill="none" stroke-width="1.2" />`
    );
  }
  return `<svg class="spine" viewBox="0 0 720 100" preserveAspectRatio="xMidYMid meet" role="img" aria-label="${escapeHtml(
    `${report.interventions.length} rounds, ${report.practiceItems.length} drafts, ${verdict}`
  )}">${parts.join("")}</svg>`;
}

function px(value: number): string {
  return (Math.round(value * 100) / 100).toString();
}

/** Both languages as sibling <text> nodes; the shared CSS hides the one not in use. */
function svgBiText(value: Bi, x: number, y: number): string {
  const place = `x="${px(x)}" y="${y}" text-anchor="middle"`;
  return (
    `<text ${place} class="tick-label lang-zh">${escapeHtml(clip(value.zh, 11))}</text>` +
    `<text ${place} class="tick-label lang-en">${escapeHtml(clip(value.en, 16))}</text>`
  );
}

function clip(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

const REPORT_CSS = `
.topbar {
  position: sticky; top: 0; z-index: 20;
  display: flex; flex-wrap: wrap; gap: .6rem 1rem; align-items: center; justify-content: space-between;
  padding: .55rem var(--gutter);
  background: color-mix(in srgb, var(--panel) 92%, transparent);
  border-bottom: 1px solid var(--rule);
  backdrop-filter: blur(8px);
}
.wordmark { display: flex; align-items: baseline; gap: .55rem; font-family: var(--mono); }
.wordmark b { letter-spacing: .16em; font-size: .82rem; }
.topbar-actions { display: flex; align-items: center; gap: .6rem; }
.jsonlink { font-family: var(--mono); font-size: .68rem; text-decoration: none; border: 1px solid var(--rule); border-radius: 4px; padding: .25rem .5rem; }
main { max-width: 780px; margin: 0 auto; padding: 0 var(--gutter) 5rem; }
.hero { padding: 2.5rem 0 1.75rem; border-bottom: 3px solid var(--pen); }
.hero.tone-moss { border-bottom-color: var(--moss); }
.hero.tone-rust { border-bottom-color: var(--rust); }
.hero h1 { margin: .5rem 0 .6rem; font-size: clamp(1.6rem, 5vw, 2.3rem); line-height: 1.2; letter-spacing: -.015em; font-weight: 650; }
.hero .lede { margin: 0 0 1.25rem; font-size: 1.05rem; color: var(--dust); max-width: 58ch; }
.spine-wrap { overflow-x: auto; }
.spine { display: block; width: 100%; min-width: 640px; max-width: 720px; height: auto; }
.spine-key { margin: .4rem 0 0; font-size: .74rem; color: var(--dust); max-width: 62ch; }
.tick-label { font-family: var(--mono); font-size: 8.5px; fill: var(--dust); }
.f-moss { fill: var(--moss); } .f-pen { fill: var(--pen); } .f-rust { fill: var(--rust); } .f-tag { fill: var(--tag); }
.s-tag { stroke: var(--tag); } .s-rule { stroke: var(--rule); } .s-pen { stroke: var(--pen); }
.block { padding: 1.75rem 0; border-bottom: 1px solid var(--rule); }
.block h2 { margin: 0 0 .75rem; font-size: .82rem; font-family: var(--mono); font-weight: 600; letter-spacing: .09em; text-transform: uppercase; color: var(--pen); }
.block > .prose { margin: .3rem 0; font-size: 1rem; }
.aside { margin: .55rem 0 0; font-size: .78rem; color: var(--dust); max-width: 62ch; }
.draft-head { display: flex; flex-wrap: wrap; gap: .35rem; align-items: center; margin-bottom: .45rem; }
.rounds, .drafts, .checks, .next { list-style: none; margin: 0; padding: 0; }
.round { border-left: 2px solid var(--pen); padding: .1rem 0 .1rem .85rem; margin: 0 0 1.1rem; }
.round-head { display: flex; flex-wrap: wrap; gap: .4rem; align-items: center; margin-bottom: .3rem; }
.round-head .eyebrow { font-size: 1rem; color: var(--pen); font-weight: 600; }
.round .prose { margin: .1rem 0; }
.draft { border-left: 2px solid var(--rule); padding: .1rem 0 .1rem .85rem; margin: 0 0 1.15rem; }
.draft.stopped { border-left-color: var(--tag); }
.draft.passed { border-left-color: var(--moss); }
.task { margin: .2rem 0; font-size: .95rem; }
.why { margin: .35rem 0 0; font-size: .8rem; color: var(--tag); }
.sketch { margin: .35rem 0 0; }
.sketch summary { cursor: pointer; font-family: var(--mono); font-size: .68rem; color: var(--dust); }
.sketch p { margin: .3rem 0 0; font-size: .88rem; }
.check { border-left: 2px solid var(--rule); padding: .1rem 0 .1rem .85rem; margin: 0 0 1.4rem; }
.verdicts { display: flex; flex-wrap: wrap; gap: .5rem; margin-top: .7rem; }
.verdict { flex: 1 1 11rem; border: 1px solid var(--rule); border-radius: 5px; padding: .5rem .7rem; }
.verdict b { display: block; font-size: 1rem; margin-top: .15rem; }
.verdict small { display: block; font-size: .66rem; color: var(--dust); margin-top: .1rem; }
.verdict.decided { border-width: 2px; }
.verdict.decided.tone-moss { border-color: var(--moss); background: var(--moss-soft); }
.verdict.decided.tone-pen { border-color: var(--pen); background: var(--pen-soft); }
.verdict.decided.tone-rust { border-color: var(--rust); background: var(--rust-soft); }
.next li { margin: .35rem 0; font-size: .9rem; display: flex; flex-wrap: wrap; gap: .4rem; align-items: center; }
.foot { padding: 1.5rem 0 0; }
@media print {
  .topbar { display: none; }
  .block, .hero { break-inside: avoid; }
  main { max-width: none; }
}
`;
