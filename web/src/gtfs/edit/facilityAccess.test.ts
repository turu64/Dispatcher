import { describe, expect, it } from 'vitest'
import type { GtfsFeed } from '../load'
import { toStops } from '../parse'
import { distanceM } from '../../reach/mesh'
import { FACILITY_ACCESS_NO_TRIPS, FACILITY_ACCESS_NOTE, facilityAccess } from './facilityAccess'
import { defaultFacilityWindows, hospitalWindows } from './facilityHours'
import { feedOf, rowsOf } from './form2.fixture'
import type { HintFacility } from './restore'

// 停留所(北へ並べる。徒歩圏は 400m):
// - X 遠い停留所 (43.76, 142.36)
// - H 病院前:X の北 2km。H2 病院前2:H の北 150m
// - S 学校前:H の北 1.5km。Y 学校裏:S の北 150m(どの便も乗り降りできない。通過だけ)
// 施設:名寄病院(H の南 100m。窓はデモの調べた結果の名寄市立総合病院の受付時間から決める)、学校前高校(S の北 100m。既定の窓)、
// 遠い中学校(X の南 3km。徒歩圏に停留所が無い)
// service:WK(月〜金、20261001〜20261130)。比較する日付 20261104 は水曜日、20261107 は土曜日

const ORIGIN = { lat: 43.76, lon: 142.36 }

/** 点 p から北へ約 m メートルの点 */
function north(p: { lat: number; lon: number }, m: number) {
  return { lat: p.lat + m / 111_000, lon: p.lon }
}

const PLACES = {
  X: ORIGIN,
  H: north(ORIGIN, 2000),
  H2: north(ORIGIN, 2150),
  S: north(ORIGIN, 3500),
  Y: north(ORIGIN, 3650),
}

const DATE = '20261104'

/**
 * data/demo/research_dohoku.json の名寄市立総合病院(P04:0efb2a9b53f0)の外来受付時間を写した事実。
 * 窓は、着く 7:30〜11:30、出る 11:30〜17:15(facilityHours.ts の hospitalWindows)
 */
const NAYORO_FACTS = [
  {
    label: '外来受付時間',
    value: '〔午前〕8：00～11：30 〔午後〕13：00～15：15（公式ページ記載。診療可能日は診療科によって異なる）',
    url: 'https://www.nayoroch.jp/hotnews/detail/00000128.html',
  },
  { label: '休診日', value: '土曜・日曜・祝日は休診(旧版の受付案内PDF・第三者サイトの記載。最新の公式記載は未確認)', url: null },
]

function facility(o: Partial<HintFacility> & Pick<HintFacility, 'targetId' | 'lat' | 'lon'>): HintFacility {
  const kind = o.kind ?? 'school'
  return { name: o.targetId, kind, categoryLabel: '高校・特別支援学校', rank: 3, radiusM: 400, windows: defaultFacilityWindows(kind), longBreaks: [], ...o }
}

const HOSPITAL = facility({
  targetId: 'P04:名寄病院',
  name: '名寄病院',
  kind: 'hospital',
  categoryLabel: '入院設備のある病院',
  rank: 1,
  windows: hospitalWindows(NAYORO_FACTS),
  ...north(PLACES.H, -100),
})
const SCHOOL = facility({ targetId: 'P29:高校', name: '学校前高校', ...north(PLACES.S, 100) })
const FAR = facility({ targetId: 'P29:中学', name: '遠い中学校', categoryLabel: '中学校', rank: 8, ...north(ORIGIN, -3000) })

const STOPS_CSV = ['stop_id,stop_name,stop_lat,stop_lon', ...Object.entries(PLACES).map(([id, p]) => `${id},停留所${id},${p.lat},${p.lon}`)].join('\n')

const CALENDAR = rowsOf(`service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date
WK,1,1,1,1,1,0,0,20261001,20261130`)

/** trips と stop_times(行は「trip_id,stop_id,時刻,stop_sequence[,pickup_type,drop_off_type]」) */
function feedWith(trips: string[], stopTimes: string[]): GtfsFeed {
  return feedOf(
    {
      stops: rowsOf(STOPS_CSV),
      routes: rowsOf('route_id,route_short_name,route_type\nR1,1,3'),
      calendar: CALENDAR,
      trips: rowsOf(['route_id,service_id,trip_id', ...trips.map((t) => `R1,WK,${t}`)].join('\n')),
      stop_times: rowsOf(
        [
          'trip_id,arrival_time,departure_time,stop_id,stop_sequence,pickup_type,drop_off_type',
          ...stopTimes.map((line) => {
            const [trip, stop, time, seq, pickup = '', dropOff = ''] = line.split(',')
            return `${trip},${time},${time},${stop},${seq},${pickup},${dropOff}`
          }),
        ].join('\n'),
      ),
    },
    { stop_times: ['trip_id', 'arrival_time', 'departure_time', 'stop_id', 'stop_sequence', 'pickup_type', 'drop_off_type'] },
  )
}

// 減便前
// - T1:X 07:00 → H 07:50 → S 08:10(終点)。病院に着く 07:50、学校に着く 08:10
// - T2:X 10:30 → H 11:00 → H2 11:05 → X 11:40。病院の徒歩圏の2つの停留所に着くが、1便と数える(最も遅く着くのは 11:05)
// - T3:H 12:00 → X 12:30。病院から出る 12:00(最初の行なので、H では降りられない)
// - T4:S 15:00 → X 15:30。学校から出る 15:00
// - T5:X 07:20 → Y 07:50(乗り降りできない)→ X 08:30。学校の徒歩圏の Y は数えない
// - T6:H 08:00 → X 08:30。最初の行なので病院に着く便には数えない
const BASE = feedWith(
  ['T1', 'T2', 'T3', 'T4', 'T5', 'T6'],
  [
    'T1,X,07:00:00,1',
    'T1,H,07:50:00,2',
    'T1,S,08:10:00,3',
    'T2,X,10:30:00,1',
    'T2,H,11:00:00,2',
    'T2,H2,11:05:00,3',
    'T2,X,11:40:00,4',
    'T3,H,12:00:00,1',
    'T3,X,12:30:00,2',
    'T4,S,15:00:00,1',
    'T4,X,15:30:00,2',
    'T5,X,07:20:00,1',
    'T5,Y,07:50:00,2,1,1',
    'T5,X,08:30:00,3',
    'T6,H,08:00:00,1',
    'T6,X,08:30:00,2',
  ],
)

// 減便後:T3 と T6 は残り、T7(X 08:30 → H 09:00)が加わる。学校の便(T1・T4)はなくなる
const EDITED = feedWith(
  ['T3', 'T6', 'T7'],
  ['T3,H,12:00:00,1', 'T3,X,12:30:00,2', 'T6,H,08:00:00,1', 'T6,X,08:30:00,2', 'T7,X,08:30:00,1', 'T7,H,09:00:00,2'],
)

const STOPS = toStops(BASE).stops

describe('facilityAccess(学校・病院の窓に着く便・出る便の前後)', () => {
  const result = facilityAccess(BASE, EDITED, DATE, [SCHOOL, FAR, HOSPITAL], STOPS)

  it('施設を優先順位・距離の順に並べ、徒歩圏に停留所が無い施設は withoutStops に入れる', () => {
    expect(result.reason).toBeNull()
    expect(result.facilities.map((f) => f.targetId)).toEqual(['P04:名寄病院', 'P29:高校'])
    expect(result.withoutStops).toEqual([{ targetId: 'P29:中学', name: '遠い中学校', kind: 'school', categoryLabel: '中学校', rank: 8 }])
    expect(result.note).toBe(FACILITY_ACCESS_NOTE)
    expect(result.note).toContain('乗り継ぎと混み具合は見ていません')
  })

  it('調べた窓の病院:窓と出どころを返し、徒歩圏の2つの停留所に着く便は1便と数える。最初の行では降りられない', () => {
    const h = result.facilities[0]
    expect(h.stops.map((s) => s.stopId)).toEqual(['H', 'H2'])
    expect(h.distanceM).toBe(Math.round(distanceM(PLACES.H, HOSPITAL)))
    expect(h.arrive).toMatchObject({
      timing: 'arrive',
      from: '7:30',
      to: '11:30',
      source: 'research',
      basis: '外来の受付 8:00〜11:30・13:00〜15:15',
      url: 'https://www.nayoroch.jp/hotnews/detail/00000128.html',
      // T1(07:50)・T2(11:00 と 11:05)。T6 は H が最初の行なので数えない
      before: { trips: 2, time: '11:05' },
      // T7(09:00)
      after: { trips: 1, time: '09:00' },
    })
    expect(h.depart).toMatchObject({
      from: '11:30',
      to: '17:15',
      source: 'research',
      // T3(12:00)。T2 は H2 から 11:05 に出るが窓の前
      before: { trips: 1, time: '12:00' },
      after: { trips: 1, time: '12:00' },
    })
    expect(h.problems).toEqual([])
  })

  it('既定の窓の学校:着く便と出る便がなくなれば arriveLost・departLost。乗り降りできない停留所は徒歩圏に数えない', () => {
    const s = result.facilities[1]
    expect(s.stops.map((x) => x.stopId)).toEqual(['S'])
    expect(s.arrive).toMatchObject({ from: '7:00', to: '9:00', source: 'default', basis: null, url: null })
    expect(s.arrive.before).toEqual({ trips: 1, time: '08:10' })
    expect(s.arrive.after).toEqual({ trips: 0, time: null })
    expect(s.depart).toMatchObject({ from: '14:00', to: '18:00', source: 'default' })
    expect(s.depart.before).toEqual({ trips: 1, time: '15:00' })
    expect(s.depart.after).toEqual({ trips: 0, time: null })
    expect(s.problems).toEqual(['arriveLost', 'departLost'])
    expect(result.counts).toEqual({ arriveLost: 1, departLost: 1 })
  })

  it('窓は終わりを含まない:窓の終わりちょうどに着く便は数えない', () => {
    const tight = facility({
      ...SCHOOL,
      targetId: 'P29:窓',
      windows: { ...defaultFacilityWindows('school'), arrive: { from: 7 * 60, to: 8 * 60 + 10, source: 'default' } },
    })
    const r = facilityAccess(BASE, EDITED, DATE, [tight], STOPS)
    expect(r.facilities[0].arrive.before).toEqual({ trips: 0, time: null })
    expect(r.facilities[0].problems).toEqual(['departLost'])
  })

  it('比較する日付に減便前の便が走らなければ、理由つきの空の結果を返す', () => {
    const r = facilityAccess(BASE, EDITED, '20261107', [SCHOOL, HOSPITAL], STOPS)
    expect(r).toEqual({
      date: '20261107',
      facilities: [],
      withoutStops: [],
      counts: { arriveLost: 0, departLost: 0 },
      reason: FACILITY_ACCESS_NO_TRIPS,
      note: FACILITY_ACCESS_NOTE,
    })
  })

  it('徒歩圏の半径が読めない施設は withoutStops に入れる', () => {
    const broken = facility({ ...SCHOOL, targetId: 'P29:半径', radiusM: Number.NaN })
    const r = facilityAccess(BASE, EDITED, DATE, [broken], STOPS)
    expect(r.facilities).toEqual([])
    expect(r.withoutStops.map((f) => f.targetId)).toEqual(['P29:半径'])
  })
})
