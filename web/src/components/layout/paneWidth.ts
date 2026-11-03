/** 左の欄(手順)の幅の下限(px) */
export const MIN_LEFT_WIDTH = 320
/** 左の欄の幅の上限(窓の幅に対する割合) */
export const MAX_LEFT_RATIO = 0.6
/** 覚えた幅が無いときの左の欄の幅(px) */
export const DEFAULT_LEFT_WIDTH = 400
/** 区切りに焦点があるとき、矢印キー1回で動かす幅(px) */
export const KEY_STEP = 16

/** 幅を覚えておくブラウザの保存の鍵(閲覧者ごとの便利機能なので localStorage で足りる) */
const STORAGE_KEY = 'dispatcher.leftPaneWidth'

/** 窓の幅に応じた、左の欄の幅の上限(下限より狭くはしない) */
export function maxLeftWidth(windowWidth: number): number {
  return Math.max(MIN_LEFT_WIDTH, Math.floor(windowWidth * MAX_LEFT_RATIO))
}

/** 左の欄の幅を、下限と上限の間に収める */
export function clampLeftWidth(width: number, windowWidth: number): number {
  return Math.round(Math.min(Math.max(width, MIN_LEFT_WIDTH), maxLeftWidth(windowWidth)))
}

/** 覚えた幅を読む。無い・読めない(保存が禁止されている、壊れた値など)ときは null */
export function readLeftWidth(): number | null {
  try {
    if (typeof window === 'undefined') return null
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (raw === null) return null
    const n = Number(raw)
    return Number.isFinite(n) && n > 0 ? n : null
  } catch {
    return null
  }
}

/** 幅を覚える。保存できなくても画面は動くので、失敗は無視する */
export function saveLeftWidth(width: number): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, String(Math.round(width)))
  } catch {
    // 保存できない(プライベートウィンドウ、保存の禁止など)ときは、覚えないだけにする
  }
}
