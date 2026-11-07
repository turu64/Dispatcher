// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GtfsFeed, GtfsRow } from '@/gtfs/load'
import { RoundTripPanel } from './RoundTripPanel'

// 道北バスに似た形:direction_id も parent_station も無く、向かい合う停留所は名前が同じで stop_id が違う。
// 比較する日付は 2026-11-04(水)。W は平日、S は土曜の service
const DATE = '20261104'
const SATURDAY = '20261107'

const STOPS: [id: string, name: string][] = [
  ['A1', '駅前'],
  ['A2', '駅 前'],
  ['B', '病院前'],
  ['C', '団地'],
  ['D1', '高校前'],
  ['D2', '高校前'],
  ['E', '温泉'],
  ['F', '空港'],
  ['G', '市役所'],
  ['H', '公園'],
]

const ROUTE_NAMES: Record<string, string> = { R1: '病院線', R2: '高校線', R3: '温泉線', R4: '市役所線' }

/** 便:[route_id, trip_id, service_id, 始発の停留所, 終着の停留所, 始発の時刻 'HH:MM'] */
type TripSpec = [route: string, trip: string, service: string, from: string, to: string, departure: string]

function feedOf(trips: TripSpec[]): GtfsFeed {
  const routeIds = [...new Set(trips.map((t) => t[0]))]
  const clock = (min: number) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}:00`
  const tables: Record<string, GtfsRow[]> = {
    routes: routeIds.map((id) => ({ route_id: id, route_short_name: '', route_long_name: ROUTE_NAMES[id] ?? id, route_type: '3' })),
    stops: STOPS.map(([id, name], i) => ({ stop_id: id, stop_name: name, stop_lat: String(44.3 + i / 1000), stop_lon: '142.4' })),
    calendar: [
      { service_id: 'W', monday: '1', tuesday: '1', wednesday: '1', thursday: '1', friday: '1', saturday: '0', sunday: '0', start_date: '20261001', end_date: '20270331' },
      { service_id: 'S', monday: '0', tuesday: '0', wednesday: '0', thursday: '0', friday: '0', saturday: '1', sunday: '0', start_date: '20261001', end_date: '20270331' },
    ],
    trips: trips.map(([route, trip, service]) => ({ route_id: route, trip_id: trip, service_id: service })),
    stop_times: trips.flatMap(([, trip, , from, to, departure]) => {
      const [h, m] = departure.split(':').map(Number)
      const start = h * 60 + m
      return [
        { trip_id: trip, stop_id: from, stop_sequence: '1', arrival_time: clock(start), departure_time: clock(start) },
        { trip_id: trip, stop_id: to, stop_sequence: '2', arrival_time: clock(start + 30), departure_time: clock(start + 30) },
      ]
    }),
  }
  return {
    tables: new Map(Object.entries(tables).map(([name, rows]) => [name, { fileName: `${name}.txt`, fields: Object.keys(rows[0] ?? {}), rows }])),
    warnings: [],
  }
}

// 減便前:
// - R1 病院線:駅前 → 病院前 06:50・07:30、病院前 → 駅前 17:00・20:00(帰りは向かいの停留所 A2)
// - R2 高校線:団地 → 高校前 07:00・21:00、高校前 → 団地 08:00・18:00(向かい合う D1・D2)
// - R3 温泉線:温泉 → 空港 だけ(片道。逆向きが無い)
// - R4 市役所線:市役所 → 公園 08:00、公園 → 市役所 17:00(減便後も同じ)
const BASE: TripSpec[] = [
  ['R1', 'r1a', 'W', 'A1', 'B', '06:50'],
  ['R1', 'r1b', 'W', 'A1', 'B', '07:30'],
  ['R1', 'r1c', 'W', 'B', 'A2', '17:00'],
  ['R1', 'r1d', 'W', 'B', 'A2', '20:00'],
  ['R2', 'r2a', 'W', 'C', 'D1', '07:00'],
  ['R2', 'r2b', 'W', 'C', 'D1', '21:00'],
  ['R2', 'r2c', 'W', 'D2', 'C', '08:00'],
  ['R2', 'r2d', 'W', 'D2', 'C', '18:00'],
  ['R3', 'r3a', 'W', 'E', 'F', '09:00'],
  ['R4', 'r4a', 'W', 'G', 'H', '08:00'],
  ['R4', 'r4b', 'W', 'H', 'G', '17:00'],
  ['R1', 's1a', 'S', 'A1', 'B', '07:30'],
]
// 減便後:R1 は朝の 07:30 だけ残り、帰りがなくなる。R2 は 21:00 の便がなくなる(終発が 14 時間早まる)
const EDITED: TripSpec[] = BASE.filter(([, trip]) => !['r1a', 'r1c', 'r1d', 'r2b'].includes(trip))

const base = feedOf(BASE)
const edited = feedOf(EDITED)

function renderPanel(o: { date?: string | null; draftLabel?: string | null; openable?: string[]; onOpenRoute?: (id: string) => void; editedFeed?: GtfsFeed } = {}) {
  return render(
    <RoundTripPanel
      base={base}
      edited={o.editedFeed ?? edited}
      weekdayServices={new Set(['W'])}
      date={o.date === undefined ? DATE : o.date}
      draftLabel={o.draftLabel ?? null}
      openable={new Set(o.openable ?? ['R1', 'R2'])}
      onOpenRoute={o.onOpenRoute ?? (() => {})}
    />,
  )
}

const panel = () => screen.getByRole('region', { name: '往復の確認' })
const problemRows = () => within(screen.getByRole('list', { name: '問題のある方向' })).getAllByRole('listitem')

afterEach(() => {
  cleanup()
})

describe('RoundTripPanel', () => {
  it('比較する日付が決まっていなければ、操作盤で選ぶよう出す', () => {
    renderPanel({ date: null })
    expect(panel().textContent).toContain('往復は、地図の下の操作盤で比較する日付を選ぶと確かめます。')
    expect(screen.queryByRole('list')).toBeNull()
  })

  it('比較する日付に平日ダイヤが走らないときは、判断材料と同じ形で理由を出す', () => {
    renderPanel({ date: SATURDAY })
    expect(panel().textContent).toContain(
      '比較する日付(2026年11月7日(土))は平日ダイヤの運行日ではないため、往復は確かめていません。比較する日付を、地図の下の操作盤で平日にすると確かめます。',
    )
    expect(screen.queryByRole('list')).toBeNull()
  })

  it('方向ごとに前後の便数・始発・終発を出し、方向の便がなくなる、帰りの便がない、終発が早まる、始発が遅くなるの順に並べる', () => {
    renderPanel()
    const rows = problemRows()
    expect(rows).toHaveLength(3)
    // 1. 方向の便がなくなる(病院前 → 駅前)
    expect(rows[0].textContent).toContain('病院線')
    // 方向の名前は、最初に見つけた便の停留所名のまま(向かいの停留所 A2 の「駅 前」)
    expect(rows[0].textContent).toContain('病院前 → 駅 前')
    expect(rows[0].textContent).toContain('方向の便がなくなる')
    expect(rows[0].textContent).toContain('便数 2 → 0 便・始発 17:00 → —・終発 20:00 → —')
    // 2. 帰りの便がない(と、始発が遅くなる)。帰りの方向の 15〜21時の便の前後を添える
    expect(rows[1].textContent).toContain('駅前 → 病院前')
    expect(within(rows[1]).getByText('帰りの便がない')).toBeTruthy()
    expect(within(rows[1]).getByText('始発が 40 分遅くなる')).toBeTruthy()
    expect(rows[1].textContent).toContain('便数 2 → 1 便・始発 06:50 → 07:30・終発 07:30 → 07:30')
    expect(rows[1].textContent).toContain('帰り(病院前 → 駅前)の15〜21時の便:2 → 0 便')
    // 3. 終発が早まる(名前が同じで stop_id が違う停留所も、同じ系統の往復とみなす)
    expect(rows[2].textContent).toContain('高校線')
    expect(rows[2].textContent).toContain('団地 → 高校前')
    expect(within(rows[2]).getByText('終発が 840 分早まる')).toBeTruthy()

    const text = panel().textContent ?? ''
    expect(text).toContain('2026年11月4日(水)の減便前と減便後を、系統の方向(始発 → 終着)ごとに比べました。')
    expect(screen.getByLabelText('往復の問題の数').textContent).toBe('方向の便がなくなる 1・帰りの便がない 1・終発が早まる 1・始発が遅くなる 1')
    // 片道の温泉線は数だけ
    expect(text).toContain('循環・片道のため往復を確かめていない系統:1')
    expect(text).not.toContain('温泉線')
    expect(text).toContain('「帰りの便がない」は、減便後に行きの方向に6〜9時の便があり、逆向きの15〜21時の便が 0 便になる方向です')
  })

  it('下書きと比べているときは、下書きの名前を添える', () => {
    renderPanel({ draftLabel: '下書き #2' })
    expect(panel().textContent).toContain('減便前と減便後(下書き #2)を')
  })

  it('行の「候補を開く」で、その系統を開く。平日に戻す候補が無い系統には出さない', () => {
    const onOpenRoute = vi.fn()
    renderPanel({ onOpenRoute, openable: ['R1'] })
    const rows = problemRows()
    fireEvent.click(within(rows[0]).getByRole('button', { name: '系統 病院線 の平日に戻す候補を開く(病院前 → 駅 前)' }))
    expect(onOpenRoute).toHaveBeenCalledWith('R1')
    expect(within(rows[2]).queryByRole('button', { name: /候補を開く/ })).toBeNull()
  })

  it('帰りの便がないだけの方向で、逆向きがほかの系統にあるときは、帰りの系統の候補を開く', () => {
    // O1 は 駅前 → 病院前 の朝の便だけ、O2 は 病院前 → 駅前 の夕方の便だけ(O2 の便が減便でなくなる)
    const trips: TripSpec[] = [
      ['O1', 'o1a', 'W', 'A1', 'B', '07:00'],
      ['O1', 'o1b', 'W', 'A1', 'B', '12:00'],
      ['O2', 'o2a', 'W', 'B', 'A1', '17:00'],
      ['O2', 'o2b', 'W', 'B', 'A1', '12:00'],
    ]
    const onOpenRoute = vi.fn()
    render(
      <RoundTripPanel
        base={feedOf(trips)}
        edited={feedOf(trips.filter(([, t]) => t !== 'o2a'))}
        weekdayServices={new Set(['W'])}
        date={DATE}
        draftLabel={null}
        openable={new Set(['O1', 'O2'])}
        onOpenRoute={onOpenRoute}
      />,
    )
    const row = problemRows().find((r) => r.textContent?.includes('帰りの便がない'))!
    fireEvent.click(within(row).getByRole('button', { name: '系統 O2 の平日に戻す候補を開く(駅前 → 病院前)' }))
    expect(onOpenRoute).toHaveBeenCalledWith('O2')
  })

  it('問題のない方向は、ボタンで開いたときだけ出す', () => {
    renderPanel()
    expect(panel().textContent).not.toContain('市役所線')
    fireEvent.click(screen.getByRole('button', { name: '問題のない方向も見る(3 方向)' }))
    const others = within(screen.getByRole('list', { name: '問題のない方向' })).getAllByRole('listitem')
    expect(others.map((li) => li.textContent?.split('便数')[0])).toEqual(['高校線高校前 → 団地', '市役所線公園 → 市役所', '市役所線市役所 → 公園'])
  })

  it('問題のある方向が多いときは、最初の 3 件だけを出し、残りは「さらに表示」で出す', () => {
    // 10 系統の往復の、帰りの方向がすべてなくなる
    const many: TripSpec[] = []
    for (let i = 0; i < 10; i++) {
      many.push([`M${i}`, `m${i}a`, 'W', 'A1', 'B', '07:00'], [`M${i}`, `m${i}b`, 'W', 'B', 'A1', '17:00'])
    }
    const manyBase = feedOf(many)
    const manyEdited = feedOf(many.filter(([, t]) => t.endsWith('a')))
    render(
      <RoundTripPanel base={manyBase} edited={manyEdited} weekdayServices={new Set(['W'])} date={DATE} draftLabel={null} openable={new Set()} onOpenRoute={() => {}} />,
    )
    // 方向の便がなくなる 10 件と、帰りの便がない 10 件 → 20 行
    expect(problemRows()).toHaveLength(3)
    fireEvent.click(screen.getByRole('button', { name: 'さらに表示(残り 17 件)' }))
    expect(problemRows()).toHaveLength(20)
    expect(problemRows()[9].textContent).toContain('方向の便がなくなる')
    expect(problemRows()[10].textContent).toContain('帰りの便がない')
  })

  it('減便前と減便後が同じなら、問題のある方向はないと出す', () => {
    renderPanel({ editedFeed: base })
    expect(panel().textContent).toContain('問題のある方向はありません。')
  })
})
