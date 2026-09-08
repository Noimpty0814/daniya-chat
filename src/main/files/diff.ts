import type { DiffLine } from '../../shared/types'

/** 行级 LCS diff；a*b 超 900 万格时退化为整文件替换（内存保护） */
export function diffLines(oldText: string, newText: string): DiffLine[] {
  // 空串按 0 行处理（''.split('\n') 会得到 ['']，凭空多出一行）
  const a = oldText === '' ? [] : oldText.split('\n')
  const b = newText === '' ? [] : newText.split('\n')
  if (a.length * b.length > 9_000_000) {
    return [
      ...a.map(text => ({ kind: 'del' as const, text })),
      ...b.map(text => ({ kind: 'add' as const, text }))
    ]
  }
  const m = a.length
  const n = b.length
  const dp: Uint32Array[] = Array.from({ length: m + 1 }, () => new Uint32Array(n + 1))
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  const out: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < m || j < n) {
    if (i < m && j < n && a[i] === b[j]) { out.push({ kind: 'same', text: a[i] }); i++; j++ }
    // 相等时优先 del（改一行 = 删旧+增新的顺序约定）
    else if (j < n && (i === m || dp[i][j + 1] > dp[i + 1][j])) { out.push({ kind: 'add', text: b[j] }); j++ }
    else { out.push({ kind: 'del', text: a[i] }); i++ }
  }
  return out
}
