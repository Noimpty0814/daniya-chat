---
name: dispatch
description: Hand a spec off to the remote agent host for execution. Use when a spec in work/specs/ is ready to be implemented remotely.
argument-hint: "<spec-name>"
triggers:
  - user
---

# Dispatch

Send a spec to the remote agent. The spec is the payload, the branch is the execution boundary, the PR is the return channel. Decomposition is the remote session's own concern (`execute-spec` covers it) — the repo only ever carries the spec.

The agent host is reached through the ssh alias `fairybox` (bound in `~/.ssh/config`). Never write its raw address into repo files — skills are public; the alias is rebindable per machine.

## Steps

1. **Read `work/specs/<name>.md`.** If it already carries a `Dispatched:` line, stop — it's spoken for; report the recorded session. If Open Questions contains anything that blocks implementation, stop and list them — a remote agent can't ask, it can only guess.

2. **Commit `work/specs/<name>.md` to `main` and push.** Work artifacts are coordination state, not code — they ride main so any session can read them, and get deleted when the work lands.

3. **Prepare the execution branch.** Reuse `feat/<name>` if it belongs to this spec; otherwise create it from `main`. Push it before dispatch. On retry, confirm whether the earlier session started before dispatching again; stop if branch ownership is unclear.

4. **Preflight the agent host.** Clone the target repo first if its workspace is missing — the spec lives in the hub repo's `work/specs/`, the work happens in `<repo>`:

   ```bash
   ssh fairybox 'mkdir -p ~/workspaces && cd ~/workspaces &&
     [ -d <repo> ] || git clone git@github.com:<org>/<repo>.git &&
     cd <repo> && git fetch origin'
   ```

   Check `gh auth status` there too — without it the remote session can still push, but the draft PR gets opened from this side.

5. **Dispatch.** Each spec gets its own worktree (`~/workspaces/<repo>-<name>`) so concurrent specs never share a checkout, and a detached tmux session (`spec-<name>`) so the work survives disconnects and stays attachable. `spec-<name>` must be unique across the box.

   - Write the prompt to a file and `scp` it to `fairybox:~/dispatch-<name>.md` — the prompt is itself a delivery surface: run `no-negative-echo` on it before sending, the remote session never saw this conversation. Contents:

     ```
     You have the full repo on this machine; the worktree is your workspace. Implement the spec at ~/workspaces/<hub>/work/specs/<name>.md on branch feat/<name> — the spec is the contract, how you slice the work is yours (the repo's execute-spec skill covers it). Then:

     1. Verify — run the repo's checks on the final feat/<name> state.
     2. Review your own diff (main...feat/<name>) with two fresh read-only subagents, one per axis, using the briefs in .devin/skills/review/briefs.md — Standards and Spec. Fix real findings and re-verify.
     3. Commit, push, and open a draft PR whose body carries the slice plan and both axis reports, then mark it ready for review — a ready PR is your return signal.

     If gh isn't authenticated, push and report done — the dispatcher opens the PR. If an Open Question blocks you, stop and report; never guess.
     ```

   - Launch:

     ```bash
     ssh fairybox 'cd ~/workspaces/<repo> &&
       git worktree add ~/workspaces/<repo>-<name> feat/<name> &&
       tmux new-session -d -s spec-<name> -c ~/workspaces/<repo>-<name> \
         "~/.local/bin/devin --model swe-2-max --permission-mode bypass --prompt-file ~/dispatch-<name>.md"'
     ```

     `bypass` is what makes the session autonomous — approvals can't reach a detached session. The `devin` user and the dedicated box are the containment boundary. Dispatched sessions always run **SWE-2 Max** (`--model swe-2-max`) — pinning the model is deliberate, don't drop the flag.

   - Verify it took: `ssh fairybox 'tmux has-session -t spec-<name>'`. The user can watch or steer with `ssh -t fairybox 'tmux attach -t spec-<name>'`.

6. **Record the dispatch state** on the spec; commit and push to `main` — switch back from `feat/<name>` first, a state line committed on the feature branch is invisible to other sessions and pollutes its review diff. Confirm push succeeded before treating the state as shared:

   `Dispatched: <repo>@feat/<name> — <date> — fairybox:spec-<name>`

   Only a verified tmux session counts as dispatched — a failed launch gets no state line. A stale `Handoff ready:` or unverifiable `Dispatched:` line is safe to re-dispatch after asking the user.

## Return signal

Push never merges — landing is gated on `/review`, by design. The remote session signals done by marking its PR ready for review (`gh pr ready`); a dead `spec-<name>` tmux session is the fallback signal when gh isn't authenticated. Check with `gh pr list` or `ssh fairybox 'tmux has-session -t spec-<name>'`.

When the PR comes back ready, `/review` handles acceptance and cleanup — including killing `spec-<name>` and removing the worktree on the agent host.
