// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { activeWeekdayServicesOf, applyForm2 } from '@/gtfs/edit/form2'
import { basePlan, smallFeed, withRows } from '@/gtfs/edit/form2.fixture'
import type { GtfsFeed } from '@/gtfs/load'
import type { EditOp } from '@/gtfs/edit/ops'
import { stopDiff } from '@/gtfs/edit/stopDiff'
import { lastVersion, useEditStore } from '@/store/edit'
import { useHolidayStore } from '@/store/holidays'
import { useReachStore } from '@/store/reach'
import { useResearchStore } from '@/store/research'
import { compareDrivers, useDriversStore } from '@/store/drivers'
import { DUTY_DEFAULTS } from '@/gtfs/edit/duties'
import { pickNoticeDate } from '@/gtfs/edit/notice'
import { formatDateJa } from '@/lib/dates'
import type { ResearchResult } from '@/claude/research'
import ChangeOrder from './ChangeOrder'

// 到達圏の計算は、この画面では走らせない(store の setEdited が呼ぶ)
vi.mock('@/reach/workerClient', () => ({ computeReachInWorker: async () => new Promise(() => {}) }))

const SAMPLE = { available: true, name: '道北バス', source: '北海道オープンデータプラットフォーム(gtfs-data)', license: 'CC BY 4.0' }

function policy(
  reason: { category: 'temporaryShortage' | 'chronicShortage' | 'demandDecline' | null; note: string },
  excludedRoutes: string[] = [],
): EditOp {
  const { addBackTripIds: _a, ...settings } = basePlan({ excludedRoutes })
  return { type: 'applyPolicy', settings, reason }
}

function commit(op: EditOp, by: 'user' | 'claude' = 'user') {
  act(() => {
    const proposed = useEditStore.getState().propose(op, by)
    if (!proposed.ok) throw new Error(proposed.message)
    const committed = useEditStore.getState().commit()
    if (!committed.ok) throw new Error(committed.message)
  })
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-20T03:00:00Z') })
  useHolidayStore.setState({ holidays: { status: 'missing' } })
  act(() => useEditStore.getState().setBase({ feed: smallFeed(), zip: new ArrayBuffer(0), label: 'dohoku.zip', sample: SAMPLE }))
})

afterEach(() => {
  cleanup()
  act(() => useResearchStore.getState().reset())
  act(() => useDriversStore.setState({ shortage: null, params: { ...DUTY_DEFAULTS }, places: [] }))
  act(() => useEditStore.getState().setBase(null))
  act(() => useReachStore.setState({ date: null }))
  vi.useRealTimers()
  vi.restoreAllMocks()
})

/** 平日だけを走る学校線(R3)の便を n 本足したフィード(06:00 から 10 分おき。土曜ダイヤに同じ時刻の便は無い) */
function feedWithSchoolTrips(n: number): { feed: GtfsFeed; tripIds: string[] } {
  const base = smallFeed()
  const tripIds: string[] = []
  const trips = [...base.tables.get('trips')!.rows]
  const stopTimes = [...base.tables.get('stop_times')!.rows]
  const clock = (min: number) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}:00`
  for (let i = 0; i < n; i++) {
    const start = 6 * 60 + i * 10
    const id = `R3_${clock(start).slice(0, 5).replace(':', '')}X_WK`
    tripIds.push(id)
    trips.push({ route_id: 'R3', service_id: 'WK', trip_id: id, trip_headsign: '市役所', block_id: '' })
    stopTimes.push(
      { trip_id: id, arrival_time: clock(start), departure_time: clock(start), stop_id: 'A', stop_sequence: '1', pickup_type: '0', drop_off_type: '1' },
      { trip_id: id, arrival_time: clock(start + 10), departure_time: clock(start + 10), stop_id: 'S9', stop_sequence: '2', pickup_type: '0', drop_off_type: '0' },
    )
  }
  return { feed: withRows(withRows(base, 'trips', trips), 'stop_times', stopTimes), tripIds }
}

function section(name: string): HTMLElement {
  const heading = screen.getByRole('heading', { name })
  const el = heading.closest('section')
  if (!el) throw new Error(`${name} の欄がありません`)
  return el
}

describe('ChangeOrder', () => {
  it('GTFS を読み込む前と、方針を承認する前は、承認を促す', () => {
    act(() => useEditStore.getState().setBase(null))
    const { unmount } = render(<ChangeOrder />)
    expect(screen.getByText(/GTFS を読み込み、減便の方針を承認すると/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: '印刷する' })).toBeNull()
    unmount()

    act(() => useEditStore.getState().setBase({ feed: smallFeed(), zip: new ArrayBuffer(0), label: 'dohoku.zip', sample: SAMPLE }))
    render(<ChangeOrder />)
    expect(screen.getByText(/減便の方針を承認すると/)).toBeTruthy()
    expect(screen.queryByTestId('change-order')).toBeNull()
  })

  it('理由・方針・除外した系統・承認の日時と承認者を出す', () => {
    commit(policy({ category: 'temporaryShortage', note: '運転士 3 人が病欠' }, ['R2']))
    render(<ChangeOrder />)
    const sheet = within(screen.getByTestId('change-order'))
    const reason = within(section('1. 減便の理由'))
    expect(reason.getByText('運転士の一時的な欠員')).toBeTruthy()
    // 減便の文で理由の直後の括弧に書いた補足は、欄の名前「補足」で出す
    expect(reason.getByText('補足:').nextElementSibling?.textContent).toBe('運転士 3 人が病欠')
    expect(reason.queryByText('メモ:')).toBeNull()

    const policySection = within(section('2. 減便の方針と承認'))
    expect(policySection.getByText('平日を土曜ダイヤに')).toBeTruthy()
    // 除外した系統は系統名(R2 は 2 番・市役所線)で出す
    expect(policySection.getByText('除外した系統:').nextElementSibling?.textContent).toBe('2')
    expect(policySection.getByText('期間:').nextElementSibling?.textContent).toContain('2026年11月1日(日)〜当面の間')
    // 承認の日時(時計は 2026-10-20 12:00 日本時間)と、利用者が作成した操作であること
    expect(policySection.getByText('減便の方針の承認:').nextElementSibling?.textContent).toBe('2026年10月20日 12:00(利用者が作成して承認)')
    expect(sheet.getByText('作成日:', { exact: false }).textContent).toContain('2026年10月20日(火)')
  })

  it('Claude の下書きを承認した操作は、AI の下書きとして出す', () => {
    commit(policy({ category: null, note: '' }), 'claude')
    render(<ChangeOrder />)
    const policySection = within(section('2. 減便の方針と承認'))
    expect(policySection.getByText('減便の方針の承認:').nextElementSibling?.textContent).toContain('AI(Claude)の下書きを利用者が承認')
    // 理由の区分を選ばなければ「未選択」
    expect(within(section('1. 減便の理由')).getByText('未選択')).toBeTruthy()
  })

  it('理由の区分が無くてメモがあれば(減便の文の理由で「その他」を選んだもの)、区分は「その他」と出す(承認の要約と同じ規則)', () => {
    commit(policy({ category: null, note: '道路工事による迂回' }), 'claude')
    render(<ChangeOrder />)
    const reason = within(section('1. 減便の理由'))
    expect(reason.getByText('区分:').nextElementSibling?.textContent).toBe('その他')
    expect(reason.getByText('道路工事による迂回')).toBeTruthy()
    expect(reason.queryByText('未選択')).toBeNull()
  })

  it('保護する便を理由と(学)の印つきで出し、足し戻した便の集計と勤務の確認欄を出す', () => {
    commit(policy({ category: 'temporaryShortage', note: '' }))
    commit({
      type: 'addBack',
      items: [{ tripId: 'R3_0730_WK', reason: '学校前から市役所へ向かう通学の便', schoolDaysOnly: true }],
    })
    render(<ChangeOrder />)
    const protectedSection = within(section('4. 平日に戻した便'))
    const row = protectedSection.getByRole('table', { name: '平日に戻した便と理由' }).querySelector('tr[data-trip-id="R3_0730_WK"]') as HTMLElement
    expect(row).toBeTruthy()
    const cells = within(row)
    expect(cells.getByText('学校前から市役所へ向かう通学の便')).toBeTruthy()
    expect(cells.getByText('(学)')).toBeTruthy()
    expect(cells.getByText('07:30〜07:50')).toBeTruthy()
    // 集計はコードが出す:1 便、営業運行時間 20 分(07:30〜07:50)
    expect(protectedSection.getByText(/平日に戻した便 1 便、営業運行時間の合計 0時間20分/)).toBeTruthy()
    expect(protectedSection.getByText(/うち休校日運休 1 便/)).toBeTruthy()
    // 勤務の確認欄(数値は目安)
    expect(protectedSection.getByText('拘束時間(13 時間以内、最大 15 時間)')).toBeTruthy()
    expect(protectedSection.getByText('休息期間(継続 9 時間以上)')).toBeTruthy()
    expect(protectedSection.getByText('確認者:', { exact: false })).toBeTruthy()
    // 足し戻しの承認の回数
    expect(within(section('2. 減便の方針と承認')).getByText('便を平日に戻す承認:').nextElementSibling?.textContent).toContain('1 回')
  })

  it('4. の欄に、要る運転士の数(目安)を承認済みの最後の版と期間の中の平日で比べて出す。平日に戻した便が無くても出し、下書きは反映しない(D04)', () => {
    commit(policy({ category: 'temporaryShortage', note: '' }))
    act(() => useDriversStore.getState().setShortage(30))
    const base = useEditStore.getState().base!
    const expectedRow = () => {
      const version = lastVersion(useEditStore.getState())!
      const date = pickNoticeDate(base.feed, version)!
      const c = compareDrivers({
        base: base.feed,
        edited: { feed: version.feed, draft: false },
        date,
        weekdayServices: activeWeekdayServicesOf(version),
        params: { ...DUTY_DEFAULTS },
        places: [],
        shortage: 30,
      })
      return { date, c, row: `勤務の数(目安)${c.before.duties.dutyCount}${c.after!.duties.dutyCount}` }
    }
    const summaryRow = () =>
      within(within(section('4. 平日に戻した便')).getByTestId('driver-summary'))
        .getAllByRole('row')
        .find((r) => r.textContent?.startsWith('勤務の数(目安)'))?.textContent ?? ''

    const first = expectedRow()
    expect(first.c.weekday).toBe(true)
    render(<ChangeOrder />)
    const protectedSection = within(section('4. 平日に戻した便'))
    expect(protectedSection.getByText('平日に戻した便はありません。')).toBeTruthy()
    const summary = protectedSection.getByTestId('driver-summary')
    expect(summary.className).toContain('break-inside-avoid')
    expect(summary.textContent).toContain(`(${formatDateJa(first.date)}の便で比べた数)`)
    expect(summaryRow().startsWith(first.row)).toBe(true)
    expect(within(summary).getByTestId('driver-summary-verdict').textContent).toContain('欠員 30 人:')
    expect(within(summary).getByRole('list', { name: '要る運転士の数の仮定' }).textContent).toContain('拘束時間は 13 時間以内')

    // 承認待ちの下書きは数に入れない
    act(() => {
      useEditStore.getState().propose({ type: 'addBack', items: [{ tripId: 'R3_0730_WK', reason: '', schoolDaysOnly: false }] }, 'claude')
    })
    expect(summaryRow().startsWith(first.row)).toBe(true)
    act(() => useEditStore.getState().discard())

    // 便を平日に戻して承認すると、戻した後の版で数え直す。今の「平日に戻した便の営業運行時間」の文は残す
    commit({ type: 'addBack', items: [{ tripId: 'R3_0730_WK', reason: '通学', schoolDaysOnly: false }] })
    expect(within(section('4. 平日に戻した便')).getByText(/平日に戻した便 1 便、営業運行時間の合計 0時間20分/)).toBeTruthy()
    expect(summaryRow().startsWith(expectedRow().row)).toBe(true)
  })

  it('系統 × 公示第47号の時間帯の前後の回数を、変わった系統だけ出す。届出の区分は運輸支局に確認する', () => {
    commit(policy({ category: 'temporaryShortage', note: '' }))
    render(<ChangeOrder />)
    const notice = within(section('3. 届出の目安:時間帯ごとの便数(北海道運輸局 公示第47号の区分)'))
    const table = notice.getByRole('table', { name: '系統と時間帯ごとの平日の便数(減便前 → 減便後)' })
    const rows = within(table).getAllByRole('row')
    const rowOf = (name: string) => rows.find((r) => within(r).queryByRole('rowheader', { name: new RegExp(`(^|\\s|\\))${name}$`) }))!
    // 基準の平日:R1 は 6〜9 時台に 2 便、R2 は 9 時に 1 便(6〜9 時台)、R3 は 7:30 の 1 便。土曜に入れ替えると
    // R1 は 3 便(07:00・08:00・08:05)、R2 は 10:00 の 1 便(10〜14 時台)、R3 は無くなる
    const r1 = within(rowOf('1')).getAllByRole('cell').map((c) => c.textContent)
    expect(r1).toEqual(['2 → 3', '0 → 0', '0 → 0', '0 → 0'])
    const r2 = within(rowOf('2')).getAllByRole('cell').map((c) => c.textContent)
    expect(r2).toEqual(['1 → 0', '0 → 1', '0 → 0', '0 → 0'])
    const r3 = rowOf('3')
    expect(within(r3).getByRole('rowheader').textContent).toContain('全曜日で便なし')
    expect(within(r3).getAllByRole('cell')[0].textContent).toBe('1 → 0')
    // 合計
    const total = screen.getByTestId('notice47-total').textContent
    expect(total).toContain('6〜9時台 4 → 3')
    expect(total).toContain('10〜14時台 0 → 1')
    // 届出の区分は判定しない
    expect(notice.getByText(/届出の区分は運輸支局に確認してください/)).toBeTruthy()
    // この表だけが公示の区分で、ほかの表と地図は3時間ごと(U05)
    expect(notice.getByText('この表だけは公示の区分(6〜9時台は 6:00〜9:59)で数えます。ほかの表と地図は3時間ごとです。')).toBeTruthy()
    const filing = within(section('5. 届出・公示(手書き)'))
    expect(filing.getByText(/運輸支局に確認し、結果を書いてください/)).toBeTruthy()
    for (const label of ['届出日:', '公示日:', '実施日:', '公示から実施まで 7 日を切るときの理由:']) {
      expect(filing.getByText(label)).toBeTruthy()
    }
  })

  it('GTFS の欄に feed_version・有効期間・運行管理システムへの反映の注意を、周知の欄に掲示を差し替える停留所の件数を出す', () => {
    commit(policy({ category: 'temporaryShortage', note: '' }))
    act(() => useEditStore.getState().setFeedVersion('202611050900'))
    // 影響の手順の日付が日曜でも、掲示の件数は平日で数える
    act(() => useReachStore.setState({ date: '20261108' }))
    render(<ChangeOrder />)
    const gtfs = within(section('6. GTFS'))
    expect(gtfs.getByText('202611050900')).toBeTruthy()
    expect(gtfs.getByText('有効期間:').nextElementSibling?.textContent).toContain('2026年11月1日(日)〜2026年11月30日(月)')
    expect(screen.getByText(/次に運行管理システムや時刻表ソフトから GTFS を出力するときは/)).toBeTruthy()
    expect(gtfs.getByText('公開予定日:')).toBeTruthy()

    const base = useEditStore.getState().base!
    const version = lastVersion(useEditStore.getState())!
    // 期間(11/1〜)の中で平日が最初に走る日は 20261102(月)
    const expected = stopDiff(base.feed, version.feed, '20261102')
    expect(expected.repostCount).toBeGreaterThan(0)
    const notice = within(section('7. 周知'))
    expect(notice.getByText('掲示を差し替える停留所:').nextElementSibling?.textContent).toContain(`${expected.repostCount} 件`)
    expect(notice.getByText('掲示を差し替える停留所:').nextElementSibling?.textContent).toContain(`全 ${expected.stops.length} 件中`)
    expect(notice.getByText('掲示を差し替える停留所:').nextElementSibling?.textContent).toContain('2026年11月2日(月)')
  })

  it('「印刷する」で window.print を呼び、紙には要らない部品に print-hide を付ける', () => {
    commit(policy({ category: 'temporaryShortage', note: '' }))
    const print = vi.fn()
    vi.stubGlobal('print', print)
    render(<ChangeOrder />)
    const button = screen.getByRole('button', { name: '印刷する' })
    expect(button.closest('.print-hide')).toBeTruthy()
    // 印刷するのは .print-area だけ(index.css の印刷の土台)
    expect(screen.getByTestId('change-order').classList.contains('print-area')).toBe(true)
    expect(button.closest('.print-area')).toBeNull()
    fireEvent.click(button)
    expect(print).toHaveBeenCalledTimes(1)
    vi.unstubAllGlobals()
  })

  it('承認待ちの下書きは反映せず、その旨を画面にだけ出す', () => {
    commit(policy({ category: 'temporaryShortage', note: '' }))
    act(() => {
      useEditStore.getState().propose({ type: 'addBack', items: [{ tripId: 'R3_0730_WK', reason: '', schoolDaysOnly: false }] }, 'claude')
    })
    const draftId = useEditStore.getState().draft!.id
    render(<ChangeOrder />)
    expect(screen.getByText(new RegExp(`承認待ちの下書き #${draftId} は反映していません`))).toBeTruthy()
    expect(within(section('4. 平日に戻した便')).getByText('平日に戻した便はありません。')).toBeTruthy()
  })

  it('applyForm2 の結果の feed_version を、入力が無いときは出力日時の例として画面だけに出し、紙は手書きの欄にする', () => {
    commit(policy({ category: 'temporaryShortage', note: '' }))
    render(<ChangeOrder />)
    const base = useEditStore.getState().base!
    const outcome = applyForm2(base.feed, basePlan(), { generatedAt: '202610201200' })
    if (!outcome.ok) throw new Error(outcome.message)
    const gtfs = within(section('6. GTFS'))
    const example = gtfs.getByText(outcome.result.report.feedVersion.after)
    // 承認した時点の値は、出力した ZIP の値と違うことがあるので、印刷しない
    expect(example.closest('.print-hide')).not.toBeNull()
    expect(gtfs.getByText('feed_version:').nextElementSibling?.textContent).toContain('出力した ZIP の値')
  })

  it('入力の feed_version が12桁でないとき、例を二重に包まない(承認したときの値をそのまま出す)', () => {
    act(() => useEditStore.getState().setBase(null))
    const feed = smallFeed()
    const withV1 = withRows(feed, 'feed_info', feed.tables.get('feed_info')!.rows.map((r) => ({ ...r, feed_version: 'v1' })))
    act(() => useEditStore.getState().setBase({ feed: withV1, zip: new ArrayBuffer(0), label: 'v1.zip', sample: SAMPLE }))
    commit(policy({ category: 'temporaryShortage', note: '' }))
    render(<ChangeOrder />)
    const after = lastVersion(useEditStore.getState())!.report.feedVersion.after
    expect(after).toMatch(/^v1_dispatcher_\d{12}$/)
    const field = within(section('6. GTFS')).getByText('feed_version:').nextElementSibling?.textContent ?? ''
    expect(field).toContain(`v1 → `)
    expect(field).toContain(after)
    expect(field).not.toContain('v1_dispatcher_v1_dispatcher')
  })

  it('入れた feed_version が確かめに通らないときは紙に出さず、理由を画面に出す', () => {
    commit(policy({ category: 'temporaryShortage', note: '' }))
    act(() => useEditStore.getState().setFeedVersion('a'.repeat(300)))
    render(<ChangeOrder />)
    const gtfs = within(section('6. GTFS'))
    expect(gtfs.queryByText('a'.repeat(300))).toBeNull()
    expect(gtfs.getByText(/入れた feed_version は使えません/).closest('.print-hide')).not.toBeNull()
  })

  it('保護する便が多くても行を落とさず、全便の trip_id と(学)の印を載せる', () => {
    act(() => useEditStore.getState().setBase(null))
    const { feed, tripIds } = feedWithSchoolTrips(9)
    act(() => useEditStore.getState().setBase({ feed, zip: new ArrayBuffer(0), label: 'many.zip', sample: SAMPLE }))
    commit(policy({ category: 'temporaryShortage', note: '' }))
    const school = new Set(tripIds.filter((_, i) => i % 2 === 0))
    commit({
      type: 'addBack',
      items: tripIds.map((tripId) => ({ tripId, reason: '通学の便', schoolDaysOnly: school.has(tripId) })),
    })
    expect(lastVersion(useEditStore.getState())!.report.addBack.accepted).toHaveLength(9)
    render(<ChangeOrder />)
    const protectedSection = section('4. 平日に戻した便')
    // 印刷では表を左右に分けるが、行は全便ある
    const tables = within(protectedSection).getAllByRole('table', { name: '平日に戻した便と理由' })
    expect(tables).toHaveLength(2)
    const rows = [...protectedSection.querySelectorAll<HTMLElement>('tr[data-trip-id]')]
    expect(rows.map((r) => r.dataset.tripId).sort()).toEqual([...tripIds].sort())
    for (const r of rows) {
      expect(r.textContent?.includes('(学)')).toBe(school.has(r.dataset.tripId!))
      // 印刷で隠さない
      expect(r.closest('.print-hide')).toBeNull()
    }
    expect(within(protectedSection).getByText(/うち休校日運休 5 便/)).toBeTruthy()
    // 画面だけを指す「ほか N 便」や、行を絞るボタンは無い
    expect(within(protectedSection).queryByText(/ほか \d+ 便/)).toBeNull()
    expect(within(protectedSection).queryByRole('button')).toBeNull()
  })
  describe('周辺の事業者の動き(前提情報で調べた結果)', () => {
    const TITLE = '8. 周辺の事業者の動き(前提情報で調べた結果)'

    function result(over: Partial<ResearchResult> = {}): ResearchResult {
      return {
        targetId: 'P11:宗谷バス',
        kind: 'operator',
        name: '宗谷バス',
        status: 'found',
        facts: [
          { label: '減便の発表', value: '11月1日から平日ダイヤを土曜ダイヤにする', source: 1 },
          { label: '運休', value: '12月は土日の一部を運休する', source: 2 },
          { label: '特別ダイヤ', value: '年末年始は特別ダイヤ', source: 2 },
          { label: '会社の所在地', value: '稚内市', source: 1 },
        ],
        sources: [
          { url: 'https://example.jp/a', title: 'お知らせ' },
          { url: 'https://example.jp/b', title: '時刻表' },
        ],
        note: '',
        checkedAt: '2026-10-19T09:00:00+09:00',
        origin: 'demo',
        ...over,
      }
    }

    it('調べていなければ「調べていません」と出す', () => {
      commit(policy({ category: 'temporaryShortage', note: '' }))
      render(<ChangeOrder />)
      expect(within(section(TITLE)).getByText('調べていません。')).toBeTruthy()
    })

    it('調べた減便の動きを、事実・出典・確認日時つきで載せる。事実は件数を絞り、残りは件数で示す', () => {
      commit(policy({ category: 'temporaryShortage', note: '' }))
      act(() => useResearchStore.getState().mergeResults([result()]))
      render(<ChangeOrder />)
      const sec = within(section(TITLE))
      const quote = sec.getByTestId('movement-quote-P11:宗谷バス')
      expect(quote.textContent).toContain('減便の発表:11月1日から平日ダイヤを土曜ダイヤにする')
      expect(quote.textContent).toContain('運休:12月は土日の一部を運休する')
      // 2 件に絞る。3 件目と、減便の動きではない事実は載せない
      expect(quote.textContent).not.toContain('年末年始は特別ダイヤ')
      expect(quote.textContent).not.toContain('会社の所在地')
      expect(quote.textContent).toContain('ほか 1 件')
      expect(quote.textContent).toContain('確認日時 2026年10月19日 09:00')
      expect(quote.textContent).toContain('お知らせ')
      expect(quote.textContent).toContain('https://example.jp/a')
      expect(sec.queryByText('調べていません。')).toBeNull()
    })

    it('調べても減便の動きの記載が無ければ、その旨と確認日時を出す。学校・病院の結果は数えない', () => {
      commit(policy({ category: 'temporaryShortage', note: '' }))
      act(() =>
        useResearchStore.getState().mergeResults([
          result({ facts: [{ label: '会社の所在地', value: '稚内市', source: 1 }] }),
          result({ targetId: 'P29:X', kind: 'school', name: '学校' }),
        ]),
      )
      render(<ChangeOrder />)
      const text = section(TITLE).textContent ?? ''
      // 見出しで絞った結果だけを言い、「動きがない」とは書かない
      expect(text).toContain(
        '調べた 1 事業者の結果(確認日時 2026年10月19日 09:00)に、減便・ダイヤ改正・運休・特別ダイヤの見出しの事実はありません。廃止などのほかの動きは、手順「前提情報」で確かめてください。',
      )
      expect(text).not.toContain('記載はありませんでした')
      expect(text).not.toContain('調べていません')
    })

    it('印刷では、節は1枚目の残りから始め、事業者ごとの引用の区切りで2枚目に送る。ほかの節は途中で分けない', () => {
      commit(policy({ category: 'temporaryShortage', note: '' }))
      const list = ['A', 'B', 'C'].map((n) => result({ targetId: `P11:事業者${n}`, name: `事業者${n}` }))
      act(() => useResearchStore.getState().mergeResults(list))
      render(<ChangeOrder />)
      const sheet = screen.getByTestId('change-order')
      expect(sheet.className).toContain('print:text-[8px]')
      const movement = section(TITLE)
      expect(movement.className).not.toContain('break-inside-avoid')
      expect(screen.getByTestId('movement-quotes').className).toContain('print:columns-2')
      for (const fig of movement.querySelectorAll('figure')) expect(fig.className).toContain('break-inside-avoid')
      for (const name of ['2. 減便の方針と承認', '4. 平日に戻した便']) expect(section(name).className).toContain('break-inside-avoid')
    })

    it('載せる事業者は 4 つまで。残りは数で示す', () => {
      commit(policy({ category: 'temporaryShortage', note: '' }))
      const list = ['A', 'B', 'C', 'D', 'E', 'F'].map((n) => result({ targetId: `P11:事業者${n}`, name: `事業者${n}` }))
      act(() => useResearchStore.getState().mergeResults(list))
      render(<ChangeOrder />)
      const sec = within(section(TITLE))
      expect(section(TITLE).querySelectorAll('figure')).toHaveLength(4)
      expect(sec.getByText(/ほか 2 事業者の動きは/)).toBeTruthy()
    })

    it('古い確認日時には、出典で確かめるよう添える。欄は印刷から隠さない', () => {
      commit(policy({ category: 'temporaryShortage', note: '' }))
      act(() => useResearchStore.getState().mergeResults([result({ checkedAt: '2020-01-01T00:00:00+09:00' })]))
      render(<ChangeOrder />)
      const sec = section(TITLE)
      expect(sec.textContent).toContain('30日より前の確認です。出典で確かめてください。')
      expect(sec.closest('.print-hide')).toBeNull()
    })
  })
})
