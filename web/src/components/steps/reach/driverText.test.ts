import { describe, expect, it } from 'vitest'
import { BOUND_LIMIT_MIN, DUTY_DEFAULTS } from '@/gtfs/edit/duties'
import {
  assumptionsSummary,
  driverCaveats,
  formatDiff,
  formatHours,
  formatHoursDiff,
  formatRatioDiff,
  needBasisText,
  parseCheckMinutes,
  parseDeadheadKmh,
  parseRoster,
  parseShortage,
  parseWorkDays,
  ROSTER_HINT,
  supplyText,
  supplyWarningText,
  verdictText,
} from './driverText'
import { driverNeedOf, driverSupplyOf, driverVerdictOf, type DriverVerdict } from '@/store/drivers'

describe('verdictText(乗務できる運転士の数(目安)と減便後に要る勤務の数の比較の文)', () => {
  it('足りる・足りないは「目安」と書き、減便前のままでの過不足も並べる', () => {
    const enough: DriverVerdict = { kind: 'enough', available: 88, needed: 70, spare: 18, beforeNeeded: 101, beforeMargin: -13 }
    expect(verdictText(enough, '20261104')).toBe(
      '減便後に要る勤務の数 70 に対して、乗務できる運転士の数(目安)88 → 足りる目安です(余り 18)。減便前のままでは 13 足りない目安です。',
    )
    const short: DriverVerdict = { kind: 'short', available: 60, needed: 70, missing: 10, beforeNeeded: 101, beforeMargin: -41 }
    expect(verdictText(short, '20261104')).toBe(
      '減便後に要る勤務の数 70 に対して、乗務できる運転士の数(目安)60 → あと 10 足りない目安です。減便前のままでは 41 足りない目安です。',
    )
    const both: DriverVerdict = { kind: 'enough', available: 110, needed: 70, spare: 40, beforeNeeded: 101, beforeMargin: 9 }
    expect(verdictText(both, '20261104')).toContain('減便前のままでも足りる目安です(余り 9)。')
    const zero: DriverVerdict = { kind: 'enough', available: 101, needed: 70, spare: 31, beforeNeeded: 101, beforeMargin: 0 }
    expect(verdictText(zero, '20261104')).toContain('減便前のままでも足りる目安です(余り 0)。')
  })

  it('平日でない日は、前後で差が無いことと、平日の日付の選び方を書く', () => {
    const text = verdictText({ kind: 'notWeekday' }, '20261107')
    expect(text).toContain('2026年11月7日(土)')
    expect(text).toContain('減便の前後で便と勤務の数は変わりません')
    expect(text).toContain('地図の下の操作盤')
  })

  it('減便後が無いとき・在籍の運転士の数が無いときの文', () => {
    expect(verdictText({ kind: 'noEdited' }, '20261104')).toContain('減便の方針を承認すると')
    expect(verdictText({ kind: 'noRoster' }, '20261104')).toBe('在籍の運転士の数を入れると、足りるかの目安を出します。')
    expect(ROSTER_HINT).toBe('在籍の運転士の数を入れると、足りるかの目安を出します。')
  })

  it('どの文も「あなた」を使わない', () => {
    const supply = driverSupplyOf(150, 5, 19)!
    const all = [
      verdictText({ kind: 'noEdited' }, '20261104'),
      verdictText({ kind: 'notWeekday' }, '20261107'),
      verdictText({ kind: 'noRoster' }, '20261104'),
      verdictText(driverVerdictOf(supply, driverNeedOf(101, 79, 55), true), '20261104'),
      verdictText(driverVerdictOf(supply, driverNeedOf(null, 79, 99), true), '20261104'),
      supplyText(supply),
      supplyText(driverSupplyOf(150, 5, null)!),
      supplyWarningText(driverSupplyOf(1, 5, 20)!)!,
      needBasisText(driverNeedOf(101, 79, 55)),
      needBasisText(driverNeedOf(null, 79, 55)),
      ...driverCaveats(DUTY_DEFAULTS),
      ...driverCaveats(DUTY_DEFAULTS, [{ name: '営業所', lat: 0, lon: 0 }]),
    ]
    for (const line of all) expect(line).not.toContain('あなた')
  })
})

describe('乗務できる運転士の数(目安)と要る勤務の数の文', () => {
  it('在籍 × 週の出勤日数 ÷ 7(切り捨て)から欠員を引いた数を、式つきで書く', () => {
    expect(supplyText(driverSupplyOf(150, 5, 19)!)).toBe(
      '乗務できる運転士の数(目安)は、在籍 150 × 週の出勤日数 5 ÷ 7 = 107(小数は切り捨て)から欠員 19 を引いた 88 です。',
    )
    expect(supplyText(driverSupplyOf(150, 5, null)!)).toBe(
      '乗務できる運転士の数(目安)は、在籍 150 × 週の出勤日数 5 ÷ 7 = 107(小数は切り捨て)です(欠員は未入力のため 0 として数えました)。',
    )
    expect(supplyWarningText(driverSupplyOf(150, 5, 19)!)).toBeNull()
    expect(supplyWarningText(driverSupplyOf(10, 5, 20)!)).toContain('欠員が、その日に出勤する運転士の数')
  })

  it('運用番号の数から出したか、推定をそのまま使ったかを1文で書く', () => {
    expect(needBasisText(driverNeedOf(101, 79, 55))).toBe(
      '要る勤務の数は、減便前は入力の運用番号の数 101、減便後はそれに推定した勤務の数の比(55/79)を掛けた 70 です(四捨五入)。',
    )
    expect(needBasisText(driverNeedOf(101, 79, null))).toBe('要る勤務の数は、減便前は入力の運用番号の数 101 です。')
    expect(needBasisText(driverNeedOf(null, 79, 55))).toContain('推定した勤務の数(目安。下限の目安)をそのまま使っています')
  })
})

describe('driverCaveats(断り書き)', () => {
  it('下限の目安、改善基準告示 第5条の上限、事業者の判断、出入庫の回送 0、甘めの休憩を書く', () => {
    const text = driverCaveats(DUTY_DEFAULTS).join('\n')
    expect(text).toContain('下限の目安')
    expect(text).toContain('改善基準告示 第5条の上限(拘束 13 時間・運転 9 時間・連続運転 4 時間)')
    for (const word of ['休息期間', '休日', '予備の要員', '36協定', '仕業・交番', '事業者が判断']) expect(text).toContain(word)
    expect(text).toContain('出庫・入庫の回送を 0 として')
    expect(text).toContain('甘めの数え方')
  })

  it('拘束を 15 時間にすると文も 15 時間になり、営業所を置くと回送と休憩の文が変わる', () => {
    const text = driverCaveats({ ...DUTY_DEFAULTS, maxBoundMin: BOUND_LIMIT_MIN.extended }, [
      { name: '営業所A', lat: 0, lon: 0 },
      { name: '営業所B', lat: 0, lon: 0 },
    ]).join('\n')
    expect(text).toContain('拘束 15 時間')
    expect(text).toContain('最寄りの営業所との直線距離')
    expect(text).toContain('営業所から遠い停留所で 1 時間 30 分より長く待つすき間は営業所へ戻って休む')
    // 車庫・休憩施設の語は使わない
    expect(text).not.toMatch(/車庫|休憩施設/)
    expect(driverCaveats(DUTY_DEFAULTS).join('\n')).not.toMatch(/車庫|休憩施設/)
  })
})

describe('assumptionsSummary(仮定の短い一覧)', () => {
  it('置いた営業所の数を「営業所 N か所」と書く', () => {
    expect(assumptionsSummary(DUTY_DEFAULTS, [])).toEqual(['拘束時間の上限 13 時間', '点呼 出庫前 30 分・入庫後 15 分', '回送 時速 30km', '営業所 0 か所'])
    const two = [
      { name: '営業所A', lat: 0, lon: 0 },
      { name: '営業所B', lat: 0, lon: 0 },
    ]
    expect(assumptionsSummary(DUTY_DEFAULTS, two).at(-1)).toBe('営業所 2 か所')
  })
})

describe('数の書き方', () => {
  it('時間と差', () => {
    expect(formatHours(24042)).toBe('400時間42分')
    expect(formatHours(0)).toBe('0時間0分')
    expect(formatHoursDiff(2934)).toBe('−48時間54分')
    expect(formatHoursDiff(-60)).toBe('+1時間0分')
    expect(formatHoursDiff(0)).toBe('±0')
    expect(formatRatioDiff(0.122)).toBe('−12.2%')
    expect(formatRatioDiff(-0.03)).toBe('+3.0%')
    expect(formatDiff(14)).toBe('−14')
    expect(formatDiff(-2, ' 便')).toBe('+2 便')
    expect(formatDiff(0)).toBe('±0')
  })
})

describe('入力の読み取り', () => {
  it('欠員は空なら null、0〜999 の整数、全角の数字も受け付ける', () => {
    expect(parseShortage('')).toEqual({ ok: true, value: null })
    expect(parseShortage('  ')).toEqual({ ok: true, value: null })
    expect(parseShortage('20')).toEqual({ ok: true, value: 20 })
    expect(parseShortage('２０')).toEqual({ ok: true, value: 20 })
    expect(parseShortage('0')).toEqual({ ok: true, value: 0 })
    expect(parseShortage('999')).toEqual({ ok: true, value: 999 })
    expect(parseShortage('1000').ok).toBe(false)
    expect(parseShortage('2.5').ok).toBe(false)
    expect(parseShortage('-1').ok).toBe(false)
    expect(parseShortage('abc').ok).toBe(false)
  })

  it('週の出勤日数は 1〜7 の整数で、空は受け付けない。全角の数字も受け付ける', () => {
    expect(parseWorkDays('5')).toEqual({ ok: true, value: 5 })
    expect(parseWorkDays('５')).toEqual({ ok: true, value: 5 })
    expect(parseWorkDays(' 7 ')).toEqual({ ok: true, value: 7 })
    expect(parseWorkDays('1')).toEqual({ ok: true, value: 1 })
    expect(parseWorkDays('0')).toEqual({ ok: false, message: '1日以上にしてください' })
    expect(parseWorkDays('8')).toEqual({ ok: false, message: '7日以下にしてください' })
    expect(parseWorkDays('5.5').ok).toBe(false)
    expect(parseWorkDays('５．５').ok).toBe(false)
    expect(parseWorkDays('').ok).toBe(false)
  })

  it('在籍の運転士の数は空なら null、0〜9999 の整数', () => {
    expect(parseRoster('')).toEqual({ ok: true, value: null })
    expect(parseRoster('１１０')).toEqual({ ok: true, value: 110 })
    expect(parseRoster('9999')).toEqual({ ok: true, value: 9999 })
    expect(parseRoster('10000')).toEqual({ ok: false, message: '9999人以下にしてください' })
    expect(parseRoster('1.5').ok).toBe(false)
  })

  it('点呼は 0〜120 分、回送の速さは 5〜60 km/h の整数', () => {
    expect(parseCheckMinutes('30')).toEqual({ ok: true, value: 30 })
    expect(parseCheckMinutes('0')).toEqual({ ok: true, value: 0 })
    expect(parseCheckMinutes('121').ok).toBe(false)
    expect(parseCheckMinutes('').ok).toBe(false)
    expect(parseDeadheadKmh('20')).toEqual({ ok: true, value: 20 })
    expect(parseDeadheadKmh('4').ok).toBe(false)
    expect(parseDeadheadKmh('61').ok).toBe(false)
  })
})
