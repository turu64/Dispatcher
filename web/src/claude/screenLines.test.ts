import { describe, expect, it, vi } from 'vitest'
import { basePlan, smallFeed } from '../gtfs/edit/form2.fixture'
import type { EditOp, PolicySettings } from '../gtfs/edit/ops'
import { createEditStore, type BaseGtfs } from '../store/edit'
import { approvedSummaryLine, researchStartedLine, ScreenLineTracker, stateLines, userEditLines, type ScreenState } from './screenLines'

const NOW = new Date('2026-11-04T00:30:00Z')

function settings(overrides: Partial<PolicySettings> = {}): PolicySettings {
  const { addBackTripIds: _a, ...rest } = basePlan()
  return { ...rest, ...overrides }
}

function setup(screen: () => ScreenState = () => ({ today: '20261104', gtfs: null, reach: null })) {
  const store = createEditStore({ now: () => NOW, onEdited: vi.fn() })
  const base: BaseGtfs = { feed: smallFeed(), zip: new ArrayBuffer(0), label: 'test.zip', sample: null }
  store.getState().setBase(base)
  const tracker = new ScreenLineTracker({
    screen,
    edits: () => store.getState(),
    takeDraftNotices: () => store.getState().takeDraftNotices(),
  })
  const s = store.getState
  const commit = (op: EditOp, by: 'user' | 'claude' = 'user') => {
    expect(s().propose(op, by).ok).toBe(true)
    expect(s().commit()).toEqual({ ok: true })
  }
  /** 行を作って送れたことにする */
  const send = (extra: string[] = []) => {
    const p = tracker.prepare(extra)
    p.commit()
    return p.lines
  }
  return { store, tracker, s, commit, send }
}

const items = (...ids: string[]) => ids.map((tripId) => ({ tripId, reason: '', schoolDaysOnly: false }))
const policy = (overrides: Partial<PolicySettings> = {}): EditOp => ({
  type: 'applyPolicy',
  settings: settings({ period: { start: '20261109', end: null }, ...overrides }),
  reason: { category: null, note: '' },
})

describe('[画面の状態] はセッションの最初の発言と、変わったときだけ入る', () => {
  it('最初の発言にすべての行を入れ、変わった行だけを次の発言に入れる。送れなかった行は次にもう一度入れる', () => {
    let screen: ScreenState = {
      today: '20261104',
      gtfs: { label: '道北バス', validity: { start: '20261001', end: '20270331' }, services: { weekday: 'WK', saturday: 'SA', sundayHoliday: null } },
      reach: { date: '20261110', stepHours: 3 },
    }
    const { tracker, send } = setup(() => screen)
    expect(send()).toEqual([
      '[画面の状態] 今日は 2026年11月4日(水)です(日本時間)。',
      '[画面の状態] 読み込んだ GTFS:道北バス(有効期間 2026年10月1日〜2027年3月31日)。平日の service:WK、土曜:SA、日祝:未選択。',
      '[画面の状態] 到達圏を比べる日:2026年11月10日(火)、時間帯の幅:3時間。',
    ])
    expect(send()).toEqual([])
    screen = { ...screen, reach: { date: '20261111', stepHours: 1 } }
    // 送れなかった(commit しない)
    expect(tracker.prepare().lines).toEqual(['[画面の状態] 到達圏を比べる日:2026年11月11日(水)、時間帯の幅:1時間。'])
    expect(send()).toEqual(['[画面の状態] 到達圏を比べる日:2026年11月11日(水)、時間帯の幅:1時間。'])
    expect(send()).toEqual([])
  })

  it('GTFS・到達圏が無ければ今日の行だけ', () => {
    expect(stateLines({ today: '20261104', gtfs: null, reach: null }).map((l) => l.key)).toEqual(['today'])
  })

  it('reset すると、次の発言を新しいセッションの最初の発言として作る', () => {
    const { tracker, send } = setup()
    expect(send()).toHaveLength(1)
    expect(send()).toEqual([])
    tracker.reset()
    expect(tracker.first).toBe(true)
    expect(send()).toEqual(['[画面の状態] 今日は 2026年11月4日(水)です(日本時間)。'])
  })
})

describe('新しいセッションの最初の発言に、承認済みの編集の要約が入る', () => {
  it('方針と足し戻した便の数を1行にし、前のセッションの下書きの行方は入れない', () => {
    const { tracker, s, commit, send } = setup()
    send()
    // 前のセッションの Claude の下書き(d1)を承認した
    commit(policy({ excludedRoutes: ['R2'] }), 'claude')
    commit({ type: 'addBack', items: items('R3_0730_WK', 'R1_0800_WK') }, 'user')
    tracker.reset()
    const lines = send()
    expect(lines).toEqual([
      '[画面の状態] 今日は 2026年11月4日(水)です(日本時間)。',
      '[画面の操作] これまでに承認された編集:方針の適用(平日を土曜ダイヤに、2026年11月9日〜当面の間、除外した系統 1)、足し戻し 2 本。',
    ])
    expect(lines.join('\n')).not.toContain('下書き d1')
    expect(s().draftNotices).toEqual([])
    // その後は差分だけ
    expect(send()).toEqual([])
  })

  it('承認済みの編集が無ければ要約を入れない。期間の終わりがあれば日付で書く', () => {
    const { s, commit, send } = setup()
    expect(send()).toHaveLength(1)
    expect(approvedSummaryLine(s())).toBeNull()
    commit(policy({ kind: 'weekdayToSundayHoliday', replacementService: 'SU', period: { start: '20261101', end: '20261120' } }))
    expect(approvedSummaryLine(s())).toBe(
      '[画面の操作] これまでに承認された編集:方針の適用(平日を日祝ダイヤに、2026年11月1日〜2026年11月20日)、足し戻し 0 本。',
    )
  })
})

describe('利用者がボタンで足し戻した便の数を [画面の操作] の行にする', () => {
  it('前に送ったときの承認済みの履歴と比べて、利用者の編集を1件ずつ書く', () => {
    const { s, commit, send } = setup()
    send()
    commit(policy({ excludedRoutes: ['R2'] }))
    expect(send()).toContain('[画面の操作] 利用者が方針を適用しました(平日を土曜ダイヤに、2026年11月9日〜当面の間、除外した系統 1)。')

    // R1_0700_WK は土曜便と同じ時刻なので受け付けられない。受け付けた 2 本を数える
    commit({ type: 'addBack', items: items('R3_0730_WK', 'R1_0800_WK', 'R1_0700_WK') })
    commit({ type: 'withdrawAddBack', tripIds: ['R1_0800_WK'] })
    expect(send()).toEqual(['[画面の操作] 利用者が便を 2 本足し戻しました。', '[画面の操作] 利用者が足し戻しを 1 本取り消しました。'])

    s().undo()
    expect(send()).toEqual(['[画面の操作] 利用者が最後の編集を元に戻しました。'])

    s().undoAll()
    expect(send()).toEqual(['[画面の操作] 利用者がすべての編集を元に戻しました。'])
  })

  it('Claude の下書きの行方は3つの文で伝え、承認した Claude の「元に戻す」は利用者の「元に戻す」と書かない', () => {
    const { tracker, s, send } = setup()
    send()
    expect(s().propose(policy(), 'claude').ok).toBe(true)
    s().commit()
    expect(send()).toEqual(['[画面の操作] 下書き d1 を利用者が承認しました。'])
    const undo = s().proposeUndo('claude')
    expect(undo.ok).toBe(true)
    tracker.noteUndoDraft('d2')
    s().commit()
    expect(send()).toEqual(['[画面の操作] 下書き d2 を利用者が承認しました。'])
    // 取り消し・置き換え
    s().propose(policy(), 'claude')
    s().discard()
    s().propose(policy(), 'claude')
    s().propose(policy({ excludedRoutes: ['R1'] }), 'user')
    s().discard()
    expect(send()).toEqual(['[画面の操作] 下書き d3 を利用者が取り消しました。', '[画面の操作] 下書き d4 は、利用者の操作で置き換えられました。'])
  })

  it('送れなかった発言の下書きの行方は、次の発言でもう一度入れる', () => {
    const { tracker, s, send } = setup()
    send()
    s().propose(policy(), 'claude')
    s().commit()
    expect(tracker.prepare().lines).toEqual(['[画面の操作] 下書き d1 を利用者が承認しました。'])
    // store からは取り出し済み
    expect(s().draftNotices).toEqual([])
    expect(send()).toEqual(['[画面の操作] 下書き d1 を利用者が承認しました。'])
    expect(send()).toEqual([])
  })

  it('userEditLines は、取り消してから新しく適用した編集を、取り消しの後に書く', () => {
    const { s, commit } = setup()
    commit({ type: 'applyPolicy', settings: settings(), reason: { category: null, note: '' } })
    const prev = { history: [...s().history], versions: [...s().versions] }
    s().undo()
    commit(policy({ kind: 'weekdayToSundayHoliday', replacementService: 'SU', period: { start: '20261101', end: '20261120' } }))
    expect(userEditLines(prev, s())).toEqual([
      '[画面の操作] 利用者が最後の編集を元に戻しました。',
      '[画面の操作] 利用者が方針を適用しました(平日を日祝ダイヤに、2026年11月1日〜2026年11月20日、除外した系統 0)。',
    ])
  })

  it('足す行(調査を始めた行)は、[画面の操作] の後ろに入れる', () => {
    const { send } = setup()
    send()
    expect(send([researchStartedLine(12)])).toEqual(['[画面の操作] 利用者が前提情報の調査を始めました(対象 12 件)。'])
  })
})
