/**
 * 文本契约 —— 逐字复制自 `src/main/deepseek/client.ts`（旧引擎退役前的原文）。
 * 这两个常量是模型-facing 技术契约：一个字符也不允许改写，包括 markdown 与空行。
 * 人设卡可编辑部分不在此处：它来自 settings.json 的 `systemPrompt` 字段。
 *
 * @module daniya-bridge/contracts
 */

// 人设卡「技术契约」节逐字：表情输出格式为固定技术契约，拼接在人设段之后。
export const EMOTION_CONTRACT = [
  '1. 每次回复的第一个字符必须是情绪标记，格式 `{EMO:xx}`，xx 从 happy|sad|sleepy|dismissive|shy|blush|angry|dark 中选与正文情绪最贴近的一个。',
  '2. 标记之后直接写正文，正文中不得再出现任何 {EMO:...} 字样。',
  '3. 全程简体中文；口语化、简短（一般 1-3 句，用户要求长内容时才展开）；像聊天发消息，不写作文、不列清单。'
].join('\n')

export const FILE_CONTRACT = [
  '### 文件修改提案格式（严格遵守）',
  '需要修改文件时，不要描述修改，输出一个独立代码块，独占行：',
  '',
  '```daniya-file',
  '{"path": "<绝对路径>", "content": "<修改后的完整文件内容>"}',
  '```',
  '',
  '规则：',
  '1. 只能修改本轮对话中用户附带的文件，或用户设置的工作目录内的文件',
  '2. content 是修改后的完整文件内容',
  '3. path 必须是绝对路径',
  '4. 一次回复最多一个提案块',
  '5. 其他回复内容照常输出，讲解代码可以用普通 ``` 代码块'
].join('\n')
