# Research Guide: the Educational On-Call Loop

*[中文版 / Chinese version](RESEARCH_GUIDE.zh-CN.md)*

This guide is for a collaborator — an instructor, TA, or researcher — who has never used Fieldnote. It covers only the research line: the adaptive learning loop, generated practice checks, and the data they produce. Everything here runs locally on one machine; no student data leaves it.

## 1. What this studies

Students routinely fix the visible error while keeping the misconception that produced it. Fieldnote wraps a chat assistant in an **educational on-call loop**: it diagnoses the individual learner's misconception with cited evidence, teaches with an explicit strategy, verifies with a **freshly generated** practice task, and re-checks the same difficulty days later.

Two research questions follow:

1. Does this loop resolve difficulties in fewer rounds, and more durably, than one-shot feedback?
2. Can the checks it generates be trusted — and how well does its automatic item reviewer agree with a human expert?

## 2. One loop, start to finish

1. **Diagnosis.** The tutor names the misconception it believes the learner holds, cites the learner's own words as evidence, and states its confidence.
2. **Teaching move.** One of eight strategies (contrastive example, worked example, Socratic question, …). A failed strategy is never repeated. After three failed rounds the loop stops and produces a structured handoff report for a human instructor.
3. **Fresh check.** Before verifying, the tutor drafts a new practice task aimed at that exact misconception. The host reviews the draft through three quality gates (section 5) before the learner ever sees it.
4. **Verdict, twice.** After the learner answers, the system proposes a verdict (resolved / partial / unresolved) with a confidence number — and the learner then confirms in their own words. **The learner's confirmation is final; both verdicts are stored.**
5. **Revisit.** A resolved difficulty is re-checked at +2 and +5 days with a brand-new transfer task. The revisit is its own record, linked to the original as "Revisit N · same difficulty" — catching decayed, falsely-resolved learning is a primary outcome.

The learner only ever sees a normal tutoring conversation. All framework data — diagnosis, confidence, strategies, verdicts — lives in a side panel the student-facing chat never mentions.

## 3. Try it yourself in three clicks

Open Fieldnote → **New chat** → click the **Learning mode** button beside the message box.

![Learning mode setup sheet with research condition picker and fixed demo cases](media/research/research-setup-sheet.png)

- **Learning goal / Topic** describe what is being learned. Topic only groups metrics.
- **Research condition** picks the experimental arm (section 4).
- The two **fixed cases** at the bottom each offer two entries:
  - **Stable demo** — deterministic, no model calls; always shows the same complete loop.
  - **Real Agent** — a real tutor agent runs the loop live; results vary and model calls are billed.

Demo runs are stored in a separate `demo` namespace and never mix with live research data.

## 4. Research conditions

| Condition | What the host enforces |
| --- | --- |
| **Adaptive loop** | Full on-call loop: diagnosis, strategy switching, generated checks, escalation, revisits. |
| **One-shot baseline** | Exactly one feedback round per difficulty. The host rejects a second intervention. |
| **Continued-conversation baseline** | An ordinary tutoring chat: no strategy planning, no escalation. |
| **Randomized** | The server draws the condition from a reproducible seeded sequence. |

Conditions are enforced by the host, not by prompt wording — the baselines physically lack the check-drafting tool.

## 5. Generated checks and the three gates

Verifying with reused question-bank items measures memory, not understanding. So in the adaptive arm the tutor must **draft a new task at verification time**, conditioned on the diagnosed misconception, and the draft passes three gates in the same turn:

1. **Programmatic (hard, free):** empty text, out-of-range difficulty, the expected answer leaking into the task text.
2. **Novelty (hard):** similarity against everything this learner has already seen in the session; too close (> 0.6) is rejected — "same task, new wording" cannot pass.
3. **LLM evaluator (advisory-strict):** four checks — is the task itself correct, does it actually discriminate the diagnosed misconception, is the difficulty right, is it novel. A returned rejection counts; an infrastructure error fails open so the loop is never blocked.

Two substantive rejections unlock a plain-prose fallback. **Every draft, including rejected ones, is stored** — the reviewer's own behavior is auditable data.

## 6. Spaced revisits

![A live revisit loop: the Revisit chip, two teaching rounds, and system verdict next to learner confirmation](media/research/research-revisit-loop.png)

The screenshot above is a real revisit: the original difficulty was confirmed resolved, the +2-day revisit asked a new transfer question, the system judged the answer **Partial at 78% confidence**, and the learner confirmed **Partial**. The revisit is a separate record — the original resolution stays true-at-the-time — linked by the blue **Revisit 1 · same difficulty** chip.

## 7. Where the data lives

**In the panel — Metrics tab.** Per-topic tiles, a per-condition table, strategy × outcome (closed loops only), and the chart *"How sure the system was vs how you called it"* — each sample is one learner-confirmed verdict, bucketed by the system's confidence. This is the loop-level system-versus-human comparison.

![Metrics tab: condition table, strategy by outcome, and the confidence-versus-confirmation chart](media/research/research-metrics-chart.png)

**The research corpus page** at `/api/learning/export/html` — every loop end to end (diagnosis, moves, every draft including gated ones, verdicts, revisits), with filters by participant, dataset, condition, difficulty type, and outcome. Bilingual, rendered from the same redacted data as the JSON.

![Research corpus page with summary charts and per-loop entries](media/research/research-export-html.png)

**Machine-readable export.** `GET /api/learning/export` returns anonymized JSON; every field is documented in the codebook, [RESEARCH_EXPORT.md](RESEARCH_EXPORT.md). `?participantId=` filters by learner.

**Per-loop report.** After the learner confirms an outcome, each loop has a one-page bilingual report at `/api/learning/incidents/<id>/report.html` (`?download=true` saves a file): where they were stuck, what was tried, the tasks written for them — including drafts the gates stopped — and the system's proposal next to their own decision.

## 8. The calibration protocol — the instructor/TA role

The generated-item reviewer (section 5, gate 3) is itself an instrument that needs validating: **how often does it agree with a human expert?** That is a concrete, bounded role for a collaborator — label 50–100 items; no software needed.

1. The study owner exports a labeling sheet:

   ```bash
   node scripts/practice-item-calibration.mjs export --dataset live,eval --sample 100
   ```

   One row per drafted task (rejected drafts included). Machine columns are pre-filled; human columns are blank. `datasetKind` / `condition` columns say where each item came from.

2. The collaborator fills, for each row: four per-check labels (`pass` / `fail` / `unsure` for correctness, fit-to-misconception, difficulty, novelty), one overall `approve` / `reject`, optional notes. Any spreadsheet app works.

3. The study owner runs the report:

   ```bash
   node scripts/practice-item-calibration.mjs report --labels filled.csv --labeler <name>
   ```

   Output: per-check precision/recall on "fail", chance-corrected agreement (κ), evaluator fail-open count, and a typed list of every disagreement. The report describes **quality-review agreement only** — it is not learning-outcome evidence, and a self-labeled run is marked as a protocol smoke test.

## 9. Multiple learners

Every learner is a **participant** with fully isolated records: experiences, strategy statistics, revisit schedules, metrics, and exports never mix across participants, and the machine owner's personal memory never enters a participant's prompts (nor the reverse). A pilot with several students needs no extra setup.

## 10. Current evidence and limits

- The only quantitative result so far is from an **offline evaluation with simulated learners**: the loop's first diagnosis matched the scripted misconception in **166/176 sessions (94%)**. No real students, so this says nothing about learning outcomes.
- An earlier simulated outcome comparison was retired after we documented why LLM-simulated learners cannot fail to learn believably; the post-mortem is public in this repository.
- Deliberate non-goals: LMS integration, question banks, grading products, multi-tenant hosting.

## Video walkthroughs

- [ ] 90-second loop demo — *to be added*
- [ ] Calibration protocol walkthrough — *to be added*
