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
  plain,
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
          <b class="round-move">${biSpan(plain("strategy", item.strategy))}</b>
          ${chip(label("strategy", item.strategy), "")}
          ${variant ? `<span class="chip">${escapeHtml(variant.title)}</span>` : ""}
        </div>
        <p class="prose">${escapeHtml(item.rationale)}</p>
        ${
          item.expectedSignal
            ? `<p class="aside">${biSpan(bi("这么讲之后，导师想听你说出", "What it hoped to hear from you next"))}：<span class="prose">${escapeHtml(item.expectedSignal)}</span></p>`
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
          ${chip(plain("gate", item.gate), passed ? "chip-moss" : "chip-tag")}
          ${chip(
            bi(
              `跟你见过的题像 ${Math.round(item.noveltyScore * 100)}%`,
              `${Math.round(item.noveltyScore * 100)}% like something you had seen`
            ),
            item.gate === "novelty" ? "chip-tag" : ""
          )}
          ${chip(plain("method", item.method), "")}
          ${passed ? chip(label("practiceStatus", item.status), "") : ""}
        </div>
        <p class="prose task">${escapeHtml(item.taskText)}</p>
        ${
          item.expectedAnswerSketch
            ? `<details class="sketch"><summary>${biSpan(bi("这道题想让你说出什么", "What this task was looking for"))}</summary><p class="prose">${escapeHtml(item.expectedAnswerSketch)}</p></details>`
            : ""
        }
        ${reasons ? `<p class="why prose">${escapeHtml(reasons)}</p>` : ""}
        ${failedOpen ? `<p class="aside">${biSpan(bi("第三关的 AI 审稿当时没答上来，这道题按放行处理。", "The third check timed out, so this one was let through."))}</p>` : ""}
      </li>`;
    })
    .join("");

  const checks = verifications
    .map((entry) => {
      const decided = entry.finalVerdict;
      return `<li class="check">
        <div class="draft-head">
          ${chip(plain("method", entry.method), "chip-pen")}
          ${
            entry.practiceItemId
              ? chip(bi("就是上面审过的那道题，一个字没改", "The approved task above, word for word"), "chip-moss")
              : chip(bi("直接在对话里问的", "Asked in conversation"), "")
          }
          <span class="eyebrow rec">${escapeHtml(stamp(entry.createdAt))}</span>
        </div>
        <p class="prose task">${escapeHtml(entry.prompt)}</p>
        ${
          entry.rubric
            ? `<details class="sketch"><summary>${biSpan(bi("怎么算答对", "What counted as right"))}</summary><p class="prose">${escapeHtml(entry.rubric)}</p></details>`
            : ""
        }
        <div class="verdicts">
          <div class="verdict proposed">
            <span class="eyebrow">${biSpan(bi("系统觉得", "The system thought"))}</span>
            <b>${entry.systemVerdict ? biSpan(label("outcome", entry.systemVerdict)) : "—"}</b>
            ${entry.systemConfidence === null ? "" : `<small class="rec">${escapeHtml(String(entry.systemConfidence))}</small>`}
          </div>
          <div class="verdict decided ${decided ? `tone-${decided === "resolved" ? "moss" : decided === "partial" ? "pen" : "rust"}` : ""}">
            <span class="eyebrow">${biSpan(bi("你说", "You said"))}</span>
            <b>${decided ? biSpan(label("outcome", decided)) : biSpan(bi("还没回答", "Not answered yet"))}</b>
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
    <p class="eyebrow rec">${escapeHtml(stamp(incident.closedAt ?? last?.confirmedAt ?? incident.updatedAt))}</p>
    ${biSpan(headline, "h1")}
    <p class="lede prose">${escapeHtml(incident.hypothesis)}</p>
    <div class="spine-wrap">${spineSvg(report, verdict)}</div>
    <ul class="spine-key">
      <li>${biSpan(bi("■ 发现你卡住了 → ◆ 每换一种讲法就是一个菱形 → ● 最后你自己怎么判", "■ noticed you were stuck → ◆ one diamond per teaching move → ● how you finally called it"))}</li>
      <li>${biSpan(bi("线下方每一根小柱＝为你写的一道题；越高说明越像你做过的题，空心的那些没通过检查，你从没见过。", "Each small bar below the line is one question written for you. Taller means more like something you had already done; the hollow ones failed a check and never reached you."))}</li>
    </ul>
  </section>

  <section class="block">
    ${biSpan(bi("你想学会什么", "What you set out to learn"), "h2")}
    <p class="prose">${escapeHtml(session.goal)}</p>
    <p class="aside rec">${escapeHtml([session.topicKey, session.datasetKind].filter(Boolean).join(" · "))}</p>
  </section>

  <section class="block">
    ${biSpan(bi("你卡在哪", "Where you got stuck"), "h2")}
    <p class="prose lead-plain">${biSpan(plain("difficultyType", incident.difficultyType))}</p>
    <div class="draft-head">
      ${chip(
        bi(
          `导师有 ${Math.round(incident.confidence * 100)}% 把握是这个`,
          `The tutor was ${Math.round(incident.confidence * 100)}% sure of this`
        ),
        ""
      )}
      ${chip(
        bi(
          `依据你说过的 ${incident.evidenceMessageIds.length} 句话`,
          `Based on ${incident.evidenceMessageIds.length} thing(s) you said`
        ),
        ""
      )}
      ${chip(label("difficultyType", incident.difficultyType), "")}
    </div>
    <p class="aside">${biSpan(bi("这是导师读你的对话猜出来的，不一定准——所以学没学会，最后由你自己说。", "The tutor worked this out from your conversation; it can be wrong. That is why whether you learned it is yours to say."))}</p>
  </section>

  ${
    interventions.length
      ? `<section class="block">
    ${biSpan(bi("导师试了什么办法", "What the tutor tried"), "h2")}
    <ol class="rounds">${rounds}</ol>
  </section>`
      : ""
  }

  ${
    practiceItems.length
      ? `<section class="block">
    ${biSpan(bi("给你出的题", "The questions written for you"), "h2")}
    <p class="aside">${biSpan(
      rejected.length
        ? bi(
            `一共写了 ${practiceItems.length} 道，其中 ${rejected.length} 道没通过检查、没发给你。没通过的也列在下面，你可以看到把关是真的在做。`,
            `${practiceItems.length} questions were written, and ${rejected.length} failed a check and never reached you. The failed ones are listed too, so you can see the checks are real.`
          )
        : bi(
            `一共写了 ${practiceItems.length} 道，全部通过了检查。没通过的也会列在这里，这次一道都没有。`,
            `${practiceItems.length} questions were written and all of them passed. Failed ones would be listed here too; this time there were none.`
          )
    )}</p>
    <ul class="drafts">${drafts}</ul>
  </section>`
      : ""
  }

  ${
    verifications.length
      ? `<section class="block">
    ${biSpan(bi("最后那道题，和你的答复", "The last question, and your answer"), "h2")}
    <ul class="checks">${checks}</ul>
  </section>`
      : ""
  }

  ${next}

  <footer class="foot">
    <p class="aside">${biSpan(bi("这份报告只写这一次学习，由本机数据生成，从未上传。文字与研究导出经过同一套脱敏；分享前请自行复查。", "This report covers this one loop, is generated from data on this machine, and is never uploaded. Its text is redacted the same way the research export is — read it once before sharing."))}</p>
    <p class="aside rec">${escapeHtml(
      `${incident.id} · ${session.participantId} · ${session.condition} · ${session.datasetKind} · ${stamp(meta.generatedAt)}`
    )}</p>
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
        bi(`第 ${task.round} 次回访 · ${when}`, `Revisit ${task.round} · ${when}`)
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
    ${
      reviewTasks.length
        ? `<p class="aside">${biSpan(bi("学会之后过一阵，导师会回到这个对话再出一道新情境的题——看你是真的懂了，还是当时刚好记着。", "A while after you learn something, the tutor comes back to this thread with the same idea in a new setting — to see whether you understood it or just remembered it that day."))}</p>`
        : ""
    }
  </section>`;
}

/** The same spine the corpus browser draws, rendered once on the server for this one loop. */
function spineSvg(report: LearningLoopReportDto, verdict: string): string {
  const base = 52;
  const x0 = 44;
  const xEnd = 660;
  const parts: string[] = [];
  parts.push(`<line x1="${x0}" y1="${base}" x2="${xEnd}" y2="${base}" class="s-rule" stroke-width="2" />`);
  parts.push(`<rect x="${x0 - 4}" y="${base - 4}" width="8" height="8" class="f-pen" />`);

  const rounds = report.interventions;
  const xs = rounds.map((_, index) => x0 + ((index + 1) * (xEnd - x0)) / (rounds.length + 1));
  rounds.forEach((item, index) => {
    const x = xs[index]!;
    parts.push(
      `<path d="M${x} ${base - 6}L${x + 6} ${base}L${x} ${base + 6}L${x - 6} ${base}Z" class="f-pen" />`,
      svgBiText(plain("strategy", item.strategy), x, base - 13)
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
    const mx = xs.length ? xs[index]! : (x0 + xEnd) / 2;
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
.spine-key { list-style: none; margin: .5rem 0 0; padding: 0; font-size: .74rem; color: var(--dust); max-width: 64ch; }
.spine-key li { margin: .18rem 0; }
.lead-plain { margin: 0 0 .5rem; font-size: 1.02rem; font-weight: 600; }
.round-move { font-size: .92rem; }
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
