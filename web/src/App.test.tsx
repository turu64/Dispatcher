import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import App from './App'

// react-dom/server で描画する。useEffect は走らないので、地図は作られない
describe('App', () => {
  const html = renderToString(<App />)

  it('アプリ名を表示する', () => {
    expect(html).toContain('Dispatcher')
  })

  it('手順の見出しを、読み込み → 方針 → 日付と時間帯 → 到達圏 → 足し戻し → 出力の順に表示する', () => {
    const titles = ['1. GTFS を読み込む', '2. 減便の方針', '3. 日付と時間帯', '4. 到達圏(減便の前後)', '5. 足し戻し', '6. GTFS を出力']
    const positions = titles.map((t) => html.indexOf(t))
    for (const p of positions) expect(p).toBeGreaterThanOrEqual(0)
    expect([...positions].sort((a, b) => a - b)).toEqual(positions)
  })

  it('データの出典を表示する', () => {
    expect(html).toContain('データの出典')
    expect(html).toContain('北海道オープンデータプラットフォーム')
    expect(html).toContain('e-Stat')
    expect(html).toContain('国土数値情報')
    expect(html).toContain('OpenStreetMap Japan')
  })

  it('地図の領域がある', () => {
    expect(html).toContain('aria-label="地図"')
  })

  it('GTFS を読み込む前は、手順2〜6は読み込みを促す', () => {
    expect(html).toContain('手順1で GTFS を読み込むと、減便の方針を選べます')
    expect(html).toContain('手順1で GTFS を読み込むと選べます')
    expect(html).toContain('手順1で GTFS を読み込むと、選んだ日付・時間帯の到達圏を計算します')
    expect(html).toContain('手順1で GTFS を読み込み、手順2で方針を承認すると、足し戻す便を選べます')
    expect(html).toContain('手順1で GTFS を読み込み、方針を承認すると、減便を反映した GTFS を出力できます')
  })

  it('鉄道駅の扱いの注記を出す', () => {
    expect(html).toContain('鉄道駅は時刻表データが無いため、6〜24時のすべての時間帯で使えるものとみなしています')
  })
})
