import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react'
import { clampLeftWidth, DEFAULT_LEFT_WIDTH, KEY_STEP, maxLeftWidth, MIN_LEFT_WIDTH, readLeftWidth, saveLeftWidth } from './paneWidth'

function windowWidth(): number {
  return typeof window === 'undefined' ? 1280 : window.innerWidth
}

/**
 * 左(手順)と右(地図)の2つに分けた画面。間の区切りをドラッグして左の幅を変えられる(最小 320px、最大は窓の 60% で、地図に 320px を残す)。
 * 区切りに焦点を置けば、矢印キー・Home・End でも変えられる。幅はブラウザに覚え、次に開いたときも使う。
 * showRight が false のときは右を隠し(消さない)、左を全体に広げる。
 * 右は overflow-hidden にする。窓が狭く地図が細いときも、地図に重ねた凡例・操作盤が左の欄に重なったり、ページに横スクロールを出したりしない。
 * ドラッグは pointer events で作る(新しい依存パッケージを足さない)
 */
export default function SplitPane({ left, right, showRight }: { left: ReactNode; right: ReactNode; showRight: boolean }) {
  const [width, setWidth] = useState(() => readLeftWidth() ?? DEFAULT_LEFT_WIDTH)
  const [winWidth, setWinWidth] = useState(windowWidth)
  const drag = useRef<{ startX: number; startWidth: number } | null>(null)

  useEffect(() => {
    const onResize = () => setWinWidth(window.innerWidth)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  const shown = clampLeftWidth(width, winWidth)
  const max = maxLeftWidth(winWidth)

  function commit(next: number) {
    const w = clampLeftWidth(next, windowWidth())
    setWidth(w)
    saveLeftWidth(w)
  }

  function widthAt(e: PointerEvent<HTMLDivElement>): number | null {
    const d = drag.current
    return d ? clampLeftWidth(d.startWidth + e.clientX - d.startX, windowWidth()) : null
  }

  function onPointerDown(e: PointerEvent<HTMLDivElement>) {
    if (e.button !== 0) return
    // 文字の選択が始まらないようにし、地図の上に出てもドラッグが続くよう、区切りがポインターを持つ
    e.preventDefault()
    e.currentTarget.setPointerCapture?.(e.pointerId)
    drag.current = { startX: e.clientX, startWidth: shown }
  }

  function onPointerMove(e: PointerEvent<HTMLDivElement>) {
    const w = widthAt(e)
    if (w !== null) setWidth(w)
  }

  function onPointerEnd(e: PointerEvent<HTMLDivElement>) {
    const w = widthAt(e)
    if (w === null) return
    drag.current = null
    if (e.currentTarget.hasPointerCapture?.(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
    commit(w)
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const next =
      e.key === 'ArrowLeft' ? shown - KEY_STEP : e.key === 'ArrowRight' ? shown + KEY_STEP : e.key === 'Home' ? MIN_LEFT_WIDTH : e.key === 'End' ? max : null
    if (next === null) return
    e.preventDefault()
    commit(next)
  }

  return (
    <div className="flex size-full min-h-0">
      <div className={showRight ? 'h-full min-w-0 shrink-0' : 'h-full min-w-0 flex-1'} style={showRight ? { width: shown } : undefined}>
        {left}
      </div>
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="手順の欄と地図の幅"
        aria-valuemin={MIN_LEFT_WIDTH}
        aria-valuemax={max}
        aria-valuenow={shown}
        tabIndex={0}
        hidden={!showRight}
        className="print-hide w-1.5 shrink-0 cursor-col-resize touch-none border-r bg-muted outline-none hover:bg-ring/40 focus-visible:bg-ring/60 active:bg-ring/60"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
        onKeyDown={onKeyDown}
      />
      <div hidden={!showRight} data-pane="right" className="print-hide relative h-full min-w-0 flex-1 overflow-hidden">
        {right}
      </div>
    </div>
  )
}
