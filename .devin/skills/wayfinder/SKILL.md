---
name: wayfinder
description: Plan and drive an effort too big for one spec — chart open questions at work/maps/<effort>.md, then work the frontier until the way to the destination is clear.
argument-hint: "<effort-name>"
triggers:
  - user
---

# Wayfinder

For work where the destination is known but the way isn't — too big or too foggy for a single spec. The map lives at `work/maps/<effort>.md`, shared through the project's coordination convention. Maps produce **decisions and specs**, never code; build work happens downstream in the spec pipeline (`to-spec` → `dispatch` → `execute-spec` → `review`).

## The map file

```markdown
# Map: <effort>

## Destination
<what reaching the end looks like — one or two lines; every session orients to it>

## Notes
<domain, CONTEXT.md files to consult, skills sessions should use, standing preferences>

## Decisions so far
- <question>: one-line gist → where the answer lives (ADR, spec, PR link)

## Frontier
- [ ] <question sharp enough to work now> — grill | research | prototype | task
- [ ] spawn spec <name>: decision resolved, ready for /to-spec

## Fog
<in-scope but can't phrase sharply yet — graduates to Frontier as answers clear it>

## Out of scope
<ruled out + why — never graduates>
```

The file is an **index, not a store**: Decisions-so-far carries one-line gists and links; detail lives in the ADR/spec/PR. Keep coordination state shared and recoverable; use the project's chosen location and sync method for every update.

## Chart — `/wayfinder <new-effort>`

1. Invoke `grill` to name the **destination** — the spec set, locked decision, or landed change this effort is finding its way to. The destination fixes scope, so it settles first.
2. Grill again **breadth-first**: fan across the space, surface the open questions and first takeable steps. If no fog surfaces — the way is already clear — don't make a map; go straight to `/align` or `/to-spec`.
3. Write and sync the map through the project's chosen shared location.
4. Research items can start immediately as background subagents — they run unattended.

## Work — `/wayfinder <existing-effort>`

1. Load the map — the low-res view, not every linked doc.
2. Pick the user's choice or the first unblocked item. **Claim it first**: refresh shared state, mark `[~]` with a session identifier, and sync successfully before starting. On a sync conflict, reread ownership; if another session owns it, pick another item.
3. Work it by type:
   - **grill** → invoke `grill` with the user. HITL: never answer for them.
   - **research** → background subagent; findings land as a linked file or PR comment, gist on the map.
   - **prototype** → a cheap throwaway artifact the user can react to.
   - **task** → do it (agent) or hand the user a precise checklist.
   - **spawn spec** → run `to-spec`; the spec then flows through the normal pipeline on its own — the map just tracks the link.
4. Record the resolution: check the box, add the gist to Decisions so far, graduate any fog the answer made specifiable into Frontier items, close what it ruled out into Out of scope. Offer an ADR only when the same three tests hold (hard to reverse, surprising, real trade-off).

**Default to one item per session** — context hygiene is the point; a session that tries to work the whole frontier compacts and loses precision. If context is still clear, closely related items may continue in the same session.

## Close

When the destination is reached — all spawned specs merged, the decision locked, the change landed — delete the map and sync through the same shared location. Preserve any still-needed decisions in their durable homes first. The map was scaffolding, not a document of record.
