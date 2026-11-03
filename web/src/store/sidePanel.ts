import { create } from 'zustand'
import { useEditStore } from './edit'

/** 左の欄の表示。edit は手順(ステッパー・手順の中身・「戻る」「次へ」)、chat は「AI に相談」 */
export type SidePanelTab = 'edit' | 'chat'

interface SidePanelState {
  tab: SidePanelTab
  show: (tab: SidePanelTab) => void
}

/**
 * 左の欄のタブ(「編集」と「AI に相談」)のどちらを開いているか。
 * 切り替えるのは、タブ(layout/SidePanel)、手順のボタンから AI に文を送ったとき(chat/ChatPanel が 'chat' に)、
 * 下書きの知らせの「編集で確かめる」(steps/stepIds.ts の jumpToStep が 'edit' に)
 */
export const useSidePanelStore = create<SidePanelState>()((set, get) => ({
  tab: 'edit',
  show: (tab) => {
    if (get().tab !== tab) set({ tab })
  },
}))

/** GTFS を読み込み直したとき(捨てたとき・別の GTFS にしたとき)は、会話が終わるので「編集」に戻す */
useEditStore.subscribe((s, prev) => {
  if (s.base !== prev.base) useSidePanelStore.getState().show('edit')
})
