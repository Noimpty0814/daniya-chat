export interface SearchResult { title: string; snippet: string; url: string }

const BOCHA_URL = 'https://api.bocha.cn/v1/web-search'
const MAX_TITLE = 120
const MAX_SNIPPET = 300
const MAX_BUDGET = 4096
const MAX_QUERY = 200
const MAX_COUNT = 5

function mapHttpError(status: number): string {
  if (status === 401) return 'Key 无效'
  if (status === 402 || status === 403 || status === 429) return '额度不足'
  return '搜索服务错误'
}

/** 博查 Web Search API（通搜）。响应形状以官方文档为准：成功 code 为 200（兼容 0），data.webPages.value 的 name/snippet/url；错误码文档：401 Key 无效、403 余额不足、429 限流 */
export async function searchBocha(query: string, apiKey: string):
  Promise<{ ok: true; results: SearchResult[] } | { ok: false; error: string }> {
  let res: Response
  try {
    res = await fetch(BOCHA_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ query: query.slice(0, MAX_QUERY), count: MAX_COUNT }),
      signal: AbortSignal.timeout(10_000)
    })
  } catch { return { ok: false, error: '网络错误' } }
  if (!res.ok) return { ok: false, error: mapHttpError(res.status) }
  try {
    const j = await res.json() as {
      code?: number | string
      data?: { webPages?: { value?: { name?: string; url?: string; snippet?: string }[] } }
    }
    // 官方文档成功 code=200（旧版本兼容 0）；数字/字符串形式都容忍
    if (j.code !== undefined && j.code !== null) {
      const c = Number(j.code)
      if (!Number.isNaN(c) && c !== 0 && c !== 200) return { ok: false, error: '搜索服务错误' }
    }
    const value = j.data?.webPages?.value
    if (!Array.isArray(value)) return { ok: false, error: '搜索服务错误' }
    const results: SearchResult[] = []
    let budget = 0
    for (const item of value) {
      const rawTitle = item.name ?? ''
      const rawSnippet = item.snippet ?? ''
      const url = item.url ?? ''
      if (!rawTitle && !url) continue
      // 预算按原始长度计算（保守：实际注入内容 ≤ 预算），截断在预算判定之后
      const cost = rawTitle.length + rawSnippet.length + url.length
      if (budget + cost > MAX_BUDGET) break
      budget += cost
      results.push({ title: rawTitle.slice(0, MAX_TITLE), snippet: rawSnippet.slice(0, MAX_SNIPPET), url })
      if (results.length >= MAX_COUNT) break
    }
    return { ok: true, results }
  } catch { return { ok: false, error: '搜索服务错误' } }
}

export function buildSearchContext(query: string, results: SearchResult[]): string {
  const head = `[搜索: ${query.slice(0, MAX_QUERY)}]`
  if (results.length === 0) return `${head}\n（未找到结果）[/搜索]`
  const lines = results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.snippet}\n   ${r.url}`)
  return `${head}\n${lines.join('\n')}\n[/搜索]`
}
