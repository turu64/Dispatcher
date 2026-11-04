// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { facilityWindows } from '@/gtfs/edit/facilityHours'
import type { HintFacility } from '@/gtfs/edit/restore'
import type { GtfsFeed, GtfsRow } from '@/gtfs/load'
import { toStops } from '@/gtfs/parse'
import { FacilityAccessPanel } from './FacilityAccessPanel'

// 比較する日付は 2026-11-04(水)。W は平日、S は土曜の service
const DATE = '20261104'
const SATURDAY = '20261107'

// 停留所:駅前(A)と、高校前(B。北高校の近く)、病院前(C。市立病院の近く)
const STOPS = [
  { stop_id: 'A', stop_name: '駅前', stop_lat: '44.350', stop_lon: '142.460' },
  { stop_id: 'B', stop_name: '高校前', stop_lat: '44.360', stop_lon: '142.460' },
  { stop_id: 'C', stop_name: '病院前', stop_lat: '44.370', stop_lon: '142.460' },
]

/** 便:[trip_id, service_id, [[stop_id, 'HH:MM'], ...]] */
type TripSpec = [trip: string, service: string, stops: [string, string][]]

function feedOf(trips: TripSpec[]): GtfsFeed {
  const tables: Record<string, GtfsRow[]> = {
    routes: [{ route_id: 'R1', route_long_name: '高校線', route_type: '3' }],
    stops: STOPS,
    calendar: [
      { service_id: 'W', monday: '1', tuesday: '1', wednesday: '1', thursday: '1', friday: '1', saturday: '0', sunday: '0', start_date: '20261001', end_date: '20270331' },
      { service_id: 'S', monday: '0', tuesday: '0', wednesday: '0', thursday: '0', friday: '0', saturday: '1', sunday: '0', start_date: '20261001', end_date: '20270331' },
    ],
    trips: trips.map(([trip, service]) => ({ route_id: 'R1', trip_id: trip, service_id: service })),
    stop_times: trips.flatMap(([trip, , stops]) =>
      stops.map(([stop, time], i) => ({ trip_id: trip, stop_id: stop, stop_sequence: String(i + 1), arrival_time: `${time}:00`, departure_time: `${time}:00` })),
    ),
  }
  return {
    tables: new Map(Object.entries(tables).map(([name, rows]) => [name, { fileName: `${name}.txt`, fields: Object.keys(rows[0] ?? {}), rows }])),
    warnings: [],
  }
}

// 減便前:駅前 07:20 → 高校前 07:40 → 病院前 08:00(朝)、病院前 15:00 → 高校前 15:20 → 駅前 15:40(帰り)
// 減便後:朝の便がなくなり、帰りの便だけが残る
const MORNING: TripSpec = ['w1', 'W', [['A', '07:20'], ['B', '07:40'], ['C', '08:00']]]
const AFTERNOON: TripSpec = ['w2', 'W', [['C', '15:00'], ['B', '15:20'], ['A', '15:40']]]
const base = feedOf([MORNING, AFTERNOON, ['s1', 'S', [['A', '10:00'], ['C', '10:40']]]])
const edited = feedOf([AFTERNOON, ['s1', 'S', [['A', '10:00'], ['C', '10:40']]]])
const stops = toStops(base).stops

function facility(o: Partial<HintFacility> & Pick<HintFacility, 'targetId' | 'name' | 'kind' | 'lat' | 'lon'>): HintFacility {
  return {
    categoryLabel: o.kind === 'school' ? '高校・特別支援学校' : '入院設備のある病院',
    rank: o.kind === 'school' ? 3 : 1,
    radiusM: 400,
    windows: facilityWindows(o.kind, []),
    longBreaks: [],
    ...o,
  }
}

// 北高校は高校前の 110m ほど北。始業 8:40 を調べた結果の窓(7:40〜8:40)にする
const school = facility({
  targetId: 'P29:北高校',
  name: '北高校',
  kind: 'school',
  lat: 44.361,
  lon: 142.46,
  windows: { ...facilityWindows('school', []), arrive: { from: 7 * 60 + 40, to: 8 * 60 + 40, source: 'research', basis: '始業 8:40' } },
})
// 市立病院は病院前のすぐ近く。既定の窓(8〜11時着・11〜16時発)
const hospital = facility({ targetId: 'P04:市立病院', name: '市立病院', kind: 'hospital', lat: 44.3705, lon: 142.46 })
// 遠い施設(徒歩圏に停留所が無い)
const far = facility({ targetId: 'P29:遠い高校', name: '遠い高校', kind: 'school', lat: 44.5, lon: 142.46 })

function renderPanel(o: { date?: string | null; facilities?: HintFacility[] | null; unavailable?: string | null; draftLabel?: string | null } = {}) {
  return render(
    <FacilityAccessPanel
      base={base}
      edited={edited}
      weekdayServices={new Set(['W'])}
      date={o.date === undefined ? DATE : o.date}
      draftLabel={o.draftLabel ?? null}
      facilities={o.facilities === undefined ? [school, hospital, far] : o.facilities}
      unavailable={o.unavailable ?? null}
      stops={stops}
    />,
  )
}

const panel = () => screen.getByRole('region', { name: '学校・病院に着く便の確認' })
const rows = () => within(screen.getByRole('list', { name: '着く便・出る便がなくなる学校・病院' })).getAllByRole('listitem')

afterEach(() => {
  cleanup()
})

describe('FacilityAccessPanel', () => {
  it('施設を読めていないときは、理由を出す', () => {
    renderPanel({ facilities: null, unavailable: '手順「前提情報」で学校・病院を読み込むと、施設ごとに確かめます。' })
    expect(panel().textContent).toContain('手順「前提情報」で学校・病院を読み込むと、施設ごとに確かめます。')
    expect(screen.queryByRole('list')).toBeNull()
  })

  it('比較する日付が無いときと、平日ダイヤが走らないときは、確かめていない理由を出す', () => {
    renderPanel({ date: null })
    expect(panel().textContent).toContain('学校・病院に着く便は、地図の下の操作盤で比較する日付を選ぶと確かめます。')
    cleanup()
    renderPanel({ date: SATURDAY })
    expect(panel().textContent).toContain(
      '比較する日付(2026年11月7日(土))は平日ダイヤの運行日ではないため、学校・病院に着く便は確かめていません。比較する日付を、地図の下の操作盤で平日にすると確かめます。',
    )
    expect(screen.queryByRole('list')).toBeNull()
  })

  it('着く便か出る便が 0 便になる施設だけを、優先順位の順に、窓と出どころ・前後の便数・最も遅く着く時刻つきで出す', () => {
    renderPanel()
    const text = panel().textContent ?? ''
    expect(text).toContain('2026年11月4日(水)の減便前と減便後で、徒歩圏に停留所がある学校・病院 2 施設のうち、着く便がなくなる施設 2・出る便がなくなる施設 0。')
    const list = rows()
    // 病院(優先順位 1)が先、高校(3)が後
    expect(list).toHaveLength(2)
    expect(list[0].textContent).toContain('市立病院入院設備のある病院')
    expect(within(list[0]).getByText('着く便がなくなる')).toBeTruthy()
    expect(within(list[0]).queryByText('出る便がなくなる')).toBeNull()
    expect(list[0].textContent).toContain('着く 8:00〜11:00(既定):1 → 0 便・最も遅く着く時刻 08:00 → —')
    expect(list[0].textContent).toContain('出る 11:00〜16:00(既定):1 → 1 便・最も早く出る時刻 15:00 → 15:00')
    expect(list[0].textContent).toContain('最寄りの停留所:病院前(56m)')
    expect(list[1].textContent).toContain('北高校高校・特別支援学校')
    expect(list[1].textContent).toContain('着く 7:40〜8:40(調べた結果:始業 8:40):1 → 0 便・最も遅く着く時刻 07:40 → —')
    // 徒歩圏に停留所が無い施設は数だけ
    expect(text).toContain('徒歩圏に、この日に乗り降りする停留所がない学校・病院:1 施設')
    expect(text).not.toContain('遠い高校')
    // 数え方の注意(窓は目安で、乗り継ぎ・混み具合は見ない)
    expect(text).toContain('乗り継ぎと混み具合は見ていません。')
  })

  it('下書きと比べているときは、下書きの名前を添える。問題の施設が無ければ、そう出す', () => {
    renderPanel({ draftLabel: '下書き #3', facilities: [far] })
    expect(panel().textContent).toContain('減便前と減便後(下書き #3)で、徒歩圏に停留所がある学校・病院 0 施設のうち')
    expect(panel().textContent).toContain('着く便・出る便が 0 便になる学校・病院はありません。')
  })

  it('施設が多いときは、最初の 3 件だけを出し、残りは「さらに表示」で出す', () => {
    const many = Array.from({ length: 7 }, (_, i) => facility({ targetId: `P04:病院${i}`, name: `病院${i}`, kind: 'hospital', lat: 44.3705, lon: 142.46 }))
    renderPanel({ facilities: many })
    expect(rows()).toHaveLength(3)
    fireEvent.click(screen.getByRole('button', { name: 'さらに表示(残り 4 件)' }))
    expect(rows()).toHaveLength(7)
  })
})
