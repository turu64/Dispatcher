import { describe, expect, it } from 'vitest'
import { MAX_PLACE_NAME, normalizePlaceName, roundCoord, validCoords } from './userPlaces'

describe('userPlaces(営業所の名前と緯度経度の整え方)', () => {
  it('名前の前後の空白を取り、続く空白を1つにする。空・文字でない・長すぎる名前は null', () => {
    expect(normalizePlaceName('  旭川  営業所 ')).toBe('旭川 営業所')
    expect(normalizePlaceName('   ')).toBeNull()
    expect(normalizePlaceName(1)).toBeNull()
    expect(normalizePlaceName('あ'.repeat(MAX_PLACE_NAME))).toBe('あ'.repeat(MAX_PLACE_NAME))
    expect(normalizePlaceName('あ'.repeat(MAX_PLACE_NAME + 1))).toBeNull()
  })

  it('緯度経度を小数 6 桁に丸める', () => {
    expect(roundCoord(43.123456789)).toBe(43.123457)
    expect(roundCoord(142.987654321)).toBe(142.987654)
  })

  it('緯度経度は数で、緯度 ±90・経度 ±180 の中だけ', () => {
    expect(validCoords(43.77, 142.36)).toBe(true)
    expect(validCoords(-90, 180)).toBe(true)
    expect(validCoords(90.1, 142)).toBe(false)
    expect(validCoords(43, -180.1)).toBe(false)
    expect(validCoords('43', 142)).toBe(false)
    expect(validCoords(Number.NaN, 142)).toBe(false)
    expect(validCoords(43, Number.POSITIVE_INFINITY)).toBe(false)
  })
})
