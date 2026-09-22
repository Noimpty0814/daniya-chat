---
name: align
description: Requirement-alignment session. Use to kick off a feature, change, or fuzzy idea — interviews the user, then captures settled vocabulary and durable decisions as CONTEXT.md and ADRs.
triggers:
  - user
---

# Align

Two jobs in one session: reach shared understanding with the user, and capture what it settles so later sessions — and other agents — start aligned.

## During the interview

Invoke the `grill` skill and run it. While it runs, work the language in parallel:

- **Challenge glossary drift.** If the user uses a term that conflicts with `CONTEXT.md`, call it out immediately: "The glossary defines X as ..., but you seem to mean ...."
- **Sharpen fuzzy terms.** When the user reaches for vague or overloaded words, propose a precise canonical term.
- **Cross-check the code.** When the user states how something works and the code disagrees, surface the contradiction — the conversation and the codebase can't both be the spec.
- **Probe with scenarios.** Invent concrete edge cases that force precision about where a concept's boundaries lie.

## Capture as you go

Write things down the moment they settle; never batch them to the end. Two lifetimes live here: `docs/` holds **current truth** — what stays true after the work lands; anything that dies with the task (specs, plans, maps) belongs in `work/` instead, where files get deleted when the work ships.

- **`CONTEXT.md`** at the repo root (create lazily, when the first term resolves): project vocabulary only — canonical terms and their meanings. No implementation details, no specs, no scratch notes. Test each line before keeping it: would removing it let a fresh agent misunderstand the domain? If the repo has multiple bounded contexts, a root **`CONTEXT-MAP.md`** routes each module to its own `CONTEXT.md` — update the map when a context is born, the glossary when a term resolves.
- **`docs/adr/NNNN-title.md`** (create lazily): write one only when all three hold — hard to reverse, surprising without context, the result of a real trade-off. Missing any one, skip it. A decision that only matters until this task ships doesn't qualify — it goes in the spec.

## Closing

When the interview converges, write back: the agreed outcome, decisions made, rejected alternatives, open questions that stayed open. The user confirms shared understanding before anything downstream starts.

If the user then wants an implementable handoff artifact, invoke `to-spec`.
