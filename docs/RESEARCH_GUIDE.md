# Fieldnote for Research: an Educational On-Call Loop

*[中文版 / Chinese version](RESEARCH_GUIDE.zh-CN.md)*

This document introduces the research side of Fieldnote to a reader seeing it for the first time — a CS-education researcher, instructor, or TA. It states the research problem, then walks through **one complete, unedited session** recorded in the product, using screenshots from that session to show how each piece of the system maps onto the research agenda. Everything runs locally on one machine; no student data leaves it. The system is open source: [github.com/YukunHe16/fieldnote](https://github.com/YukunHe16/fieldnote).

## 1. The research problem

Students routinely fix the visible error while keeping the misconception that produced it — they can restate the rule and still apply the old one. Two measurement problems follow:

- **One-shot feedback is a weak signal of learning.** A correct answer right after an explanation does not distinguish understanding from short-term recall.
- **Re-checking with question-bank items conflates mastery with memorization** — and writing practice that actually discriminates a misconception requires knowing *which* misconception this learner holds, which is usually available only as a static, generic list.

Fieldnote is a working instrument built around those two problems. It wraps a chat tutor in an **educational on-call loop**: diagnose the individual learner's misconception from evidence, teach with an explicit strategy, verify with a **freshly generated** task aimed at that exact misconception, let the learner — not the model — deliver the final verdict, and re-check the same difficulty days later. Every step leaves a research-grade record.

Three questions this instrument is built to study:

1. Does the adaptive loop resolve difficulties in fewer rounds, and more durably, than one-shot feedback?
2. Do checks **generated at verification time, conditioned on a live diagnosis**, measure understanding better than reused items — visible as a difference in false-resolution rate?
3. How well do the system's judgments — outcome verdicts and generated-item quality reviews — agree with human judgment?

## 2. One complete session, start to finish

Everything below is from a single real session (about fifteen minutes), recorded under an isolated demo participant. The learner is the author role-playing a student with a classic Python misconception — *"a mutable default like `items=[]` creates a fresh list on every call."* No real students were involved.

### 2.1 A session declares its research condition up front

![Learning-mode setup: goal, topic, and the research-condition picker](media/research/research-setup-sheet.png)

Starting learning mode asks for a goal, an optional topic (metrics grouping only), and the **research condition**: the adaptive loop, a one-shot feedback baseline, a continued-conversation baseline, or randomized server-side assignment from a seeded sequence. Conditions are enforced by the host, not by prompt wording — the baselines physically lack the check-drafting tool, and the one-shot arm rejects a second intervention.

![Session active, panel observing](media/research/research-session-start.png)

The learner sees a normal chat. All framework data — diagnosis, confidence, strategies, verdicts — lives in the side panel; the student-facing conversation never mentions it.

### 2.2 Diagnosis with evidence, then a check written for this exact misconception

The learner asks why `add_item('b')` returned `['a', 'b']`, stating their belief that `items=[]` re-evaluates per call. The tutor does not just answer — it records a diagnosis and, before verifying, **drafts a brand-new practice task** aimed at the diagnosed misconception (here: the same rule wearing a dict instead of a list).

![Round 1: the taught explanation, the delivered check, and the panel record](media/research/research-demo-loop.png)

On the right: the diagnosed misconception with **1 evidence item · 90% diagnostic confidence**, the Round 1 strategy (direct explanation) with its rationale, and the delivered transfer task. Before the learner ever saw that task, it passed three host-side gates: a deterministic answer-leakage check, a novelty check against everything this learner has seen (too similar is rejected), and an LLM item reviewer judging correctness, **fit to the diagnosed misconception**, difficulty, and novelty. Every draft — including rejected ones — is stored for audit.

### 2.3 Two verdicts on every check; the learner's word is final

The learner answers half-right on purpose: correct prediction, wrong mechanism ("Python passes dicts by reference"). The system proposes its verdict and confidence — and then asks the learner.

![The system's proposal (Partial, 0.7) beside the learner's confirmation buttons](media/research/research-confirm.png)

This two-verdict design runs through the whole system: the machine's judgment and the human's judgment are both stored, never merged, and the human's is authoritative. It is the loop-level version of the standard methodological demand that model judgments be checked against human ones.

### 2.4 A partial confirmation owes another round — and the strategy must change

The learner clicks **Partly**. The system does not stop: it automatically opens the next round on the learner's behalf, and the failed strategy is barred from repeating.

![The automatic follow-up message, and the panel already holding round 1's paired verdicts](media/research/research-partial-followup.png)

Round 2 switches to an analogical explanation (defaults as objects stored in the function's "pocket") with a new gated transfer task — a set instead of a dict. The learner answers correctly this time and confirms **I understand**. Loops are bounded: after three failed rounds the system stops and produces a structured handoff report for a human instructor instead of grinding on.

### 2.5 Every closed loop renders as an auditable report

![Loop report: the misconception, the arc from stuck to learned](media/research/research-loop-report.png)

One page per loop, generated from the same records: what the tutor believed and how sure it was, each strategy tried and *what it hoped to hear back*, every task written for this learner —

![The questions written for this learner, each showing which gates it cleared and how novel it was](media/research/research-loop-report-questions.png)

— with its gate outcomes and novelty score (here 0% and 28% similarity to anything previously seen), and finally each check's **system verdict beside the learner's own**, plus the scheduled revisit:

![System verdict and learner verdict, side by side, for both checks; the revisit scheduled at +2 days](media/research/research-loop-report-verdicts.png)

### 2.6 The revisit: delayed transfer, recorded as its own loop

Two days later — compressed to minutes in this recording via a local override; the research schedule is +2 and +5 days — the tutor returns to the same thread on its own, with a task in a situation the learner has not seen: a default bound to an outer name that is later rebound.

![The revisit loop: linked to the original difficulty, new strategy, new transfer task, resolved at 95%](media/research/research-revisit-loop.png)

The revisit is deliberately **its own record**, linked to the original by the "Revisit 1 · same difficulty" tag — the original resolution stays true-at-the-time, and decayed, falsely-resolved learning shows up as a revisit that fails. Delayed transfer and false-resolution rate are primary outcomes here, not afterthoughts.

### 2.7 What the data looks like immediately afterward

![Metrics: per-condition table, strategy-by-outcome, and system confidence versus learner confirmation](media/research/research-metrics-chart.png)

The panel's metrics tab aggregates by topic and by research condition, and charts *how sure the system was versus how the learner called it* — each sample one learner-confirmed verdict (here: the Partly at 0.7, and the two Learned at 0.9 and 0.95).

![The research corpus page: summary charts over every loop](media/research/research-export-html.png)

![The same page, filtered to this participant: two loops, each with its full arc](media/research/research-export-loops.png)

The corpus page renders **the same anonymized data as the JSON export** (`GET /api/learning/export`; every field documented in [RESEARCH_EXPORT.md](RESEARCH_EXPORT.md)). Participants appear only as pseudonymous IDs — display names never enter the export layer. Note the filters: participant, dataset (live / demo / replay are hard-isolated namespaces), condition, difficulty type, outcome.

## 3. How this maps onto the research agenda

**Misconception-targeted practice generation.** The known bottleneck for generating erroneous examples and discriminating practice is deep knowledge of students' misconceptions — typically a static, generic list. This loop supplies the missing input: a **live, evidenced, per-learner diagnosis**, and generates the check *inside* the remediation process at the moment of verification. The item reviewer's *fit-to-misconception* check is exactly the property that distinguishes targeted practice from topically related practice. The embedded comparison the design supports: verification with reused items versus freshly generated ones — the difference in false-resolution rate is the measured contribution of in-loop generation.

**Model judgment checked against human judgment, at two levels.** At the outcome level, every verdict is a pair — system proposal with confidence, learner confirmation — and the confidence-versus-confirmation chart is the running agreement record. At the instrument level, the LLM item reviewer is itself validated by a **calibration protocol**: export a labeling sheet of drafted items (`node scripts/practice-item-calibration.mjs export --dataset live,eval --sample 100`), a human expert labels each item on the same four checks plus an overall approve/reject (any spreadsheet app; 50–100 items is a bounded, well-defined role for an instructor or TA), and the report command computes per-check precision/recall on "fail", chance-corrected agreement (κ), reviewer fail-open counts, and a typed disagreement list. The report is explicitly quality-review agreement, not learning-outcome evidence.

**Outcome-first evaluation under enforced conditions.** Interventions-to-mastery, immediate and delayed transfer, and false-resolution rate are all first-class records, and the arms are enforced by the host rather than by prompt discipline. Per-learner isolation (the participant axis) keeps a multi-student pilot clean by construction: strategy statistics, revisit schedules, metrics, and exports never mix, and the machine owner's personal data never enters a participant's prompts.

## 4. Current evidence and honest limits

- The only quantitative result so far is from an **offline evaluation with simulated learners**: the loop's first diagnosis matched the scripted misconception in **166/176 sessions (94%)**. Simulated learners say nothing about learning outcomes.
- An earlier simulated outcome comparison was **retired** after we documented why LLM-simulated learners cannot fail to learn believably; the post-mortem is public in this repository.
- The walkthrough above is a role-played demonstration by the author, recorded in an isolated demo namespace, with the revisit interval shortened for demonstration. No student data has been collected.
- Deliberate non-goals: LMS integration, question banks, grading products, multi-tenant hosting.

## 5. Trying it

Open Fieldnote → **New chat** → **Learning mode**. The setup sheet's two fixed cases each offer a **Stable demo** (deterministic, no model calls) and a **Real Agent** entry (a live tutor agent; results vary). Demo runs live in a separate namespace and never mix with live research data.
