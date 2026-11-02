import { describe, expect, it } from 'vitest'
import { activeServiceIds, addDays, feedServicePeriod, isValidGtfsDate, weekdayIndex } from './calendar'
import type { GtfsFeed, GtfsRow } from './load'

const CALENDAR_FIELDS = [
  'service_id',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
  'start_date',
  'end_date',
]
const CALENDAR_DATES_FIELDS = ['service_id', 'date', 'exception_type']

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

/** テスト用のフィード。表を渡さなければ、そのファイルが無いフィードになる */
function feedOf(tables: { calendar?: GtfsRow[]; calendar_dates?: GtfsRow[] }): GtfsFeed {
  const map: GtfsFeed['tables'] = new Map()
  if (tables.calendar) {
    map.set('calendar', { fileName: 'calendar.txt', fields: CALENDAR_FIELDS, rows: tables.calendar })
  }
  if (tables.calendar_dates) {
    map.set('calendar_dates', {
      fileName: 'calendar_dates.txt',
      fields: CALENDAR_DATES_FIELDS,
      rows: tables.calendar_dates,
    })
  }
  return { tables: map, warnings: [] }
}

/** 平日・土曜・日祝の3つ。期間は 2026-10-01(木)〜2026-11-30(月) */
const BASE_CALENDAR = [
  cal('平日', '1111100', '20261001', '20261130'),
  cal('土曜', '0000010', '20261001', '20261130'),
  cal('日祝', '0000001', '20261001', '20261130'),
]

function ids(feed: GtfsFeed, date: string): string[] {
  return [...activeServiceIds(feed, date)].sort()
}

describe('isValidGtfsDate', () => {
  it('実在する8桁の日付を受け付ける', () => {
    for (const s of ['20261102', '20261231', '20270101', '20280229', '20000229', '19991231']) {
      expect(isValidGtfsDate(s), s).toBe(true)
    }
  })

  it('存在しない月日を受け付けない', () => {
    for (const s of ['20261332', '20261301', '20260001', '20261100', '20261131', '20260431', '20270229', '21000229']) {
      expect(isValidGtfsDate(s), s).toBe(false)
    }
  })

  it('8桁の数字でなければ受け付けない(区切り、桁の過不足、前後の空白、全角数字)', () => {
    for (const s of ['2026-11-02', '2026/11/02', '2026112', '202611021', ' 20261102', '20261102 ', '', 'abcdefgh', '２０２６１１０２']) {
      expect(isValidGtfsDate(s), JSON.stringify(s)).toBe(false)
    }
  })
})

describe('addDays', () => {
  it('前後に日をずらす。0 日ならそのまま', () => {
    expect(addDays('20261102', 1)).toBe('20261103')
    expect(addDays('20261102', 0)).toBe('20261102')
    expect(addDays('20261102', -7)).toBe('20261026')
  })

  it('月末をまたぐ(負の n も)', () => {
    expect(addDays('20261031', 1)).toBe('20261101')
    expect(addDays('20261101', -1)).toBe('20261031')
    expect(addDays('20261130', 1)).toBe('20261201')
    expect(addDays('20260430', 1)).toBe('20260501')
  })

  it('年末をまたぐ(負の n も)', () => {
    expect(addDays('20261231', 1)).toBe('20270101')
    expect(addDays('20270101', -1)).toBe('20261231')
  })

  it('うるう年の 2月29日を扱う', () => {
    expect(addDays('20280228', 1)).toBe('20280229')
    expect(addDays('20280229', 1)).toBe('20280301')
    expect(addDays('20280301', -1)).toBe('20280229')
    // うるう年でない年は 2月28日の次が 3月1日
    expect(addDays('20270228', 1)).toBe('20270301')
    expect(addDays('20270301', -1)).toBe('20270228')
  })

  it('1年以上ずらす', () => {
    expect(addDays('20261102', 365)).toBe('20271102')
    expect(addDays('20280101', 366)).toBe('20290101')
    expect(addDays('20261102', 10000)).toBe('20540320')
    expect(addDays('20261102', -10000)).toBe('19990617')
  })

  it('不正な日付や整数でない日数はエラーにする', () => {
    expect(() => addDays('20261332', 1)).toThrow('日付の形が正しくありません')
    expect(() => addDays('2026-11-02', 1)).toThrow('日付の形が正しくありません')
    expect(() => addDays('20261102', 1.5)).toThrow('ずらす日数は整数で指定してください')
    expect(() => addDays('20261102', Number.NaN)).toThrow('ずらす日数は整数で指定してください')
  })
})

describe('weekdayIndex', () => {
  it('0=月曜 … 6=日曜で返す', () => {
    expect(weekdayIndex('20261102')).toBe(0) // 月
    expect(weekdayIndex('20261103')).toBe(1) // 火
    expect(weekdayIndex('20261107')).toBe(5) // 土
    expect(weekdayIndex('20261108')).toBe(6) // 日
  })

  it('過去・未来の既知の曜日と一致する', () => {
    expect(weekdayIndex('19700101')).toBe(3) // 木
    expect(weekdayIndex('20000101')).toBe(5) // 土
    expect(weekdayIndex('20270101')).toBe(4) // 金
    expect(weekdayIndex('20280229')).toBe(1) // 火
  })

  it('addDays で n 日ずらすと曜日も n だけ進む', () => {
    const base = weekdayIndex('20261102')
    for (let n = -800; n <= 800; n += 1) {
      expect(weekdayIndex(addDays('20261102', n))).toBe((((base + n) % 7) + 7) % 7)
    }
  })

  it('不正な日付はエラーにする', () => {
    expect(() => weekdayIndex('20261332')).toThrow('日付の形が正しくありません')
  })
})

describe('activeServiceIds', () => {
  it('曜日の列で判定する', () => {
    const feed = feedOf({ calendar: BASE_CALENDAR })
    expect(ids(feed, '20261102')).toEqual(['平日']) // 月
    expect(ids(feed, '20261103')).toEqual(['平日']) // 火(calendar_dates が無ければ祝日も平日)
    expect(ids(feed, '20261106')).toEqual(['平日']) // 金
    expect(ids(feed, '20261107')).toEqual(['土曜'])
    expect(ids(feed, '20261108')).toEqual(['日祝'])
  })

  it('start_date と end_date の当日を含み、その外は含まない', () => {
    const feed = feedOf({ calendar: BASE_CALENDAR })
    expect(ids(feed, '20261001')).toEqual(['平日']) // 開始日(木)
    expect(ids(feed, '20261130')).toEqual(['平日']) // 終了日(月)
    expect(ids(feed, '20260930')).toEqual([])
    expect(ids(feed, '20261201')).toEqual([])
  })

  it('期間が1日だけの行も、その日の曜日が合えば運行とする', () => {
    const feed = feedOf({ calendar: [cal('特別', '0000010', '20261107', '20261107')] })
    expect(ids(feed, '20261107')).toEqual(['特別'])
    expect(ids(feed, '20261114')).toEqual([])
  })

  it('exception_type=1 は追加、2 は削除として calendar より優先する', () => {
    const feed = feedOf({
      calendar: BASE_CALENDAR,
      calendar_dates: [ex('平日', '20261103', '2'), ex('日祝', '20261103', '1')],
    })
    expect(ids(feed, '20261103')).toEqual(['日祝'])
    // ほかの日は calendar のまま
    expect(ids(feed, '20261104')).toEqual(['平日'])
    expect(ids(feed, '20261108')).toEqual(['日祝'])
  })

  it('calendar の期間の外や、曜日の列が 0 の日でも exception_type=1 なら運行とする', () => {
    const feed = feedOf({
      calendar: BASE_CALENDAR,
      calendar_dates: [ex('日祝', '20261231', '1'), ex('土曜', '20261102', '1')],
    })
    expect(ids(feed, '20261231')).toEqual(['日祝'])
    expect(ids(feed, '20261102')).toEqual(['土曜', '平日']) // 並びは文字コード順
  })

  it('運行しない日の exception_type=2 は何も変えない', () => {
    const feed = feedOf({ calendar: BASE_CALENDAR, calendar_dates: [ex('土曜', '20261103', '2')] })
    expect(ids(feed, '20261103')).toEqual(['平日'])
  })

  it('calendar_dates.txt だけのフィードを扱う', () => {
    const feed = feedOf({
      calendar_dates: [ex('A', '20261102', '1'), ex('B', '20261103', '1'), ex('A', '20261103', '1'), ex('A', '20261104', '2')],
    })
    expect(ids(feed, '20261102')).toEqual(['A'])
    expect(ids(feed, '20261103')).toEqual(['A', 'B'])
    expect(ids(feed, '20261104')).toEqual([])
  })

  it('calendar.txt と calendar_dates.txt のどちらも無ければ空', () => {
    expect(ids(feedOf({}), '20261102')).toEqual([])
    expect(ids(feedOf({ calendar: [], calendar_dates: [] }), '20261102')).toEqual([])
  })

  it('calendar_dates に calendar に無い service_id があっても扱う', () => {
    const feed = feedOf({
      calendar: BASE_CALENDAR,
      calendar_dates: [ex('臨時', '20261102', '1'), ex('臨時', '20261103', '2')],
    })
    expect(ids(feed, '20261102')).toEqual(['平日', '臨時'])
    expect(ids(feed, '20261103')).toEqual(['平日'])
  })

  it('キーと値の前後の空白を取って照合し、空白を取った service_id を返す', () => {
    const feed = feedOf({
      calendar: [{ ...cal(' 平日 ', '1111100', ' 20261001 ', '20261130 '), monday: ' 1 ' }],
      calendar_dates: [ex('平日 ', ' 20261103', ' 2 '), ex(' 日祝', '20261103 ', '1 ')],
    })
    expect([...activeServiceIds(feed, '20261102')]).toEqual(['平日'])
    expect([...activeServiceIds(feed, '20261103')]).toEqual(['日祝'])
  })

  it('同じ service_id・日付に exception_type 1 と 2 の両方があれば、行の順に関係なく削除を優先する', () => {
    const addThenRemove = feedOf({ calendar_dates: [ex('A', '20261102', '1'), ex('A', '20261102', '2')] })
    const removeThenAdd = feedOf({ calendar_dates: [ex('A', '20261102', '2'), ex('A', '20261102', '1')] })
    expect(ids(addThenRemove, '20261102')).toEqual([])
    expect(ids(removeThenAdd, '20261102')).toEqual([])
  })

  it('日付が不正な行、service_id が空の行、1・2 以外の exception_type は数えない', () => {
    const feed = feedOf({
      calendar: [
        cal('不正な開始日', '1111111', '20261332', '20261130'),
        cal('不正な終了日', '1111111', '20261001', '2026-11-30'),
        cal('', '1111111', '20261001', '20261130'),
        cal('平日', '1111100', '20261001', '20261130'),
      ],
      calendar_dates: [ex('臨時', '2026-11-02', '1'), ex('臨時2', '20261102', '3'), ex('平日', '20261102', ''), ex('', '20261102', '1')],
    })
    expect(ids(feed, '20261102')).toEqual(['平日'])
  })

  it('列が無い行は、その列が空とみなす', () => {
    const feed = feedOf({
      calendar: [{ service_id: '列なし', start_date: '20261001', end_date: '20261130' }],
      calendar_dates: [{ service_id: '日付なし', exception_type: '1' }],
    })
    expect(ids(feed, '20261102')).toEqual([])
  })

  it('不正な日付を渡すとエラーにする', () => {
    const feed = feedOf({ calendar: BASE_CALENDAR })
    expect(() => activeServiceIds(feed, '20261332')).toThrow('日付の形が正しくありません')
    expect(() => activeServiceIds(feed, '2026-11-02')).toThrow('日付の形が正しくありません')
  })
})

describe('feedServicePeriod', () => {
  it('calendar の期間を返す', () => {
    expect(feedServicePeriod(feedOf({ calendar: BASE_CALENDAR }))).toEqual({ start: '20261001', end: '20261130' })
  })

  it('期間の違う行があれば、最も早い開始日と最も遅い終了日を返す', () => {
    const feed = feedOf({
      calendar: [cal('前期', '1111100', '20261001', '20261031'), cal('後期', '1111100', '20261101', '20270331')],
    })
    expect(feedServicePeriod(feed)).toEqual({ start: '20261001', end: '20270331' })
  })

  it('calendar の期間の外の追加日(exception_type=1)で期間を広げる', () => {
    const feed = feedOf({
      calendar: BASE_CALENDAR,
      calendar_dates: [ex('日祝', '20260920', '1'), ex('日祝', '20261231', '1')],
    })
    expect(feedServicePeriod(feed)).toEqual({ start: '20260920', end: '20261231' })
  })

  it('削除日(exception_type=2)では期間を広げない', () => {
    const feed = feedOf({
      calendar: BASE_CALENDAR,
      calendar_dates: [ex('平日', '20260901', '2'), ex('平日', '20261215', '2')],
    })
    expect(feedServicePeriod(feed)).toEqual({ start: '20261001', end: '20261130' })
  })

  it('calendar_dates.txt だけのフィードでは追加日の最小・最大を返す', () => {
    const feed = feedOf({
      calendar_dates: [ex('A', '20261103', '1'), ex('A', '20261102', '1'), ex('B', '20261123', '1'), ex('A', '20261130', '2')],
    })
    expect(feedServicePeriod(feed)).toEqual({ start: '20261102', end: '20261123' })
  })

  it('運行日を生まない行(曜日がすべて 0、開始日が終了日より後、日付が不正)は数えない', () => {
    const feed = feedOf({
      calendar: [
        cal('運行なし', '0000000', '20260101', '20261231'),
        cal('逆順', '1111111', '20261231', '20260101'),
        cal('不正', '1111111', '20261332', '20271231'),
        cal('平日', '1111100', '20261001', '20261130'),
      ],
      calendar_dates: [ex('臨時', '2026-12-31', '1')],
    })
    expect(feedServicePeriod(feed)).toEqual({ start: '20261001', end: '20261130' })
  })

  it('前後の空白を取った日付を返す', () => {
    const feed = feedOf({ calendar: [cal(' 平日 ', '1111100', ' 20261001', '20261130 ')] })
    expect(feedServicePeriod(feed)).toEqual({ start: '20261001', end: '20261130' })
  })

  it('運行日が1つも無ければ null', () => {
    expect(feedServicePeriod(feedOf({}))).toBeNull()
    expect(feedServicePeriod(feedOf({ calendar: [], calendar_dates: [] }))).toBeNull()
    expect(feedServicePeriod(feedOf({ calendar: [cal('運行なし', '0000000', '20261001', '20261130')] }))).toBeNull()
    expect(feedServicePeriod(feedOf({ calendar_dates: [ex('A', '20261103', '2')] }))).toBeNull()
  })
})
