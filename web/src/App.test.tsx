import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import App from './App'

describe('App', () => {
  it('アプリ名を表示する', () => {
    expect(renderToString(<App />)).toContain('Dispatcher')
  })
})
