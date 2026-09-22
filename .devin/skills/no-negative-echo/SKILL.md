---
name: no-negative-echo
description: Use before producing a final deliverable — a spec, PR title/body, commit message, handoff, or review report — especially after a session that held corrections or rejected proposals.
triggers:
  - user
  - model
---

# No Negative Echo

Ship the result, not the conversation. The reader of your deliverable never saw this session — describe only the accepted final state. Adapted from LB623/no-negative-echo.

## Before producing the artifact

Identify internally:

- the accepted final state and the facts the audience needs;
- rejected session-only alternatives — they stay silent;
- every surface being written: titles, filenames, comments, commit text, PR text, handoff, report.

Mention an exclusion only when a session-less reader needs it: omitting it would make the artifact unsafe, inaccurate, misleading, or incompatible — or the surface exists to record the trade-off (ADR, changelog, migration note, a requested comparison). A real decision record earns its "why not X"; a spec or commit doesn't.

## Produce

Generate each surface from the positive target. Regenerate titles, headings, labels, and filenames from the accepted design rather than editing rejected wording token by token — "don't mention X" means the contrast disappears entirely, not that it gets a euphemism, a parenthetical, or a compliance claim.

Preserve real facts: pre-existing user changes, executed actions, required diagnostics, tests, and API names are never cut just to avoid a term.

## Verify before delivery

Re-read the final bundle for residue: direct or paraphrased references to rejected options, explanations of why an absent option is absent, and the wrappers — filename, metadata, commit subject, PR title. Changed anything? Check again. Then stop: don't append a claim that the output is clean — that claim is itself residue.
