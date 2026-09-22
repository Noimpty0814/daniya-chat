# Subagent briefs

Use these briefs for delegated or local review; delegated reviewers stay read-only.

## Standards axis

Inputs: the pinned diff command, commit list, standards-source files, and smell baseline from SKILL.md. Include the baseline in delegated briefs.

Brief:

> Report, per file/hunk where relevant: (a) every place the diff violates a documented standard — cite the file and the rule; (b) any baseline smell you spot — name it and quote the hunk. Distinguish hard violations from judgement calls: documented-standard breaches can be hard, baseline smells are always judgement calls, and a documented repo standard overrides the baseline. Skip anything tooling already enforces. Under 400 words.

## Spec axis

Inputs: the pinned diff command, commit list, and spec contents (or the fact that no spec exists).

Brief:

> Report: (a) requirements the spec asked for that are missing or partial; (b) behaviour in the diff that wasn't asked for (scope creep); (c) requirements that look implemented but are implemented wrong. Quote the spec line for each finding. If there is no spec: review correctness instead — failure paths, call relations, compatibility — and state that requirement coverage can't be fully judged. Under 400 words.
