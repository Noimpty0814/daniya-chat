---
name: execute-spec
description: Implement a spec end to end — decompose into slices when it outgrows one context, executed by fresh subagents on their own worktrees when parallelism pays. Use when a task points at a spec in work/specs/ — dispatched remote work or a local request alike.
argument-hint: "<spec-path>"
triggers:
  - user
  - model
---

# Execute Spec

Implement the spec you're pointed at. **Scale the machinery to the work**: a spec one session can hold is implemented directly; a bigger one is decomposed and orchestrated. The spec is the contract, git carries execution state, the PR carries the plan.

## 1. Orient

Read the spec, `CONTEXT.md`, and any ADRs it touches; explore the code enough that the spec's claims check out. If the spec's branch `feat/<name>` doesn't exist yet, create it from `main` and check it out.

## 2. Size the work

- **Fits one context**: implement directly in this session, then skip to verification.
- **Bigger**: decompose into **tracer-bullet slices** — narrow but complete paths through the layers the change actually touches. Vertical slicing is the default strategy, not a requirement that every slice cross every layer. Each slice is demoable or verifiable alone and sized for one fresh context. Declare blocking edges; keep them minimal. Then route each slice:
  a) A slice whose interfaces with its neighbors are already pinned — in the spec's Decisions or in landed code — and that is independently verifiable goes to a fresh subagent with a crisp task boundary.
  b) A slice on a chain that must share one author's mind — or whose interfaces only become clear during implementation — stays in the main session.
- **Wide refactors** (one mechanical change whose blast radius fans across the codebase) don't slice vertically — run **expand → migrate → contract**, green at each stage.

Slices live in your plan and the PR body — never as repo files.

## 3. Open the PR early when slices exist

With slices: push `feat/<name>` and open a **draft PR** whose body is the slice plan with checkboxes and blocking edges — the running log and the resume point (a dead session is rebuilt from PR body + git). Single-session work can open its PR at the end instead.

## 4. Execute

Work the frontier — a slice is unblocked once everything it depends on is merged into `feat/<name>`:

- **Sequential default**: implement the slice yourself in this session.
- **Parallel when it pays**: for independent slices, `git worktree add ../<repo>-sNN -b feat/<name>-sNN feat/<name>` and dispatch a fresh subagent per slice with a self-contained brief — deliverable, acceptance criteria, pointers to spec/CONTEXT.md/ADRs, never your session history.
- Merge each landed slice: `git merge --no-ff feat/<name>-sNN -m "slice sNN: <title>"`, then `git worktree remove` and `git branch -d`. `git branch --merged feat/<name>` is the done-record; `slice sNN:` commits are the ledger.
- A merge conflict between "independent" slices means a missed dependency — resolve it and note the missed edge on the PR.

**Discretion boundary.** Implementation details that don't change agreed behavior: decide and keep moving, recording on the PR when worth noting. Anything changing the goal, scope, external contract, or acceptance criteria: surface it for confirmation — ask the user if reachable, otherwise post it on the PR — and pause only the work that depends on the answer. Stop the whole effort only for irreversible or security-sensitive steps, or a spec so broken every path is a guess.

## 5. Verify the integrated result

Before marking ready, run the checks relevant to the change — build, tests, typecheck, whatever the repo has — **on the final `feat/<name>` state**. Per-slice green doesn't prove the merge is right: two slices can pass alone and break together. State plainly on the PR what was verified and what wasn't.

## 6. Close

Invoke `no-negative-echo` across the PR title, body, comments, and commit subjects.

Slices landed, integrated result checked, acceptance signals demonstrable → mark the PR ready. Can't demonstrate a signal → say so on the PR rather than claiming done.
