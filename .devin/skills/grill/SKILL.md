---
name: grill
description: Relentless interview to reach shared understanding of a plan, design, or idea. Use when the user wants to think through or stress-test what to build, when requirements feel fuzzy, or when another skill needs open decisions resolved by the user.
triggers:
  - user
  - model
---

# Grill

Interview the user until you share the same picture of the work. Map it as a **design tree**: every decision branches into the decisions that hang off it.

Work the tree in **rounds**. The **frontier** is every decision whose prerequisites are settled. Prioritize high-risk questions gating the next step; defer the rest as needed. Number each question, recommend an answer, then wait.

Format a round like this:

```
❓ **Q1** - **<question title>**: <question body — multiple paragraphs or options as needed>

➡️ <your recommended answer>

---

❓ **Q2** - **<question title>**: <question body>

➡️ <your recommended answer>
```

Each answer reshapes the tree: settled decisions push the frontier outward and unblock the questions that depended on them. Recompute the frontier and ask the next round. A question whose answer depends on another question still open belongs to a later round, not this one.

**Facts are your job, decisions are the user's:**

- When a frontier question needs a fact (codebase, docs, environment), look it up or dispatch a subagent — never ask the user for what you can find yourself.
- While lookups run, ask priority questions that don't depend on them.
- Every question carries a recommended answer with reasoning, so the user can confirm with one word instead of writing essays. Recommendations carry your judgment; the decision stays theirs.

Prioritize by blast radius: what gates the most downstream work, and what's most expensive to get wrong, get asked first. Not every branch needs visiting — a question the user can safely defer gets recorded as an open question, not pressed.

The interview converges when the decisions gating the next step are settled and the remaining open assumptions are ones the user knowingly accepts. Then write back the shared understanding — the agreed outcome, decisions made, deferred items — and get the user's confirmation before acting on it.
