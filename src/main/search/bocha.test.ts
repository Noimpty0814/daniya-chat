import { describe, it, expect, afterEach, vi } from 'vitest'
import { searchBocha, buildSearchContext } from './bocha'

afterEach(() => vi.unstubAllGlobals())

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response
}

function item(name: string, snippet = 'snippet', url = 'https://example.com/a'): { name: string; snippet: string; url: string } {
  return { name, snippet, url }
}

describe('searchBocha', () => {
  it('成功：解析前 5 条 title/snippet/url', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      code: 200,
      data: { webPages: { value: [
        item('t1'), item('t2'), item('t3'), item('t4'), item('t5'), item('t6')
      ] } }
    })))
    const r = await searchBocha('查询', 'sk-x')
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.results).toHaveLength(5)
      expect(r.results[0]).toEqual({ title: 't1', snippet: 'snippet', url: 'https://example.com/a' })
    }
  })

  it('title/snippet 截断到 120/300 字符', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      code: 0,
      data: { webPages: { value: [item('长'.repeat(200), '短'.repeat(500))] } }
    })))
    const r = await searchBocha('q', 'sk-x')
    if (!r.ok) throw new Error('unreachable')
    expect(r.results[0].title).toHaveLength(120)
    expect(r.results[0].snippet).toHaveLength(300)
  })

  it('总预算 4096：超出预算的条目不入', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      code: 0,
      data: { webPages: { value: Array.from({ length: 6 }, (_, i) => item(`t${i}`, 'x'.repeat(1000))) } }
    })))
    const r = await searchBocha('q', 'sk-x')
    if (!r.ok) throw new Error('unreachable')
    expect(r.results).toHaveLength(4)
  })

  it('HTTP 错误映射：401→Key 无效、403→额度不足、429→额度不足、500→搜索服务错误', async () => {
    for (const [status, err] of [[401, 'Key 无效'], [403, '额度不足'], [429, '额度不足'], [500, '搜索服务错误']] as const) {
      vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({}, status)))
      const r = await searchBocha('q', 'sk-x')
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.error).toBe(err)
    }
  })

  it('fetch 抛错 → 网络错误；code 非 0/200 → 搜索服务错误', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('boom') }))
    const r1 = await searchBocha('q', 'sk-x')
    expect(r1.ok).toBe(false)
    if (!r1.ok) expect(r1.error).toBe('网络错误')
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ code: 500, data: null })))
    const r2 = await searchBocha('q', 'sk-x')
    expect(r2.ok).toBe(false)
    if (!r2.ok) expect(r2.error).toBe('搜索服务错误')
  })

  it('畸形 JSON → 搜索服务错误；空 value → 空结果 ok', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ code: 0, data: { webPages: { value: '不是数组' } } })))
    const r1 = await searchBocha('q', 'sk-x')
    expect(r1.ok).toBe(false)
    if (!r1.ok) expect(r1.error).toBe('搜索服务错误')
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ code: 0, data: { webPages: { value: [] } } })))
    const r2 = await searchBocha('q', 'sk-x')
    expect(r2.ok).toBe(true)
    if (r2.ok) expect(r2.results).toEqual([])
  })

  it('buildSearchContext：无结果与正常格式', () => {
    expect(buildSearchContext('今天天气', [])).toBe('[搜索: 今天天气]\n（未找到结果）[/搜索]')
    const block = buildSearchContext('今天天气', [
      { title: '晴', snippet: '白天晴转多云', url: 'https://example.com/1' },
      { title: '雨', snippet: '夜间有小雨', url: 'https://example.com/2' }
    ])
    expect(block).toBe('[搜索: 今天天气]\n1. 晴\n   白天晴转多云\n   https://example.com/1\n2. 雨\n   夜间有小雨\n   https://example.com/2\n[/搜索]')
  })

  it('code 为字符串 200（真实响应形状）也按成功解析', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      code: '200',
      data: { webPages: { value: [item('t1')] } }
    })))
    const r = await searchBocha('q', 'sk-x')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.results).toHaveLength(1)
  })

  it('code 无法解析为数字（如 "abc"）→ 搜索服务错误', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      code: 'abc',
      data: { webPages: { value: [item('t1')] } }
    })))
    const r = await searchBocha('q', 'sk-x')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBe('搜索服务错误')
  })
})
