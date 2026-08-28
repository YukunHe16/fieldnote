# What the offline evaluation taught us about its own instrument

> **Status.** The outcome half of this evaluation — "does the adaptive loop resolve more
> misconceptions than a baseline?" — is retired until it can be run with real learners.
> This document records why, with the evidence, because the reasons generalize to anyone
> evaluating a tutoring system against LLM-simulated students. The diagnosis half of the
> evaluation survives, with numbers, in [the section below](#what-remains-measurable-without-real-students).
> Everything here is about system behavior under simulation; none of it is evidence about
> real students.

The evaluation compared the adaptive on-call loop against baselines on 12 (later 18)
scripted-misconception items, with an LLM role-playing the learner and a fixed concept
checklist grading a standardized post-test. Three instrument failures surfaced, in
sequence, each discovered by auditing the previous result rather than by accepting it.

## Failure 1 — a literal-pattern grader penalized paraphrase, and the penalty was one-sided

The original grader matched post-test answers against regex patterns per concept. Regrading
all 90 archived final answers with a substance judge (temperature 0, patterns kept as a
recorded second opinion) showed the patterns had **denied credit to 29 answers that
demonstrated the concept and granted credit to 2 that got it wrong**. One item
(`pg-reverse-accumulator`) accepted only one of two correct solution shapes; the arm that
was taught the other shape scored 67% on every single run.

The bias was structural, not random: only the multi-round arm answers the post-test more
than once, and learners paraphrase more after more teaching — so the paraphrase penalty
fell mostly on the adaptive condition the evaluation existed to measure. The
"crossover" narrative the early runs seemed to show (baseline better on mild
misconceptions, adaptive loop better on stubborn ones) did not survive the regrade.

Worse, the grader was also the **loop's stop signal**: its verdict was fed back as the
learner's confirmation, so a false "not yet" forced rounds that never needed to happen.
Under the fixed grader, multi-round on-call runs dropped from 9 of 24 to 2 of 24 — most of
the observed "adaptivity" had been the instrument arguing with itself.

## Failure 2 — with substance grading, both arms hit the ceiling

Scored on substance, the archived one-shot baseline answers were already essentially
perfect (23/23 resolved), and fresh runs put both arms at or near 100% coverage on both
persona tiers. There was nothing left for adaptivity to improve. Harder items did not
help: four items authored specifically to be harder — including one requiring the learner
to reject **both** pieces of conflicting grader feedback — resolved in one round in every
arm.

## Failure 3 — an LLM cannot credibly keep failing to learn

The stubborn persona tier scripts consolidation rules ("your first application slips back
into the old habit; you only consolidate after your own attempt is corrected AND the idea
is re-taught a different way"). Three escalating designs tried to make them bind:

1. **Dispositional rules alone** — the persona complied for one message and then answered
   correctly.
2. **Transfer tasks in the exit check** (so reciting the tutor's words cannot pass) — the
   persona worked the fresh case correctly on the first try.
3. **Harness-decided state**, where the runner itself tracks whether the scripted
   consolidation conditions have been met and injects it verbatim, including *"every
   example you actually work out MUST still be done your old way and MUST come out
   wrong"* — the learner model replied "I think it finally landed", wrote a correct
   `deep_max` from scratch, and traced it correctly.

The model's pull toward being correct and helpful beats the role-play instruction at
exactly the moment the evaluation needs it not to. This is the load-bearing failure: an
outcome comparison between tutoring conditions requires learners who fail believably and
recover for legible reasons, and current LLM personas do neither on demand.

Two structural artifacts from the same effort are worth keeping even though the
comparison is retired: a **turns-matched baseline** (`multi-turn`: same three-round
budget as on-call, no strategy bookkeeping, no forced switch, no escalation — so a win
would be attributable to structure rather than to talking longer), and the observed
**reliability tax** of agentic tutoring itself: across all 177 archived sessions, 6.2%
stalled mid-loop, errored, or never opened an incident — 7.9% of on-call sessions against
4.5% of one-shot ones. More machinery, more places to fail; any deployment claim has to
carry that number alongside any effectiveness number.

## What remains measurable without real students

**Diagnosis accuracy.** Every item scripts the learner's misconception verbatim, and the
loop's first act is to record a written hypothesis — so the script, not learner behavior,
is ground truth, and no acting is required. Across all 176 archived eval sessions that
opened an incident:

| | n | match | partial | miss |
| --- | --- | --- | --- | --- |
| **all sessions** | 176 | **166 (94%)** | 8 | 2 |
| conceptual misconception items | 65 | 65 (100%) | 0 | 0 |
| planning-gap items | 52 | 51 (98%) | 0 | 1 |
| feedback-uncertainty items | 59 | 50 (85%) | 8 | 1 |

(Judge at temperature 0 against the scripted beliefs; both misses are sessions where the
loop diagnosed a malformed learner message rather than the misconception. The original
per-session audit trail is stored locally next to the run data. Because that historical
176-session cohort predates frozen manifests, `node scripts/learning-diagnosis-accuracy.mjs --dry-run`
should now be used to inspect the discovered scope before regrading; adding later runs changes
the denominator.)

For that archived protocol, this was a validity floor rather than an outcome claim: it suggested
the diagnoses shown in the demo recordings were representative of those scripted openings. It
does not validate the current prompt/schema, which changed after this cohort was measured.

**Structural guarantees, auditable from code and data rather than from learner behavior:**
eval sessions are isolated from live statistics (fixed strategy order, no experience
writes, no policy revisions unless explicitly opted in); treatment attribution is checked
against a prompt-render delivery ledger rather than recomputed after the fact; the
one-shot cap is host-enforced, not prompt-requested; every self-evolved teaching change
passes human review before it can affect anyone.

## What requires real students

Any claim of the form "the adaptive loop resolves more / faster / more durably than a
baseline." Simulated learners cannot support it — not because the numbers came out wrong,
but because the instrument cannot produce believable failure. The honest statement of the
system's current evidence is: *the loop's diagnoses match scripted misconceptions 94% of
the time, its measurement scaffolding is in place and audited, and its effect on learning
is untested.*

## Next steps

The point of the workbench was always to make the follow-up studies cheap. Three pilot
designs are ready to run the moment real learners are available, each in a different
computing-education research area:

**1. Plan-first scaffolding for recursion (programming-plans research).**
RQ: does bounded, plan-aware scaffolding improve plan articulation and transfer compared
with one-shot planning feedback? Design: CS1-level recursion tasks from the planning-gap
item bank; treatment = on-call loop with plan-level diagnosis; control = host-enforced
one-shot feedback; outcome = plan articulation plus a transfer task, rubric-graded.
Fieldnote already provides the incident lifecycle, the condition enforcement, and the
anonymized research export.

**2. Trust calibration under conflicting AI feedback (feedback-literacy research).**
RQ: does uncertainty-aware verification reduce students' acceptance of incorrect AI
feedback without excessive escalation? Design: explain-in-plain-English tasks where two
automated graders disagree and neither, one, or both are right; measure acceptance of
incorrect feedback and appropriateness of escalations. Fieldnote already separates the
system's verdict from the learner's confirmation and writes a structured handoff report
for every escalation — the two instruments this study needs.

**3. Interventions-to-mastery on architecture misconceptions (mastery-learning research).**
RQ: does a conversation-first remediation loop reduce interventions-to-mastery for
well-defined cache misconceptions? Design: the conceptual-misconception item bank plus
spaced re-verification (+2/+5 days, already implemented); outcome = interventions and
days to a passed delayed transfer check.

**4. The meta-question this document is evidence for (AI-reliability research).**
When can LLM-simulated learners stand in for real ones? The harness runs the identical
protocol against either population, so the three failure modes above become testable
hypotheses: measure where simulated and real learners diverge (compliance under
role-play, paraphrase behavior, failure persistence), and derive validity conditions for
simulation-based tutoring evaluations. The negative result reported here is the first
data point.
