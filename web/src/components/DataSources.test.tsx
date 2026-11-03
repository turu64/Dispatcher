import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { HolidayList } from '@/gtfs/holidays'
import { useHolidayStore, type HolidayState } from '@/store/holidays'
import DataSources, { DataSourcesView } from './DataSources'

const SOURCE = '内閣府「国民の祝日について」の祝日一覧(syukujitsu.csv)を加工して作成'

const list: HolidayList = {
  names: new Map([['20261103', '文化の日']]),
  first: '19550101',
  coveredUntil: '20271231',
  source: SOURCE,
}

const ready: HolidayState = { status: 'ready', list }

describe('DataSourcesView', () => {
  it('祝日一覧が ready のとき、画面に祝日の出典と利用条件が出る', () => {
    const html = renderToStaticMarkup(<DataSourcesView holidays={ready} />)
    expect(html).toContain('データの出典')
    expect(html).toContain('国民の祝日(内閣府)')
    expect(html).toContain('syukujitsu.csv')
    expect(html).toContain('を加工して作成')
    expect(html).toContain('公共データ利用規約(第1.0版)')
  })

  it('祝日一覧が無いとき、祝日の行は出ない(ほかの出典は出る)', () => {
    const html = renderToStaticMarkup(<DataSourcesView holidays={{ status: 'missing' }} />)
    expect(html).not.toContain('国民の祝日')
    expect(html).toContain('北海道オープンデータプラットフォーム')
    expect(html).toContain('OpenStreetMap Japan')
  })
})

describe('DataSources', () => {
  it('まだ読み込んでいない最初の描画では、祝日の行は出ない', () => {
    // サーバー側の描画(renderToStaticMarkup)は store の初期状態を使う
    const html = renderToStaticMarkup(<DataSources />)
    expect(html).toContain('データの出典')
    expect(html).not.toContain('国民の祝日')
    expect(useHolidayStore.getState().holidays.status).toBe('idle')
  })
})
