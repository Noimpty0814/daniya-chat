---
name: to-spec
description: Turn the current conversation into an implementable spec file. Use after an alignment discussion when the user wants the agreed design captured as a handoff artifact for implementation.
argument-hint: "[spec-name]"
triggers:
  - user
---

# To Spec

Synthesize what this conversation already established into `work/specs/<name>.md`. No new interview — if something load-bearing is undecided, it goes under Open Questions instead of being re-asked or silently guessed.

**A spec is a work order, not a document of record.** `work/` holds in-flight artifacts; `docs/` holds what stays true after the work lands. Commit the spec so other sessions and agents can pick it up; when the implementation merges, delete the spec file — its durable decisions graduate to `docs/adr/` or `CONTEXT.md`, and git history preserves the rest. A spec file left behind after its work ships is noise for every future session.

1. Read `CONTEXT.md` if it exists and use its vocabulary throughout; respect ADRs touching the area.
2. Explore the repo enough that every claim the spec makes about the current system is true.
3. Write the spec with the template below. It is the handoff artifact to the implementer: an agent in a fresh session — possibly a different model — should be able to execute it without reading this conversation.

<spec-template>

## Problem

The problem from the user's perspective. One paragraph.

## Outcome

What done looks like, observably. Acceptance signals a reviewer can check.

## User Stories

A numbered list covering every user-facing aspect — exhaustive, not illustrative:

1. As an <actor>, I want <capability>, so that <benefit>

## Decisions

Numbered list of settled decisions: interfaces, data shapes, behavior rules, technical choices. One line each — the decision, plus the why when it isn't obvious. This is the spec's backbone; the prose sections support it. No file paths or code snippets (they rot fast) — except a snippet that encodes a decision more precisely than prose can, e.g. a state machine or schema shape.

## Testing

- Which public seams get tests. Prefer existing seams; the fewer the better.
- What a good test is here: external behavior through those seams, never implementation details.

## Out of Scope

What this spec deliberately does not cover.

## Open Questions

Unresolved points implementation must not guess at. An empty section is a valid answer — it means alignment held.

</spec-template>

Before delivering the spec, invoke `no-negative-echo` on it — the conversation that produced it held rejected options, and the spec must describe only the accepted design.

To send the spec to a remote executor, tell the user to run `/dispatch <name>`. To implement it locally instead, run `/execute-spec work/specs/<name>.md` — same contract, no handoff.
