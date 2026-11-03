import { describe, expect, it } from 'vitest'
import { applyForm2 } from './form2'
import { AGENCY, basePlan, CALENDAR, feedOf, ROUTES, rowsOf, smallFeed } from './form2.fixture'
import type { GtfsFeed } from '../load'
import {
  alternativesFor,
  buildAnnouncement,
  buildStopNotice,
  buildStopNotices,
  distanceM,
  excludedAtStop,
  NOTICE_DISCLAIMER,
  pickNoticeDate,
  schoolTripIdsOf,
  segmentsOf,
  stopCoordinates,
  underLeadTime,
  type AnnouncementInput,
  type StopNotice,
} from './notice'
import type { EditRecord } from './ops'
import { stopDiff, type StopDeparture } from './stopDiff'

function dep(time: string, tripId = time, routeId = 'R1'): StopDeparture {
  const [h, m] = time.split(':').map(Number)
  return { routeId, tripId, seconds: h * 3600 + m * 60, time, headsign: '市役所' }
}

describe('segmentsOf(頻繁な系統は始発・終発と間隔)', () => {
  it('隣り合う発車が15分以内で5本以上続く区間は間隔でまとめ、前後の発車は1本ずつ載せる', () => {
    const times = ['06:00', '07:00', '07:10', '07:20', '07:30', '07:40', '07:50', '08:00', '12:00']
    const segs = segmentsOf(times.map((t) => dep(t)), new Set())
    expect(segs.map((s) => s.kind)).toEqual(['single', 'interval', 'single'])
    const interval = segs[1]
    if (interval.kind !== 'interval') throw new Error('間隔の区間ではありません')
    expect(interval).toMatchObject({ first: '07:00', last: '08:00', count: 7, minGapMin: 10, maxGapMin: 10 })
    // 区間の前後の発車は個別の時刻
    expect(segs[0]).toMatchObject({ kind: 'single', time: '06:00' })
    expect(segs[2]).toMatchObject({ kind: 'single', time: '12:00' })
  })

  it('間隔が混ざるときは、最小〜最大の間隔を出す', () => {
    const segs = segmentsOf(['07:00', '07:10', '07:25', '07:40', '07:50'].map((t) => dep(t)), new Set())
    expect(segs).toHaveLength(1)
    expect(segs[0]).toMatchObject({ kind: 'interval', count: 5, minGapMin: 10, maxGapMin: 15 })
  })

  it('1時間に4本に満たない系統(間隔が15分を超える、または5本に満たない)は1本ずつ載せる', () => {
    expect(segmentsOf(['07:00', '07:20', '07:40', '08:00', '08:20'].map((t) => dep(t)), new Set()).every((s) => s.kind === 'single')).toBe(true)
    expect(segmentsOf(['07:00', '07:10', '07:20', '07:30'].map((t) => dep(t)), new Set()).every((s) => s.kind === 'single')).toBe(true)
  })

  it('混む時間の区間だけを間隔にし、空いた夕方の便まで間隔で言い切らない', () => {
    const times = ['07:00', '07:10', '07:20', '07:30', '07:40', '07:50', '16:00', '18:30']
    const segs = segmentsOf(times.map((t) => dep(t)), new Set())
    expect(segs.map((s) => s.kind)).toEqual(['interval', 'single', 'single'])
  })

  it('(学)の便は間隔に混ぜず、印を付けて1本ずつ載せる', () => {
    const times = ['07:00', '07:10', '07:20', '07:30', '07:40', '07:50']
    const segs = segmentsOf(times.map((t) => dep(t)), new Set(['07:30']))
    const school = segs.filter((s) => s.kind === 'single' && s.school)
    expect(school).toHaveLength(1)
    expect(school[0]).toMatchObject({ time: '07:30', school: true })
    // 残る5本は 07:30 を抜いた間隔(20分)が15分を超えるので間隔にはならない
    expect(segs.filter((s) => s.kind === 'interval')).toHaveLength(0)
  })

  it('24時を超える時刻をそのまま扱う', () => {
    const segs = segmentsOf([dep('23:30'), dep('24:40')], new Set())
    expect(segs.map((s) => (s.kind === 'single' ? s.time : ''))).toEqual(['23:30', '24:40'])
  })
})

// 20261104(水)。平日を土曜ダイヤに:A は R1 07:00・08:05、R2 10:00 に。S9 は発車が無くなる
function setup() {
  const base = smallFeed()
  const outcome = applyForm2(base, basePlan(), { generatedAt: '202611041200' })
  if (!outcome.ok) throw new Error(outcome.message)
  return { base, result: outcome.result }
}

describe('buildStopNotices(stop_id で照合し、期間中の発車を系統ごとに)', () => {
  it('停留所ごとに、編集後の系統ごとの発車時刻と、無くなる発車を出す', () => {
    const { base, result } = setup()
    const notices = buildStopNotices(base, result.feed, '20261104', new Set())
    const a = notices.stops.find((s) => s.stopId === 'A')!
    expect(a.stopName).toBe('駅前')
    expect(a.beforeCount).toBe(4)
    expect(a.count).toBe(3)
    expect(a.needsRepost).toBe(true)
    expect(a.lines.map((l) => [l.routeName, l.segments.map((s) => (s.kind === 'single' ? s.time : ''))])).toEqual([
      ['1', ['07:00', '08:05']],
      ['2', ['10:00']],
    ])
    // 無くなる発車:R3 07:30 と R2 09:00(R1 08:00 は R1 08:05 に変わる)
    expect(a.removedLines.map((l) => [l.routeName, l.times])).toContainEqual(['3', ['07:30']])
    expect(a.removedLines.map((l) => [l.routeName, l.times])).toContainEqual(['2', ['09:00']])
    expect(a.lat).toBeCloseTo(43.76)
  })

  it('停留所を stop_id で選ぶ:同じ名前の別の停留所を取り違えない', () => {
    const base = smallFeed()
    const stops = base.tables.get('stops')!
    const dup: GtfsFeed = {
      ...base,
      tables: new Map(base.tables).set('stops', {
        ...stops,
        rows: stops.rows.map((r) => (r.stop_id === 'B' ? { ...r, stop_name: '駅前' } : r)),
      }),
    }
    const outcome = applyForm2(dup, basePlan(), { generatedAt: '202611041200' })
    if (!outcome.ok) throw new Error(outcome.message)
    const notices = buildStopNotices(dup, outcome.result.feed, '20261104', new Set())
    // B にも発車がある(R1 の終点以外では発車しない)ので、A だけを名前でなく stop_id で引ける
    const a = notices.stops.find((s) => s.stopId === 'A')!
    expect(a.stopName).toBe('駅前')
    expect(a.lat).toBeCloseTo(43.76)
    expect(a.lines.length).toBeGreaterThan(0)
    // C(病院前)は R1 08:00(C→B)の発車だけ。名前の同じ停留所があっても混ざらない
    expect(notices.stops.find((s) => s.stopId === 'C')!.lines.map((l) => l.routeName)).toEqual(['1'])
  })

  it('期間中に発車が無くなる停留所は losesAll で、掲示の行が無い', () => {
    const { base, result } = setup()
    const s9 = buildStopNotices(base, result.feed, '20261104', new Set()).stops.find((s) => s.stopId === 'S9')!
    expect(s9.losesAll).toBe(true)
    expect(s9.lines).toEqual([])
    expect(s9.removedLines.map((l) => l.times)).toEqual([['07:40']])
  })

  it('(学)の便には印を付ける:足し戻した便は基準の trip_id のまま編集後に入る', () => {
    const base = smallFeed()
    const outcome = applyForm2(base, basePlan({ addBackTripIds: ['R3_0730_WK'] }), { generatedAt: '202611041200' })
    if (!outcome.ok) throw new Error(outcome.message)
    const history: EditRecord[] = [
      { op: { type: 'applyPolicy', settings: { ...basePlan() }, reason: { category: null, note: '' } }, by: 'user', at: 'x' },
      { op: { type: 'addBack', items: [{ tripId: 'R3_0730_WK', reason: '通学', schoolDaysOnly: true }] }, by: 'user', at: 'x' },
    ]
    const school = schoolTripIdsOf(history, outcome.result.report.addBack.accepted)
    expect([...school]).toEqual(['R3_0730_WK'])
    const s9 = buildStopNotices(base, outcome.result.feed, '20261104', school).stops.find((s) => s.stopId === 'S9')!
    expect(s9.lines).toHaveLength(1)
    expect(s9.lines[0].schoolCount).toBe(1)
    expect(s9.lines[0].segments[0]).toMatchObject({ kind: 'single', time: '07:40', school: true })
    expect(s9.losesAll).toBe(false)
  })

  it('足し戻されなかった便の(学)の印は数えない', () => {
    const history: EditRecord[] = [
      { op: { type: 'applyPolicy', settings: { ...basePlan() }, reason: { category: null, note: '' } }, by: 'user', at: 'x' },
      { op: { type: 'addBack', items: [{ tripId: 'R3_0730_WK', reason: '', schoolDaysOnly: true }] }, by: 'user', at: 'x' },
    ]
    expect(schoolTripIdsOf(history, []).size).toBe(0)
  })
})

describe('pickNoticeDate', () => {
  it('期間の中で、基準の平日 service が走る最初の日(祝日などの運休日を飛ばす)', () => {
    const base = smallFeed()
    // 20261101 は日曜、20261102(月)は平日、20261103(火)は WK の運休
    expect(pickNoticeDate(base, basePlan(), { start: '20261101', end: '20261130' })).toBe('20261102')
    expect(pickNoticeDate(base, basePlan(), { start: '20261103', end: '20261130' })).toBe('20261104')
    expect(pickNoticeDate(base, basePlan(), { start: '20261107', end: '20261108' })).toBeNull()
    expect(pickNoticeDate(base, { weekdayService: 'NONE' }, { start: '20261101', end: '20261130' })).toBeNull()
  })
})

// 座標を持つ小さなフィード:A(駅前)と A2(約 120 m)、A3(約 600 m)。平日は R1 が A に 2 本、A2 に 1 本
function nearFeed(): GtfsFeed {
  return feedOf({
    agency: rowsOf(AGENCY),
    routes: rowsOf(ROUTES),
    stops: rowsOf(`
stop_id,stop_name,stop_lat,stop_lon
A,駅前,43.7600,142.3600
A2,駅前北,43.7611,142.3600
A3,遠い所,43.7660,142.3600
Z,終点,43.7800,142.4000`),
    calendar: rowsOf(CALENDAR),
    trips: rowsOf(`
route_id,service_id,trip_id,trip_headsign
R1,WK,W1,終点
R1,WK,W2,終点
R2,WK,W3,終点
R1,SA,S1,終点
R2,SA,S2,終点
R2,SA,S3,終点`),
    stop_times: rowsOf(`
trip_id,arrival_time,departure_time,stop_id,stop_sequence
W1,07:00:00,07:00:00,A,1
W1,07:30:00,07:30:00,Z,2
W2,08:00:00,08:00:00,A,1
W2,08:30:00,08:30:00,Z,2
W3,09:00:00,09:00:00,A2,1
W3,09:30:00,09:30:00,Z,2
S1,07:00:00,07:00:00,A2,1
S1,07:30:00,07:30:00,Z,2
S2,10:00:00,10:00:00,A3,1
S2,10:30:00,10:30:00,Z,2
S3,11:00:00,11:00:00,A3,1
S3,11:30:00,11:30:00,Z,2`),
  })
}

describe('alternativesFor(同じ停留所と、半径 300 m 以内に残る自社の便)', () => {
  function notices(): { all: StopNotice[]; byId: (id: string) => StopNotice } {
    const base = nearFeed()
    const outcome = applyForm2(
      base,
      basePlan({ replacementService: 'SA' }),
      { generatedAt: '202611041200' },
    )
    if (!outcome.ok) throw new Error(outcome.message)
    const all = buildStopNotices(base, outcome.result.feed, '20261104', new Set()).stops
    return { all, byId: (id) => all.find((s) => s.stopId === id)! }
  }

  it('駅前(A)は発車が無くなり、約 120 m の駅前北(A2)に残る便を案内する。600 m の A3 は入れない', () => {
    const { all, byId } = notices()
    const a = byId('A')
    expect(a.losesAll).toBe(true)
    const alt = alternativesFor(a, all)
    expect(alt.sameStop).toEqual([])
    expect(alt.nearby.map((n) => n.stopId)).toEqual(['A2'])
    expect(alt.nearby[0].distanceM).toBe(120)
    expect(alt.nearby[0].lines).toEqual([
      expect.objectContaining({ routeName: '1', count: 1, first: '07:00', last: '07:00' }),
    ])
    expect(alt.noCoordinates).toBe(false)
  })

  it('半径を変えると対象が変わる(600 m なら A3 も入り、近い順に並ぶ)', () => {
    const { all, byId } = notices()
    expect(alternativesFor(byId('A'), all, 700).nearby.map((n) => n.stopId)).toEqual(['A2', 'A3'])
    expect(alternativesFor(byId('A'), all, 100).nearby).toEqual([])
  })

  it('同じ停留所に残る便は sameStop に出る', () => {
    const { all, byId } = notices()
    const alt = alternativesFor(byId('A2'), all)
    expect(alt.sameStop).toHaveLength(1)
    expect(alt.sameStop[0]).toMatchObject({ routeName: '1', count: 1 })
  })

  it('座標が無い停留所は、近くの停留所を探さずにそのことを示す', () => {
    const { all, byId } = notices()
    const noCoord: StopNotice = { ...byId('A'), lat: null, lon: null }
    expect(alternativesFor(noCoord, all)).toMatchObject({ nearby: [], noCoordinates: true })
  })

  it('距離は 2 点の大圏距離(約 122 m)', () => {
    expect(distanceM({ lat: 43.76, lon: 142.36 }, { lat: 43.7611, lon: 142.36 })).toBeCloseTo(122.3, 0)
  })
})

describe('stopCoordinates', () => {
  it('読めない座標・範囲外の座標は入れない', () => {
    const feed = feedOf({
      stops: rowsOf(`
stop_id,stop_name,stop_lat,stop_lon
A,a,43.1,142.1
B,b,,142.1
C,c,x,142.1
D,d,91,142.1`),
    })
    expect([...stopCoordinates(feed).keys()]).toEqual(['A'])
  })
})

describe('underLeadTime(公示日から実施日まで7日を切るか)', () => {
  it('7日前なら切らない、6日前なら切る、同日・実施日が前なら切る', () => {
    expect(underLeadTime('20261101', '20261108')).toBe(false)
    expect(underLeadTime('20261102', '20261108')).toBe(true)
    expect(underLeadTime('20261108', '20261108')).toBe(true)
    expect(underLeadTime('20261110', '20261108')).toBe(true)
  })

  it('月をまたいでも日数で数える', () => {
    expect(underLeadTime('20261025', '20261101')).toBe(false)
    expect(underLeadTime('20261026', '20261101')).toBe(true)
  })

  it('日付が空・不正なら判定しない', () => {
    expect(underLeadTime('', '20261108')).toBeNull()
    expect(underLeadTime('20261101', '')).toBeNull()
    expect(underLeadTime('20261301', '20261108')).toBeNull()
  })
})

describe('buildAnnouncement(第17条の5項目)', () => {
  const input: AnnouncementInput = {
    agencyName: 'テストバス',
    effectiveDate: '20261101',
    periodEnd: '20261130',
    replacementLabel: '土曜',
    reasonLabel: '運転士の一時的な欠員',
    reasonNote: '病欠のため',
    weekdayBefore: 100,
    weekdayAfter: 70,
    removedTrips: 30,
    addedTrips: 0,
    addedBackTrips: 4,
    schoolTrips: 2,
    vanishingRoutes: ['旭川線'],
    excludedRouteNames: [],
    place: '',
    alternativesNote: '',
  }

  it('5項目を順に作り、実施日・理由・数字・復旧の見込みを入れる', () => {
    const items = buildAnnouncement(input)
    expect(items.map((i) => i.no)).toEqual([1, 2, 3, 4, 5])
    expect(items[0].text).toContain('2026年11月1日から')
    expect(items[1].text).toContain('運転士の一時的な欠員(病欠のため)のため')
    expect(items[1].text).toContain('100 便から 70 便(30 便減)になります')
    expect(items[1].text).toContain('平日ダイヤの時刻の 30 便は運休します。')
    expect(items[2].text).toContain('2026年11月30日までの予定')
    expect(items[2].text).toContain('2026年12月1日から元のダイヤに戻す予定')
    expect(items[3].text).toContain('4 便は平日の時刻のまま')
    expect(items[3].text).toContain('うち 2 便は学校の休業日は運休')
    expect(items[3].text).toContain('旭川線')
  })

  it('期間の終わりが無いときは「当面の間」。場所と代替手段が空なら記入を促し、自由記入があればそれを使う', () => {
    const open = buildAnnouncement({ ...input, periodEnd: null })
    expect(open[2].text).toContain('当面の間')
    expect(open[0].text).toContain('(ここに記入してください)')
    expect(open[4].text).toContain('(ここに記入してください)')
    const filled = buildAnnouncement({ ...input, place: '旭川市内の全停留所', alternativesNote: '市内循環バス(他社)' })
    expect(filled[0].text).toContain('旭川市内の全停留所')
    expect(filled[4].text).toBe('市内循環バス(他社)')
  })

  it('消える便と入る便がどちらもあるときは、正味の差と入れ替えの内訳を分けて書き、消える便の数を運休の総数と言わない', () => {
    // 道北バスの 9/17 版に main の方針を当てたときの数(removed 273・added 208・same 174)
    const items = buildAnnouncement({ ...input, weekdayBefore: 447, weekdayAfter: 382, removedTrips: 273, addedTrips: 208 })
    expect(items[1].text).toContain('447 便から 382 便(65 便減)になります。')
    expect(items[1].text).toContain('内訳は、平日ダイヤの時刻の 273 便は運休し、土曜ダイヤの時刻の 208 便を運行します。')
    expect(items[1].text).not.toContain('273 便が運休')
    // 便数が変わらない・増えるときも、減ると書かない
    expect(buildAnnouncement({ ...input, weekdayBefore: 10, weekdayAfter: 10, removedTrips: 3, addedTrips: 3 })[1].text).toContain('(便数は変わりません)')
    expect(buildAnnouncement({ ...input, weekdayBefore: 10, weekdayAfter: 12, removedTrips: 0, addedTrips: 2 })[1].text).toContain(
      '(2 便増)になります。土曜ダイヤの時刻の 2 便を運行します。',
    )
  })

  it('1項目めの見出しは利用者向けに「変更の日時・場所」とし、第17条の項目名(事故の日時・場所)は別に持つ', () => {
    const items = buildAnnouncement(input)
    expect(items[0].label).toBe('変更の日時・場所')
    expect(items[0].label).not.toContain('事故')
    expect(items[0].legalLabel).toBe('事故の日時・場所')
    // 見出しが第17条の項目名と同じ項目は、別の名前を持たない
    expect(items.slice(1).every((i) => i.legalLabel === undefined)).toBe(true)
  })

  it('除外した系統は、平日ダイヤのまま運行すると4項目めに書く。無ければ書かない', () => {
    const items = buildAnnouncement({ ...input, excludedRouteNames: ['留萌線', '深川線'] })
    expect(items[3].text).toContain('次の系統は平日ダイヤのまま運行します:留萌線、深川線。')
    expect(buildAnnouncement(input)[3].text).not.toContain('平日ダイヤのまま')
  })

  it('法定の様式ではない旨の注記を持つ', () => {
    expect(NOTICE_DISCLAIMER).toContain('法定の様式ではありません')
  })
})

describe('excludedAtStop(方針で除外した系統)', () => {
  // 学校線(R3)を除外:S9 は R3 だけが止まり、A は R1・R2・R3 が止まる
  function excludedSetup() {
    const base = smallFeed()
    const outcome = applyForm2(base, basePlan({ excludedRoutes: ['R3'] }), { generatedAt: '202611041200' })
    if (!outcome.ok) throw new Error(outcome.message)
    return buildStopNotices(base, outcome.result.feed, '20261104', new Set()).stops
  }

  it('除外した系統だけが止まる停留所は all。期間中も平日ダイヤの発車が残る', () => {
    const s9 = excludedSetup().find((s) => s.stopId === 'S9')
    if (!s9) throw new Error('S9 がありません')
    expect(s9.needsRepost).toBe(false)
    expect(s9.lines.map((l) => l.routeId)).toEqual(['R3'])
    expect(excludedAtStop(s9, ['R3'])).toEqual({ all: true, names: ['3'] })
  })

  it('除外した系統とほかの系統が止まる停留所は、除外した系統の名前だけを返す(all ではない)', () => {
    const a = excludedSetup().find((s) => s.stopId === 'A')
    if (!a) throw new Error('A がありません')
    expect(excludedAtStop(a, [' R3 '])).toEqual({ all: false, names: ['3'] })
    expect(excludedAtStop(a, [])).toEqual({ all: false, names: [] })
  })

  it('系統の無い停留所は all にしない', () => {
    expect(excludedAtStop({ lines: [], removedLines: [] }, ['R3'])).toEqual({ all: false, names: [] })
  })
})

describe('buildStopNotice(単体)', () => {
  it('座標を渡さなければ null', () => {
    const { base, result } = setup()
    const stop = stopDiff(base, result.feed, '20261104').stops[0]
    expect(buildStopNotice(stop, new Set())).toMatchObject({ lat: null, lon: null })
  })
})
