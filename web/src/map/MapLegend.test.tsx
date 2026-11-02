import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import MapLegend from './MapLegend'

/** タグを除いた文字だけ(React が入れる <!-- --> も除く) */
function textOf(html: string): string {
  return html.replace(/<!-- -->/g, '').replace(/<[^>]+>/g, '')
}

describe('MapLegend', () => {
  it('日付と時間帯、徒歩圏の内外、塗らないセルの数、停留所の出発の有無、鉄道駅を出す', () => {
    const html = renderToString(
      <MapLegend caption="2026年11月4日(水) 9〜12時の徒歩圏" computing={false} showStations nonCoverableCells={1751} />,
    )
    expect(html).toContain('aria-label="凡例"')
    expect(html).toContain('2026年11月4日(水) 9〜12時の徒歩圏')
    expect(html).toContain('徒歩圏内')
    expect(html).toContain('徒歩圏から外れる')
    expect(textOf(html)).toContain('塗らないセル:ダイヤと関係なく外れる 1,751 セル')
    expect(html).toContain('停留所(この時間帯に出発あり)')
    expect(html).toContain('停留所(出発なし)')
    expect(html).toContain('鉄道駅')
    expect(html).not.toContain('計算中')
  })

  it('駅が無ければ駅の行を出さない。計算中はそう出す。塗らないセルが 0 でも件数を出す', () => {
    const html = renderToString(<MapLegend caption="x" computing showStations={false} nonCoverableCells={0} />)
    expect(html).not.toContain('鉄道駅')
    expect(html).toContain('計算中')
    expect(textOf(html)).toContain('ダイヤと関係なく外れる 0 セル')
  })
})
