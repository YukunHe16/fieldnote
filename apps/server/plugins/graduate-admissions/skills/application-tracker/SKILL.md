---
name: application-tracker
description: Read or change saved programmes, requirements, tasks, and deadlines on the application board. Use when the user asks to 加入看板/改状态/更新截止日期. Skip researching unknown official facts first (use official-source-research) and skip drafting materials.
---

# Application tracker

Use this skill to read or update the applicant's structured application board.

## When to use

- The user asks to add, edit, list, or delete saved programmes, requirements, tasks, or deadlines.
- A later answer needs the current board as the source of saved GPA, scores, status, or artifact versions.

## When not to use

- Looking up an official fact that is not yet on the board — use official-source-research first.
- Drafting a CV, SOP, or outreach email — use the matching writing skill.
- Inventing a new programme row from a ranking-site snippet.

## Method

1. Use tracker data as the factual source for GPA, test scores, programme status, requirements, tasks, and artifact versions.
2. Link dynamic programme fields to an official evidence source and verification date.
3. When the user asks to save, correct, or update the board, write the change with the matching tracker tool. Use `update_program` for official URL, deadline, tuition/funding notes, and programme name. Use `update_requirement` for notes and due dates. Use `update_task` for title, due date, and priority. Use `update_application_cycle` for degree, intake, field, or regions. Use `delete_program` when the user clearly asks to remove a saved programme. Do not ask the user to edit the board by hand when a write tool exists.
4. If a programme page URL is not yet verified, leave `officialUrl` empty rather than writing a homepage placeholder.
5. Summarize upcoming deadlines, incomplete materials, and next actions clearly.
6. Ask for confirmation before destructive actions such as deleting a programme or overwriting an artifact.

## Safety

Use only these programme states: researching, shortlisted, applying, submitted, interview, offer, rejected. Legacy `withdrawn` rows may still appear; do not offer withdrawn as a new status — delete the programme instead when the user wants it gone. Use only these requirement states: missing, in_progress, ready, submitted, waived. Do not save transcript text, passports, financial evidence, or recommendation letters as memory. Mark outdated evidence as needing re-verification rather than presenting it as current.

## Evaluation prompts

- Are all changes explicitly authorized and reversible where possible?
- Do dynamic facts include official evidence and a verification date, with stale data clearly marked?
