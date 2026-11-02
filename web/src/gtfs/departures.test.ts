import { describe, expect, it } from 'vitest'
import { departureCountsByBand, makeBands, parseGtfsTime, type DepartureCounts } from './departures'
import type { GtfsFeed, GtfsRow } from './load'

/** 引用符の無い簡単な CSV を行にする(値の前後の空白は元のまま残す) */
function rowsOf(csv: string): GtfsRow[] {
  const [header, ...lines] = csv.trim().split('\n')
  const fields = header.split(',')
  return lines.map((line) => {
    const values = line.split(',')
    const row: GtfsRow = {}
    fields.forEach((f, i) => {
      if (i < values.length) row[f] = values[i]
    })
    return row
  })
}

function feedOf(tables: Record<string, GtfsRow[]>): GtfsFeed {
  return {
    tables: new Map(
      Object.entries(tables).map(([name, rows]) => [
        name,
        { fileName: `${name}.txt`, fields: Object.keys(rows[0] ?? {}), rows },
      ]),
    ),
    warnings: [],
  }
}

const BANDS3 = makeBands(3) // 6〜9、9〜12、12〜15、15〜18、18〜21、21〜24
const ZERO6 = [0, 0, 0, 0, 0, 0]
const WEEKDAY = { today: new Set(['平日']), yesterday: new Set<string>() }

/** 停留所の時間帯ごとの数。Map に無ければすべて 0 */
function countsAt(result: DepartureCounts, stopId: string, bandCount = BANDS3.length): number[] {
  return result.counts.get(stopId) ?? new Array<number>(bandCount).fill(0)
}

/** 便ごとに、出発を数えたい停留所 A と、数えない終点 Z を並べた stop_times を作る */
function tripsWithDeparture(list: { trip: string; service: string; time: string }[]): GtfsFeed {
  const trips = list.map((x) => ({ trip_id: x.trip, service_id: x.service }))
  const stopTimes = list.flatMap((x) => [
    { trip_id: x.trip, stop_id: 'A', stop_sequence: '1', departure_time: x.time, pickup_type: '0' },
    { trip_id: x.trip, stop_id: 'Z', stop_sequence: '2', departure_time: '99:00:00', pickup_type: '0' },
  ])
  return feedOf({ trips, stop_times: stopTimes })
}

describe('makeBands', () => {
  it('3時間ごとは 6〜24時を6個に分ける', () => {
    const bands = makeBands(3)
    expect(bands).toHaveLength(6)
    expect(bands[0]).toEqual({ startHour: 6, endHour: 9, label: '6〜9時' })
    expect(bands.map((b) => b.label)).toEqual(['6〜9時', '9〜12時', '12〜15時', '15〜18時', '18〜21時', '21〜24時'])
    expect(bands[5]).toEqual({ startHour: 21, endHour: 24, label: '21〜24時' })
  })

  it('1時間ごとは 6〜24時を18個に分ける', () => {
    const bands = makeBands(1)
    expect(bands).toHaveLength(18)
    expect(bands[0]).toEqual({ startHour: 6, endHour: 7, label: '6〜7時' })
    expect(bands[17]).toEqual({ startHour: 23, endHour: 24, label: '23〜24時' })
    // 隙間なく続く
    for (let i = 1; i < bands.length; i++) expect(bands[i].startHour).toBe(bands[i - 1].endHour)
  })

  it('1時間・3時間以外の幅はエラーにする', () => {
    expect(() => makeBands(2 as 1)).toThrow('時間帯の幅は1時間か3時間にしてください')
  })
})

describe('parseGtfsTime', () => {
  it('HH:MM:SS を 0:00 からの秒数にする', () => {
    expect(parseGtfsTime('00:00:00')).toBe(0)
    expect(parseGtfsTime('07:05:30')).toBe(7 * 3600 + 5 * 60 + 30)
    expect(parseGtfsTime('23:59:59')).toBe(86399)
  })

  it('24時を超える時刻を許す', () => {
    expect(parseGtfsTime('24:00:00')).toBe(86400)
    expect(parseGtfsTime('25:10:00')).toBe(90600)
    expect(parseGtfsTime('30:10:00')).toBe(108600)
  })

  it('時が1桁の時刻を許す', () => {
    expect(parseGtfsTime('7:05:00')).toBe(25500)
    expect(parseGtfsTime('9:00:00')).toBe(32400)
  })

  it('前後の空白は取る', () => {
    expect(parseGtfsTime(' 09:00:00 ')).toBe(32400)
  })

  it('空・未指定・形式が違う値は null', () => {
    expect(parseGtfsTime(undefined)).toBeNull()
    expect(parseGtfsTime('')).toBeNull()
    expect(parseGtfsTime('   ')).toBeNull()
    expect(parseGtfsTime('7:5:00')).toBeNull()
    expect(parseGtfsTime('07:60:00')).toBeNull()
    expect(parseGtfsTime('07:00:60')).toBeNull()
    expect(parseGtfsTime('07:00')).toBeNull()
    expect(parseGtfsTime('-1:00:00')).toBeNull()
    expect(parseGtfsTime('七時')).toBeNull()
  })
})

describe('departureCountsByBand', () => {
  it('当日の便の出発を、停留所ごと・時間帯ごとに数える', () => {
    const feed = feedOf({
      trips: rowsOf(`
trip_id,service_id
T1,平日
T2,平日`),
      stop_times: rowsOf(`
trip_id,stop_id,stop_sequence,departure_time,pickup_type
T1,A,1,07:00:00,0
T1,B,2,07:10:00,0
T1,C,3,07:20:00,0
T2,A,1,19:00:00,0
T2,C,2,19:30:00,0`),
    })
    const result = departureCountsByBand(feed, WEEKDAY, BANDS3)
    expect(countsAt(result, 'A')).toEqual([1, 0, 0, 0, 1, 0])
    expect(countsAt(result, 'B')).toEqual([1, 0, 0, 0, 0, 0])
    // C はどちらの便でも終点なので数えない(Map にも入らない)
    expect(result.counts.has('C')).toBe(false)
    expect(result.skippedBlankTime).toBe(0)
    expect(result.hasFrequencies).toBe(false)
  })

  describe('24時を超える時刻', () => {
    it('当日の便の 25:10 は 6〜24時のどの時間帯にも入らない', () => {
      const feed = tripsWithDeparture([{ trip: 'T1', service: '平日', time: '25:10:00' }])
      const result = departureCountsByBand(feed, WEEKDAY, BANDS3)
      expect(countsAt(result, 'A')).toEqual(ZERO6)
      expect(result.counts.size).toBe(0)
    })

    it('前日の便の 30:10 は対象日の 6:10 として 6〜9時に入る', () => {
      const feed = tripsWithDeparture([{ trip: 'T1', service: '日曜', time: '30:10:00' }])
      const result = departureCountsByBand(
        feed,
        { today: new Set(['平日']), yesterday: new Set(['日曜']) },
        BANDS3,
      )
      expect(countsAt(result, 'A')).toEqual([1, 0, 0, 0, 0, 0])
    })

    it('前日の便の 24時より前の出発は、対象日のどの時間帯にも入らない', () => {
      const feed = tripsWithDeparture([
        { trip: 'T1', service: '日曜', time: '23:00:00' },
        { trip: 'T2', service: '日曜', time: '07:00:00' },
      ])
      const result = departureCountsByBand(feed, { today: new Set(), yesterday: new Set(['日曜']) }, BANDS3)
      expect(result.counts.size).toBe(0)
    })

    it('当日の便の 30:10 は翌日の分なので、対象日には数えない', () => {
      const feed = tripsWithDeparture([{ trip: 'T1', service: '平日', time: '30:10:00' }])
      expect(departureCountsByBand(feed, WEEKDAY, BANDS3).counts.size).toBe(0)
    })

    it('同じ service_id が当日と前日の両方で走るときは、両方の出発を数える', () => {
      const feed = tripsWithDeparture([
        { trip: 'T1', service: '平日', time: '07:00:00' },
        { trip: 'T2', service: '平日', time: '30:10:00' },
        { trip: 'T3', service: '平日', time: '22:00:00' },
      ])
      const both = new Set(['平日'])
      const result = departureCountsByBand(feed, { today: both, yesterday: both }, BANDS3)
      // T1 は当日の 7:00、T2 は前日の分が当日の 6:10、T3 は当日の 22:00
      expect(countsAt(result, 'A')).toEqual([2, 0, 0, 0, 0, 1])
    })
  })

  describe('時間帯の端', () => {
    it('開始の時刻を含み、終了の時刻を含まない', () => {
      const feed = tripsWithDeparture([
        { trip: 'T1', service: '平日', time: '06:00:00' },
        { trip: 'T2', service: '平日', time: '08:59:59' },
        { trip: 'T3', service: '平日', time: '09:00:00' },
        { trip: 'T4', service: '平日', time: '23:59:59' },
      ])
      const result = departureCountsByBand(feed, WEEKDAY, BANDS3)
      // 9:00:00 ちょうどは 9〜12時
      expect(countsAt(result, 'A')).toEqual([2, 1, 0, 0, 0, 1])
    })

    it('5:59:59 と当日の 24:00:00 はどの時間帯にも入らない', () => {
      const feed = tripsWithDeparture([
        { trip: 'T1', service: '平日', time: '05:59:59' },
        { trip: 'T2', service: '平日', time: '24:00:00' },
      ])
      expect(departureCountsByBand(feed, WEEKDAY, BANDS3).counts.size).toBe(0)
    })
  })

  it('時が1桁の時刻を読む', () => {
    const feed = tripsWithDeparture([
      { trip: 'T1', service: '平日', time: '7:05:00' },
      { trip: 'T2', service: '平日', time: '9:00:00' },
    ])
    expect(countsAt(departureCountsByBand(feed, WEEKDAY, BANDS3), 'A')).toEqual([1, 1, 0, 0, 0, 0])
  })

  it('pickup_type=1(乗車できない)の行は数えない。0・2・3・空は数える', () => {
    const feed = feedOf({
      trips: rowsOf(`
trip_id,service_id
T1,平日`),
      stop_times: rowsOf(`
trip_id,stop_id,stop_sequence,pickup_type,departure_time
T1,P0,1,0,07:00:00
T1,P1,2,1,07:01:00
T1,P2,3,2,07:02:00
T1,P3,4,3,07:03:00
T1,PB,5,,07:04:00
T1,PS,6, 1 ,07:05:00
T1,Z,7,0,07:10:00`),
    })
    const result = departureCountsByBand(feed, WEEKDAY, BANDS3)
    expect([...result.counts.keys()].sort()).toEqual(['P0', 'P2', 'P3', 'PB'])
  })

  it('pickup_type の列が無いフィードは、すべて乗車できるとみなす', () => {
    const feed = feedOf({
      trips: rowsOf(`
trip_id,service_id
T1,平日`),
      stop_times: rowsOf(`
trip_id,stop_id,stop_sequence,departure_time
T1,A,1,07:00:00
T1,Z,2,07:10:00`),
    })
    expect(countsAt(departureCountsByBand(feed, WEEKDAY, BANDS3), 'A')).toEqual([1, 0, 0, 0, 0, 0])
  })

  describe('各便の最後の停留所', () => {
    it('stop_sequence を数値で比べて最大の行を数えない(10 > 9)', () => {
      // 行の並びもばらばらにする
      const lines = [10, 3, 9, 1, 2, 4, 5, 6, 7, 8].map(
        (seq) => `T1,S${seq},${seq},07:${String(seq).padStart(2, '0')}:00,0`,
      )
      const feed = feedOf({
        trips: rowsOf('trip_id,service_id\nT1,平日'),
        stop_times: rowsOf(`trip_id,stop_id,stop_sequence,departure_time,pickup_type\n${lines.join('\n')}`),
      })
      const result = departureCountsByBand(feed, WEEKDAY, BANDS3)
      expect(result.counts.has('S10')).toBe(false)
      expect(result.counts.has('S9')).toBe(true)
      expect(result.counts.size).toBe(9)
    })

    it('stop_sequence が飛び飛びでも、最大の行だけを除く。最後の停留所は便ごとに判定する', () => {
      const feed = feedOf({
        trips: rowsOf(`
trip_id,service_id
T1,平日
T2,平日`),
        stop_times: rowsOf(`
trip_id,stop_id,stop_sequence,departure_time,pickup_type
T1,A,5,07:00:00,0
T1,B,20,07:10:00,0
T1,C,100,07:20:00,0
T2,C,1,08:00:00,0
T2,A,2,08:10:00,0`),
      })
      const result = departureCountsByBand(feed, WEEKDAY, BANDS3)
      expect(countsAt(result, 'A')).toEqual([1, 0, 0, 0, 0, 0]) // T2 では終点
      expect(countsAt(result, 'B')).toEqual([1, 0, 0, 0, 0, 0])
      expect(countsAt(result, 'C')).toEqual([1, 0, 0, 0, 0, 0]) // T1 では終点、T2 では始発
    })

    it('1行しかない便は、その行が最後の停留所なので数えない', () => {
      const feed = feedOf({
        trips: rowsOf('trip_id,service_id\nT1,平日'),
        stop_times: rowsOf('trip_id,stop_id,stop_sequence,departure_time\nT1,A,1,07:00:00'),
      })
      expect(departureCountsByBand(feed, WEEKDAY, BANDS3).counts.size).toBe(0)
    })
  })

  it('departure_time が空の行は数えず、数を skippedBlankTime に入れる(補間しない)', () => {
    const feed = feedOf({
      trips: rowsOf(`
trip_id,service_id
T1,平日
T9,土曜`),
      stop_times: [
        ...rowsOf(`
trip_id,arrival_time,departure_time,stop_id,stop_sequence,pickup_type
T1,07:00:00,07:00:00,A,1,0
T1,,,B,2,0
T1,07:20:00,  ,C,3,0
T1,07:25:00,,P,4,1
T1,07:30:00,07:30:00,D,5,0
T1,,,Z,6,0
T9,,,A,1,0
T9,,,Z,2,0`),
        // 列が足りず、departure_time のキーが無い行
        { trip_id: 'T1', stop_id: 'E', stop_sequence: '5.5' },
      ],
    })
    const result = departureCountsByBand(feed, WEEKDAY, BANDS3)
    expect([...result.counts.keys()].sort()).toEqual(['A', 'D'])
    // B・C・E の3行。乗車できない P、終点 Z、運行しない便 T9 の空欄は数えない
    expect(result.skippedBlankTime).toBe(3)
  })

  it('形式が違う時刻は数えず、空の行の数にも入れない', () => {
    const feed = tripsWithDeparture([{ trip: 'T1', service: '平日', time: '7時' }])
    const result = departureCountsByBand(feed, WEEKDAY, BANDS3)
    expect(result.counts.size).toBe(0)
    expect(result.skippedBlankTime).toBe(0)
  })

  it('trip_id・service_id・stop_id の前後の空白を取って照合し、キーも空白を取った値にする', () => {
    const feed = feedOf({
      trips: [{ trip_id: ' T1 ', service_id: ' 平日 ' }],
      stop_times: rowsOf(`
trip_id,stop_id,stop_sequence,departure_time,pickup_type
T1, A ,1,07:00:00,0
 T1 ,A,2,10:00:00,0
T1,B, 3 ,11:00:00,0
T1 ,Z,10,12:00:00,0`),
    })
    const result = departureCountsByBand(feed, WEEKDAY, BANDS3)
    expect([...result.counts.keys()].sort()).toEqual(['A', 'B'])
    expect(countsAt(result, 'A')).toEqual([1, 1, 0, 0, 0, 0])
    expect(countsAt(result, 'B')).toEqual([0, 1, 0, 0, 0, 0])
    // 終点 Z(stop_sequence 10)は数えない
    expect(result.counts.has('Z')).toBe(false)
  })

  it('1時間ごとなら18個、3時間ごとなら6個の配列で、合計は同じ', () => {
    const feed = tripsWithDeparture([
      { trip: 'T1', service: '平日', time: '06:30:00' },
      { trip: 'T2', service: '平日', time: '07:30:00' },
      { trip: 'T3', service: '平日', time: '13:00:00' },
      { trip: 'T4', service: '平日', time: '23:30:00' },
    ])
    const hourly = departureCountsByBand(feed, WEEKDAY, makeBands(1))
    const a1 = countsAt(hourly, 'A', 18)
    expect(a1).toHaveLength(18)
    expect(a1[0]).toBe(1) // 6〜7時
    expect(a1[1]).toBe(1) // 7〜8時
    expect(a1[7]).toBe(1) // 13〜14時
    expect(a1[17]).toBe(1) // 23〜24時
    const a3 = countsAt(departureCountsByBand(feed, WEEKDAY, BANDS3), 'A')
    expect(a3).toEqual([2, 0, 1, 0, 0, 1])
    expect(a1.reduce((s, n) => s + n, 0)).toBe(a3.reduce((s, n) => s + n, 0))
  })

  describe('frequencies.txt', () => {
    const base = {
      trips: rowsOf('trip_id,service_id\nT1,平日'),
      stop_times: rowsOf('trip_id,stop_id,stop_sequence,departure_time\nT1,A,1,07:00:00\nT1,Z,2,07:10:00'),
    }

    it('無ければ hasFrequencies は false', () => {
      expect(departureCountsByBand(feedOf(base), WEEKDAY, BANDS3).hasFrequencies).toBe(false)
    })

    it('あれば hasFrequencies は true で、運行間隔の展開はしない', () => {
      const feed = feedOf({
        ...base,
        frequencies: rowsOf('trip_id,start_time,end_time,headway_secs\nT1,07:00:00,10:00:00,600'),
      })
      const result = departureCountsByBand(feed, WEEKDAY, BANDS3)
      expect(result.hasFrequencies).toBe(true)
      // stop_times の1本だけを数える
      expect(countsAt(result, 'A')).toEqual([1, 0, 0, 0, 0, 0])
    })
  })

  describe('運行しない便', () => {
    it('当日にも前日にも走らない service_id の便は数えない', () => {
      const feed = tripsWithDeparture([
        { trip: 'T1', service: '平日', time: '07:00:00' },
        { trip: 'T2', service: '土曜', time: '08:00:00' },
        { trip: 'T3', service: '日曜', time: '09:00:00' },
      ])
      const result = departureCountsByBand(feed, WEEKDAY, BANDS3)
      expect(countsAt(result, 'A')).toEqual([1, 0, 0, 0, 0, 0])
    })

    it('trips.txt に無い便の stop_times は数えない', () => {
      const feed = feedOf({
        trips: rowsOf('trip_id,service_id\nT1,平日'),
        stop_times: rowsOf(`
trip_id,stop_id,stop_sequence,departure_time
T1,A,1,07:00:00
T1,Z,2,07:10:00
X1,B,1,07:00:00
X1,Z,2,07:10:00`),
      })
      expect([...departureCountsByBand(feed, WEEKDAY, BANDS3).counts.keys()]).toEqual(['A'])
    })

    it('運行する service_id が無い日は空の結果を返す', () => {
      const feed = tripsWithDeparture([{ trip: 'T1', service: '平日', time: '07:00:00' }])
      const result = departureCountsByBand(feed, { today: new Set(), yesterday: new Set() }, BANDS3)
      expect(result).toEqual({ counts: new Map(), skippedBlankTime: 0, hasFrequencies: false })
    })
  })

  it('trips.txt や stop_times.txt が無いフィードでも止まらない', () => {
    const result = departureCountsByBand(feedOf({}), WEEKDAY, BANDS3)
    expect(result.counts.size).toBe(0)
  })

  it('5万行の stop_times を 1 秒以内に数える', () => {
    const tripCount = 2000
    const stopsPerTrip = 25
    const trips: GtfsRow[] = []
    const stopTimes: GtfsRow[] = []
    for (let t = 0; t < tripCount; t++) {
      trips.push({ trip_id: `T${t}`, service_id: t % 3 === 0 ? '土曜' : '平日' })
      const start = 6 * 3600 + (t % 60) * 300
      for (let s = 1; s <= stopsPerTrip; s++) {
        const sec = start + s * 120
        const hh = String(Math.floor(sec / 3600)).padStart(2, '0')
        const mm = String(Math.floor((sec % 3600) / 60)).padStart(2, '0')
        const ss = String(sec % 60).padStart(2, '0')
        stopTimes.push({
          trip_id: `T${t}`,
          stop_id: `S${(t * 7 + s) % 1500}`,
          stop_sequence: String(s),
          departure_time: `${hh}:${mm}:${ss}`,
          pickup_type: '0',
        })
      }
    }
    const feed = feedOf({ trips, stop_times: stopTimes })
    const t0 = performance.now()
    const result = departureCountsByBand(feed, { today: new Set(['平日']), yesterday: new Set(['土曜']) }, makeBands(1))
    const elapsed = performance.now() - t0
    const total = [...result.counts.values()].flat().reduce((s, n) => s + n, 0)
    // 平日の便(2000 本のうち 1333 本)× 終点を除く 24 停留所
    expect(total).toBe(1333 * 24)
    expect(elapsed).toBeLessThan(1000)
  })
})
