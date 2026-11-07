// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeBands } from '@/gtfs/departures'
import { basePlan, rowsOf, smallFeed } from '@/gtfs/edit/form2.fixture'
import { facilityWindows, readLongBreaks } from '@/gtfs/edit/facilityHours'
import type { HintFacility, NearFacility, RestoreHint, RestoreHintContext, RestoreHintDetail } from '@/gtfs/edit/restore'
import type { GtfsFeed } from '@/gtfs/load'
import type { EditOp } from '@/gtfs/edit/ops'
import { buildRestoreHintContext } from '@/store/restoreHintContext'
import { useChatStore } from '@/store/chat'
import { lastVersion, useEditStore } from '@/store/edit'
import { DUTY_DEFAULTS } from '@/gtfs/edit/duties'
import { activeWeekdayServicesOf } from '@/gtfs/edit/form2'
import { compareDrivers, useDriversStore } from '@/store/drivers'
import { useReachStore } from '@/store/reach'
import RestoreStep from './RestoreStep'

// 到達圏の store への受け渡し(setEdited)は、この画面では計算しない
vi.mock('@/reach/workerClient', () => ({ computeReachInWorker: async () => new Promise(() => {}) }))

// 到達圏の前後の比較(ctx)は、この画面では作らない。ctx を渡したときだけ、FAKE_EXTRA の便(既定は R3_0730_WK)に
// 到達圏を使う2つの手がかりを付ける(手がかりの計算そのものは gtfs/edit/restore.test.ts で確かめている)
// 比較の日付 2026-11-04(水)は smallFeed の平日(WK)の運行日
// bands は地図の時間帯の幅(既定の3時間ごと)。FAKE_CTX_1H は1時間ごとに切り替えたとき(U05 の D6)
const FAKE_CTX = { fake: true, date: '20261104', bands: makeBands(3) } as unknown as RestoreHintContext
const FAKE_CTX_1H = { fake: true, date: '20261104', bands: makeBands(1) } as unknown as RestoreHintContext
type FakeExtra = { hints: RestoreHint[]; lostCells: RestoreHintDetail['lostCells']; facilities?: NearFacility[] }
const REACH_HINTS: RestoreHint[] = ['onlyServiceAtStop', 'restoresLostCells']
const DEFAULT_EXTRA: Record<string, FakeExtra> = { R3_0730_WK: { hints: REACH_HINTS, lostCells: { cells: 1234, population: 5678.4 } } }
const FAKE_EXTRA: { current: Record<string, FakeExtra> } = { current: DEFAULT_EXTRA }
vi.mock('@/store/restoreHintContext', () => ({ buildRestoreHintContext: vi.fn(() => null) }))
vi.mock('@/gtfs/edit/restore', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/gtfs/edit/restore')>()
  return {
    ...original,
    createRestoreHinter: (...args: Parameters<typeof original.createRestoreHinter>) => {
      const hinter = original.createRestoreHinter(...args)
      return (trip: Parameters<typeof hinter>[0], ctx?: RestoreHintContext) => {
        const detail = hinter(trip)
        const extra = FAKE_EXTRA.current[trip.tripId]
        if ((ctx !== FAKE_CTX && ctx !== FAKE_CTX_1H) || !extra) return detail
        // 時間帯と系統の便数(band・routeTrips。A03)は、元の計算の値をそのまま渡す
        const { facilities: _f, ...rest } = detail
        return { ...rest, hints: [...detail.hints, ...extra.hints], lostCells: extra.lostCells, ...(extra.facilities ? { facilities: extra.facilities } : {}) }
      }
    },
  }
})

const realAskRestore = useChatStore.getState().askRestore

function policy(): EditOp {
  const { addBackTripIds: _a, ...settings } = basePlan()
  return { type: 'applyPolicy', settings, reason: { category: null, note: '' } }
}

const candidates = () => screen.getByRole('group', { name: '平日に戻す便の候補' })

/** 系統をすべて開き、「ほかの便を見る」もすべて押す */
function expandAll() {
  for (const b of within(candidates()).queryAllByRole('button', { expanded: false })) fireEvent.click(b)
  for (const b of within(candidates()).queryAllByRole('button', { name: /ほかの便を見る/ })) fireEvent.click(b)
}

function idOf(box: HTMLElement): string {
  return /([A-Z0-9]+_\d{4}_WK)/.exec(box.getAttribute('aria-label') ?? '')?.[1] ?? ''
}

/** 候補の一覧のチェック(開いている分だけ。expand なら先にすべて開く) */
function candidateBoxes(expand = true): HTMLInputElement[] {
  if (screen.queryByText('当てはまる便がありません。')) return []
  if (expand) expandAll()
  return within(candidates()).queryAllByRole('checkbox') as HTMLInputElement[]
}

function candidateIds(expand = true): string[] {
  return candidateBoxes(expand).map(idOf)
}

/** 系統のまとまりの名前(上からの順) */
function routeOrder(): string[] {
  return within(candidates())
    .getAllByRole('region')
    .map((r) => r.getAttribute('aria-label') ?? '')
}

/**
 * smallFeed に R1 の便を足したフィード。時間帯は到達圏と同じ3時間ごと(U05)。
 * R1_1130_WK は手がかりの無い消える便(土曜の R1_1100_SA が同じ 9〜12時にあるので、時間帯の便は 0 にならない)。
 * R1_1200_WK は 12〜15時の R1 の便が減便後に 0 になる(土曜の 11:00 は 9〜12時。公示第47号の 10〜14時台で数えていた
 * ときは手がかりが無かった)。R1_1900_WK は系統の終発で、18〜21時の便が 0 になり、夕方・夜(15〜21時)にも入る
 */
function feedWithMore(): GtfsFeed {
  const feed = smallFeed()
  feed.tables.get('trips')!.rows.push(
    ...rowsOf(`
route_id,service_id,trip_id,trip_headsign,block_id
R1,SA,R1_1100_SA,市役所,
R1,WK,R1_1130_WK,市役所,
R1,WK,R1_1200_WK,市役所,
R1,WK,R1_1900_WK,市役所,`),
  )
  feed.tables.get('stop_times')!.rows.push(
    ...rowsOf(`
trip_id,arrival_time,departure_time,stop_id,stop_sequence,pickup_type,drop_off_type
R1_1100_SA,11:00:00,11:00:00,A,1,0,1
R1_1100_SA,11:10:00,11:10:00,B,2,1,0
R1_1130_WK,11:30:00,11:30:00,A,1,0,1
R1_1130_WK,11:40:00,11:40:00,B,2,1,0
R1_1200_WK,12:00:00,12:00:00,A,1,0,1
R1_1200_WK,12:10:00,12:10:00,B,2,1,0
R1_1900_WK,19:00:00,19:00:00,A,1,0,1
R1_1900_WK,19:10:00,19:10:00,B,2,1,0`),
  )
  return feed
}

function loadFeed(feed: GtfsFeed) {
  act(() => {
    useEditStore.getState().setBase({ feed, zip: new ArrayBuffer(0), label: 'test.zip', sample: null })
    useEditStore.getState().propose(policy(), 'user')
    useEditStore.getState().commit()
  })
}

beforeEach(() => {
  loadFeed(smallFeed())
})

afterEach(() => {
  cleanup()
  act(() => useEditStore.getState().setBase(null))
  vi.restoreAllMocks()
  vi.mocked(buildRestoreHintContext).mockReset()
  vi.mocked(buildRestoreHintContext).mockReturnValue(null)
  useChatStore.setState({ status: { state: 'unknown' }, token: null, toolRunning: false, sending: false, budgetReached: false, askRestore: realAskRestore })
  useReachStore.setState({ computing: false, error: null, date: null })
  FAKE_EXTRA.current = DEFAULT_EXTRA
})

describe('RestoreStep', () => {
  it('方針を承認する前は、方針の承認を促す', () => {
    act(() => useEditStore.getState().undoAll())
    render(<RestoreStep />)
    expect(screen.getByText('減便の方針を承認すると、なくなる平日便から戻す便を選べます。')).toBeTruthy()
  })

  it('候補は消える平日便で、手がかりの多い順に並べ、停留所名・手がかりで絞り込める', () => {
    render(<RestoreStep />)
    // R1_0800_WK(終発・朝)と R2_0900_WK(始発・終発)は手がかりが2つずつで、始発の早い R1 が先。
    // R2 の 09:00 は土曜の 10:00 と同じ 9〜12時なので、時間帯の便は 0 にならない(U05。公示第47号では 6〜9時台と 10〜14時台に分かれていた)
    expect(candidateIds()).toEqual(['R3_0730_WK', 'R1_0800_WK', 'R2_0900_WK'])
    fireEvent.change(screen.getByLabelText('停留所名(一部)'), { target: { value: '学校' } })
    expect(candidateIds()).toEqual(['R3_0730_WK'])
    fireEvent.change(screen.getByLabelText('停留所名(一部)'), { target: { value: '' } })
    fireEvent.change(screen.getByLabelText('判断材料'), { target: { value: 'lastTripOfRoute' } })
    expect(candidateIds()).toEqual(['R3_0730_WK', 'R1_0800_WK', 'R2_0900_WK'])
    fireEvent.change(screen.getByLabelText('判断材料'), { target: { value: 'onlyTripInBand' } })
    expect(candidateIds()).toEqual(['R3_0730_WK'])
    fireEvent.change(screen.getByLabelText('系統'), { target: { value: 'R1' } })
    expect(candidateIds()).toEqual([])
    expect(screen.getByText('当てはまる便がありません。')).toBeTruthy()
  })

  it('候補は系統ごとに折りたたみ、全曜日で便がなくなる系統を先頭にし、開くと方向ごとに編集後の最大間隔を添える', () => {
    render(<RestoreStep />)
    // 最初は閉じている
    expect(candidateBoxes(false)).toEqual([])
    // R3 は平日だけの系統で、全曜日で便がなくなる。R1 と R2 は手がかりの数が同じで、始発の早い R1 が先
    expect(routeOrder()).toEqual(['系統 3', '系統 1', '系統 2'])
    const region = (name: string) => within(candidates()).getByRole('region', { name })
    expect(region('系統 3').textContent).toContain('全曜日で便がなくなる')
    expect(region('系統 1').textContent).not.toContain('全曜日で便がなくなる')
    expect(region('系統 1').textContent).toContain('なくなる便 1 便(判断材料あり 1 便)')
    // 比べる日が無ければ、最大間隔は出さない
    expect(screen.getByText(/比較する日付が決まると/)).toBeTruthy()
    expect(screen.getByText(/比較する日付は、地図の下の操作盤で選べます/)).toBeTruthy()

    act(() => useReachStore.setState({ date: '20261104' }))
    expect(screen.getByText(/比較する日付\(2026年11月4日\(水\)\)の/)).toBeTruthy()
    expect(screen.getByText(/比較する日付は、地図の下の操作盤で変えられます/)).toBeTruthy()
    fireEvent.click(within(region('系統 1')).getByRole('button', { expanded: false }))
    expect(region('系統 1').textContent).toContain('駅前 → 市役所')
    expect(region('系統 1').textContent).toContain('減便後の最大間隔 65 分')
    expect(region('系統 1').textContent).toContain('減便後の便:07:00・08:05')
    expect(within(region('系統 1')).getAllByRole('checkbox').map(idOf)).toEqual(['R1_0800_WK'])
    fireEvent.click(within(region('系統 3')).getByRole('button', { expanded: false }))
    expect(region('系統 3').textContent).toContain('減便後はこの方向の便がありません')
    // 閉じると便は出さない
    fireEvent.click(within(region('系統 1')).getByRole('button', { expanded: true }))
    expect(within(region('系統 1')).queryAllByRole('checkbox')).toEqual([])
  })

  it('系統を開くと、最初は手がかりのある便だけを時刻の順に出し、残りは「ほかの便を見る」で開く', () => {
    loadFeed(feedWithMore())
    render(<RestoreStep />)
    const r1 = () => within(candidates()).getByRole('region', { name: '系統 1' })
    expect(r1().textContent).toContain('なくなる便 4 便(判断材料あり 3 便)')
    fireEvent.click(within(r1()).getByRole('button', { expanded: false }))
    expect(within(r1()).getAllByRole('checkbox').map(idOf)).toEqual(['R1_0800_WK', 'R1_1200_WK', 'R1_1900_WK'])
    fireEvent.click(within(r1()).getByRole('button', { name: 'ほかの便を見る(残り 1 便)' }))
    expect(within(r1()).getAllByRole('checkbox').map(idOf)).toEqual(['R1_0800_WK', 'R1_1130_WK', 'R1_1200_WK', 'R1_1900_WK'])
    expect(within(r1()).queryByRole('button', { name: /ほかの便を見る/ })).toBeNull()
  })

  it('「時間帯の便がなくなる」には始発の時間帯(3時間ごと)を添え、「唯一の便」とは出さない(A03、指摘15.3)', () => {
    loadFeed(feedWithMore())
    render(<RestoreStep />)
    expandAll()
    const row = (id: string) => within(candidates()).getByRole('checkbox', { name: new RegExp(id) }).closest('li')!
    // R1_1200_WK は 12〜15時、R1_1900_WK は 18〜21時の R1 の便が減便後に 0 になる。R3_0730_WK は 6〜9時
    expect(row('R1_1200_WK').textContent).toContain('時間帯の便がなくなる(12〜15時)')
    expect(row('R1_1900_WK').textContent).toContain('時間帯の便がなくなる(18〜21時)')
    expect(row('R3_0730_WK').textContent).toContain('時間帯の便がなくなる(6〜9時)')
    // R1_1130_WK は土曜の 11:00 が同じ 9〜12時にあるので付かない
    expect(row('R1_1130_WK').textContent).not.toContain('時間帯の便がなくなる')
    expect(candidates().textContent).not.toContain('唯一')
    // 判断材料の絞り込みの名前と、説明の注記も同じ名前
    expect(within(screen.getByLabelText('判断材料')).getByRole('option', { name: '時間帯の便がなくなる' })).toBeTruthy()
    expect(screen.getByText(/「時間帯の便がなくなる」は、始発の時間帯\(到達圏と同じ3時間ごと。.*同じ時間帯のなくなる便すべてに付き、方向は分けていません。/)).toBeTruthy()
    expect(document.body.textContent).not.toContain('唯一')
  })

  it('系統の並びは、手がかりの数、次に外れたセルの人口、次に始発の時刻', () => {
    vi.mocked(buildRestoreHintContext).mockReturnValue(FAKE_CTX)
    // 到達圏を使う手がかりを足して、R1_0800_WK(元の手がかり2つ)と R2_0900_WK(元の手がかり2つ)をどちらも4つにする
    const order = (r1: number, r2: number) => {
      FAKE_EXTRA.current = {
        R1_0800_WK: { hints: REACH_HINTS, lostCells: { cells: 1, population: r1 } },
        R2_0900_WK: { hints: REACH_HINTS, lostCells: { cells: 1, population: r2 } },
      }
      const { unmount } = render(<RestoreStep />)
      const routes = routeOrder()
      unmount()
      return routes
    }
    // 人口の多い便のある系統が先
    expect(order(900, 10)).toEqual(['系統 3', '系統 1', '系統 2'])
    expect(order(5, 10)).toEqual(['系統 3', '系統 2', '系統 1'])
    // 人口も同じなら、始発の早い便(R1 08:00)のある系統が先
    expect(order(10, 10)).toEqual(['系統 3', '系統 1', '系統 2'])
    // 手がかりの数が多い系統は、人口が少なくても先(R2 に手がかりを1つ足して5つにする)
    FAKE_EXTRA.current = {
      R1_0800_WK: { hints: REACH_HINTS, lostCells: { cells: 1, population: 900 } },
      R2_0900_WK: { hints: [...REACH_HINTS, 'nearFacility'], lostCells: { cells: 1, population: 10 } },
    }
    render(<RestoreStep />)
    expect(routeOrder()).toEqual(['系統 3', '系統 2', '系統 1'])
  })

  it('「AI に候補を聞く」の結果(Claude の足し戻しの下書き)の便は、一覧の先頭の「AI のおすすめ」にまとめ、承認すると消える', () => {
    render(<RestoreStep />)
    expect(screen.queryByRole('region', { name: 'AI のおすすめ' })).toBeNull()
    act(() => {
      useEditStore.getState().propose(
        {
          type: 'addBack',
          items: [
            { tripId: 'R2_0900_WK', reason: '病院の通院', schoolDaysOnly: false },
            { tripId: 'R3_0730_WK', reason: '高校の通学', schoolDaysOnly: true },
          ],
        },
        'claude',
      )
    })
    const ai = screen.getByRole('region', { name: 'AI のおすすめ' })
    // 時刻の順。理由と(学)を添える
    expect(within(ai).getAllByRole('checkbox').map(idOf)).toEqual(['R3_0730_WK', 'R2_0900_WK'])
    expect(ai.textContent).toContain('AI の理由:高校の通学・休校日運休(学)')
    expect(ai.textContent).toContain('AI の理由:病院の通院')
    // 系統の一覧より前に出す
    expect(ai.compareDocumentPosition(candidates()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    // 系統の一覧の便にも印を付ける
    expandAll()
    expect(within(within(candidates()).getByRole('region', { name: '系統 3' })).getByText('AI のおすすめ')).toBeTruthy()

    // AI のおすすめから選ぶと、AI が(学)とした便は印が付いた状態で選ぶ
    fireEvent.click(within(ai).getAllByRole('checkbox')[0])
    const picked = screen.getByRole('region', { name: '選んだ便' })
    expect((within(picked).getByRole('checkbox', { name: 'R3_0730_WK を休校日運休(学)にする' }) as HTMLInputElement).checked).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: '承認する' }))
    expect(screen.queryByRole('region', { name: 'AI のおすすめ' })).toBeNull()
  })

  it('足し戻す便ごとに「休校日運休(学)」の印を付けられ、addBack の schoolDaysOnly に渡る', () => {
    render(<RestoreStep />)
    const boxes = candidateBoxes()
    fireEvent.click(boxes.find((b) => idOf(b) === 'R3_0730_WK')!)
    fireEvent.click(boxes.find((b) => idOf(b) === 'R2_0900_WK')!)
    const picked = screen.getByRole('region', { name: '選んだ便' })
    expect(picked.textContent).toContain('選んだ便(2 便)')
    fireEvent.click(within(picked).getByRole('checkbox', { name: 'R3_0730_WK を休校日運休(学)にする' }))
    fireEvent.change(screen.getByLabelText(/平日に戻す理由/), { target: { value: '通学' } })
    fireEvent.click(screen.getByRole('button', { name: '選んだ 2 便を平日に戻す' }))

    const op = useEditStore.getState().history.at(-1)?.op
    expect(op).toEqual({
      type: 'addBack',
      items: [
        { tripId: 'R3_0730_WK', reason: '通学', schoolDaysOnly: true },
        { tripId: 'R2_0900_WK', reason: '通学', schoolDaysOnly: false },
      ],
    })
    // 足し戻した便の一覧に(学)を出す。選んだ便と印は空にする
    const added = screen.getByRole('region', { name: '平日に戻した便' })
    const line = (id: string) => within(added).getByRole('button', { name: `${id} を平日に戻す操作を取り消す` }).closest('li')!.textContent
    expect(line('R3_0730_WK')).toMatch(/理由:通学\(利用者、[^)]*\)・休校日運休\(学\)/)
    expect(line('R2_0900_WK')).not.toContain('休校日運休')
    expect(screen.queryByRole('region', { name: '選んだ便' })).toBeNull()
  })

  it('候補の上に、勤務の数の目安の今の値と欠員との比較を1行出す。最初の1便を戻す前から出し、便を戻すたびに書き直す(D04)', () => {
    const base = useEditStore.getState().base!.feed
    const period = { start: '20261001', end: '20261130' }
    const expected = () => {
      const version = lastVersion(useEditStore.getState())!
      const c = compareDrivers({
        base,
        edited: { feed: version.feed, draft: false },
        date: '20261104',
        weekdayServices: activeWeekdayServicesOf(version),
        params: { ...DUTY_DEFAULTS },
        places: [],
        shortage: 20,
      })
      return `勤務の数(目安):減便前 ${c.before.duties.dutyCount} → 減便後 ${c.after!.duties.dutyCount}`
    }
    // 到達圏の store に減便前・承認済みの減便後・比較する日付(平日)を入れる。便を戻すと store/edit が setEdited で減便後を差し替える
    act(() => {
      useReachStore.setState({
        source: { feed: base, stops: [], period },
        edited: { feed: lastVersion(useEditStore.getState())!.feed, period, draft: false },
        date: '20261104',
      })
      useDriversStore.getState().setShortage(20)
      useDriversStore.getState().setRoster(110)
    })
    try {
      render(<RestoreStep />)
      // まだ便を戻していなくても(平日に戻した便の一覧が無くても)出す
      expect(screen.queryByRole('region', { name: '平日に戻した便' })).toBeNull()
      const line = () => screen.getByTestId('driver-line').textContent ?? ''
      expect(line()).toContain(expected())
      expect(line()).toMatch(/乗務できる運転士の数\(目安\)58 → (足りる目安です\(余り \d+\)|あと \d+ 足りない目安です)。減便前のまま(でも足りる目安です\(余り \d+\)|では \d+ 足りない目安です)。$/)
      // 1行は候補の一覧より上に出す
      const candidateList = candidates()
      expect(screen.getByTestId('driver-line').compareDocumentPosition(candidateList) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

      fireEvent.click(candidateBoxes().find((b) => idOf(b) === 'R3_0730_WK')!)
      fireEvent.click(screen.getByRole('button', { name: '選んだ 1 便を平日に戻す' }))
      // 平日に戻した便の一覧の中には重ねて出さない(1か所だけ)
      expect(within(screen.getByRole('region', { name: '平日に戻した便' })).queryByTestId('driver-line')).toBeNull()
      expect(screen.getAllByTestId('driver-line')).toHaveLength(1)
      expect(line()).toContain(expected())
      expect(line()).toContain('2026年11月4日(水)')
      expect(line()).toMatch(/乗務できる運転士の数\(目安\)58 → (足りる目安です\(余り \d+\)|あと \d+ 足りない目安です)。減便前のまま(でも足りる目安です\(余り \d+\)|では \d+ 足りない目安です)。$/)

      fireEvent.click(candidateBoxes().find((b) => idOf(b) === 'R2_0900_WK')!)
      fireEvent.click(screen.getByRole('button', { name: '選んだ 1 便を平日に戻す' }))
      expect(useEditStore.getState().versions.length).toBeGreaterThan(2)
      expect(line()).toContain(expected())
    } finally {
      act(() => {
        useReachStore.setState({ source: null, edited: null })
        useDriversStore.setState({ shortage: null, roster: null })
      })
    }
  })

  it('選んだ便は「外す」で選ぶのをやめられ、(学)の印も消える', () => {
    render(<RestoreStep />)
    fireEvent.click(candidateBoxes()[0])
    const picked = () => screen.getByRole('region', { name: '選んだ便' })
    fireEvent.click(within(picked()).getByRole('checkbox', { name: 'R3_0730_WK を休校日運休(学)にする' }))
    fireEvent.click(within(picked()).getByRole('button', { name: 'R3_0730_WK を選ぶのをやめる' }))
    expect(screen.queryByRole('region', { name: '選んだ便' })).toBeNull()
    expect(candidateBoxes()[0].checked).toBe(false)
    fireEvent.click(candidateBoxes()[0])
    expect((within(picked()).getByRole('checkbox', { name: 'R3_0730_WK を休校日運休(学)にする' }) as HTMLInputElement).checked).toBe(false)
  })

  it('受け付けなかった便は、理由をつけて出し、一覧から除ける', () => {
    // R1_0700_WK は土曜の R1_0700_SA と同じ時刻なので、足し戻す必要が無い
    act(() => {
      useEditStore.getState().propose({ type: 'addBack', items: [{ tripId: 'R1_0700_WK', reason: '', schoolDaysOnly: false }] }, 'user')
      useEditStore.getState().commit()
    })
    render(<RestoreStep />)
    const added = screen.getByRole('region', { name: '平日に戻した便' })
    expect(added.textContent).toContain('平日に戻した便(0 便)')
    expect(added.textContent).toContain('R1_0700_WK:土曜ダイヤに同じ時刻の便(R1_0700_SA)があるため、平日に戻す必要がありません。')
    fireEvent.click(within(added).getByRole('button', { name: 'R1_0700_WK を一覧から除く' }))
    expect(screen.queryByRole('region', { name: '平日に戻した便' })).toBeNull()
  })

  it('方針の下書きを確かめている間は、足し戻せない', () => {
    act(() => {
      useEditStore.getState().propose(policy(), 'user')
    })
    render(<RestoreStep />)
    fireEvent.click(candidateBoxes()[0])
    expect(screen.getByRole('button', { name: '選んだ 1 便を平日に戻す' })).toHaveProperty('disabled', true)
    expect(screen.getByText('減便の方針の下書きを承認するか、やめてから便を平日に戻してください。')).toBeTruthy()
  })

  it('Claude の下書きがあるときに足し戻すと、画面の中で捨ててよいかを確かめ、「やめる」なら選んだ便も下書きも残る', () => {
    act(() => {
      useEditStore.getState().propose({ type: 'addBack', items: [{ tripId: 'R3_0730_WK', reason: '通学', schoolDaysOnly: false }] }, 'claude')
    })
    const draftId = useEditStore.getState().draft!.id
    const browserConfirm = vi.spyOn(window, 'confirm')
    render(<RestoreStep />)
    const boxes = () => candidateBoxes()
    fireEvent.click(boxes()[1])
    fireEvent.click(screen.getByRole('button', { name: '選んだ 1 便を平日に戻す' }))

    // ボタンの場所に確認が出る。まだ何も変えていない
    const box = screen.getByRole('group', { name: 'AI の下書きを破棄する確認' })
    expect(box.textContent).toContain(`AI の下書き #${draftId} を破棄して、この操作をしますか。`)
    expect(screen.queryByRole('button', { name: '選んだ 1 便を平日に戻す' })).toBeNull()
    expect(useEditStore.getState().history).toHaveLength(1)

    fireEvent.click(within(box).getByRole('button', { name: 'やめる' }))
    expect(useEditStore.getState().draft?.id).toBe(draftId)
    expect(useEditStore.getState().history).toHaveLength(1)
    expect(boxes()[1].checked).toBe(true)
    expect(screen.queryByRole('group', { name: 'AI の下書きを破棄する確認' })).toBeNull()

    // 「捨てて続ける」なら、Claude の下書きを捨てて足し戻す
    fireEvent.click(screen.getByRole('button', { name: '選んだ 1 便を平日に戻す' }))
    fireEvent.click(within(screen.getByRole('group', { name: 'AI の下書きを破棄する確認' })).getByRole('button', { name: '破棄して続ける' }))
    expect(useEditStore.getState().draft).toBeNull()
    expect(useEditStore.getState().history).toHaveLength(2)
    // 2番目の候補は R1_0800_WK(R3・R1・R2 の順)
    expect(useEditStore.getState().versions.at(-1)?.plan.addBackTripIds).toEqual(['R1_0800_WK'])
    expect(useEditStore.getState().draftNotices).toEqual([expect.objectContaining({ draftId, result: 'replaced' })])
    expect(screen.getByRole('status').textContent).toContain('1 便を平日に戻しました')
    expect(boxes().every((b) => !b.checked)).toBe(true)
    expect(browserConfirm).not.toHaveBeenCalled()
  })

  it('Claude の下書きがあるときに足し戻しを取り消すと、足し戻した便の欄で確かめ、確かめたあとで取り消す', () => {
    act(() => {
      useEditStore.getState().propose({ type: 'addBack', items: [{ tripId: 'R3_0730_WK', reason: '', schoolDaysOnly: false }] }, 'user')
      useEditStore.getState().commit()
      useEditStore.getState().propose({ type: 'addBack', items: [{ tripId: 'R2_0900_WK', reason: '', schoolDaysOnly: false }] }, 'claude')
    })
    render(<RestoreStep />)
    const added = screen.getByRole('region', { name: '平日に戻した便' })
    fireEvent.click(within(added).getByRole('button', { name: 'R3_0730_WK を平日に戻す操作を取り消す' }))
    const box = within(added).getByRole('group', { name: 'AI の下書きを破棄する確認' })
    expect(useEditStore.getState().history).toHaveLength(2)
    fireEvent.click(within(box).getByRole('button', { name: 'やめる' }))
    expect(useEditStore.getState().history).toHaveLength(2)
    expect(useEditStore.getState().draft).not.toBeNull()

    fireEvent.click(within(added).getByRole('button', { name: 'R3_0730_WK を平日に戻す操作を取り消す' }))
    fireEvent.click(within(within(added).getByRole('group', { name: 'AI の下書きを破棄する確認' })).getByRole('button', { name: '破棄して続ける' }))
    expect(useEditStore.getState().history).toHaveLength(3)
    expect(useEditStore.getState().draft).toBeNull()
    expect(useEditStore.getState().versions.at(-1)?.plan.addBackTripIds).toEqual([])
  })

  it('確かめている間に Claude の下書きがなくなったら、確かめは残さず、元のボタンに戻る', () => {
    act(() => {
      useEditStore.getState().propose({ type: 'addBack', items: [{ tripId: 'R3_0730_WK', reason: '', schoolDaysOnly: false }] }, 'claude')
    })
    render(<RestoreStep />)
    fireEvent.click(candidateBoxes()[1])
    fireEvent.click(screen.getByRole('button', { name: '選んだ 1 便を平日に戻す' }))
    expect(screen.getByRole('group', { name: 'AI の下書きを破棄する確認' })).toBeTruthy()
    // 別の場所で Claude の下書きを承認した
    fireEvent.click(screen.getByRole('button', { name: '承認する' }))
    expect(screen.queryByRole('group', { name: 'AI の下書きを破棄する確認' })).toBeNull()
    expect(screen.getByRole('button', { name: '選んだ 1 便を平日に戻す' })).toBeTruthy()
    expect(useEditStore.getState().history).toHaveLength(2)
  })

  it('Claude の足し戻しの下書きは、承認するまで履歴に入らず、承認すると足し戻した便に入る', () => {
    act(() => {
      useEditStore.getState().propose({ type: 'addBack', items: [{ tripId: 'R3_0730_WK', reason: '通学', schoolDaysOnly: false }] }, 'claude')
    })
    render(<RestoreStep />)
    expect(screen.getByText(/AI の提案\):1 便を平日に戻す/)).toBeTruthy()
    expect(useEditStore.getState().history).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: '承認する' }))
    expect(useEditStore.getState().history).toHaveLength(2)
    expect(screen.getByRole('region', { name: '平日に戻した便' }).textContent).toContain('理由:通学(AI(承認済み)')
  })

  it('到達圏の比較ができていれば、停留所の発車がなくなると、到達圏が戻る(区画の数と人口)を判断材料に出す。できていなければ出さない', () => {
    const { unmount } = render(<RestoreStep />)
    const list = () => {
      expandAll()
      return candidates()
    }
    expect(list().textContent).not.toContain('到達圏が戻る')
    expect(list().textContent).not.toContain('停留所の発車がなくなる')
    expect(screen.queryByText(/この便だけを平日に戻したときの値/)).toBeNull()
    unmount()

    vi.mocked(buildRestoreHintContext).mockReturnValue(FAKE_CTX)
    render(<RestoreStep />)
    // 承認済みの編集後のフィードを渡して、手がかりの ctx を作っている
    expect(vi.mocked(buildRestoreHintContext).mock.calls.at(-1)?.[1]).toBe(useEditStore.getState().versions.at(-1)?.feed)
    expect(list().textContent).toContain('停留所の発車がなくなる')
    expect(list().textContent).toContain('到達圏が戻る(1,234 区画、約 5,678 人)')
    expect(screen.getByText(/この便だけを平日に戻したときの値です/)).toBeTruthy()
    // 手がかりが付いた便が先頭に来る。手がかりでの絞り込みにも出る
    expect(candidateIds()[0]).toBe('R3_0730_WK')
    fireEvent.change(screen.getByLabelText('判断材料'), { target: { value: 'restoresLostCells' } })
    expect(candidateIds()).toEqual(['R3_0730_WK'])
    // 比較の日付と、数えた時間帯の幅(地図の時間帯の幅)を注記に出す(U05 の D6)
    expect(screen.getByText(/2026年11月4日\(水\)の到達圏の前後の比較から、地図の時間帯\(今は3時間ごと\)で数えています/)).toBeTruthy()
  })

  it('地図の時間帯を1時間ごとにすると、到達圏を使う手がかりの注記も1時間ごとと出す(U05 の D6)', () => {
    vi.mocked(buildRestoreHintContext).mockReturnValue(FAKE_CTX_1H)
    render(<RestoreStep />)
    expect(screen.getByText(/地図の時間帯\(今は1時間ごと\)で数えています/)).toBeTruthy()
    expect(screen.queryByText(/今は3時間ごと/)).toBeNull()
  })

  it('時刻で決まる判断材料の時間帯は、到達圏と同じ3時間ごとであることを出す。公示第47号の区分は出さない(U05)', () => {
    render(<RestoreStep />)
    const note = screen.getByText(/始発の時間帯\(到達圏と同じ3時間ごと/)
    expect(note.textContent).toContain('「夕方・夜(15〜21時)」')
    expect(note.textContent).toContain('「朝(6〜9時)」')
    // 始発の時間帯の絞り込みも3時間ごと(diff.ts の START_BANDS)
    const bands = [...(screen.getByLabelText('始発の時間帯') as HTMLSelectElement).options].map((o) => o.value)
    // 候補の始発は 07:30・08:00(6〜9時)と 09:00(9〜12時)
    expect(bands).toEqual(['', '6〜9時', '9〜12時'])
    expect(document.body.textContent).not.toContain('時台')
  })

  it('到達圏を使う手がかりで絞り込んだまま比較が無くなったら(計算中など)、絞り込みを「すべて」に戻し、出していない理由を出す', () => {
    vi.mocked(buildRestoreHintContext).mockReturnValue(FAKE_CTX)
    render(<RestoreStep />)
    fireEvent.change(screen.getByLabelText('判断材料'), { target: { value: 'restoresLostCells' } })
    expect(candidateIds()).toEqual(['R3_0730_WK'])
    // 到達圏の計算が始まると、比較が無くなる(buildRestoreHintContext は null)
    vi.mocked(buildRestoreHintContext).mockReturnValue(null)
    act(() => useReachStore.setState({ computing: true }))
    expect(candidateIds()).toHaveLength(3)
    expect((screen.getByLabelText('判断材料') as HTMLSelectElement).value).toBe('')
    expect(screen.getByText(/到達圏を計算しているため/)).toBeTruthy()
    // 計算に失敗したとき
    act(() => useReachStore.setState({ computing: false, error: '計算できませんでした' }))
    expect(screen.getByText(/到達圏の計算に失敗したため/)).toBeTruthy()
  })

  it('下書きを確かめている間は、到達圏を使う手がかりを出していない理由を出す', () => {
    act(() => {
      useEditStore.getState().propose({ type: 'addBack', items: [{ tripId: 'R1_0800_WK', reason: '', schoolDaysOnly: false }] }, 'claude')
    })
    render(<RestoreStep />)
    expect(screen.getByText(/承認待ちの下書きがある間は/)).toBeTruthy()
  })

  it('比較の日付に平日の便が走らないときは、そう書く', () => {
    // 20261103 は smallFeed の WK の運休日
    vi.mocked(buildRestoreHintContext).mockReturnValue({ ...FAKE_CTX, date: '20261103' } as RestoreHintContext)
    render(<RestoreStep />)
    expect(screen.getByText(/2026年11月3日\(火\)\)は平日ダイヤの運行日ではない/)).toBeTruthy()
  })

  describe('調べた結果の要点と長期休業との重なり(T33)', () => {
    const URL_HOSP = 'https://www.nayoro-hosp.example/outpatient'
    const URL_SCHOOL = 'https://www.school.example/calendar'
    const HOSPITAL_FACTS = [{ label: '外来受付時間', value: '〔午前〕8：00～11：30 〔午後〕13：00～15：15', url: URL_HOSP }]
    const SCHOOL_FACTS = [
      { label: '始業時刻', value: '8:40', url: URL_SCHOOL },
      { label: '終業時刻', value: '15:30', url: URL_SCHOOL },
      { label: '秋季休業', value: '11月9日から11月12日まで', url: URL_SCHOOL },
      { label: '夏季休業', value: '7月24日から8月24日まで', url: URL_SCHOOL },
    ]
    const note = (checkedAt: string, origin: 'web' | 'demo' = 'demo') => ({
      status: 'found' as const,
      checkedAt,
      origin,
      facts: [],
    })
    function hintFacility(o: Partial<HintFacility> & { kind: 'school' | 'hospital' }): HintFacility {
      const facts = o.kind === 'school' ? SCHOOL_FACTS : HOSPITAL_FACTS
      return {
        targetId: o.kind === 'school' ? 'P29:高校' : 'P04:病院',
        name: o.kind === 'school' ? '北高校' : '市立病院',
        categoryLabel: o.kind === 'school' ? '高校・特別支援学校' : '入院設備のある病院',
        rank: 3,
        lat: 0,
        lon: 0,
        radiusM: 400,
        windows: facilityWindows(o.kind, facts),
        longBreaks: o.kind === 'school' ? readLongBreaks(facts) : [],
        ...o,
      }
    }
    function near(f: HintFacility, timing: 'arrive' | 'depart' = 'arrive'): NearFacility {
      return { facility: f, stopId: 'A', stopName: 'A停', distanceM: 120, matches: [{ timing, stopId: 'A', stopName: 'A停', time: '07:30', distanceM: 120 }] }
    }
    function withFacilities(tripId: string, facilities: NearFacility[]) {
      FAKE_EXTRA.current = { [tripId]: { hints: ['nearFacility'], lostCells: null, facilities } }
      vi.mocked(buildRestoreHintContext).mockReturnValue(FAKE_CTX)
    }
    function pick(tripId: string) {
      const box = candidateBoxes().find((b) => idOf(b) === tripId)!
      fireEvent.click(box)
    }
    const reasons = () => screen.getByRole('region', { name: '選んだ便の近くの学校・病院' })

    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(new Date('2026-11-03T12:00:00+09:00'))
    })
    afterEach(() => {
      vi.useRealTimers()
    })

    it('病院の判断材料のある便:窓の出どころと確認日時・デモの印を出し、開くと受付時間の事実を出典のリンクつきで出す', () => {
      withFacilities('R3_0730_WK', [near(hintFacility({ kind: 'hospital', research: note('2026-10-30T10:00:00+09:00') }))])
      render(<RestoreStep />)
      pick('R3_0730_WK')
      const toggle = within(reasons()).getByRole('button', { name: '市立病院の調べた要点' })
      expect(toggle.getAttribute('aria-expanded')).toBe('false')
      // 閉じていても、窓の出どころと確認日時・デモの印は見える。事実はまだ出さない
      expect(reasons().textContent).toContain('窓は調べた結果')
      expect(reasons().textContent).toContain('確認日時 2026年10月30日 10:00・デモ用の保存済みの結果')
      expect(reasons().textContent).not.toContain('外来受付時間')
      expect(reasons().textContent).not.toContain('30日より前の確認です')

      fireEvent.click(toggle)
      expect(toggle.getAttribute('aria-expanded')).toBe('true')
      expect(reasons().textContent).toContain('外来受付時間')
      expect(reasons().textContent).toContain('〔午前〕8：00～11：30 〔午後〕13：00～15：15')
      expect(reasons().textContent).toContain('通院の行きの窓に使用・通院の帰りの窓に使用')
      const link = within(reasons()).getByRole('link', { name: /出典 www\.nayoro-hosp\.example/ })
      expect(link.getAttribute('href')).toBe(URL_HOSP)
      expect(link.getAttribute('rel')).toContain('noopener')
      fireEvent.click(toggle)
      expect(toggle.getAttribute('aria-expanded')).toBe('false')
    })

    it('確認日時が 30 日より前なら注意を添える(ちょうど 30 日前までは添えない)', () => {
      withFacilities('R3_0730_WK', [near(hintFacility({ kind: 'hospital', research: note('2026-10-04T12:00:00+09:00') }))])
      const { unmount } = render(<RestoreStep />)
      pick('R3_0730_WK')
      expect(reasons().textContent).not.toContain('30日より前の確認です')
      unmount()

      withFacilities('R3_0730_WK', [near(hintFacility({ kind: 'hospital', research: note('2026-10-04T11:59:00+09:00', 'web') }))])
      render(<RestoreStep />)
      pick('R3_0730_WK')
      expect(reasons().textContent).toContain('30日より前の確認です。出典で確かめてください。')
      expect(reasons().textContent).toContain('Web で調べた結果')
    })

    it('調べていない施設は、窓が既定であることを開くと出す。受付時間などを読めなかった結果も同じ', () => {
      const plain = hintFacility({ kind: 'hospital', windows: facilityWindows('hospital', []) })
      withFacilities('R3_0730_WK', [near(plain)])
      const { unmount } = render(<RestoreStep />)
      pick('R3_0730_WK')
      expect(reasons().textContent).toContain('窓は既定')
      fireEvent.click(within(reasons()).getByRole('button', { name: '市立病院の調べた要点' }))
      expect(reasons().textContent).toContain('この施設は「判断材料を調べる」で調べていないため、時間帯の窓は既定です。')
      unmount()

      const unread = hintFacility({ kind: 'hospital', windows: facilityWindows('hospital', []), research: note('2026-11-01T09:00:00+09:00') })
      withFacilities('R3_0730_WK', [near(unread)])
      render(<RestoreStep />)
      pick('R3_0730_WK')
      expect(reasons().textContent).toContain('確認日時 2026年11月1日 09:00')
      fireEvent.click(within(reasons()).getByRole('button', { name: '市立病院の調べた要点' }))
      expect(reasons().textContent).toContain('調べた結果から受付時間・始業・終業を読めなかったため、時間帯の窓は既定です。')
    })

    it('学校の長期休業が減便の期間と重なるときだけ、(学)のチェックの近くに注意を出す。チェックは自動で付けない', () => {
      // 減便の期間は 2026-11-01〜(当面の間=出力の有効期間の末日 11-30)。秋季休業(11月9〜12日)は重なり、夏季休業(7月24日〜8月24日)は重ならない
      withFacilities('R3_0730_WK', [near(hintFacility({ kind: 'school', research: note('2026-11-01T09:00:00+09:00') }))])
      render(<RestoreStep />)
      pick('R3_0730_WK')
      const picked = screen.getByRole('region', { name: '選んだ便' })
      const notes = within(picked).getAllByTestId('school-break-note')
      expect(notes.map((n) => n.textContent)).toEqual([
        '北高校:期間中に秋季休業(11月9日〜11月12日)が重なります。休校日運休(学)の印を付けるか確かめてください。',
      ])
      expect(picked.textContent).not.toContain('夏季休業')
      const check = within(picked).getByRole('checkbox', { name: 'R3_0730_WK を休校日運休(学)にする' }) as HTMLInputElement
      expect(check.checked).toBe(false)
      // 注意が出ていても、チェックは利用者が付ける
      fireEvent.click(check)
      expect(check.checked).toBe(true)
      // 学校の窓の要点も、始業・終業・休業の事実を出す
      fireEvent.click(within(reasons()).getByRole('button', { name: '北高校の調べた要点' }))
      expect(reasons().textContent).toContain('始業時刻')
      expect(reasons().textContent).toContain('終業時刻')
      expect(reasons().textContent).toContain('長期休業の重なりの確認に使用')
    })

    /** 減便の期間を指定して方針を承認し直す(feed を渡せば、そのフィードで読み込み直す) */
    function loadWithPeriod(period: { start: string; end: string | null }, feed: GtfsFeed = smallFeed()) {
      const { addBackTripIds: _a, ...settings } = basePlan({ period })
      act(() => {
        useEditStore.getState().setBase({ feed, zip: new ArrayBuffer(0), label: 'test.zip', sample: null })
        useEditStore.getState().propose({ type: 'applyPolicy', settings, reason: { category: null, note: '' } }, 'user')
        useEditStore.getState().commit()
      })
      expect(useEditStore.getState().history).toHaveLength(1)
    }
    /** smallFeed の有効期間(calendar と feed_info)の末日を 20280331 にしたフィード(減便の期間が2回の冬をまたぐ) */
    function longFeed(): GtfsFeed {
      const feed = smallFeed()
      for (const r of feed.tables.get('calendar')!.rows) r.end_date = '20280331'
      for (const r of feed.tables.get('feed_info')!.rows) r.feed_end_date = '20280331'
      return feed
    }
    const schoolNotes = () => within(screen.getByRole('region', { name: '選んだ便' })).queryAllByTestId('school-break-note').map((n) => n.textContent)

    it('期間の終わりを指定したときは、その日までで重なりを見る(秋季休業 11月9〜12日は、終わりが 11-10 なら重なり、11-08 なら重ならない)', () => {
      const school = () => [near(hintFacility({ kind: 'school', research: note('2026-11-01T09:00:00+09:00') }))]
      loadWithPeriod({ start: '20261101', end: '20261110' })
      withFacilities('R3_0730_WK', school())
      const { unmount } = render(<RestoreStep />)
      pick('R3_0730_WK')
      expect(schoolNotes()).toEqual(['北高校:期間中に秋季休業(11月9日〜11月12日)が重なります。休校日運休(学)の印を付けるか確かめてください。'])
      unmount()

      loadWithPeriod({ start: '20261101', end: '20261108' })
      withFacilities('R3_0730_WK', school())
      render(<RestoreStep />)
      pick('R3_0730_WK')
      expect(schoolNotes()).toEqual([])
      expect((screen.getByRole('checkbox', { name: 'R3_0730_WK を休校日運休(学)にする' }) as HTMLInputElement).checked).toBe(false)
    })

    it('12月〜1月をまたぐ冬季休業も重なりを見る。期間が2回の冬をまたいでも、同じ注意は1つだけ出す', () => {
      const winter = [{ label: '冬季休業', value: '12月23日から1月14日まで', url: URL_SCHOOL }]
      const school = () => [near(hintFacility({ kind: 'school', longBreaks: readLongBreaks(winter), research: note('2026-11-01T09:00:00+09:00') }))]
      const WINTER_NOTE = '北高校:期間中に冬季休業(12月23日〜1月14日)が重なります。休校日運休(学)の印を付けるか確かめてください。'
      // 期間が年をまたぐ冬季休業の途中(1月)で終わる:重なる
      loadWithPeriod({ start: '20261101', end: '20270105' }, longFeed())
      withFacilities('R3_0730_WK', school())
      const first = render(<RestoreStep />)
      pick('R3_0730_WK')
      expect(schoolNotes()).toEqual([WINTER_NOTE])
      first.unmount()

      // 冬季休業の前(12月22日)に終わる:重ならない
      loadWithPeriod({ start: '20261101', end: '20261222' }, longFeed())
      withFacilities('R3_0730_WK', school())
      const second = render(<RestoreStep />)
      pick('R3_0730_WK')
      expect(schoolNotes()).toEqual([])
      second.unmount()

      // 当面の間(出力の有効期間の末日 2028-03-31 まで):2026-27 と 2027-28 の冬が重なるが、注意は1つ
      loadWithPeriod({ start: '20261101', end: null }, longFeed())
      withFacilities('R3_0730_WK', school())
      render(<RestoreStep />)
      pick('R3_0730_WK')
      expect(schoolNotes()).toEqual([WINTER_NOTE])
    })

    it('病院の便と、長期休業の事実が無い学校の便には、長期休業の注意を出さない', () => {
      withFacilities('R3_0730_WK', [near(hintFacility({ kind: 'hospital', research: note('2026-11-01T09:00:00+09:00') })), near(hintFacility({ kind: 'school', longBreaks: [] }))])
      render(<RestoreStep />)
      pick('R3_0730_WK')
      expect(screen.queryByTestId('school-break-note')).toBeNull()
    })
  })

  describe('往復と学校・病院に着く便の確認(A09。指摘18.2・18.3)', () => {
    /**
     * smallFeed に、R1 の帰りの方向(市役所 → 駅前)の平日の便 R1_1700_WK を足したフィード。土曜ダイヤには帰りの便が無いので、
     * 平日を土曜ダイヤにすると、駅前 → 市役所 は朝の便が残るのに帰りの方向の便がなくなる(方向の便がなくなる・帰りの便がない)
     */
    function feedWithReturn(): GtfsFeed {
      const feed = smallFeed()
      feed.tables.get('trips')!.rows.push(...rowsOf(`
route_id,service_id,trip_id,trip_headsign,block_id
R1,WK,R1_1700_WK,駅前,`))
      feed.tables.get('stop_times')!.rows.push(...rowsOf(`
trip_id,arrival_time,departure_time,stop_id,stop_sequence,pickup_type,drop_off_type
R1_1700_WK,17:00:00,17:00:00,B,1,0,1
R1_1700_WK,17:10:00,17:10:00,A,2,1,0`))
      return feed
    }
    const checks = () => screen.getByRole('group', { name: '往復と学校・病院の確認' })
    const roundTrip = () => screen.getByRole('region', { name: '往復の確認' })
    const facilityCheck = () => screen.getByRole('region', { name: '学校・病院に着く便の確認' })
    const problemRows = () => within(screen.getByRole('list', { name: '問題のある方向' })).getAllByRole('listitem')

    it('比較する日付の減便前と承認済みの減便後を、方向ごとに比べ、方向の便がなくなる、帰りの便がないの順に出す。判定しないことを断る', () => {
      loadFeed(feedWithReturn())
      act(() => useReachStore.setState({ date: '20261104' }))
      render(<RestoreStep />)
      expect(roundTrip().textContent).toContain('2026年11月4日(水)の減便前と減便後を、系統の方向(始発 → 終着)ごとに比べました。')
      const rows = problemRows()
      expect(rows[0].textContent).toContain('市役所 → 駅前')
      expect(rows[0].textContent).toContain('方向の便がなくなる')
      expect(rows[0].textContent).toContain('便数 1 → 0 便・始発 17:00 → —')
      // 平日だけの系統 3(駅前 → 学校前 → 市役所)も方向の便がなくなる。逆向きは系統 1 の市役所 → 駅前
      expect(rows[1].textContent).toMatch(/^3駅前 → 市役所方向の便がなくなる/)
      expect(rows[2].textContent).toMatch(/^1駅前 → 市役所帰りの便がない/)
      expect(rows[2].textContent).toContain('帰り(市役所 → 駅前)の15〜21時の便:1 → 0 便')
      expect(rows).toHaveLength(3)
      expect(checks().textContent).toContain(
        '乗車人数・混み具合・鉄道との乗り継ぎの時刻は、データがないため判定していません。窓は始業・受付の時刻からの目安です。',
      )
      // 学校・病院を読み込んでいなければ、理由を出す
      expect(facilityCheck().textContent).toContain('周辺の学校・病院の参照データを読み込むと、施設ごとに確かめます。')
    })

    it('行の「候補を開く」で、その系統の候補のまとまりを開く。絞り込みで隠れていれば、絞り込みを外す', () => {
      loadFeed(feedWithReturn())
      act(() => useReachStore.setState({ date: '20261104' }))
      render(<RestoreStep />)
      const r1 = () => within(candidates()).getByRole('region', { name: '系統 1' })
      expect(within(r1()).getAllByRole('button')[0].getAttribute('aria-expanded')).toBe('false')
      // 系統 3 だけに絞り込んでいると、系統 1 は一覧に出ない
      fireEvent.change(screen.getByLabelText('系統'), { target: { value: 'R3' } })
      expect(within(candidates()).queryByRole('region', { name: '系統 1' })).toBeNull()
      fireEvent.click(within(problemRows()[0]).getByRole('button', { name: /系統 1 の平日に戻す候補を開く/ }))
      expect((screen.getByLabelText('系統') as HTMLSelectElement).value).toBe('')
      const toggle = within(r1()).getAllByRole('button')[0]
      expect(toggle.getAttribute('aria-expanded')).toBe('true')
      expect(document.activeElement).toBe(toggle)
      expect(r1().textContent).toContain('R1_1700_WK')
    })

    it('承認待ちの下書きがあれば、下書きの結果と比べる', () => {
      loadFeed(feedWithReturn())
      act(() => {
        useReachStore.setState({ date: '20261104' })
        useEditStore.getState().propose({ type: 'addBack', items: [{ tripId: 'R1_1700_WK', reason: '', schoolDaysOnly: false }] }, 'claude')
      })
      render(<RestoreStep />)
      const id = useEditStore.getState().draft!.id
      expect(roundTrip().textContent).toContain(`減便前と減便後(下書き #${id})を`)
      // 帰りの便を平日に戻す下書きなので、帰りの方向の問題はなくなる
      expect(screen.getByLabelText('往復の問題の数').textContent).toBe('方向の便がなくなる 1・帰りの便がない 0・終発が早まる 0・始発が遅くなる 0')
      expect(problemRows().map((r) => r.textContent?.split('便数')[0])).toEqual(['3駅前 → 市役所方向の便がなくなる'])
    })

    it('比較する日付に平日ダイヤが走らないときは、2つとも確かめていない理由を出す', () => {
      act(() => useReachStore.setState({ date: '20261107' }))
      render(<RestoreStep />)
      expect(roundTrip().textContent).toContain('比較する日付(2026年11月7日(土))は平日ダイヤの運行日ではないため、往復は確かめていません。')
      expect(facilityCheck().textContent).toContain('比較する日付(2026年11月7日(土))は平日ダイヤの運行日ではないため、学校・病院に着く便は確かめていません。')
    })

    it('学校・病院を読めていれば、着く便が 0 便になる施設を出す', () => {
      // 学校前(S9)の近くの高校。S9 に着くのは平日だけの R3_0730_WK(07:40 着)だけなので、平日を土曜ダイヤにすると着く便がなくなる
      const school: HintFacility = {
        targetId: 'P29:学校',
        name: '南高校',
        kind: 'school',
        categoryLabel: '高校・特別支援学校',
        rank: 3,
        lat: 43.7905,
        lon: 142.39,
        radiusM: 400,
        windows: facilityWindows('school', []),
        longBreaks: [],
      }
      vi.mocked(buildRestoreHintContext).mockReturnValue({ ...FAKE_CTX, facilities: [school] } as RestoreHintContext)
      act(() => useReachStore.setState({ date: '20261104' }))
      render(<RestoreStep />)
      const list = within(facilityCheck()).getByRole('list', { name: '着く便・出る便がなくなる学校・病院' })
      expect(list.textContent).toContain('南高校')
      expect(list.textContent).toContain('着く便がなくなる')
      expect(list.textContent).toContain('着く 7:00〜9:00(既定):1 → 0 便・最も遅く着く時刻 07:40 → —')
    })
  })

  it('AI に候補を聞くボタン:AI が使えるときだけ押せて、押すと依頼を送る。使えないときは理由を出す', async () => {
    const askRestore = vi.fn(async () => true)
    useChatStore.setState({ status: { state: 'ready', available: false, tokenRequired: false }, askRestore })
    const { unmount } = render(<RestoreStep />)
    const button = () => screen.getByRole('button', { name: 'AI に候補を聞く' }) as HTMLButtonElement
    expect(button().disabled).toBe(true)
    expect(screen.getByText(/AI は使えません/)).toBeTruthy()
    unmount()

    act(() => useChatStore.setState({ status: { state: 'ready', available: true, tokenRequired: false } }))
    render(<RestoreStep />)
    expect(button().disabled).toBe(false)
    // 押したボタンは送り終えるまで処理中の形になるため、送り終えるのを待つ
    await act(async () => {
      fireEvent.click(button())
    })
    expect(askRestore).toHaveBeenCalledTimes(1)

    // 方針の下書きを確かめている間は、足し戻せないのと同じに、聞けない
    act(() => {
      useEditStore.getState().propose(policy(), 'user')
    })
    expect(button().disabled).toBe(true)
    expect(screen.getAllByText('減便の方針の下書きを承認するか、やめてから聞いてください。').length).toBeGreaterThan(0)
  })
})
