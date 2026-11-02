import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import App from './App'

// react-dom/server で描画する。useEffect は走らないので、地図は作られない
describe('App', () => {
  const html = renderToString(<App />)

  it('アプリ名を表示する', () => {
    expect(html).toContain('Dispatcher')
  })

  it('手順の見出しを表示する', () => {
    expect(html).toContain('1. GTFS を読み込む')
    expect(html).toContain('2. 日付と時間帯')
    expect(html).toContain('3. 到達圏')
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
})
