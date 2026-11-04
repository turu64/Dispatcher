import { describe, expect, it } from 'vitest'
import { BOUND_LIMIT_MIN, DUTY_DEFAULTS } from '@/gtfs/edit/duties'
import {
  driverCaveats,
  formatDiff,
  formatHours,
  formatHoursDiff,
  formatRatioDiff,
  parseCheckMinutes,
  parseDeadheadKmh,
  parseShortage,
  verdictText,
} from './driverText'

describe('verdictText(欠員との比較の文)', () => {
  it('足りる・足りないは「目安」と書き、数は判定から入れる', () => {
    expect(verdictText({ kind: 'enough', reduced: 25, shortage: 20 }, '20261104')).toBe(
      '減便で減る勤務の数(目安)25 ≥ 欠員 20 → 足りる目安です。',
    )
    expect(verdictText({ kind: 'short', reduced: 14, shortage: 20, missing: 6 }, '20261104')).toBe(
      '減便で減る勤務の数(目安)14 < 欠員 20 → あと 6 足りない目安です。',
    )
  })

  it('平日でない日は、前後で差が無いことと、平日の日付の選び方を書く', () => {
    const text = verdictText({ kind: 'notWeekday' }, '20261107')
    expect(text).toContain('2026年11月7日(土)')
    expect(text).toContain('減便の前後で便と勤務の数は変わりません')
    expect(text).toContain('地図の下の操作盤')
  })

  it('減便後が無いとき・欠員が無いときの文', () => {
    expect(verdictText({ kind: 'noEdited' }, '20261104')).toContain('減便の方針を承認すると')
    expect(verdictText({ kind: 'noShortage', reduced: 25 }, '20261104')).toBe(
      '減便で減る勤務の数(目安)は 25 です。欠員を入れると、足りるかの目安を出します。',
    )
  })

  it('どの文も「あなた」を使わない', () => {
    const all = [
      verdictText({ kind: 'noEdited' }, '20261104'),
      verdictText({ kind: 'notWeekday' }, '20261107'),
      verdictText({ kind: 'noShortage', reduced: 1 }, '20261104'),
      verdictText({ kind: 'enough', reduced: 1, shortage: 1 }, '20261104'),
      verdictText({ kind: 'short', reduced: 1, shortage: 2, missing: 1 }, '20261104'),
      ...driverCaveats(DUTY_DEFAULTS),
      ...driverCaveats(DUTY_DEFAULTS, [{ kind: 'rest', name: '休憩所', lat: 0, lon: 0 }]),
    ]
    for (const line of all) expect(line).not.toContain('あなた')
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

  it('拘束を 15 時間にすると文も 15 時間になり、施設を置くと回送と休憩の文が変わる', () => {
    const text = driverCaveats({ ...DUTY_DEFAULTS, maxBoundMin: BOUND_LIMIT_MIN.extended }, [
      { kind: 'depot', name: '車庫', lat: 0, lon: 0 },
      { kind: 'rest', name: '休憩所', lat: 0, lon: 0 },
    ]).join('\n')
    expect(text).toContain('拘束 15 時間')
    expect(text).toContain('最寄りの営業所・車庫')
    expect(text).toContain('前の便の終着か次の便の始発のどちらかが休憩施設・営業所の近くなら')
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
