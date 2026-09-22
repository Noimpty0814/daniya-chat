# work/ — 在途协作面

本目录存放**在途**协调产物，随 `main` 提交同步，所有会话共享。这里没有任何东西是永久文档——产物随其工作落地而删除，沉淀下来的真值去 `docs/`（ADR）或 `CONTEXT.md`。

## 布局

- `maps/<effort>.md` — 工作图（wayfinder）。目标已知但路径不明时使用；产出**决策与 spec**，不产出代码。到达目的地后删除。
- `specs/<name>.md` — 工作单（to-spec）。与分支 `feat/<name>` 配对；工作落地后删除。

## 生命周期

```
/align → /to-spec → /dispatch(fairybox 远程) 或 /execute-spec(本地) → /review
```

- 认领 map 条目：刷新共享状态 → 标 `[~]` + 会话标识 → 同步成功后才开工。
- 同步方式：直接提交到 `main`。
