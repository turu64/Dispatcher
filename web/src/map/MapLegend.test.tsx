import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import MapLegend, { type LegendCompare } from './MapLegend'

/** タグを除いた文字だけ(React が入れる <!-- --> も除く) */
function textOf(html: string): string {
  return html.replace(/<!-- -->/g, '').replace(/<[^>]+>/g, '')
}

const COMPARE: LegendCompare = {
  mode: 'diff',
  onModeChange: () => {},
  counts: { lost: 281, bothUnreachable: 1200, bothReachable: 15000, gained: 3 },
  draft: false,
  zeroStops: { feed: 91, day: 5 },
}

describe('MapLegend', () => {
  it('日付と時間帯、徒歩圏の内外、塗らないセルの数、停留所の出発の有無、鉄道駅を出す', () => {
    const html = renderToString(
      <MapLegend caption="2026年11月4日(水) 9〜12時の到達圏" computing={false} showStations nonCoverableCells={1751} />,
    )
    expect(html).toContain('aria-label="凡例"')
    expect(html).toContain('2026年11月4日(水) 9〜12時の到達圏')
    expect(html).toContain('到達圏内')
    expect(html).toContain('到達圏から外れる')
    expect(textOf(html)).toContain('塗らない区画:徒歩圏に停留所・駅がない 1,751 区画')
    expect(html).toContain('停留所(この時間帯に発車あり)')
    expect(html).toContain('停留所(発車なし)')
    expect(html).toContain('鉄道駅')
    expect(html).not.toContain('計算中')
    // 減便後の GTFS が無ければ、塗り分けの切り替えは出さない
    expect(html).not.toContain('前後の差')
  })

  it('駅が無ければ駅の行を出さない。計算中はそう出す。塗らないセルが 0 でも件数を出す', () => {
    const html = renderToString(<MapLegend caption="x" computing showStations={false} nonCoverableCells={0} />)
    expect(html).not.toContain('鉄道駅')
    expect(html).toContain('計算中')
    expect(textOf(html)).toContain('徒歩圏に停留所・駅がない 0 区画')
  })

  it('参照データが無い(fallback)ときは、ダイヤと関係なく外れるセルの行を出さない', () => {
    const html = renderToString(<MapLegend caption="x" computing={false} showStations={false} nonCoverableCells={null} />)
    expect(html).not.toContain('徒歩圏に停留所・駅がない')
    expect(html).not.toContain('data-non-coverable')
  })

  it('前後の差では、4つの塗り分けを件数と文字で出し、運行がゼロになる停留所の印を出す', () => {
    const text = textOf(renderToString(<MapLegend caption="x" computing={false} showStations={false} nonCoverableCells={10} compare={COMPARE} />))
    expect(text).toContain('減便で到達圏から外れた 281 区画')
    expect(text).toContain('前後とも到達圏外 1,200 区画')
    expect(text).toContain('新たに到達 3 区画')
    expect(text).toContain('両方で到達 15,000 区画')
    expect(text).toContain('発車がなくなる停留所 96 件(出力のどの日にも便が来ない 91 件)')
    expect(text).not.toContain('到達圏から外れる')
    for (const label of ['減便前', '減便後', '前後の差']) expect(text).toContain(label)
  })

  it('減便前・減便後では2色の凡例にし、運行がゼロになる停留所の印は出さない。下書きはそう出す', () => {
    const html = renderToString(
      <MapLegend caption="x" computing={false} showStations={false} nonCoverableCells={10} compare={{ ...COMPARE, mode: 'before', draft: true }} />,
    )
    const text = textOf(html)
    expect(text).toContain('到達圏から外れる')
    expect(text).not.toContain('減便で到達圏から外れた')
    expect(text).not.toContain('発車がなくなる停留所')
    expect(text).toContain('下書き')
    // 選んでいる塗り分けが押された状態
    expect(html).toMatch(/aria-checked="true"[^>]*>減便前</)
  })
})
