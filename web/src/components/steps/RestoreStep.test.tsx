// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { basePlan, rowsOf, smallFeed } from '@/gtfs/edit/form2.fixture'
import type { RestoreHint, RestoreHintContext, RestoreHintDetail } from '@/gtfs/edit/restore'
import type { GtfsFeed } from '@/gtfs/load'
import type { EditOp } from '@/gtfs/edit/ops'
import { buildRestoreHintContext } from '@/store/restoreHintContext'
import { useChatStore } from '@/store/chat'
import { useEditStore } from '@/store/edit'
import { useReachStore } from '@/store/reach'
import RestoreStep from './RestoreStep'

// 到達圏の store への受け渡し(setEdited)は、この画面では計算しない
vi.mock('@/reach/workerClient', () => ({ computeReachInWorker: async () => new Promise(() => {}) }))

// 到達圏の前後の比較(ctx)は、この画面では作らない。ctx を渡したときだけ、FAKE_EXTRA の便(既定は R3_0730_WK)に
// 到達圏を使う2つの手がかりを付ける(手がかりの計算そのものは gtfs/edit/restore.test.ts で確かめている)
// 比較の日付 2026-11-04(水)は smallFeed の平日(WK)の運行日
const FAKE_CTX = { fake: true, date: '20261104' } as unknown as RestoreHintContext
type FakeExtra = { hints: RestoreHint[]; lostCells: RestoreHintDetail['lostCells'] }
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
        if (ctx !== FAKE_CTX || !extra) return detail
        return { hints: [...detail.hints, ...extra.hints], lostCells: extra.lostCells }
      }
    },
  }
})

const realAskRestore = useChatStore.getState().askRestore

function policy(): EditOp {
  const { addBackTripIds: _a, ...settings } = basePlan()
  return { type: 'applyPolicy', settings, reason: { category: null, note: '' } }
}

const candidates = () => screen.getByRole('group', { name: '足し戻す便の候補' })

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
 * smallFeed に R1 の便を足したフィード。R1_1130_WK・R1_1200_WK は手がかりの無い消える便
 * (土曜の R1_1100_SA があるので、時間帯で唯一の便にもならない)。R1_1900_WK は系統の終発で、15〜19時台で唯一の便
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
    expect(screen.getByText('減便の方針を承認すると、消える平日便から足し戻す便を選べます。')).toBeTruthy()
  })

  it('候補は消える平日便で、手がかりの多い順に並べ、停留所名・手がかりで絞り込める', () => {
    render(<RestoreStep />)
    expect(candidateIds()).toEqual(['R3_0730_WK', 'R2_0900_WK', 'R1_0800_WK'])
    fireEvent.change(screen.getByLabelText('停留所名(一部)'), { target: { value: '学校' } })
    expect(candidateIds()).toEqual(['R3_0730_WK'])
    fireEvent.change(screen.getByLabelText('停留所名(一部)'), { target: { value: '' } })
    fireEvent.change(screen.getByLabelText('手がかり'), { target: { value: 'lastTripOfRoute' } })
    expect(candidateIds()).toEqual(['R3_0730_WK', 'R2_0900_WK', 'R1_0800_WK'])
    fireEvent.change(screen.getByLabelText('手がかり'), { target: { value: 'onlyTripInBand' } })
    expect(candidateIds()).toEqual(['R3_0730_WK', 'R2_0900_WK'])
    fireEvent.change(screen.getByLabelText('系統'), { target: { value: 'R1' } })
    expect(candidateIds()).toEqual([])
    expect(screen.getByText('当てはまる便がありません。')).toBeTruthy()
  })

  it('候補は系統ごとに折りたたみ、全曜日で便がなくなる系統を先頭にし、開くと方向ごとに編集後の最大間隔を添える', () => {
    render(<RestoreStep />)
    // 最初は閉じている
    expect(candidateBoxes(false)).toEqual([])
    // R3 は平日だけの系統で、全曜日で便がなくなる
    expect(routeOrder()).toEqual(['系統 3', '系統 2', '系統 1'])
    const region = (name: string) => within(candidates()).getByRole('region', { name })
    expect(region('系統 3').textContent).toContain('全曜日で便がなくなる')
    expect(region('系統 1').textContent).not.toContain('全曜日で便がなくなる')
    expect(region('系統 1').textContent).toContain('消える 1 便(手がかりあり 1 便)')
    // 比べる日が無ければ、最大間隔は出さない
    expect(screen.getByText(/到達圏を比べる日が決まると/)).toBeTruthy()

    act(() => useReachStore.setState({ date: '20261104' }))
    expect(screen.getByText(/到達圏を比べる日\(2026年11月4日\(水\)\)の/)).toBeTruthy()
    fireEvent.click(within(region('系統 1')).getByRole('button', { expanded: false }))
    expect(region('系統 1').textContent).toContain('駅前 → 市役所')
    expect(region('系統 1').textContent).toContain('編集後の最大間隔 65 分')
    expect(region('系統 1').textContent).toContain('編集後の便:07:00・08:05')
    expect(within(region('系統 1')).getAllByRole('checkbox').map(idOf)).toEqual(['R1_0800_WK'])
    fireEvent.click(within(region('系統 3')).getByRole('button', { expanded: false }))
    expect(region('系統 3').textContent).toContain('編集後はこの方向の便がありません')
    // 閉じると便は出さない
    fireEvent.click(within(region('系統 1')).getByRole('button', { expanded: true }))
    expect(within(region('系統 1')).queryAllByRole('checkbox')).toEqual([])
  })

  it('系統を開くと、最初は手がかりのある便だけを時刻の順に出し、残りは「ほかの便を見る」で開く', () => {
    loadFeed(feedWithMore())
    render(<RestoreStep />)
    const r1 = () => within(candidates()).getByRole('region', { name: '系統 1' })
    expect(r1().textContent).toContain('消える 4 便(手がかりあり 2 便)')
    fireEvent.click(within(r1()).getByRole('button', { expanded: false }))
    expect(within(r1()).getAllByRole('checkbox').map(idOf)).toEqual(['R1_0800_WK', 'R1_1900_WK'])
    fireEvent.click(within(r1()).getByRole('button', { name: 'ほかの便を見る(残り 2 便)' }))
    expect(within(r1()).getAllByRole('checkbox').map(idOf)).toEqual(['R1_0800_WK', 'R1_1130_WK', 'R1_1200_WK', 'R1_1900_WK'])
    expect(within(r1()).queryByRole('button', { name: /ほかの便を見る/ })).toBeNull()
  })

  it('系統の並びは、手がかりの数、次に外れたセルの人口、次に始発の時刻', () => {
    vi.mocked(buildRestoreHintContext).mockReturnValue(FAKE_CTX)
    // 到達圏を使う手がかりを足して、R1_0800_WK(元の手がかり2つ)と R2_0900_WK(元の手がかり3つ)をどちらも4つにする
    const order = (r1: number, r2: number) => {
      FAKE_EXTRA.current = {
        R1_0800_WK: { hints: REACH_HINTS, lostCells: { cells: 1, population: r1 } },
        R2_0900_WK: { hints: ['restoresLostCells'], lostCells: { cells: 1, population: r2 } },
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
      R2_0900_WK: { hints: REACH_HINTS, lostCells: { cells: 1, population: 10 } },
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
    expect(ai.textContent).toContain('AI の理由:高校の通学(休校日運休(学))')
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
    fireEvent.change(screen.getByLabelText(/足し戻す理由/), { target: { value: '通学' } })
    fireEvent.click(screen.getByRole('button', { name: '選んだ 2 便を足し戻す' }))

    const op = useEditStore.getState().history.at(-1)?.op
    expect(op).toEqual({
      type: 'addBack',
      items: [
        { tripId: 'R3_0730_WK', reason: '通学', schoolDaysOnly: true },
        { tripId: 'R2_0900_WK', reason: '通学', schoolDaysOnly: false },
      ],
    })
    // 足し戻した便の一覧に(学)を出す。選んだ便と印は空にする
    const added = screen.getByRole('region', { name: '足し戻した便' })
    const line = (id: string) => within(added).getByRole('button', { name: `${id} の足し戻しを取り消す` }).closest('li')!.textContent
    expect(line('R3_0730_WK')).toMatch(/理由:通学\(利用者、[^)]*\)・休校日運休\(学\)/)
    expect(line('R2_0900_WK')).not.toContain('休校日運休')
    expect(screen.queryByRole('region', { name: '選んだ便' })).toBeNull()
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
    const added = screen.getByRole('region', { name: '足し戻した便' })
    expect(added.textContent).toContain('足し戻した便(0 便)')
    expect(added.textContent).toContain('R1_0700_WK:土曜ダイヤに同じ時刻の便(R1_0700_SA)があるため、足し戻す必要がありません。')
    fireEvent.click(within(added).getByRole('button', { name: 'R1_0700_WK を一覧から除く' }))
    expect(screen.queryByRole('region', { name: '足し戻した便' })).toBeNull()
  })

  it('方針の下書きを確かめている間は、足し戻せない', () => {
    act(() => {
      useEditStore.getState().propose(policy(), 'user')
    })
    render(<RestoreStep />)
    fireEvent.click(candidateBoxes()[0])
    expect(screen.getByRole('button', { name: '選んだ 1 便を足し戻す' })).toHaveProperty('disabled', true)
    expect(screen.getByText('減便の方針の下書きを承認するか、やめてから足し戻してください。')).toBeTruthy()
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
    fireEvent.click(screen.getByRole('button', { name: '選んだ 1 便を足し戻す' }))

    // ボタンの場所に確認が出る。まだ何も変えていない
    const box = screen.getByRole('group', { name: 'Claude の下書きを捨てる確認' })
    expect(box.textContent).toContain(`Claude の下書き ${draftId} を捨てて、この操作をしますか。`)
    expect(screen.queryByRole('button', { name: '選んだ 1 便を足し戻す' })).toBeNull()
    expect(useEditStore.getState().history).toHaveLength(1)

    fireEvent.click(within(box).getByRole('button', { name: 'やめる' }))
    expect(useEditStore.getState().draft?.id).toBe(draftId)
    expect(useEditStore.getState().history).toHaveLength(1)
    expect(boxes()[1].checked).toBe(true)
    expect(screen.queryByRole('group', { name: 'Claude の下書きを捨てる確認' })).toBeNull()

    // 「捨てて続ける」なら、Claude の下書きを捨てて足し戻す
    fireEvent.click(screen.getByRole('button', { name: '選んだ 1 便を足し戻す' }))
    fireEvent.click(within(screen.getByRole('group', { name: 'Claude の下書きを捨てる確認' })).getByRole('button', { name: '捨てて続ける' }))
    expect(useEditStore.getState().draft).toBeNull()
    expect(useEditStore.getState().history).toHaveLength(2)
    expect(useEditStore.getState().versions.at(-1)?.plan.addBackTripIds).toEqual(['R2_0900_WK'])
    expect(useEditStore.getState().draftNotices).toEqual([expect.objectContaining({ draftId, result: 'replaced' })])
    expect(screen.getByRole('status').textContent).toContain('1 便を足し戻しました')
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
    const added = screen.getByRole('region', { name: '足し戻した便' })
    fireEvent.click(within(added).getByRole('button', { name: 'R3_0730_WK の足し戻しを取り消す' }))
    const box = within(added).getByRole('group', { name: 'Claude の下書きを捨てる確認' })
    expect(useEditStore.getState().history).toHaveLength(2)
    fireEvent.click(within(box).getByRole('button', { name: 'やめる' }))
    expect(useEditStore.getState().history).toHaveLength(2)
    expect(useEditStore.getState().draft).not.toBeNull()

    fireEvent.click(within(added).getByRole('button', { name: 'R3_0730_WK の足し戻しを取り消す' }))
    fireEvent.click(within(within(added).getByRole('group', { name: 'Claude の下書きを捨てる確認' })).getByRole('button', { name: '捨てて続ける' }))
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
    fireEvent.click(screen.getByRole('button', { name: '選んだ 1 便を足し戻す' }))
    expect(screen.getByRole('group', { name: 'Claude の下書きを捨てる確認' })).toBeTruthy()
    // 別の場所で Claude の下書きを承認した
    fireEvent.click(screen.getByRole('button', { name: '承認する' }))
    expect(screen.queryByRole('group', { name: 'Claude の下書きを捨てる確認' })).toBeNull()
    expect(screen.getByRole('button', { name: '選んだ 1 便を足し戻す' })).toBeTruthy()
    expect(useEditStore.getState().history).toHaveLength(2)
  })

  it('Claude の足し戻しの下書きは、承認するまで履歴に入らず、承認すると足し戻した便に入る', () => {
    act(() => {
      useEditStore.getState().propose({ type: 'addBack', items: [{ tripId: 'R3_0730_WK', reason: '通学', schoolDaysOnly: false }] }, 'claude')
    })
    render(<RestoreStep />)
    expect(screen.getByText(/Claude の提案\):便を 1 本足し戻す/)).toBeTruthy()
    expect(useEditStore.getState().history).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: '承認する' }))
    expect(useEditStore.getState().history).toHaveLength(2)
    expect(screen.getByRole('region', { name: '足し戻した便' }).textContent).toContain('理由:通学(Claude(承認済み)')
  })

  it('到達圏の比較ができていれば、停留所で唯一の便と、外れたセルが戻る(セル数と人口)を手がかりに出す。できていなければ出さない', () => {
    const { unmount } = render(<RestoreStep />)
    const list = () => {
      expandAll()
      return candidates()
    }
    expect(list().textContent).not.toContain('外れたセルが戻る')
    expect(list().textContent).not.toContain('停留所で唯一の便')
    expect(screen.queryByText(/この便だけを足し戻したときの値/)).toBeNull()
    unmount()

    vi.mocked(buildRestoreHintContext).mockReturnValue(FAKE_CTX)
    render(<RestoreStep />)
    // 承認済みの編集後のフィードを渡して、手がかりの ctx を作っている
    expect(vi.mocked(buildRestoreHintContext).mock.calls.at(-1)?.[1]).toBe(useEditStore.getState().versions.at(-1)?.feed)
    expect(list().textContent).toContain('停留所で唯一の便')
    expect(list().textContent).toContain('外れたセルが戻る(1,234 セル、約 5,678 人)')
    expect(screen.getByText(/この便だけを足し戻したときの値です/)).toBeTruthy()
    // 手がかりが付いた便が先頭に来る。手がかりでの絞り込みにも出る
    expect(candidateIds()[0]).toBe('R3_0730_WK')
    fireEvent.change(screen.getByLabelText('手がかり'), { target: { value: 'restoresLostCells' } })
    expect(candidateIds()).toEqual(['R3_0730_WK'])
    // 比較の日付を注記に出す
    expect(screen.getByText(/2026年11月4日\(水\)の到達圏の前後の比較から出しています/)).toBeTruthy()
  })

  it('到達圏を使う手がかりで絞り込んだまま比較が無くなったら(計算中など)、絞り込みを「すべて」に戻し、出していない理由を出す', () => {
    vi.mocked(buildRestoreHintContext).mockReturnValue(FAKE_CTX)
    render(<RestoreStep />)
    fireEvent.change(screen.getByLabelText('手がかり'), { target: { value: 'restoresLostCells' } })
    expect(candidateIds()).toEqual(['R3_0730_WK'])
    // 到達圏の計算が始まると、比較が無くなる(buildRestoreHintContext は null)
    vi.mocked(buildRestoreHintContext).mockReturnValue(null)
    act(() => useReachStore.setState({ computing: true }))
    expect(candidateIds()).toHaveLength(3)
    expect((screen.getByLabelText('手がかり') as HTMLSelectElement).value).toBe('')
    expect(screen.getByText(/到達圏を計算しているので/)).toBeTruthy()
    // 計算に失敗したとき
    act(() => useReachStore.setState({ computing: false, error: '計算できませんでした' }))
    expect(screen.getByText(/到達圏の計算に失敗したので/)).toBeTruthy()
  })

  it('下書きを確かめている間は、到達圏を使う手がかりを出していない理由を出す', () => {
    act(() => {
      useEditStore.getState().propose({ type: 'addBack', items: [{ tripId: 'R1_0800_WK', reason: '', schoolDaysOnly: false }] }, 'claude')
    })
    render(<RestoreStep />)
    expect(screen.getByText(/下書きを確かめている間は/)).toBeTruthy()
  })

  it('比較の日付に平日の便が走らないときは、そう書く', () => {
    // 20261103 は smallFeed の WK の運休日
    vi.mocked(buildRestoreHintContext).mockReturnValue({ ...FAKE_CTX, date: '20261103' } as RestoreHintContext)
    render(<RestoreStep />)
    expect(screen.getByText(/2026年11月3日\(火\)\)は平日ダイヤの運行日ではない/)).toBeTruthy()
  })

  it('AI に候補を聞くボタン:AI が使えるときだけ押せて、押すと依頼を送る。使えないときは理由を出す', () => {
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
    fireEvent.click(button())
    expect(askRestore).toHaveBeenCalledTimes(1)

    // 方針の下書きを確かめている間は、足し戻せないのと同じに、聞けない
    act(() => {
      useEditStore.getState().propose(policy(), 'user')
    })
    expect(button().disabled).toBe(true)
    expect(screen.getAllByText('減便の方針の下書きを承認するか、やめてから聞いてください。').length).toBeGreaterThan(0)
  })
})
