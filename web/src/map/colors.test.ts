import { describe, expect, it } from 'vitest'
import {
  REACH_COLORS,
  REACH_DIFF_COLORS,
  REACH_DIFF_OPACITY,
  REACH_FILL_OPACITY,
  REACH_FILL_OPACITY_REACHABLE,
  REGION_COLORS,
} from './colors'

// 色覚シミュレーション(Machado, Oliveira, Fernandes, 2009 の重大度 1.0)。線形 RGB に掛ける。
const SIMULATIONS = {
  通常: [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ],
  P型: [
    [0.152286, 1.052583, -0.204868],
    [0.114503, 0.786281, 0.099216],
    [-0.003882, -0.048116, 1.051998],
  ],
  D型: [
    [0.367322, 0.860646, -0.227968],
    [0.280085, 0.672501, 0.047413],
    [-0.01182, 0.04294, 0.968881],
  ],
  T型: [
    [1.255528, -0.076749, -0.178779],
    [-0.078411, 0.930809, 0.147602],
    [0.004733, 0.691367, 0.3039],
  ],
} as const

type Vec3 = readonly [number, number, number]

function toLinear(c: number): number {
  const v = c / 255
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
}

function hexToLinear(hex: string): Vec3 {
  return [1, 3, 5].map((i) => toLinear(parseInt(hex.slice(i, i + 2), 16))) as unknown as Vec3
}

/** 線形 sRGB(D65)→ CIE L*a*b* */
function toLab([r, g, b]: Vec3): Vec3 {
  const x = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047
  const y = 0.2126729 * r + 0.7151522 * g + 0.072175 * b
  const z = (0.0193339 * r + 0.119192 * g + 0.9503041 * b) / 1.08883
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : ((24389 / 27) * t + 16) / 116)
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))]
}

function simulatedLab(hex: string, m: readonly (readonly number[])[]): Vec3 {
  const rgb = hexToLinear(hex)
  const out = m.map((row) => Math.min(1, Math.max(0, row[0] * rgb[0] + row[1] * rgb[1] + row[2] * rgb[2])))
  return toLab(out as unknown as Vec3)
}

/** 色の差(CIE76 の ΔE)。2〜3 で気づき、20〜30 を超えると別の色として区別しやすい */
function deltaE(a: string, b: string, m: readonly (readonly number[])[]): number {
  const [l1, a1, b1] = simulatedLab(a, m)
  const [l2, a2, b2] = simulatedLab(b, m)
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2)
}

describe('到達圏の色', () => {
  for (const [name, m] of Object.entries(SIMULATIONS)) {
    it(`徒歩圏内と徒歩圏外の色が、${name}でも区別できる`, () => {
      expect(deltaE(REACH_COLORS.reachable, REACH_COLORS.unreachable, m)).toBeGreaterThan(50)
    })
  }

  it('白黒にしても、徒歩圏内と徒歩圏外の明るさが違う', () => {
    const l1 = simulatedLab(REACH_COLORS.reachable, SIMULATIONS.通常)[0]
    const l2 = simulatedLab(REACH_COLORS.unreachable, SIMULATIONS.通常)[0]
    expect(Math.abs(l1 - l2)).toBeGreaterThan(15)
  })

  it('地域の区分の色は、明るさで順に並ぶ', () => {
    const l = (hex: string) => simulatedLab(hex, SIMULATIONS.通常)[0]
    expect(l(REGION_COLORS.urban)).toBeLessThan(l(REGION_COLORS.suburban))
    expect(l(REGION_COLORS.suburban)).toBeLessThan(l(REGION_COLORS.rural))
  })

  it('塗りの不透明度は 0 より大きく 1 以下', () => {
    expect(REACH_FILL_OPACITY).toBeGreaterThan(0)
    expect(REACH_FILL_OPACITY).toBeLessThanOrEqual(1)
  })

  it('徒歩圏内は、外れるセルより薄く塗る(見えなくなるほど薄くはしない)', () => {
    expect(REACH_FILL_OPACITY_REACHABLE).toBeGreaterThanOrEqual(0.15)
    expect(REACH_FILL_OPACITY_REACHABLE).toBeLessThan(REACH_FILL_OPACITY)
  })
})

/** 白い背景に不透明度 opacity で重ねたときの色(地図の上の見え方に近い) */
function overWhite(hex: string, opacity: number): string {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))
  return `#${c.map((v) => Math.round(opacity * v + (1 - opacity) * 255).toString(16).padStart(2, '0')).join('')}`
}

describe('減便の前後の差の4色', () => {
  const shown = {
    lost: overWhite(REACH_DIFF_COLORS.lost, REACH_DIFF_OPACITY.lost),
    bothUnreachable: overWhite(REACH_DIFF_COLORS.bothUnreachable, REACH_DIFF_OPACITY.bothUnreachable),
    bothReachable: overWhite(REACH_DIFF_COLORS.bothReachable, REACH_DIFF_OPACITY.bothReachable),
    gained: overWhite(REACH_DIFF_COLORS.gained, REACH_DIFF_OPACITY.gained),
  }

  for (const [name, m] of Object.entries(SIMULATIONS)) {
    it(`「減便で外れた」は、「両方で外れる」「新たに到達」と${name}でも区別できる`, () => {
      expect(deltaE(shown.lost, shown.bothUnreachable, m)).toBeGreaterThan(25)
      expect(deltaE(shown.lost, shown.gained, m)).toBeGreaterThan(25)
    })

    it(`「両方で外れる」は、「新たに到達」「両方で到達」と${name}でも見分けられる`, () => {
      expect(deltaE(shown.bothUnreachable, shown.gained, m)).toBeGreaterThan(25)
      expect(deltaE(shown.bothUnreachable, shown.bothReachable, m)).toBeGreaterThan(12)
    })
  }

  it('「減便で外れた」は今の外れるセルの色と濃さ、「新たに到達」は「両方で到達」より濃い青', () => {
    expect(REACH_DIFF_COLORS.lost).toBe(REACH_COLORS.unreachable)
    expect(REACH_DIFF_OPACITY.lost).toBe(REACH_FILL_OPACITY)
    expect(REACH_DIFF_COLORS.gained).toBe(REACH_COLORS.reachable)
    expect(REACH_DIFF_OPACITY.bothReachable).toBe(REACH_FILL_OPACITY_REACHABLE)
    expect(REACH_DIFF_OPACITY.gained).toBeGreaterThan(REACH_DIFF_OPACITY.bothReachable)
  })

  it('「両方で外れる」の灰は、地域の区分の灰と同じ色にしない', () => {
    expect(Object.values(REGION_COLORS)).not.toContain(REACH_DIFF_COLORS.bothUnreachable)
  })
})
