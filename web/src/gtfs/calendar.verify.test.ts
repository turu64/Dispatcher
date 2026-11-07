import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'
import { activeServiceIds, addDays, feedServicePeriod, isValidGtfsDate, servicesFor, weekdayIndex } from './calendar'
import { loadGtfsZip, type GtfsFeed, type GtfsRow } from './load'

// ---- 実装から独立した基準(オラクル) ----
// Date の UTC のセッターだけを使う。Date.UTC(y, …) は 0〜99 年を 1900〜1999 年に読み替えるので使わない。

function oracleDate(y: number, m: number, d: number): Date {
  const o = new Date(0)
  o.setUTCFullYear(y, m - 1, d)
  return o
}

function fromOracle(o: Date): string {
  return `${String(o.getUTCFullYear()).padStart(4, '0')}${String(o.getUTCMonth() + 1).padStart(2, '0')}${String(o.getUTCDate()).padStart(2, '0')}`
}

function oracleOf(date: string): Date {
  return oracleDate(Number(date.slice(0, 4)), Number(date.slice(4, 6)), Number(date.slice(6, 8)))
}

/** オラクルでの曜日(0=月曜 … 6=日曜) */
function oracleWeekday(date: string): number {
  return (oracleOf(date).getUTCDay() + 6) % 7
}

/** 再現できる乱数(mulberry32) */
function seededRandom(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

describe('日付の計算をオラクル(Date の UTC セッター)と照合する', () => {
  it('1899-12-01〜2101-01-31 のすべての日で、addDays(前日, 1)・曜日・isValidGtfsDate が一致する(1900・2000・2100 年の規則を含む)', () => {
    const mismatches: string[] = []
    const o = oracleDate(1899, 12, 1)
    let prev = fromOracle(o)
    let days = 0
    for (;;) {
      o.setUTCDate(o.getUTCDate() + 1)
      const cur = fromOracle(o)
      if (cur > '21010131') break
      days += 1
      if (addDays(prev, 1) !== cur) mismatches.push(`addDays(${prev}, 1) = ${addDays(prev, 1)}、正しくは ${cur}`)
      if (addDays(cur, -1) !== prev) mismatches.push(`addDays(${cur}, -1) = ${addDays(cur, -1)}、正しくは ${prev}`)
      if (weekdayIndex(cur) !== (o.getUTCDay() + 6) % 7) mismatches.push(`weekdayIndex(${cur})`)
      if (!isValidGtfsDate(cur)) mismatches.push(`isValidGtfsDate(${cur})`)
      prev = cur
    }
    expect(mismatches.slice(0, 20)).toEqual([])
    expect(days).toBeGreaterThan(73_000)
  })

  it('0000〜9999 年の乱数の日付と日数で、addDays と曜日がオラクルと一致し、往復で元に戻る', () => {
    const rand = seededRandom(20261103)
    const mismatches: string[] = []
    for (let i = 0; i < 3000; i += 1) {
      const base = oracleDate(Math.floor(rand() * 10000), 1, 1)
      base.setUTCDate(base.getUTCDate() + Math.floor(rand() * 366))
      if (base.getUTCFullYear() > 9999) continue
      const d = fromOracle(base)
      const n = Math.floor((rand() - 0.5) * 2 * 400_000)
      const target = new Date(base.getTime())
      target.setUTCDate(target.getUTCDate() + n)
      const y = target.getUTCFullYear()
      if (y < 0 || y > 9999) {
        if (!throws(() => addDays(d, n))) mismatches.push(`addDays(${d}, ${n}) は範囲外なのにエラーにならない`)
        continue
      }
      const expected = fromOracle(target)
      if (addDays(d, n) !== expected) mismatches.push(`addDays(${d}, ${n}) = ${addDays(d, n)}、正しくは ${expected}`)
      if (addDays(expected, -n) !== d) mismatches.push(`往復 ${d} ${n}`)
      if (weekdayIndex(d) !== oracleWeekday(d)) mismatches.push(`weekdayIndex(${d})`)
    }
    expect(mismatches.slice(0, 20)).toEqual([])
  })

  it('0000 年・99 年・100 年・9999 年の端を扱う(2桁の年として読み替えない)', () => {
    for (const d of ['00000101', '00000229', '00991231', '01000101', '04000229', '99991231']) {
      expect(isValidGtfsDate(d), d).toBe(true)
      expect(weekdayIndex(d), d).toBe(oracleWeekday(d))
    }
    expect(isValidGtfsDate('01000229')).toBe(false) // 100 年はうるう年でない
    expect(addDays('00991231', 1)).toBe('01000101')
    expect(addDays('00000228', 1)).toBe('00000229')
    expect(addDays('99991230', 1)).toBe('99991231')
    expect(() => addDays('99991231', 1)).toThrow('日付が範囲外になります')
    expect(() => addDays('00000101', -1)).toThrow('日付が範囲外になります')
    expect(() => addDays('20261102', Number.POSITIVE_INFINITY)).toThrow('ずらす日数は整数で指定してください')
  })

  it('isValidGtfsDate は、月 0〜13・日 0〜32 のすべての組でオラクルと一致する', () => {
    const mismatches: string[] = []
    for (const y of [0, 4, 99, 100, 400, 1900, 2000, 2024, 2026, 2027, 2028, 2100, 9999]) {
      for (let m = 0; m <= 13; m += 1) {
        for (let d = 0; d <= 32; d += 1) {
          const s = `${String(y).padStart(4, '0')}${String(m).padStart(2, '0')}${String(d).padStart(2, '0')}`
          const o = oracleDate(y, m, d)
          const real = m >= 1 && m <= 12 && o.getUTCFullYear() === y && o.getUTCMonth() === m - 1 && o.getUTCDate() === d
          if (isValidGtfsDate(s) !== real) mismatches.push(s)
        }
      }
    }
    expect(mismatches).toEqual([])
  })

  it('isValidGtfsDate は末尾の改行や符号を受け付けない', () => {
    for (const s of ['20261102\n', '\n20261102', '20261102\r', '+2026110', '-2026110', '2026 1102', '2026110２']) {
      expect(isValidGtfsDate(s), JSON.stringify(s)).toBe(false)
    }
  })
})

function throws(fn: () => unknown): boolean {
  try {
    fn()
    return false
  } catch {
    return true
  }
}

// ---- 手書きのフィードで、取り決めの端のケースを確かめる ----

function cal(serviceId: string, days: string, start: string, end: string): GtfsRow {
  const row: GtfsRow = { service_id: serviceId, start_date: start, end_date: end }
  ;['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'].forEach((c, i) => {
    row[c] = days[i]
  })
  return row
}

function ex(serviceId: string, date: string, exceptionType: string): GtfsRow {
  return { service_id: serviceId, date, exception_type: exceptionType }
}

function feedOf(tables: { calendar?: GtfsRow[]; calendar_dates?: GtfsRow[] }): GtfsFeed {
  const map: GtfsFeed['tables'] = new Map()
  if (tables.calendar) map.set('calendar', { fileName: 'calendar.txt', fields: [], rows: tables.calendar })
  if (tables.calendar_dates) map.set('calendar_dates', { fileName: 'calendar_dates.txt', fields: [], rows: tables.calendar_dates })
  return { tables: map, warnings: [] }
}

/** start〜end のうち、activeServiceIds が空でない日があるか */
function hasServiceDay(feed: GtfsFeed, start: string, end: string): boolean {
  for (let d = start; d <= end; d = addDays(d, 1)) if (activeServiceIds(feed, d).size > 0) return true
  return false
}

describe('feedServicePeriod:運行日が1つも無ければ null(取り決め)', () => {
  it('曜日の列が期間の中に一度も当たらない行だけなら null(土曜だけで期間が火〜水)', () => {
    const feed = feedOf({ calendar: [cal('土曜のみ', '0000010', '20261103', '20261104')] })
    expect(hasServiceDay(feed, '20261103', '20261104')).toBe(false)
    expect(feedServicePeriod(feed)).toBeNull()
  })

  it('calendar の運行日がすべて exception_type=2 で消えるなら null', () => {
    const feed = feedOf({
      calendar: [cal('平日', '1000000', '20261102', '20261102')],
      calendar_dates: [ex('平日', '20261102', '2')],
    })
    expect(hasServiceDay(feed, '20261102', '20261102')).toBe(false)
    expect(feedServicePeriod(feed)).toBeNull()
  })

  it('同じ service_id・日付に 1 と 2 の両方がある(削除が優先)だけなら null。activeServiceIds と食い違わない', () => {
    const feed = feedOf({ calendar_dates: [ex('A', '20261102', '1'), ex('A', '20261102', '2')] })
    expect(activeServiceIds(feed, '20261102').size).toBe(0)
    expect(feedServicePeriod(feed)).toBeNull()
  })

  it('運行日を生まない行・追加日は、ほかの行の期間を広げない', () => {
    const feed = feedOf({
      calendar: [cal('平日', '1111100', '20261001', '20261130'), cal('土曜のみ', '0000010', '20261201', '20261202')],
      calendar_dates: [ex('臨時', '20260901', '1'), ex('臨時', '20260901', '2'), ex('平日', '20261203', '1'), ex('平日', '20261203', '2')],
    })
    expect(feedServicePeriod(feed)).toEqual({ start: '20261001', end: '20261130' })
  })

  it('別の service_id の削除は、その日の追加を消さない', () => {
    const feed = feedOf({
      calendar: [cal('平日', '1111100', '20261001', '20261130')],
      calendar_dates: [ex('臨時', '20261231', '1'), ex('平日', '20261231', '2')],
    })
    expect(feedServicePeriod(feed)).toEqual({ start: '20261001', end: '20261231' })
  })

  it('前後の空白があっても、削除の照合は空白を取った値で行う', () => {
    const feed = feedOf({
      calendar: [cal(' 平日', '1000000', '20261102 ', '20261102')],
      calendar_dates: [ex('平日 ', ' 20261102', ' 2')],
    })
    expect(feedServicePeriod(feed)).toBeNull()
  })

  it('期間の端は calendar の start_date・end_date のまま返す(端の日が曜日に当たらない・削除で運休でも、運行日へ縮めない)', () => {
    // 2026-10-03 は土曜。平日だけの行でも、開始日は 10/3 のまま
    const satStart = feedOf({ calendar: [cal('平日', '1111100', '20261003', '20261130')] })
    expect(feedServicePeriod(satStart)).toEqual({ start: '20261003', end: '20261130' })
    // 最初の平日(10/5 月)と最後の日(11/30 月)を削除しても、端は変えない
    const removedEdges = feedOf({
      calendar: [cal('平日', '1111100', '20261003', '20261130')],
      calendar_dates: [ex('平日', '20261005', '2'), ex('平日', '20261130', '2')],
    })
    expect(feedServicePeriod(removedEdges)).toEqual({ start: '20261003', end: '20261130' })
  })

  it('削除が運行日の一部だけなら、その行は期間に数える', () => {
    const feed = feedOf({
      calendar: [cal('土曜', '0000010', '20261107', '20261114')],
      calendar_dates: [ex('土曜', '20261107', '2')],
    })
    expect(feedServicePeriod(feed)).toEqual({ start: '20261107', end: '20261114' })
  })

  it('end_date が 99991231 で運行日を生まない行でもエラーにしない(最後の日の次を求めない)', () => {
    const wd = oracleWeekday('99991231')
    const mask = [0, 1, 2, 3, 4, 5, 6].map((i) => (i === wd ? '0' : '1')).join('')
    const feed = feedOf({ calendar: [cal('最終日', mask, '99991231', '99991231')] })
    expect(feedServicePeriod(feed)).toBeNull()
    const removedAll = feedOf({
      calendar: [cal('最終日', '1111111', '99991231', '99991231')],
      calendar_dates: [ex('最終日', '99991231', '2')],
    })
    expect(feedServicePeriod(removedAll)).toBeNull()
  })

  it('乱数のフィード 2000 件で、null になるのは activeServiceIds が空でない日が1日も無いときだけで、運行日はすべて期間の中にある', () => {
    const rand = seededRandom(1103)
    const pick = <T,>(xs: T[]): T => xs[Math.floor(rand() * xs.length)]
    const window = Array.from({ length: 40 }, (_, i) => addDays('20261020', i))
    const pad = (s: string) => pick(['', ' ']) + s + pick(['', ' '])
    const problems: string[] = []
    let nulls = 0
    for (let i = 0; i < 2000; i += 1) {
      const sids = ['A', 'B', 'C']
      const calendar = Array.from({ length: Math.floor(rand() * 3) }, () => {
        const a = pick(window.slice(5, 35))
        const b = pick(window.slice(5, 35))
        const mask = Array.from({ length: 7 }, () => (rand() < 0.15 ? '1' : '0')).join('')
        return cal(pad(pick(sids)), mask, pad(rand() < 0.9 ? (a <= b ? a : b) : b), pad(rand() < 0.9 ? (a <= b ? b : a) : a))
      })
      const calendarDates = Array.from({ length: Math.floor(rand() * 5) }, () =>
        ex(pad(pick(sids)), pad(pick(window.slice(5, 35))), pad(pick(['1', '2', '2', '3']))),
      )
      const feed = feedOf({ calendar, calendar_dates: calendarDates })
      const period = feedServicePeriod(feed)
      const serviceDays = window.filter((d) => activeServiceIds(feed, d).size > 0)
      const label = JSON.stringify({ calendar, calendarDates, period })
      if (period === null) nulls += 1
      if ((period === null) !== (serviceDays.length === 0)) problems.push(`null の判定が食い違う ${label}`)
      if (period && serviceDays.some((d) => d < period.start || d > period.end)) problems.push(`期間の外に運行日がある ${label}`)
    }
    expect(problems.slice(0, 5)).toEqual([])
    // null と null でない結果の両方が十分に出ている(何も確かめていないテストにしない)
    expect(nulls).toBeGreaterThan(200)
    expect(nulls).toBeLessThan(1800)
  })

  it('読み込んだ行を書き換えない(元の値を前後の空白ごと残す)', () => {
    const calendar = [cal(' 平日 ', '1111100', ' 20261001', '20261130 ')]
    const calendarDates = [ex(' 平日', '20261103 ', ' 2 ')]
    const snapshot = JSON.stringify([calendar, calendarDates])
    const feed = feedOf({ calendar, calendar_dates: calendarDates })
    activeServiceIds(feed, '20261103')
    feedServicePeriod(feed)
    expect(JSON.stringify([calendar, calendarDates])).toBe(snapshot)
  })
})

// 道北バスの GTFS(data/raw/gtfs/ に置く。コミットしない)で運行日の判定を確かめる。ファイルがあるときだけ走る。
//
// このデータの service_id は 01=平日、03=土曜、06=日祝。
// 祝日は calendar_dates.txt で、日付ごとに「01 と 03 を削除(2)、06 を追加(1)」の3行で表している。
// 祝日の知識はコードに持たず、データのとおりに判定する。

function samplePath(file: string): string {
  return fileURLToPath(new URL(`../../../data/raw/gtfs/${file}`, import.meta.url))
}

async function loadSample(path: string): Promise<GtfsFeed> {
  const buf = readFileSync(path)
  return loadGtfsZip(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength))
}

/** 期間の各日について、祝日・日曜は 06、土曜は 03、それ以外は 01 だけが走ることを確かめる */
function expectOneServicePerDay(feed: GtfsFeed, start: string, end: string, holidays: string[]) {
  let days = 0
  for (let d = start; d <= end; d = addDays(d, 1)) {
    const wd = weekdayIndex(d)
    const expected = holidays.includes(d) || wd === 6 ? '06' : wd === 5 ? '03' : '01'
    expect([...activeServiceIds(feed, d)], d).toEqual([expected])
    days += 1
  }
  return days
}

/** calendar_dates.txt を日付ごとに { service_id: exception_type } にまとめる */
function exceptionsByDate(feed: GtfsFeed): Record<string, Record<string, string>> {
  const result: Record<string, Record<string, string>> = {}
  for (const row of feed.tables.get('calendar_dates')?.rows ?? []) {
    const date = row.date?.trim() ?? ''
    result[date] = { ...result[date], [row.service_id?.trim() ?? '']: row.exception_type?.trim() ?? '' }
  }
  return result
}

const HOLIDAY_EXCEPTIONS = { '01': '2', '03': '2', '06': '1' }

/** servicesFor の結果を、比べやすいように並べた配列にする */
function servicesOf(feed: GtfsFeed, date: string): { today: string[]; yesterday: string[] } {
  const { today, yesterday } = servicesFor(feed, date)
  return { today: [...today].sort(), yesterday: [...yesterday].sort() }
}

const BEFORE = samplePath('dohoku_bus_減便前.zip')
const AFTER = samplePath('dohoku_bus_減便後.zip')

describe.skipIf(!existsSync(BEFORE))('道北バス(減便前、20261001〜20261130)', () => {
  let feed: GtfsFeed
  beforeAll(async () => {
    feed = await loadSample(BEFORE)
  }, 30_000)

  it('運行期間は calendar の期間で、feed_info の期間と一致する', () => {
    expect(feedServicePeriod(feed)).toEqual({ start: '20261001', end: '20261130' })
    const info = feed.tables.get('feed_info')?.rows[0]
    expect({ start: info?.feed_start_date, end: info?.feed_end_date }).toEqual({ start: '20261001', end: '20261130' })
  })

  it('曜日ごとに 01・03・06 が走る', () => {
    expect([...activeServiceIds(feed, '20261102')]).toEqual(['01']) // 月
    expect([...activeServiceIds(feed, '20261104')]).toEqual(['01']) // 水
    expect([...activeServiceIds(feed, '20261107')]).toEqual(['03']) // 土
    expect([...activeServiceIds(feed, '20261108')]).toEqual(['06']) // 日
  })

  it('祝日(スポーツの日・文化の日・勤労感謝の日)は日祝の 06 だけが走る', () => {
    expect([...activeServiceIds(feed, '20261012')]).toEqual(['06']) // 月・スポーツの日
    expect([...activeServiceIds(feed, '20261103')]).toEqual(['06']) // 火・文化の日
    expect([...activeServiceIds(feed, '20261123')]).toEqual(['06']) // 月・勤労感謝の日
  })

  it('祝日は calendar_dates で、01 と 03 の削除と 06 の追加の3行で表されている', () => {
    expect(exceptionsByDate(feed)).toEqual({
      '20261012': HOLIDAY_EXCEPTIONS,
      '20261103': HOLIDAY_EXCEPTIONS,
      '20261123': HOLIDAY_EXCEPTIONS,
    })
  })

  it('期間の端の日は含み、その外は何も走らない', () => {
    expect([...activeServiceIds(feed, '20261001')]).toEqual(['01']) // 木・開始日
    expect([...activeServiceIds(feed, '20261130')]).toEqual(['01']) // 月・終了日
    expect([...activeServiceIds(feed, '20260930')]).toEqual([])
    expect([...activeServiceIds(feed, '20261201')]).toEqual([])
  })

  it('期間のすべての日で、ちょうど1つの service_id が走る', () => {
    const days = expectOneServicePerDay(feed, '20261001', '20261130', ['20261012', '20261103', '20261123'])
    expect(days).toBe(61)
  })

  it('trips の service_id はすべて calendar にある', () => {
    const inCalendar = new Set(feed.tables.get('calendar')?.rows.map((r) => r.service_id?.trim()))
    const inTrips = new Set(feed.tables.get('trips')?.rows.map((r) => r.service_id?.trim()))
    expect([...inTrips].sort()).toEqual(['01', '03', '06'])
    for (const id of inTrips) expect(inCalendar.has(id), id).toBe(true)
  })

  it('servicesFor:11/2(月)の当日は平日 01、前日の 11/1(日)は日祝 06', () => {
    expect(servicesOf(feed, '20261102')).toEqual({ today: ['01'], yesterday: ['06'] })
  })

  it('servicesFor:祝日の 11/3(火)は当日が 06、前日の 11/2 は 01。翌日の 11/4 は前日が祝日の 06', () => {
    expect(servicesOf(feed, '20261103')).toEqual({ today: ['06'], yesterday: ['01'] })
    expect(servicesOf(feed, '20261104')).toEqual({ today: ['01'], yesterday: ['06'] })
  })

  it('servicesFor:月またぎ(10/31 土→11/1 日)と期間の端(開始日の前日・終了日の翌日)', () => {
    expect(servicesOf(feed, '20261101')).toEqual({ today: ['06'], yesterday: ['03'] })
    expect(servicesOf(feed, '20261001')).toEqual({ today: ['01'], yesterday: [] })
    expect(servicesOf(feed, '20261201')).toEqual({ today: [], yesterday: ['01'] })
  })

  it('servicesFor:期間のすべての日で、today・yesterday は activeServiceIds と一致する', () => {
    for (let d = '20260930'; d <= '20261201'; d = addDays(d, 1)) {
      expect(servicesOf(feed, d), d).toEqual({
        today: [...activeServiceIds(feed, d)].sort(),
        yesterday: [...activeServiceIds(feed, addDays(d, -1))].sort(),
      })
    }
  })
})

describe.skipIf(!existsSync(AFTER))('道北バス(減便後、20261101〜20270331)', () => {
  let feed: GtfsFeed
  beforeAll(async () => {
    feed = await loadSample(AFTER)
  }, 30_000)

  it('運行期間は calendar の期間で、feed_info の期間と一致する', () => {
    expect(feedServicePeriod(feed)).toEqual({ start: '20261101', end: '20270331' })
    const info = feed.tables.get('feed_info')?.rows[0]
    expect({ start: info?.feed_start_date, end: info?.feed_end_date }).toEqual({ start: '20261101', end: '20270331' })
  })

  it('曜日ごとに 01・03・06 が走り、11/3 と 11/23 は 06 だけが走る', () => {
    expect([...activeServiceIds(feed, '20261101')]).toEqual(['06']) // 日・開始日
    expect([...activeServiceIds(feed, '20261102')]).toEqual(['01']) // 月
    expect([...activeServiceIds(feed, '20261103')]).toEqual(['06']) // 火・文化の日
    expect([...activeServiceIds(feed, '20261107')]).toEqual(['03']) // 土
    expect([...activeServiceIds(feed, '20261123')]).toEqual(['06']) // 月・勤労感謝の日
    expect([...activeServiceIds(feed, '20270331')]).toEqual(['01']) // 水・終了日
  })

  it('期間の外(減便前の期間のスポーツの日など)は何も走らない', () => {
    expect([...activeServiceIds(feed, '20261012')]).toEqual([])
    expect([...activeServiceIds(feed, '20261031')]).toEqual([])
    expect([...activeServiceIds(feed, '20270401')]).toEqual([])
  })

  it('calendar_dates には 11/3 と 11/23 しか無く、2027年の祝日は平日の 01 と判定される(データのとおり)', () => {
    expect(exceptionsByDate(feed)).toEqual({ '20261103': HOLIDAY_EXCEPTIONS, '20261123': HOLIDAY_EXCEPTIONS })
    // 元日(金)、成人の日(月)、建国記念の日(木)、天皇誕生日(火)。祝日一覧での補いは減便の方針の適用(11/4)で行う
    for (const d of ['20270101', '20270111', '20270211', '20270223']) {
      expect([...activeServiceIds(feed, d)], d).toEqual(['01'])
    }
  })

  it('期間のすべての日で、ちょうど1つの service_id が走る', () => {
    const days = expectOneServicePerDay(feed, '20261101', '20270331', ['20261103', '20261123'])
    expect(days).toBe(151)
  })

  it('servicesFor:開始日の 11/1(日)は前日の 10/31 が期間の外なので yesterday が空', () => {
    expect(servicesOf(feed, '20261101')).toEqual({ today: ['06'], yesterday: [] })
    expect(servicesOf(feed, '20261102')).toEqual({ today: ['01'], yesterday: ['06'] })
  })

  it('servicesFor:祝日の 11/3 と、その翌日(前日が祝日の 06)', () => {
    expect(servicesOf(feed, '20261103')).toEqual({ today: ['06'], yesterday: ['01'] })
    expect(servicesOf(feed, '20261104')).toEqual({ today: ['01'], yesterday: ['06'] })
  })

  it('servicesFor:年またぎ(12/31 木→1/1 金)と、終了日の翌日', () => {
    expect(servicesOf(feed, '20270101')).toEqual({ today: ['01'], yesterday: ['01'] })
    expect(servicesOf(feed, '20270102')).toEqual({ today: ['03'], yesterday: ['01'] })
    expect(servicesOf(feed, '20270331')).toEqual({ today: ['01'], yesterday: ['01'] })
    expect(servicesOf(feed, '20270401')).toEqual({ today: [], yesterday: ['01'] })
  })
})
