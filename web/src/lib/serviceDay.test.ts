import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { feedServicePeriod } from '@/gtfs/calendar'
import { loadGtfsZip, type GtfsFeed, type GtfsRow } from '@/gtfs/load'
import { defaultServiceDate, describeServiceDay } from './serviceDay'

const CALENDAR_FIELDS = ['service_id', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday', 'start_date', 'end_date']

/** calendar.txt の1行。曜日は '1111100' のように月曜から7文字で書く */
function cal(serviceId: string, days: string, start: string, end: string): GtfsRow {
  const row: GtfsRow = { service_id: serviceId, start_date: start, end_date: end }
  CALENDAR_FIELDS.slice(1, 8).forEach((c, i) => {
    row[c] = days[i]
  })
  return row
}

function ex(serviceId: string, date: string, exceptionType: string): GtfsRow {
  return { service_id: serviceId, date, exception_type: exceptionType }
}

function feedOf(tables: { calendar?: GtfsRow[]; calendar_dates?: GtfsRow[] }): GtfsFeed {
  const map: GtfsFeed['tables'] = new Map()
  if (tables.calendar) map.set('calendar', { fileName: 'calendar.txt', fields: CALENDAR_FIELDS, rows: tables.calendar })
  if (tables.calendar_dates) {
    map.set('calendar_dates', {
      fileName: 'calendar_dates.txt',
      fields: ['service_id', 'date', 'exception_type'],
      rows: tables.calendar_dates,
    })
  }
  return { tables: map, warnings: [] }
}

// 道北バスと同じ作り:01 平日、03 土曜、06 日祝。11/3(火)は祝日で 01・03 を運休し 06 を追加
const DOHOKU_LIKE = feedOf({
  calendar: [cal('01', '1111100', '20261001', '20261130'), cal('03', '0000010', '20261001', '20261130'), cal('06', '0000001', '20261001', '20261130')],
  calendar_dates: [ex('01', '20261103', '2'), ex('03', '20261103', '2'), ex('06', '20261103', '1')],
})
const PERIOD = { start: '20261001', end: '20261130' }

describe('describeServiceDay', () => {
  it('平日は calendar.txt のとおりで、calendar_dates.txt は効いていない', () => {
    const day = describeServiceDay(DOHOKU_LIKE, '20261104')
    expect(day).toEqual({
      date: '20261104',
      weekday: 2,
      serviceIds: ['01'],
      calendarServiceIds: ['01'],
      added: [],
      removed: [],
      exceptionApplied: false,
    })
  })

  it('祝日は calendar_dates.txt で 06 が追加され、01 が運休になる(もともと走らない 03 の運休は数えない)', () => {
    const day = describeServiceDay(DOHOKU_LIKE, '20261103')
    expect(day.weekday).toBe(1)
    expect(day.serviceIds).toEqual(['06'])
    expect(day.calendarServiceIds).toEqual(['01'])
    expect(day.added).toEqual(['06'])
    expect(day.removed).toEqual(['01'])
    expect(day.exceptionApplied).toBe(true)
  })

  it('calendar_dates.txt の行があっても、運行が変わらなければ効いていないとみなす', () => {
    const feed = feedOf({ calendar: [cal('01', '1111100', '20261001', '20261130')], calendar_dates: [ex('03', '20261104', '2')] })
    expect(describeServiceDay(feed, '20261104').exceptionApplied).toBe(false)
  })

  it('期間の外は走る便が無い', () => {
    expect(describeServiceDay(DOHOKU_LIKE, '20261201').serviceIds).toEqual([])
  })

  it('不正な日付はエラー', () => {
    expect(() => describeServiceDay(DOHOKU_LIKE, '20261131')).toThrow()
  })

  it('元のフィードの表を書き換えない', () => {
    describeServiceDay(DOHOKU_LIKE, '20261103')
    expect([...DOHOKU_LIKE.tables.keys()]).toEqual(['calendar', 'calendar_dates'])
  })
})

describe('defaultServiceDate', () => {
  it('今日が運行期間の中で平日なら今日', () => {
    expect(defaultServiceDate(DOHOKU_LIKE, PERIOD, '20261104')).toBe('20261104')
  })

  it('今日が祝日(calendar_dates が効く)なら、次の平日', () => {
    expect(defaultServiceDate(DOHOKU_LIKE, PERIOD, '20261103')).toBe('20261104')
  })

  it('今日が土曜なら、次の月曜', () => {
    expect(defaultServiceDate(DOHOKU_LIKE, PERIOD, '20261107')).toBe('20261109')
  })

  it('今日が運行期間の外なら、期間の最初の日から探す(10/1 は木曜)', () => {
    expect(defaultServiceDate(DOHOKU_LIKE, PERIOD, '20261201')).toBe('20261001')
    expect(defaultServiceDate(DOHOKU_LIKE, PERIOD, '20260901')).toBe('20261001')
  })

  it('期間の最初の日が土曜なら、次の月曜', () => {
    const feed = feedOf({ calendar: [cal('01', '1111100', '20261003', '20261130'), cal('03', '0000011', '20261003', '20261130')] })
    expect(defaultServiceDate(feed, { start: '20261003', end: '20261130' }, '20250101')).toBe('20261005')
  })

  it('期間の最後の日が今日でも扱える', () => {
    expect(defaultServiceDate(DOHOKU_LIKE, PERIOD, '20261130')).toBe('20261130')
  })

  it('calendar_dates.txt だけのフィードは、月〜金で便がある最初の日', () => {
    const feed = feedOf({ calendar_dates: [ex('A', '20261107', '1'), ex('A', '20261110', '1'), ex('A', '20261111', '1')] })
    expect(defaultServiceDate(feed, { start: '20261107', end: '20261111' }, '20261101')).toBe('20261110')
  })

  it('月〜金に便が無ければ、便がある最初の日', () => {
    const feed = feedOf({ calendar: [cal('W', '0000011', '20261101', '20261130')] })
    expect(defaultServiceDate(feed, { start: '20261101', end: '20261130' }, '20261102')).toBe('20261107')
  })

  it('便のある日が無ければ、探し始めた日', () => {
    const feed = feedOf({ calendar: [] })
    expect(defaultServiceDate(feed, { start: '20261101', end: '20261105' }, '20261103')).toBe('20261103')
  })

  it('運行期間が無ければ null', () => {
    expect(defaultServiceDate(DOHOKU_LIKE, null, '20261104')).toBeNull()
  })

  it('99991231 で終わる期間でも、範囲外のエラーにならない', () => {
    const feed = feedOf({ calendar: [cal('W', '0000011', '99991225', '99991231')] })
    expect(defaultServiceDate(feed, { start: '99991225', end: '99991231' }, '99991229')).toBe('99991229')
  })
})

// ---- 実データ(data/raw/gtfs/ に ZIP があるときだけ) ----
const ZIPS = {
  減便前: fileURLToPath(new URL('../../../data/raw/gtfs/dohoku_bus_減便前.zip', import.meta.url)),
  減便後: fileURLToPath(new URL('../../../data/raw/gtfs/dohoku_bus_減便後.zip', import.meta.url)),
}

for (const [name, path] of Object.entries(ZIPS)) {
  describe.skipIf(!existsSync(path))(`実データ(道北バス ${name})`, () => {
    it('今日が 2026-11-03(祝日)なら、既定の日付は 11/4(水)', async () => {
      const feed = await loadGtfsZip(new Uint8Array(readFileSync(path)).buffer)
      const period = feedServicePeriod(feed)
      expect(defaultServiceDate(feed, period, '20261103')).toBe('20261104')
      const holiday = describeServiceDay(feed, '20261103')
      expect(holiday.serviceIds).toEqual(['06'])
      expect(holiday.added).toEqual(['06'])
      expect(holiday.removed).toEqual(['01'])
    })
  })
}
