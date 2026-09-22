---
name: review
description: Review a work branch or PR along two axes — Standards and Spec — then land it with approval. Use when a dispatched branch comes back as a PR, or to review any diff against main.
argument-hint: "<branch-or-pr>"
triggers:
  - user
---

# Review

Two-axis review of the diff between the target branch and `main`, followed by approved landing.

## 1. Pin the diff

`git fetch origin`, then pin both ends by SHA, not ref name: `BASE=$(git rev-parse origin/main)`, `HEAD_SHA=$(git rev-parse <branch>)`. The diff is `git diff $BASE...$HEAD_SHA`, the commit list `git log $BASE..$HEAD_SHA --oneline`. Confirm the diff is non-empty before spawning anything — a bad ref fails here, not inside two subagents. Hand subagents the pinned SHAs: a mutable ref can drift mid-review.

## 2. Find the spec

Deterministic in this workflow: `feat/<name>` maps to `work/specs/<name>.md` on `main`. If nothing matches, ask the user. The remote session's slice plan and rulings live in the PR body and comments — read them as evidence of what the implementer believed it was doing.

**No spec doesn't mean no Spec axis.** Without a spec it reviews correctness directly — failure paths, call relations, compatibility — and reports that requirement coverage can't be fully judged. Never write a spec just to enable review.

## 3. Standards sources

Whatever the repo documents (`CODING_STANDARDS.md`, `CONTRIBUTING.md`, lint config) plus the smell baseline below, which always applies. Two rules bind it: **a documented repo standard overrides the baseline**, and **every smell is a judgement call, never a hard violation**. Skip anything tooling already enforces.

- **Mysterious Name**: name doesn't reveal what it does or holds → rename; if no honest name comes, the design is murky.
- **Duplicated Code**: same logic shape in more than one hunk → extract the shared shape.
- **Feature Envy**: method reaches into another object's data more than its own → move it onto the data.
- **Data Clumps**: same fields travel together → bundle into a type.
- **Primitive Obsession**: primitive standing in for a domain concept → give it a small type.
- **Repeated Switches**: same switch on the same type recurs → polymorphism or a shared map.
- **Shotgun Surgery**: one logical change forces scattered edits → gather what changes together.
- **Divergent Change**: one module edited for unrelated reasons → split by reason.
- **Speculative Generality**: abstraction the spec doesn't need → delete it.
- **Message Chains**: `a.b().c().d()` the caller shouldn't depend on → hide behind one method.
- **Middle Man**: mostly delegates onward → call the real target.
- **Refused Bequest**: subclass ignores most of what it inherits → drop inheritance, compose.

## 4. Review both axes

Use parallel read-only subagents when available and independent review is worthwhile; otherwise review both axes locally and disclose the lack of independent review. Inputs and prompts: [briefs.md](briefs.md).

**Dispatched specs arrive pre-reviewed.** The remote session already ran both axes against its diff and posted the reports on the PR. Read them as the axis evidence — check they stand against the pinned diff (coverage, quoted lines, real findings vs rubber stamp) — and only re-run an axis locally when the report is thin or the diff drifted past what it covered. Disclose which evidence is remote.

## 5. Report

`## Standards` and `## Spec` sections, reported separately — never merged or reranked. A change can pass one axis and fail the other (clean code doing the wrong thing; right thing breaking conventions), and only separate reporting shows it. Close with one line per axis: finding count and worst issue.

Before presenting the report, invoke `no-negative-echo` on it — findings stand on evidence, not on the review session's own detours.

## 6. Land

Critical findings mean fix before merge — push back via PR comment for the remote session, or fix locally. Once the user approves:

Before merging, confirm the branch head still matches the reviewed SHA; use an expected-head guard where supported. If it changed, review the delta, refresh affected checks, and obtain approval for the updated result.

1. **Merge into `main`.** With a PR: `gh pr merge <branch> --merge` — a merge commit keeps the `slice sNN:` ledger inside main's history; `--squash` is the alternative if you want one commit per spec and are fine leaving slice detail on the PR page. Without a PR (pure local flow): `git checkout main && git merge --no-ff <branch> -m "feat: <name>" && git push`.
2. **Cleanup contract**: `git checkout main && git pull`, delete `work/specs/<name>.md` (plus a `work/specs/<name>/` companion directory if one exists — only this work's artifacts), commit and push — the spec was a work order and its work has landed.
3. **Delete the branch** local and remote: `git branch -d feat/<name>` and `git push origin --delete feat/<name>` (`gh pr merge --delete-branch` folds this into step 1). If the spec was dispatched, clean up the agent host too: `ssh fairybox 'tmux kill-session -t spec-<name> 2>/dev/null; cd ~/workspaces/<repo> && git worktree remove --force ~/workspaces/<repo>-<name>'`.
4. **Graduate surviving decisions**: anything a future agent will wonder "why" about becomes an ADR candidate — offer them, don't write unprompted.
