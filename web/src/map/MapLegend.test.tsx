import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import MapLegend from './MapLegend'

describe('MapLegend', () => {
  it('日付と時間帯、徒歩圏の内外、停留所の出発の有無、鉄道駅を出す', () => {
    const html = renderToString(<MapLegend caption="2026年11月4日(水) 9〜12時の徒歩圏" computing={false} showStations />)
    expect(html).toContain('aria-label="凡例"')
    expect(html).toContain('2026年11月4日(水) 9〜12時の徒歩圏')
    expect(html).toContain('徒歩圏内')
    expect(html).toContain('徒歩圏から外れる')
    expect(html).toContain('停留所(この時間帯に出発あり)')
    expect(html).toContain('停留所(出発なし)')
    expect(html).toContain('鉄道駅')
    expect(html).not.toContain('計算中')
  })

  it('駅が無ければ駅の行を出さない。計算中はそう出す', () => {
    const html = renderToString(<MapLegend caption="x" computing showStations={false} />)
    expect(html).not.toContain('鉄道駅')
    expect(html).toContain('計算中')
  })
})
