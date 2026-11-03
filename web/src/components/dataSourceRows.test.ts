import { describe, expect, it } from 'vitest'
import type { HolidayList } from '@/gtfs/holidays'
import type { HolidayState } from '@/store/holidays'
import { dataSourceRows } from './dataSourceRows'

const SOURCE = '内閣府「国民の祝日について」の祝日一覧(syukujitsu.csv)を加工して作成'

const list: HolidayList = {
  names: new Map([['20261103', '文化の日']]),
  first: '19550101',
  coveredUntil: '20271231',
  source: SOURCE,
}

const ready: HolidayState = { status: 'ready', list }

describe('dataSourceRows', () => {
  it('祝日一覧を読めていなければ、祝日の行を出さない', () => {
    for (const state of [
      { status: 'idle' },
      { status: 'loading' },
      { status: 'missing' },
      { status: 'error', message: '失敗' },
    ] as const) {
      const rows = dataSourceRows(state)
      expect(rows.map((r) => r.data)).not.toContain('国民の祝日(内閣府)')
      expect(rows).toHaveLength(5)
    }
  })

  it('読めたときだけ「国民の祝日(内閣府)」の行を出す(source の文と利用条件)', () => {
    const row = dataSourceRows(ready).find((r) => r.data === '国民の祝日(内閣府)')
    expect(row).toEqual({
      data: '国民の祝日(内閣府)',
      source: SOURCE,
      license: '公共データ利用規約(第1.0版)',
    })
  })

  it('祝日の行は背景地図の前に入り、ほかの行は変わらない', () => {
    const without = dataSourceRows({ status: 'missing' })
    const withHoliday = dataSourceRows(ready)
    expect(withHoliday).toHaveLength(without.length + 1)
    expect(withHoliday.at(-1)?.data).toBe('背景地図')
    expect(withHoliday.map((r) => r.data).filter((d) => d !== '国民の祝日(内閣府)')).toEqual(without.map((r) => r.data))
  })

  it('行の data は重複しない(画面の key に使う)', () => {
    const data = dataSourceRows(ready).map((r) => r.data)
    expect(new Set(data).size).toBe(data.length)
  })

  it('呼ぶたびに新しい配列を返す(元の一覧を書き換えさせない)', () => {
    const a = dataSourceRows(ready)
    a.pop()
    expect(dataSourceRows(ready)).toHaveLength(6)
  })

  it('施設の参照データを使っていなければ、P11・P29・P04 の行を出さない', () => {
    for (const usage of [undefined, {}, { facilities: false }]) {
      const data = dataSourceRows(ready, usage).map((r) => r.data)
      expect(data.some((d) => /P11|P29|P04/.test(d))).toBe(false)
    }
  })

  it('施設の参照データを使ったときだけ、P11・P29・P04 の行を鉄道駅の後ろに出す(国土数値情報を加工した旨と CC BY 4.0)', () => {
    const rows = dataSourceRows(ready, { facilities: true })
    expect(rows.map((r) => r.data)).toEqual([
      'GTFS(道北バスなど)',
      '人口(令和2年国勢調査 地域メッシュ統計、250m)',
      '人口集中地区(A16、2020年)',
      '鉄道駅(N02、2025年度)',
      'バス停留所(P11、2022年度)',
      '学校(P29、2023年度)',
      '医療機関(P04、2020年度)',
      '国民の祝日(内閣府)',
      '背景地図',
    ])
    for (const r of rows.filter((x) => /P11|P29|P04/.test(x.data))) {
      expect(r.source).toBe('国土数値情報(国土交通省)を加工して作成')
      expect(r.license).toBe('CC BY 4.0')
    }
    // 祝日一覧を読めていなくても、施設の行は出す
    expect(dataSourceRows({ status: 'missing' }, { facilities: true })).toHaveLength(8)
  })

  it('ほかの出典はこれまでどおり出す', () => {
    const data = dataSourceRows({ status: 'idle' }).map((r) => r.data)
    expect(data).toEqual([
      'GTFS(道北バスなど)',
      '人口(令和2年国勢調査 地域メッシュ統計、250m)',
      '人口集中地区(A16、2020年)',
      '鉄道駅(N02、2025年度)',
      '背景地図',
    ])
  })
})
