/**
 * 人设段 —— 每次 system-prompt 组装时重读 settings 文件并拼接文本契约。
 *
 * 现行语义：`systemPrompt` 字段 + EMOTION_CONTRACT + FILE_CONTRACT
 * + `用户当前工作目录：<workdir>`，四段以空行相连。文件每轮重读、不缓存，
 * 保持"设置页改完，下一条消息即生效"。
 *
 * 读文件失败 / JSON 非对象 / 字段缺失：人设部分按空串处理，契约与工作目录行
 * 仍然照常输出（不阻塞组装，也不让技术契约静默消失）。settingsFile 未配置时同样处理。
 *
 * @module daniya-bridge/persona
 */

import { readFileSync } from 'node:fs'
import { EMOTION_CONTRACT, FILE_CONTRACT } from './contracts.js'

/** 拼装一次人设段文本；任何读/解析失败都收缩为人设空串，绝不抛出。 */
export function buildPersonaText(settingsFile: string | undefined, workdir: string): string {
  const persona = readSystemPrompt(settingsFile)
  return [persona, EMOTION_CONTRACT, FILE_CONTRACT, `用户当前工作目录：${workdir}`]
    .filter(part => part.length > 0)
    .join('\n\n')
}

/** 读取 settings JSON 的 `systemPrompt` 字段；失败或非字符串一律返回 `''`。 */
function readSystemPrompt(settingsFile: string | undefined): string {
  if (settingsFile === undefined || settingsFile.length === 0) return ''
  try {
    const parsed: unknown = JSON.parse(readFileSync(settingsFile, 'utf8'))
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return ''
    const value = (parsed as Record<string, unknown>).systemPrompt
    return typeof value === 'string' ? value : ''
  } catch {
    // 文件不存在、读失败或 JSON 非法：人设为空，契约仍输出。
    return ''
  }
}
