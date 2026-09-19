import type { AppSettingsView, ChatMessage, ConversationMeta, FileAttachment, FileProposalEvent, PetStatus, SearchHit, StartReplyPayload, StartReplyResult, StreamEventMsg } from './types'

export interface Api {
  listConversations(): Promise<ConversationMeta[]>
  createConversation(): Promise<ConversationMeta>
  renameConversation(id: string, title: string): Promise<void>
  deleteConversation(id: string): Promise<void>
  getMessages(id: string): Promise<ChatMessage[]>
  search(q: string): Promise<SearchHit[]>
  startReply(p: StartReplyPayload): Promise<StartReplyResult>
  stopReply(requestId: string): Promise<void>
  onStream(cb: (e: StreamEventMsg) => void): () => void
  onPetError(cb: (message: string) => void): () => void
  getSettings(): Promise<AppSettingsView>
  saveSettings(s: AppSettingsView): Promise<void>
  setApiKey(key: string): Promise<void>
  testConnection(): Promise<{ ok: boolean; message: string }>
  captureScreen(): Promise<{ ok: boolean; dataUrl?: string; error?: string }>
  pickFiles(): Promise<{ files: FileAttachment[]; error?: string }>
  registerFiles(paths: string[]): Promise<{ ok: boolean; files: FileAttachment[]; error?: string }>
  pickWorkDir(): Promise<string>
  applyProposal(id: string): Promise<{ ok: boolean; error?: string }>
  rejectProposal(id: string): Promise<void>
  onFileProposal(cb: (e: FileProposalEvent) => void): () => void
  getPathForFile(f: File): string
  hideWindow(): Promise<void>
  getPetStatus(): Promise<PetStatus>
  openExternal(url: string): Promise<void>
}
