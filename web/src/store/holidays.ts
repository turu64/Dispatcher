import { create } from 'zustand'
import { fetchHolidays, type HolidayList } from '../gtfs/holidays'

/** 祝日一覧の読み込みの状態 */
export type HolidayState =
  | { status: 'idle' | 'loading' }
  | { status: 'ready'; list: HolidayList }
  | { status: 'missing' } // 404(サーバーに祝日一覧が無い)
  | { status: 'error'; message: string }

interface HolidayStoreState {
  holidays: HolidayState
  /**
   * 祝日一覧を読む。読み込み中と読み込み済みのときは何もしない(画面を開いたときに 1 回だけ読む)。
   * 読めなかった(missing・error)あとは、もう一度呼べば読み直す(読み込み直しのボタン用)。
   */
  load: () => Promise<void>
}

export interface HolidayStoreDeps {
  /** 404 のときは null。ほかの失敗は投げる */
  fetchHolidays: () => Promise<HolidayList | null>
}

function messageOf(e: unknown): string {
  const message = e instanceof Error ? e.message : String(e)
  return message || '祝日一覧を読み込めませんでした。'
}

/** 祝日一覧の store を作る(テストでは fetchHolidays を差し替える) */
export function createHolidayStore(deps: HolidayStoreDeps) {
  return create<HolidayStoreState>()((set, get) => ({
    holidays: { status: 'idle' },
    load: async () => {
      const { status } = get().holidays
      if (status === 'loading' || status === 'ready') return
      set({ holidays: { status: 'loading' } })
      try {
        const list = await deps.fetchHolidays()
        set({ holidays: list ? { status: 'ready', list } : { status: 'missing' } })
      } catch (e) {
        set({ holidays: { status: 'error', message: messageOf(e) } })
      }
    },
  }))
}

/**
 * 祝日一覧を持つ。使う側は `useHolidayStore((s) => s.holidays)` で状態を選んで読む。
 * 祝日一覧が無くても(missing・error)、方針の適用・足し戻し・比較・出力は動く。
 * 祝日に関わる確かめだけを、「祝日一覧を読めないため、祝日の確認をしていません」と出して省く。
 */
export const useHolidayStore = createHolidayStore({ fetchHolidays: () => fetchHolidays() })
