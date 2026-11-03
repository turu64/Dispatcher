import { describe, expect, it } from 'vitest'
import { clampLeftWidth, maxLeftWidth, MIN_LEFT_WIDTH, MIN_RIGHT_WIDTH, SEPARATOR_WIDTH } from './paneWidth'

describe('maxLeftWidth', () => {
  it('広い窓では、上限は窓の 60% のまま', () => {
    expect(maxLeftWidth(1280)).toBe(768)
    expect(maxLeftWidth(2544)).toBe(1526)
  })

  it('狭い窓(分割画面など)では、地図に 320px を残す', () => {
    expect(maxLeftWidth(720)).toBe(720 - SEPARATOR_WIDTH - MIN_RIGHT_WIDTH)
    expect(clampLeftWidth(400, 720) + SEPARATOR_WIDTH + MIN_RIGHT_WIDTH).toBe(720)
  })

  it('左の下限と地図の下限が両方は入らない窓では、左の下限を優先する', () => {
    expect(maxLeftWidth(380)).toBe(MIN_LEFT_WIDTH)
    expect(clampLeftWidth(400, 380)).toBe(MIN_LEFT_WIDTH)
  })
})
