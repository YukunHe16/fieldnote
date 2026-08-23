---
name: official-source-research
description: Research current graduate-admissions facts from official pages. Use when the user asks about deadlines, tuition, language requirements, scholarships, visa or exam policy, or faculty availability (截止/学费/语言要求/奖学金/签证). Skip casual chat and facts the user just confirmed in this turn.
---

# Official-source research

Use this skill for deadlines, tuition, language requirements, scholarships, application rules, visa or examination policy, and faculty availability.

## When to use

- The user asks for a current deadline, fee, language rule, scholarship, visa or exam policy, or whether a faculty member is recruiting.
- A later comparison, strategy, statement, or tracker write needs an official URL and verification date.

## When not to use

- Casual chat, or a fact the user just confirmed in this turn.
- Comparing several programmes after the official facts are already in hand — use program-comparison.
- Reading or writing the saved application board — use application-tracker.

## Method

1. Start with the responsible institution's official school, department, graduate-school, laboratory, faculty, government, or examination-provider page.
2. Record the exact claim, URL, source organisation, page date when available, and today's verification date.
3. Separate verified facts from inference, discovery leads, stale pages, and unresolved conflicts.
4. Use ranking sites, forums, and aggregators only to discover an official page; never present them as final evidence.
5. Discover URLs with built-in `WebSearch`. Write the query from the school and programme names already in play; do not invent domains. `allowed_domains` is optional and only for a host you already know. Read the selected page with `admissions_evidence.fetch_official_page`, or `WebFetch` for a quick look. If the fetch reports a JavaScript-rendered shell, follow `candidateLinks` or search again for a static or PDF official page. Use `admissions_evidence.search_official_sources` only when native search is unavailable or empty. Search snippets alone are never verified evidence.

## Safety

Do not state dynamic admissions facts as current without a source. Do not fabricate unavailable fields. Do not store full webpages, transcripts, passports, finances, or recommendation letters. If pages conflict or cannot be read, say so and give the user the official link to confirm.

## Evaluation prompts

- Does every current deadline, fee, requirement, or funding claim cite the responsible official source and a verification date?
- Are non-official discovery sources clearly excluded from the final factual conclusion?
