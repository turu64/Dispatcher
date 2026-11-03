import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { weekdayIndex } from './calendar'
import { fetchHolidays, holidaysBetween, parseHolidayJson, uncoveredRanges, type HolidayList } from './holidays'

/** data/ の dispatcher-holidays が書く JSON と同じ形(小さな例) */
function sampleJson(overrides: Record<string, unknown> = {}) {
  return {
    source: '内閣府「国民の祝日について」の祝日一覧(syukujitsu.csv)を加工して作成',
    url: 'https://www8.cao.go.jp/chosei/shukujitsu/syukujitsu.csv',
    first: '20261103',
    last: '20270322',
    coveredUntil: '20271231',
    holidays: [
      ['20261103', '文化の日'],
      ['20261123', '勤労感謝の日'],
      ['20270101', '元日'],
      ['20270111', '成人の日'],
      ['20270211', '建国記念の日'],
      ['20270223', '天皇誕生日'],
      ['20270321', '春分の日'],
      ['20270322', '休日'],
    ],
    ...overrides,
  }
}

function sampleList(): HolidayList {
  return parseHolidayJson(sampleJson())
}

// parseHolidayJson
describe('祝日の JSON を読み、形が違えば日本語のエラーにする', () => {
  it('JSON を祝日一覧にする', () => {
    const list = parseHolidayJson(sampleJson())
    expect(list.first).toBe('20261103')
    expect(list.coveredUntil).toBe('20271231')
    expect(list.source).toBe('内閣府「国民の祝日について」の祝日一覧(syukujitsu.csv)を加工して作成')
    expect(list.names.size).toBe(8)
    expect(list.names.get('20261103')).toBe('文化の日')
    expect(list.names.get('20270322')).toBe('休日')
    expect(list.names.has('20261104')).toBe(false)
  })

  it('日付の昇順に並べて持つ', () => {
    const list = parseHolidayJson(
      sampleJson({
        holidays: [
          ['20270111', '成人の日'],
          ['20261103', '文化の日'],
        ],
      }),
    )
    expect([...list.names.keys()]).toEqual(['20261103', '20270111'])
  })

  it('祝日が 1 件も無くても読める', () => {
    const list = parseHolidayJson(sampleJson({ holidays: [] }))
    expect(list.names.size).toBe(0)
  })

  it.each([
    ['null', null],
    ['配列', []],
    ['文字列', 'x'],
    ['source が無い', sampleJson({ source: undefined })],
    ['source が空', sampleJson({ source: ' ' })],
    ['first が無い', sampleJson({ first: undefined })],
    ['first が日付でない', sampleJson({ first: '2026-11-03' })],
    ['first が実在しない日付', sampleJson({ first: '20260230' })],
    ['coveredUntil が数', sampleJson({ coveredUntil: 20271231 })],
    ['first が coveredUntil より後', sampleJson({ first: '20280101' })],
    ['holidays が配列でない', sampleJson({ holidays: {} })],
    ['holidays の要素が組でない', sampleJson({ holidays: ['20261103'] })],
    ['holidays の要素が 3 つ', sampleJson({ holidays: [['20261103', '文化の日', 'x']] })],
    ['名称が文字列でない', sampleJson({ holidays: [['20261103', 1]] })],
    ['祝日の日付が実在しない', sampleJson({ holidays: [['20261131', '文化の日']] })],
    ['祝日の日付が範囲の前', sampleJson({ holidays: [['20261102', '文化の日']] })],
    ['祝日の日付が範囲の後', sampleJson({ holidays: [['20280101', '元日']] })],
    [
      '同じ日付が 2 回',
      sampleJson({
        holidays: [
          ['20261103', '文化の日'],
          ['20261103', '文化の日'],
        ],
      }),
    ],
  ])('形が違えば日本語のエラー:%s', (_name, json) => {
    expect(() => parseHolidayJson(json)).toThrowError(/祝日一覧の形が違います/)
  })

  it('エラーには何件目かが入る', () => {
    expect(() =>
      parseHolidayJson(
        sampleJson({
          holidays: [
            ['20261103', '文化の日'],
            ['20261131', '勤労感謝の日'],
          ],
        }),
      ),
    ).toThrowError(/holidays の 2 件目/)
  })
})

describe('fetchHolidays', () => {
  const response = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => body })

  it('/api/holidays を読んで祝日一覧にする', async () => {
    const fetchFn = vi.fn(async () => response(200, sampleJson()))
    const list = await fetchHolidays(fetchFn)
    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect(fetchFn).toHaveBeenCalledWith('/api/holidays')
    expect(list?.names.get('20261103')).toBe('文化の日')
  })

  it('404 は null(エラーにしない)', async () => {
    const fetchFn = vi.fn(async () => response(404, { detail: '祝日一覧が見つかりません。' }))
    expect(await fetchHolidays(fetchFn)).toBeNull()
  })

  it('404 以外の失敗はエラー(状態番号を含む)', async () => {
    await expect(fetchHolidays(async () => response(500, null))).rejects.toThrowError(/祝日一覧を取得できませんでした\(500\)/)
    await expect(fetchHolidays(async () => response(403, null))).rejects.toThrowError(/\(403\)/)
  })

  it('通信の失敗はエラー', async () => {
    const fetchFn = vi.fn(async () => {
      throw new TypeError('Failed to fetch')
    })
    await expect(fetchHolidays(fetchFn)).rejects.toThrowError(/サーバーに接続できません/)
  })

  it('JSON でない本文はエラー', async () => {
    const fetchFn = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => Promise.reject(new SyntaxError('Unexpected token')),
    }))
    await expect(fetchHolidays(fetchFn)).rejects.toThrowError(/JSON として読めません/)
  })

  it('形が違う JSON はエラー', async () => {
    await expect(fetchHolidays(async () => response(200, { holidays: 1 }))).rejects.toThrowError(/祝日一覧の形が違います/)
  })

  it('引数を省くと fetch を使う', async () => {
    const stub = vi.fn(async () => new Response(JSON.stringify(sampleJson()), { status: 200 }))
    vi.stubGlobal('fetch', stub)
    try {
      const list = await fetchHolidays()
      expect(stub).toHaveBeenCalledWith('/api/holidays')
      expect(list?.first).toBe('20261103')
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

// holidaysBetween
describe('期間の中の祝日を並べる', () => {
  const list = sampleList()

  it('両端を含み、日付の昇順で返す', () => {
    expect(holidaysBetween(list, '20261103', '20261123')).toEqual([
      { date: '20261103', name: '文化の日' },
      { date: '20261123', name: '勤労感謝の日' },
    ])
  })

  it('端の 1 日外は含まない', () => {
    expect(holidaysBetween(list, '20261104', '20261122')).toEqual([])
    expect(holidaysBetween(list, '20261104', '20261123')).toEqual([{ date: '20261123', name: '勤労感謝の日' }])
  })

  it('1 日だけの範囲', () => {
    expect(holidaysBetween(list, '20270101', '20270101')).toEqual([{ date: '20270101', name: '元日' }])
    expect(holidaysBetween(list, '20270102', '20270102')).toEqual([])
  })

  it('年をまたぐ範囲', () => {
    expect(holidaysBetween(list, '20261201', '20270111').map((h) => h.date)).toEqual(['20270101', '20270111'])
  })

  it('開始が終了より後なら空', () => {
    expect(holidaysBetween(list, '20270111', '20270101')).toEqual([])
  })

  it('範囲が収録より広くても、あるものだけ返す', () => {
    expect(holidaysBetween(list, '19000101', '29991231')).toHaveLength(8)
  })

  it('Map の順が昇順でなくても昇順で返す', () => {
    const shuffled: HolidayList = {
      ...list,
      names: new Map([
        ['20270111', '成人の日'],
        ['20261103', '文化の日'],
      ]),
    }
    expect(holidaysBetween(shuffled, '20261101', '20270131').map((h) => h.date)).toEqual(['20261103', '20270111'])
  })
})

// uncoveredRanges
describe('収録の範囲の外を返す', () => {
  // 収録は 20261103〜20271231
  const list = sampleList()

  it('収録の範囲の中なら空', () => {
    expect(uncoveredRanges(list, '20261103', '20271231')).toEqual([])
    expect(uncoveredRanges(list, '20270101', '20270131')).toEqual([])
  })

  it('範囲の後にはみ出す部分', () => {
    expect(uncoveredRanges(list, '20271201', '20280115')).toEqual([{ start: '20280101', end: '20280115' }])
    // 端の 1 日だけ外
    expect(uncoveredRanges(list, '20271231', '20280101')).toEqual([{ start: '20280101', end: '20280101' }])
  })

  it('全部が範囲の後なら、期間そのまま', () => {
    expect(uncoveredRanges(list, '20280201', '20280228')).toEqual([{ start: '20280201', end: '20280228' }])
  })

  it('範囲の前にはみ出す部分', () => {
    expect(uncoveredRanges(list, '20261101', '20261110')).toEqual([{ start: '20261101', end: '20261102' }])
    expect(uncoveredRanges(list, '20261102', '20261103')).toEqual([{ start: '20261102', end: '20261102' }])
  })

  it('全部が範囲の前なら、期間そのまま', () => {
    expect(uncoveredRanges(list, '20260101', '20261031')).toEqual([{ start: '20260101', end: '20261031' }])
  })

  it('前後の両方にはみ出すなら 2 つ(前、後の順)', () => {
    expect(uncoveredRanges(list, '20261001', '20280131')).toEqual([
      { start: '20261001', end: '20261102' },
      { start: '20280101', end: '20280131' },
    ])
  })

  it('開始が終了より後なら空', () => {
    expect(uncoveredRanges(list, '20280201', '20280101')).toEqual([])
  })

  it('収録の終わりが月末でも翌日を求められる', () => {
    const l: HolidayList = { ...list, coveredUntil: '20281231' }
    expect(uncoveredRanges(l, '20281230', '20290102')).toEqual([{ start: '20290101', end: '20290102' }])
  })
})

// ---- 実データ(data/ が作った JSON。無ければ飛ばす) ----

const REAL_JSON = fileURLToPath(new URL('../../../data/out/ref/holidays.json', import.meta.url))

describe.skipIf(!existsSync(REAL_JSON))('実データの祝日一覧(data/out/ref/holidays.json)', () => {
  const list = parseHolidayJson(JSON.parse(readFileSync(REAL_JSON, 'utf-8')))

  it('1955 年から最後の祝日の年の終わりまで収録している', () => {
    expect(list.first).toBe('19550101')
    expect(list.names.size).toBeGreaterThanOrEqual(1067)
    const lastDate = [...list.names.keys()].at(-1)!
    expect(lastDate >= '20271123').toBe(true)
    expect(list.coveredUntil).toBe(`${lastDate.slice(0, 4)}1231`)
    expect(list.source).toContain('内閣府')
  })

  it('2026-11-03 は文化の日', () => {
    expect(list.names.get('20261103')).toBe('文化の日')
  })

  it('2027 年の平日の祝日 5 日(1/1・1/11・2/11・2/23・3/22)が祝日になっている', () => {
    const range = holidaysBetween(list, '20270101', '20270331')
    expect(range.map((h) => `${h.date}:${h.name}`)).toEqual([
      '20270101:元日',
      '20270111:成人の日',
      '20270211:建国記念の日',
      '20270223:天皇誕生日',
      '20270321:春分の日',
      '20270322:休日',
    ])
    // 平日(月〜金)に当たるのは 3/21 を除く 5 日(3/21 は日曜で、翌日の 3/22 が「休日」になる)
    const weekdays = range.filter((h) => weekdayIndex(h.date) < 5)
    expect(weekdays.map((h) => h.date)).toEqual(['20270101', '20270111', '20270211', '20270223', '20270322'])
  })

  it('道北バスの期間(2026-11-01〜2027-03-31)は全部が収録の範囲の中', () => {
    expect(uncoveredRanges(list, '20261101', '20270331')).toEqual([])
  })
})
