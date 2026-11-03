import { useEffect } from 'react'
import { CLAUDE_UNAVAILABLE, sendBlockedReason, useChatStore, type ChatState } from '@/store/chat'

/** チャットの store(テストでは createChatStore で作った別の store を渡す) */
export type ChatStoreHook = typeof useChatStore

/** AI の状態(GET /api/claude/status)をまだ読んでいなければ、読む */
export function useEnsureChatStatus(store: ChatStoreHook): void {
  const state = store((s) => s.status.state)
  useEffect(() => {
    if (state === 'unknown') void store.getState().loadStatus()
  }, [state, store])
}

/**
 * 「AI に候補を聞く」を押せない理由(押せるなら null)。
 * 状態を確かめている間、AI が使えない、合言葉が要る、予算に達した、ツールを実行している・送っている間は押せない
 */
export function askRestoreBlockedReason(
  s: Pick<ChatState, 'status' | 'token' | 'budgetReached' | 'toolRunning' | 'sending' | 'budgetCents'>,
): string | null {
  if (s.status.state === 'unknown' || s.status.state === 'loading') return 'AI の状態を確かめています…'
  if (s.status.state === 'ready' && s.status.available && s.status.tokenRequired && !s.token) {
    return '認証コードを入れると使えます(「AI に相談」のタブ)。'
  }
  if (s.status.state === 'ready' && !s.status.available) return `${CLAUDE_UNAVAILABLE}ほかの手順はボタンで使えます。`
  return sendBlockedReason(s)
}
