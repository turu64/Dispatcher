import { describe, expect, it, vi } from 'vitest'
import { basePlan, smallFeed } from '../gtfs/edit/form2.fixture'
import type { EditOp, PolicySettings } from '../gtfs/edit/ops'
import type { HolidayList } from '../gtfs/holidays'
import type { EditedSource } from './reach'
import { blockingIssues, createEditStore, generatedAtOf, japanIso, lastVersion, type BaseGtfs } from './edit'

// 時計は 2026-11-04 09:30(日本時間)に止める
const NOW = new Date('2026-11-04T00:30:00Z')

function settings(overrides: Partial<PolicySettings> = {}): PolicySettings {
  const { addBackTripIds: _a, ...rest } = basePlan()
  return { ...rest, ...overrides }
}

function policy(overrides: Partial<PolicySettings> = {}): EditOp {
  return { type: 'applyPolicy', settings: settings(overrides), reason: { category: null, note: '' } }
}

function addBack(...ids: string[]): EditOp {
  return { type: 'addBack', items: ids.map((tripId) => ({ tripId, reason: '通学', schoolDaysOnly: false })) }
}

/** 11/3 は平日の例外(WK,2)あり、11/23(月)は例外なし。小さなフィードの期間(〜11/30)を覆う */
const HOLIDAYS: HolidayList = {
  names: new Map([
    ['20261103', '文化の日'],
    ['20261123', '勤労感謝の日'],
  ]),
  first: '19550101',
  coveredUntil: '20271231',
  source: '内閣府「国民の祝日について」の祝日一覧(syukujitsu.csv)を加工して作成',
}

function setup() {
  const onEdited = vi.fn<(e: EditedSource | null) => void>()
  const store = createEditStore({ now: () => NOW, onEdited })
  const base: BaseGtfs = { feed: smallFeed(), zip: new ArrayBuffer(0), label: 'test.zip', sample: null }
  store.getState().setBase(base)
  return { store, onEdited, base }
}

describe('日時の書き方', () => {
  it('作成日時と承認日時は日本時間で書く(パソコンの時刻帯によらない)', () => {
    expect(generatedAtOf(NOW)).toBe('202611040930')
    expect(japanIso(NOW)).toBe('2026-11-04T09:30:00+09:00')
    // 日本時間で日付が変わる時刻
    expect(generatedAtOf(new Date('2026-11-03T15:00:00Z'))).toBe('202611040000')
  })
})

describe('useEditStore(createEditStore)', () => {
  it('方針を下書きにし、承認すると履歴と版に入る。下書きの間は地図に下書きを渡す', () => {
    const { store, onEdited } = setup()
    const proposed = store.getState().propose(policy(), 'user')
    expect(proposed.ok).toBe(true)
    const draft = store.getState().draft
    expect(draft?.kind).toBe('op')
    if (draft?.kind !== 'op' || !draft.outcome.ok) throw new Error('下書きがありません')
    expect(draft.id).toBe('1')
    expect(draft.diff?.byRoute.find((r) => r.routeId === 'R3')?.vanishes).toBe(true)
    expect(store.getState().history).toEqual([])
    expect(onEdited).toHaveBeenLastCalledWith(expect.objectContaining({ draft: true, feed: draft.outcome.result.feed }))

    expect(store.getState().commit()).toEqual({ ok: true })
    const s = store.getState()
    expect(s.draft).toBeNull()
    expect(s.history).toHaveLength(1)
    expect(s.history[0].at).toBe('2026-11-04T09:30:00+09:00')
    expect(lastVersion(s)?.feed).toBe(draft.outcome.result.feed)
    // 同じフィードを、承認済み(draft: false)として渡し直す
    expect(onEdited).toHaveBeenLastCalledWith({ feed: draft.outcome.result.feed, period: { start: '20261101', end: '20261130' }, draft: false })
  })

  it('適用できない方針は履歴に入らず、commit は理由を返す', () => {
    const { store, onEdited } = setup()
    onEdited.mockClear()
    const proposed = store.getState().propose(policy({ replacementService: 'WK' }), 'user')
    expect(proposed.ok).toBe(true)
    const draft = store.getState().draft
    expect(draft?.kind === 'op' && draft.outcome.ok).toBe(false)
    const committed = store.getState().commit()
    expect(committed.ok).toBe(false)
    if (!committed.ok) expect(committed.message).toContain('平日の service と入れ替えに使う service が同じ')
    expect(store.getState().history).toEqual([])
    expect(store.getState().versions).toEqual([])
    // 失敗した下書きでは、地図は基準のまま(編集後なし)
    expect(onEdited).not.toHaveBeenCalled()
  })

  it('方針を承認する前の足し戻しは断る', () => {
    const { store } = setup()
    const r = store.getState().propose(addBack('R3_0730_WK'), 'user')
    expect(r).toEqual({ ok: false, message: '減便の方針を承認してから、便を平日に戻せます。' })
    expect(store.getState().draft).toBeNull()
  })

  it('Claude の下書きがある間は、Claude の次の編集は断られ、先の下書きは残る', () => {
    const { store } = setup()
    store.getState().propose(policy(), 'user')
    store.getState().commit()
    const first = store.getState().propose(addBack('R3_0730_WK'), 'claude')
    expect(first.ok).toBe(true)
    const second = store.getState().propose(addBack('R1_0800_WK'), 'claude')
    expect(second).toEqual({ ok: false, message: '下書き #2 が承認待ちです。' })
    expect(store.getState().proposeUndo('claude')).toEqual({ ok: false, message: '下書き #2 が承認待ちです。' })
    const draft = store.getState().draft
    expect(draft?.id).toBe('2')
    expect(draft?.kind === 'op' && draft.record.op).toEqual(addBack('R3_0730_WK'))
    expect(store.getState().draftNotices).toEqual([])
  })

  it('利用者の操作で Claude の下書きを置き換えると、置き換えたことが draftNotices に残る', () => {
    const { store } = setup()
    store.getState().propose(policy(), 'claude')
    expect(store.getState().commit()).toEqual({ ok: true })
    store.getState().propose(addBack('R3_0730_WK'), 'claude')
    store.getState().propose(addBack('R1_0800_WK'), 'user')
    expect(store.getState().draft?.id).toBe('3')
    const notices = store.getState().takeDraftNotices()
    expect(notices).toEqual([
      { draftId: '1', by: 'claude', result: 'committed', at: '2026-11-04T09:30:00+09:00' },
      { draftId: '2', by: 'claude', result: 'replaced', at: '2026-11-04T09:30:00+09:00' },
    ])
    // 伝えた分は消える
    expect(store.getState().takeDraftNotices()).toEqual([])
    // 利用者の下書きを捨てても、Claude には伝えない
    store.getState().discard()
    expect(store.getState().draftNotices).toEqual([])
  })

  it('7 日以下の有効期間は承認でき、出力だけが止まる', () => {
    const { store } = setup()
    // 入力の末日は 20261130。20261124〜 は 7 日
    store.getState().propose(policy({ period: { start: '20261124', end: null } }), 'user')
    const draft = store.getState().draft
    if (draft?.kind !== 'op') throw new Error('下書きがありません')
    const short = draft.issues.find((i) => i.code === 'shortValidity')
    expect(short).toMatchObject({ severity: 'error', exportOnly: true })
    expect(blockingIssues(draft.issues)).toEqual([])
    expect(store.getState().commit()).toEqual({ ok: true })
    expect(store.getState().history).toHaveLength(1)
  })

  it('足し戻しと取り消しは、承認済みの計画に積み重なる', () => {
    const { store } = setup()
    store.getState().propose(policy(), 'user')
    store.getState().commit()
    store.getState().propose(addBack('R3_0730_WK'), 'user')
    expect(store.getState().commit()).toEqual({ ok: true })
    expect(lastVersion(store.getState())?.report.addBack.accepted).toEqual(['R3_0730_WK'])
    store.getState().propose({ type: 'withdrawAddBack', tripIds: ['R3_0730_WK'] }, 'user')
    store.getState().commit()
    expect(store.getState().history).toHaveLength(3)
    expect(lastVersion(store.getState())?.report.addBack.accepted).toEqual([])
  })

  it('元に戻すと1つ前の版に戻り、すべて戻すと編集後なし(基準)になる。下書きは捨てる', () => {
    const { store, onEdited } = setup()
    store.getState().propose(policy(), 'user')
    store.getState().commit()
    const v1 = lastVersion(store.getState())
    store.getState().propose(addBack('R3_0730_WK'), 'user')
    store.getState().commit()
    store.getState().propose(addBack('R1_0800_WK'), 'claude')

    store.getState().undo()
    expect(store.getState().draft).toBeNull()
    expect(store.getState().history).toHaveLength(1)
    expect(lastVersion(store.getState())).toBe(v1)
    expect(onEdited).toHaveBeenLastCalledWith(expect.objectContaining({ feed: v1?.feed, draft: false }))
    expect(store.getState().takeDraftNotices().map((n) => [n.draftId, n.result])).toEqual([['3', 'discarded']])

    store.getState().undoAll()
    expect(store.getState().history).toEqual([])
    expect(onEdited).toHaveBeenLastCalledWith(null)
  })

  it('元に戻す下書き(Claude)は、承認すると元に戻すのと同じことをする', () => {
    const { store, onEdited, base } = setup()
    store.getState().propose(policy(), 'user')
    store.getState().commit()
    expect(store.getState().proposeUndo('claude').ok).toBe(true)
    const draft = store.getState().draft
    expect(draft).toMatchObject({ kind: 'undo', by: 'claude', result: null, diff: null })
    // 下書きの間は、戻したあと(基準)を下書きとして比べる
    expect(onEdited).toHaveBeenLastCalledWith(expect.objectContaining({ feed: base.feed, draft: true }))
    expect(store.getState().commit()).toEqual({ ok: true })
    expect(store.getState().history).toEqual([])
    expect(onEdited).toHaveBeenLastCalledWith(null)
    expect(store.getState().takeDraftNotices().map((n) => n.result)).toEqual(['committed'])
  })

  it('読み込み直すと履歴と下書きを捨て、編集後なしを渡す', () => {
    const { store, onEdited } = setup()
    store.getState().propose(policy(), 'user')
    store.getState().commit()
    store.getState().propose(addBack('R3_0730_WK'), 'claude')
    store.getState().setBase(null)
    const s = store.getState()
    expect([s.base, s.history, s.versions, s.draft, s.draftNotices]).toEqual([null, [], [], null, []])
    expect(onEdited).toHaveBeenLastCalledWith(null)
    expect(store.getState().propose(policy(), 'user')).toEqual({ ok: false, message: 'GTFS を読み込んでから編集してください。' })
  })

  describe('祝日一覧があとから読めたとき(下書きの確かめを作り直す)', () => {
    /** 祝日一覧は変数で差し替える。祝日の store の代わりに、変わったことを知らせる関数を取り出す */
    function setupWithHolidays() {
      let current: HolidayList | null = null
      let notify: () => void = () => {}
      const store = createEditStore({
        now: () => NOW,
        onEdited: vi.fn(),
        holidays: () => current,
        watchHolidays: (onChange) => {
          notify = onChange
        },
      })
      store.getState().setBase({ feed: smallFeed(), zip: new ArrayBuffer(0), label: 'test.zip', sample: null })
      const issues = () => {
        const d = store.getState().draft
        return d?.kind === 'op' ? d.issues : []
      }
      return {
        store,
        issues,
        codes: () => issues().map((i) => i.code),
        setHolidays(list: HolidayList | null) {
          current = list
          notify()
        },
      }
    }

    it('祝日一覧が無いまま作った下書きに、あとから読めた祝日の確かめが加わり、「読めない」は消える', () => {
      const { store, codes, issues, setHolidays } = setupWithHolidays()
      store.getState().propose(policy(), 'user')
      expect(codes()).toContain('holidayListMissing')
      expect(codes()).not.toContain('holidayWithoutException')
      const before = store.getState().draft
      const blockingBefore = blockingIssues(issues())

      setHolidays(HOLIDAYS)
      expect(codes()).not.toContain('holidayListMissing')
      // 11/23(月)は祝日で、減便後の平日ダイヤが走る(例外なし)
      expect(issues().find((i) => i.code === 'holidayWithoutException')?.examples.join()).toContain('20261123')
      // 下書きそのもの(id・適用の結果・差)は変えない
      const after = store.getState().draft
      expect(after?.kind === 'op' && before?.kind === 'op' && after.id === before.id && after.outcome === before.outcome && after.diff === before.diff).toBe(true)
      // 祝日の確かめは warning・info なので、承認を止める判定は変わらず、承認できる
      expect(blockingIssues(issues())).toEqual(blockingBefore)
      expect(store.getState().commit()).toEqual({ ok: true })
    })

    it('祝日一覧が読めなくなったら、また「読めない」に戻る。作り直した結果は propose のときと同じ', () => {
      const { store, codes, issues, setHolidays } = setupWithHolidays()
      setHolidays(HOLIDAYS)
      store.getState().propose(policy(), 'user')
      const withList = issues()
      expect(codes()).toContain('holidayWithoutException')

      setHolidays(null)
      expect(codes()).toContain('holidayListMissing')
      expect(codes()).not.toContain('holidayWithoutException')
      setHolidays(HOLIDAYS)
      expect(issues()).toEqual(withList)
    })

    it('祝日一覧そのものが同じなら(読み込み中の表示に変わっただけなど)、下書きを作り直さない', () => {
      const { store, setHolidays } = setupWithHolidays()
      setHolidays(HOLIDAYS)
      store.getState().propose(policy(), 'user')
      const draft = store.getState().draft
      setHolidays(HOLIDAYS)
      expect(store.getState().draft).toBe(draft)
    })

    it('下書きが無い、または適用できない方針の下書きでは、何も変えない', () => {
      const { store, setHolidays } = setupWithHolidays()
      setHolidays(HOLIDAYS)
      expect(store.getState().draft).toBeNull()
      store.getState().propose(policy({ replacementService: 'WK' }), 'user')
      const failed = store.getState().draft
      setHolidays(null)
      expect(store.getState().draft).toBe(failed)
    })
  })

  it('同じ編集後のフィードを続けて渡さない(到達圏を計算し直させない)', () => {
    const { store, onEdited } = setup()
    // 読み込んだ直後は編集後なし。setBase(null) → setBase(base) の間も null のまま
    expect(onEdited).not.toHaveBeenCalled()
    store.getState().propose(policy(), 'user')
    store.getState().commit()
    const calls = onEdited.mock.calls.length
    // 適用できない方針の下書きでは、承認済みの版のまま。捨てても同じ版なので渡し直さない
    store.getState().propose(policy({ replacementService: 'WK' }), 'user')
    store.getState().discard()
    expect(onEdited.mock.calls.length).toBe(calls)
  })
})
