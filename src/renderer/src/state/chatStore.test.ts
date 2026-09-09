import { describe, it, expect } from 'vitest'
import { initialState, reducer, type State } from './chatStore'
import type { ChatMessage, ConversationMeta } from '../../../shared/types'

function conv(id: string, title = '会话' + id): ConversationMeta {
  return { id, title, createdAt: 1, updatedAt: 1 }
}
function msg(id: string, content = '', role: 'user' | 'assistant' = 'user'): ChatMessage {
  return { id, role, content, createdAt: 1 }
}

describe('chatStore reducer', () => {
  it('初始状态为空聊天视图', () => {
    expect(initialState).toEqual({
      view: 'chat', conversations: [], activeId: null, messages: [],
      streaming: null, error: null, errorRetry: null, searchQuery: '', searchHits: null,
      proposal: null
    })
  })

  it('init 设置会话列表', () => {
    const s = reducer(initialState, { type: 'init', conversations: [conv('a'), conv('b')] })
    expect(s.conversations.map(c => c.id)).toEqual(['a', 'b'])
  })

  it('setView 切换视图', () => {
    expect(reducer(initialState, { type: 'setView', view: 'settings' }).view).toBe('settings')
  })

  it('select 设置 activeId/messages 并清空 streaming/error', () => {
    const dirty: State = {
      ...initialState,
      streaming: { requestId: 'r', text: 'x' },
      error: 'boom',
      messages: [msg('old')]
    }
    const s = reducer(dirty, { type: 'select', id: 'a', messages: [msg('m1')] })
    expect(s.activeId).toBe('a')
    expect(s.messages.map(m => m.id)).toEqual(['m1'])
    expect(s.streaming).toBeNull()
    expect(s.error).toBeNull()
  })

  it('newConversation 置顶新会话并选中、清空消息', () => {
    const base: State = { ...initialState, conversations: [conv('a')], activeId: 'a', messages: [msg('x')] }
    const s = reducer(base, { type: 'newConversation', meta: conv('b') })
    expect(s.conversations.map(c => c.id)).toEqual(['b', 'a'])
    expect(s.activeId).toBe('b')
    expect(s.messages).toEqual([])
  })

  it('rename 只改目标会话标题', () => {
    const base: State = { ...initialState, conversations: [conv('a'), conv('b')] }
    const s = reducer(base, { type: 'rename', id: 'a', title: '改名' })
    expect(s.conversations[0].title).toBe('改名')
    expect(s.conversations[1].title).toBe('会话b')
  })

  it('remove 删除会话；删除当前会话时选中第一个剩余并清空消息', () => {
    const base: State = { ...initialState, conversations: [conv('a'), conv('b')], activeId: 'a', messages: [msg('x')] }
    const s = reducer(base, { type: 'remove', id: 'a' })
    expect(s.conversations.map(c => c.id)).toEqual(['b'])
    expect(s.activeId).toBe('b')
    expect(s.messages).toEqual([])
  })

  it('remove 删除最后一个会话时 activeId 为 null', () => {
    const base: State = { ...initialState, conversations: [conv('a')], activeId: 'a', messages: [msg('x')] }
    const s = reducer(base, { type: 'remove', id: 'a' })
    expect(s.conversations).toEqual([])
    expect(s.activeId).toBeNull()
    expect(s.messages).toEqual([])
  })

  it('remove 删除非当前会话时保持 activeId 与消息', () => {
    const base: State = { ...initialState, conversations: [conv('a'), conv('b')], activeId: 'b', messages: [msg('keep')] }
    const s = reducer(base, { type: 'remove', id: 'a' })
    expect(s.conversations.map(c => c.id)).toEqual(['b'])
    expect(s.activeId).toBe('b')
    expect(s.messages.map(m => m.id)).toEqual(['keep'])
  })

  it('appendUser 追加用户消息', () => {
    const s = reducer(initialState, { type: 'appendUser', message: msg('m1', '你好') })
    expect(s.messages).toHaveLength(1)
    expect(s.messages[0].content).toBe('你好')
  })

  it('startStream 初始化 streaming 并清空错误', () => {
    const base: State = { ...initialState, error: 'boom' }
    const s = reducer(base, { type: 'startStream', requestId: 'r1' })
    expect(s.streaming).toEqual({ requestId: 'r1', text: '' })
    expect(s.error).toBeNull()
  })

  it('streamEvent delta 累加文本', () => {
    let s: State = reducer(initialState, { type: 'startStream', requestId: 'r1' })
    s = reducer(s, { type: 'streamEvent', e: { requestId: 'r1', type: 'delta', delta: '你' } })
    s = reducer(s, { type: 'streamEvent', e: { requestId: 'r1', type: 'delta', delta: '好' } })
    expect(s.streaming?.text).toBe('你好')
  })

  it('streamEvent delta 无增量字段时保持文本不变', () => {
    let s: State = reducer(initialState, { type: 'startStream', requestId: 'r1' })
    s = reducer(s, { type: 'streamEvent', e: { requestId: 'r1', type: 'delta' } })
    expect(s.streaming?.text).toBe('')
  })

  it('streamEvent requestId 不匹配时忽略', () => {
    let s: State = reducer(initialState, { type: 'startStream', requestId: 'r1' })
    s = reducer(s, { type: 'streamEvent', e: { requestId: 'other', type: 'delta', delta: 'x' } })
    expect(s.streaming?.text).toBe('')
  })

  it('streamEvent 在无 streaming 时忽略', () => {
    const s = reducer(initialState, { type: 'streamEvent', e: { requestId: 'r1', type: 'delta', delta: 'x' } })
    expect(s.streaming).toBeNull()
  })

  it('streamEvent done 将非空 assistant 消息落入 messages 并结束 streaming', () => {
    let s: State = reducer(initialState, { type: 'startStream', requestId: 'r1' })
    s = reducer(s, { type: 'streamEvent', e: { requestId: 'r1', type: 'delta', delta: '回' } })
    s = reducer(s, { type: 'streamEvent', e: { requestId: 'r1', type: 'done', message: msg('a1', '回复', 'assistant') } })
    expect(s.streaming).toBeNull()
    expect(s.messages.map(m => m.id)).toEqual(['a1'])
  })

  it('streamEvent done 空内容时不追加消息', () => {
    let s: State = reducer(initialState, { type: 'startStream', requestId: 'r1' })
    s = reducer(s, { type: 'streamEvent', e: { requestId: 'r1', type: 'done', message: msg('a1', '  ', 'assistant') } })
    expect(s.streaming).toBeNull()
    expect(s.messages).toEqual([])
  })

  it('streamEvent error 设置错误并结束 streaming', () => {
    let s: State = reducer(initialState, { type: 'startStream', requestId: 'r1' })
    s = reducer(s, { type: 'streamEvent', e: { requestId: 'r1', type: 'error', error: '网络错误' } })
    expect(s.streaming).toBeNull()
    expect(s.error).toBe('网络错误')
  })

  it('streamEvent error 缺省错误文案为 未知错误', () => {
    const s = reducer(initialState, { type: 'streamEvent', e: { requestId: 'r1', type: 'error' } })
    expect(s.error).toBe('未知错误')
  })

  it('streamEvent error 携带 retry 载荷时同时设置 error 与 errorRetry', () => {
    const s = reducer(initialState, {
      type: 'streamEvent',
      e: { requestId: '__none__', type: 'error', error: '请先在设置中填写 API Key' },
      retry: { content: '你好' }
    })
    expect(s.error).toBe('请先在设置中填写 API Key')
    expect(s.errorRetry).toEqual({ content: '你好' })
  })

  it('streamEvent error 载荷含 images/userVisible 时原样透传（重试补气泡与跳过落库判据）', () => {
    const s = reducer(initialState, {
      type: 'streamEvent',
      e: { requestId: '__none__', type: 'error', error: '请先在设置中填写 API Key' },
      retry: { content: '你好', images: ['data:image/png;base64,x'], userVisible: false }
    })
    expect(s.errorRetry).toEqual({ content: '你好', images: ['data:image/png;base64,x'], userVisible: false })
  })

  it('error 事件的 retry 载荷透传 files 字段', () => {
    const s = reducer(initialState, { type: 'startStream', requestId: 'r1' })
    const next = reducer(s, {
      type: 'streamEvent',
      e: { requestId: 'r1', type: 'error', error: '网络错误' },
      retry: { content: 'x', files: [{ name: 'a.txt', path: 'C:/a.txt' }], userVisible: false }
    })
    expect(next.errorRetry).toEqual({ content: 'x', files: [{ name: 'a.txt', path: 'C:/a.txt' }], userVisible: false })
  })

  it('error 事件的 retry 载荷透传 search 字段', () => {
    const s = reducer(initialState, { type: 'startStream', requestId: 'r1' })
    const next = reducer(s, {
      type: 'streamEvent',
      e: { requestId: 'r1', type: 'error', error: '网络错误' },
      retry: { content: 'x', search: true, userVisible: false }
    })
    expect(next.errorRetry).toEqual({ content: 'x', search: true, userVisible: false })
  })

  it('streamEvent error 无载荷时 errorRetry 为 null', () => {
    let s: State = reducer(initialState, { type: 'startStream', requestId: 'r1' })
    s = reducer(s, { type: 'streamEvent', e: { requestId: 'r1', type: 'error', error: '网络错误' } })
    expect(s.error).toBe('网络错误')
    expect(s.errorRetry).toBeNull()
  })

  it('startStream 清空 errorRetry', () => {
    const base: State = { ...initialState, errorRetry: { content: 'hi' } }
    expect(reducer(base, { type: 'startStream', requestId: 'r1' }).errorRetry).toBeNull()
  })

  it('select 清空 errorRetry', () => {
    const base: State = { ...initialState, errorRetry: { content: 'hi' } }
    expect(reducer(base, { type: 'select', id: 'a', messages: [] }).errorRetry).toBeNull()
  })

  it('newConversation 清空 errorRetry', () => {
    const base: State = { ...initialState, errorRetry: { content: 'hi' } }
    expect(reducer(base, { type: 'newConversation', meta: conv('b') }).errorRetry).toBeNull()
  })

  it('streamEvent done 清空 errorRetry', () => {
    let s: State = reducer({ ...initialState, errorRetry: { content: 'hi' } }, { type: 'startStream', requestId: 'r1' })
    s = reducer(s, { type: 'streamEvent', e: { requestId: 'r1', type: 'done', message: msg('a1', '回复', 'assistant') } })
    expect(s.streaming).toBeNull()
    expect(s.errorRetry).toBeNull()
  })

  it('clearError 清除错误与 errorRetry', () => {
    const base: State = { ...initialState, error: 'x', errorRetry: { content: 'hi' } }
    const s = reducer(base, { type: 'clearError' })
    expect(s.error).toBeNull()
    expect(s.errorRetry).toBeNull()
  })

  it('clearError 清除错误', () => {
    const base: State = { ...initialState, error: 'x' }
    expect(reducer(base, { type: 'clearError' }).error).toBeNull()
  })

  it('setSearch 同时更新关键词与命中', () => {
    const s = reducer(initialState, { type: 'setSearch', query: '关键词', hits: [] })
    expect(s.searchQuery).toBe('关键词')
    expect(s.searchHits).toEqual([])
  })

  it('petError 直接设置错误（不依赖 streaming 状态）', () => {
    let s: State = reducer(initialState, { type: 'startStream', requestId: 'r1' })
    s = reducer(s, { type: 'petError', message: '桌宠窗口未找到' })
    expect(s.error).toBe('桌宠窗口未找到')
    expect(s.streaming).toEqual({ requestId: 'r1', text: '' })
  })

  it('fileProposal 事件：进入 proposal 状态，startStream 时清空', () => {
    const ev = { id: 'p1', path: 'C:/a.txt', resolvedPath: 'C:/a.txt', diff: [], autoApplied: false }
    const s1 = reducer(initialState, { type: 'fileProposal', e: ev })
    expect(s1.proposal).toEqual(ev)
    const s2 = reducer(s1, { type: 'startStream', requestId: 'r1' })
    expect(s2.proposal).toBeNull()
  })
})
