import { describe, expect, it } from 'vitest'
import {
  cellAreaKm2,
  cellsWithinRadius,
  distanceM,
  meshBounds,
  meshCenter,
  meshCode,
  meshCodesInBounds,
  parentCode,
  type LatLon,
} from './mesh'

const ALL_DIGITS = [4, 6, 8, 9, 10, 11] as const

/** 再現できる乱数(mulberry32) */
function random(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const dms = ([d, m, s]: readonly [number, number, number]) => d + m / 60 + s / 3600

// 総務省統計局「地域メッシュ統計の概要」(https://www.stat.go.jp/data/mesh/pdf/gaiyo1.pdf)14ページ
// 表7「都道府県庁の所在する基準地域メッシュの大きさと面積(世界測地系)」。
// コード、区画の左下端(南西)の緯度・経度、縦・横の長さ(km、国土地理院の測量計算で算出)、面積(縦 × 横、km²)。
type Table7Row = readonly [string, string, readonly [number, number, number], readonly [number, number, number], number, number, number]
const TABLE7: readonly Table7Row[] = [
  ['札幌市', '6441-42-77', [43, 3, 30], [141, 20, 15], 0.926, 1.018, 0.943],
  ['青森市', '6140-15-89', [40, 49, 0], [140, 44, 15], 0.925, 1.055, 0.976],
  ['盛岡市', '5941-41-42', [39, 42, 0], [141, 9, 0], 0.925, 1.072, 0.992],
  ['仙台市', '5740-36-29', [38, 16, 0], [140, 51, 45], 0.925, 1.094, 1.012],
  ['秋田市', '5940-40-68', [39, 43, 0], [140, 6, 0], 0.925, 1.072, 0.992],
  ['山形市', '5740-22-89', [38, 14, 0], [140, 21, 45], 0.925, 1.094, 1.012],
  ['福島市', '5640-53-07', [37, 45, 0], [140, 27, 45], 0.925, 1.102, 1.019],
  ['水戸市', '5440-43-15', [36, 20, 30], [140, 26, 15], 0.925, 1.122, 1.038],
  ['宇都宮市', '5439-67-70', [36, 33, 30], [139, 52, 30], 0.925, 1.119, 1.035],
  ['前橋市', '5439-40-64', [36, 23, 0], [139, 3, 0], 0.925, 1.122, 1.037],
  ['さいたま市', '5339-65-21', [35, 51, 0], [139, 38, 15], 0.925, 1.129, 1.044],
  ['千葉市', '5340-30-29', [35, 36, 0], [140, 6, 45], 0.925, 1.133, 1.047],
  ['新宿区', '5339-45-25', [35, 41, 0], [139, 41, 15], 0.925, 1.132, 1.046],
  ['横浜市', '5339-15-31', [35, 26, 30], [139, 38, 15], 0.925, 1.135, 1.049],
  ['新潟市', '5639-60-81', [37, 54, 0], [139, 0, 45], 0.925, 1.099, 1.017],
  ['富山市', '5537-01-36', [36, 41, 30], [137, 12, 0], 0.925, 1.117, 1.033],
  ['金沢市', '5436-75-10', [36, 35, 30], [136, 37, 30], 0.925, 1.119, 1.034],
  ['福井市', '5436-01-77', [36, 3, 30], [136, 12, 45], 0.925, 1.126, 1.041],
  ['甲府市', '5338-34-95', [35, 39, 30], [138, 33, 45], 0.925, 1.132, 1.047],
  ['長野市', '5438-71-84', [36, 39, 0], [138, 10, 30], 0.925, 1.118, 1.034],
  ['岐阜市', '5336-05-67', [35, 23, 0], [136, 42, 45], 0.925, 1.136, 1.05],
  ['静岡市', '5238-33-70', [34, 58, 30], [138, 22, 30], 0.925, 1.141, 1.055],
  ['名古屋市', '5236-67-12', [35, 10, 30], [136, 54, 0], 0.925, 1.139, 1.053],
  ['津市', '5236-04-70', [34, 43, 30], [136, 30, 0], 0.924, 1.145, 1.058],
  ['大津市', '5235-46-09', [35, 0, 0], [135, 51, 45], 0.925, 1.141, 1.055],
  ['京都市', '5235-46-20', [35, 1, 0], [135, 45, 0], 0.925, 1.141, 1.055],
  ['大阪市', '5235-04-21', [34, 41, 0], [135, 30, 45], 0.924, 1.145, 1.059],
  ['神戸市', '5235-01-24', [34, 41, 0], [135, 10, 30], 0.924, 1.145, 1.059],
  ['奈良市', '5235-06-26', [34, 41, 0], [135, 49, 30], 0.924, 1.145, 1.059],
  ['和歌山市', '5135-21-73', [34, 13, 30], [135, 9, 45], 0.924, 1.152, 1.065],
  ['鳥取市', '5334-21-09', [35, 30, 0], [134, 14, 15], 0.925, 1.134, 1.049],
  ['松江市', '5333-10-64', [35, 28, 0], [133, 3, 0], 0.925, 1.135, 1.049],
  ['岡山市', '5133-77-94', [34, 39, 30], [133, 55, 30], 0.924, 1.146, 1.059],
  ['広島市', '5132-43-76', [34, 23, 30], [132, 27, 0], 0.924, 1.149, 1.063],
  ['山口市', '5131-23-27', [34, 11, 0], [131, 27, 45], 0.924, 1.152, 1.065],
  ['徳島市', '5134-04-74', [34, 3, 30], [134, 33, 0], 0.924, 1.154, 1.067],
  ['高松市', '5134-40-03', [34, 20, 0], [134, 2, 15], 0.924, 1.15, 1.063],
  ['松山市', '5032-66-01', [33, 50, 0], [132, 45, 45], 0.924, 1.157, 1.069],
  ['高知市', '5033-24-72', [33, 33, 30], [133, 31, 30], 0.924, 1.161, 1.073],
  ['福岡市', '5030-33-23', [33, 36, 0], [130, 24, 45], 0.924, 1.16, 1.072],
  ['佐賀市', '4930-62-93', [33, 14, 30], [130, 17, 15], 0.924, 1.165, 1.077],
  ['長崎市', '4929-06-99', [32, 44, 30], [129, 51, 45], 0.924, 1.172, 1.083],
  ['熊本市', '4930-15-49', [32, 47, 0], [130, 44, 15], 0.924, 1.171, 1.082],
  ['大分市', '4931-64-89', [33, 14, 0], [131, 36, 45], 0.924, 1.165, 1.077],
  ['宮崎市', '4731-63-93', [31, 54, 30], [131, 24, 45], 0.924, 1.182, 1.092],
  ['鹿児島市', '4730-24-74', [31, 33, 30], [130, 33, 0], 0.924, 1.187, 1.097],
  ['那覇市', '3927-25-54', [26, 12, 30], [127, 40, 30], 0.923, 1.249, 1.153],
]

describe('meshCode・meshBounds:既知のコード', () => {
  it.each(TABLE7)('%s の基準地域メッシュ %s(統計局 表7)', (_name, dashed, lat, lon, heightKm, widthKm) => {
    const code = dashed.replaceAll('-', '')
    const south = dms(lat)
    const west = dms(lon)
    // 左下端の点は、境界の上でもその区画に入る
    expect(meshCode(south, west, 8)).toBe(code)
    const b = meshBounds(code)
    expect(b.south).toBeCloseTo(south, 12)
    expect(b.west).toBeCloseTo(west, 12)
    expect(b.north - b.south).toBeCloseTo(30 / 3600, 12)
    expect(b.east - b.west).toBeCloseTo(45 / 3600, 12)
    // 縦・横の長さは km の小数3桁に丸めた値
    expect(Math.abs(distanceM({ lat: b.south, lon: b.west }, { lat: b.north, lon: b.west }) / 1000 - heightKm)).toBeLessThan(0.0006)
    expect(Math.abs(distanceM({ lat: b.south, lon: b.west }, { lat: b.south, lon: b.east }) / 1000 - widthKm)).toBeLessThan(0.0006)
  })

  it('東京駅(35.681236, 139.767125)は 53394611、4分の1 は 5339461132', () => {
    // 統計局「地域メッシュ統計の概要」12ページの算出式で手計算した値。
    // 緯度:35.681236 × 60 ÷ 40 = 53 余り 20.874分 → q = 4、余り 0.874分 = 52.45秒 → r = 1、
    //       余り 22.45秒 → s = 1、余り 7.45秒 → t = 0
    // 経度:139.767125 − 100 = 39 余り 0.767125度 = 46.03分 → v = 6、余り 61.65秒 → w = 1、
    //       余り 16.65秒 → x = 0、余り 16.65秒 → y = 1
    // m = 1 × 2 + 0 + 1 = 3、n = 0 × 2 + 1 + 1 = 2
    expect(meshCode(35.681236, 139.767125, 8)).toBe('53394611')
    expect(meshCode(35.681236, 139.767125, 10)).toBe('5339461132')
  })

  it('旭川市付近の1次メッシュは 6542(統計局 図1:北緯 43度20分〜44度、東経 142〜143度)', () => {
    expect(meshCode(43.7628, 142.3587, 4)).toBe('6542')
    expect(meshBounds('6542')).toEqual({ south: 65 / 1.5, west: 142, north: 66 / 1.5, east: 143 })
  })

  it('統計局の例 5438-23-43-1-2-3 の区画の位置(表4・表6)', () => {
    // 5438:南端 36度、西端 138度。23:南から2番目・西から3番目の2次(+10分、+22分30秒)。
    // 43:南から4番目・西から3番目の3次(+2分、+2分15秒)。1:南西。2:南東(経度 +11.25秒)。3:北西(緯度 +3.75秒)
    expect(meshBounds('5438')).toMatchObject({ south: 36, west: 138 })
    const b2 = meshBounds('543823')
    expect(b2.south).toBeCloseTo(36 + 10 / 60, 12)
    expect(b2.west).toBeCloseTo(138 + 22.5 / 60, 12)
    const b3 = meshBounds('54382343')
    expect(b3.south).toBeCloseTo(36 + 12 / 60, 12)
    expect(b3.west).toBeCloseTo(138 + 24.75 / 60, 12)
    const b11 = meshBounds('54382343123')
    expect(b11.south).toBeCloseTo(36 + 12 / 60 + 3.75 / 3600, 12)
    expect(b11.west).toBeCloseTo(138 + 24.75 / 60 + 11.25 / 3600, 12)
    expect(b11.north - b11.south).toBeCloseTo(3.75 / 3600, 12)
    expect(b11.east - b11.west).toBeCloseTo(5.625 / 3600, 12)
    expect(meshCode(b11.south, b11.west, 11)).toBe('54382343123')
  })

  it('分割地域メッシュの番号は 南西 1・南東 2・北西 3・北東 4', () => {
    const b = meshBounds('54382343')
    const midLat = (b.south + b.north) / 2
    const midLon = (b.west + b.east) / 2
    const q = 1e-4
    expect(meshCode(b.south + q, b.west + q, 9)).toBe('543823431')
    expect(meshCode(b.south + q, midLon + q, 9)).toBe('543823432')
    expect(meshCode(midLat + q, b.west + q, 9)).toBe('543823433')
    expect(meshCode(midLat + q, midLon + q, 9)).toBe('543823434')
  })
})

describe('meshCode・meshBounds:境界と誤差', () => {
  it('境界ちょうどの点:南西の端は含み、北・東の端は隣のセル', () => {
    const next = random(1)
    const failures: string[] = []
    for (let i = 0; i < 2000; i++) {
      const lat = 24 + next() * 22
      const lon = 123 + next() * 30
      for (const digits of ALL_DIGITS) {
        const code = meshCode(lat, lon, digits)
        const b = meshBounds(code)
        const h = b.north - b.south
        const w = b.east - b.west
        const check = (label: string, got: string, want: string) => {
          if (got !== want) failures.push(`${code} ${label}: ${got}(期待 ${want})`)
        }
        check('南西の角', meshCode(b.south, b.west, digits), code)
        check('南の辺', meshCode(b.south, b.west + w / 2, digits), code)
        check('西の辺', meshCode(b.south + h / 2, b.west, digits), code)
        check('北の辺', meshCode(b.north, b.west + w / 2, digits), meshCode(b.north + h / 2, b.west + w / 2, digits))
        check('東の辺', meshCode(b.south + h / 2, b.east, digits), meshCode(b.south + h / 2, b.east + w / 2, digits))
        check('北東の角', meshCode(b.north, b.east, digits), meshCode(b.north + h / 2, b.east + w / 2, digits))
        // 境界の内側 1e-7 度(約 1cm)は、まだそのセル
        check('北の辺の内側', meshCode(b.north - 1e-7, b.west + w / 2, digits), code)
        check('東の辺の内側', meshCode(b.south + h / 2, b.east - 1e-7, digits), code)
      }
    }
    expect(failures.slice(0, 10)).toEqual([])
  })

  it('十進で書いた境界の値(43.333333333333336 = 65 ÷ 1.5 など)も、計算の向きによらず同じセル', () => {
    expect(meshCode(65 / 1.5, 142, 4)).toBe('6542')
    expect(meshCode(43 + 1 / 3, 142, 4)).toBe('6542')
    expect(meshCode(43.333333333333336, 142, 11)).toBe('65420000111')
    expect(meshCode(43.33333333333333, 142, 11)).toBe('65420000111')
    // 142.025 は 2次 00 の中の3次 w = 2 の西の端
    expect(meshCode(43.34166666666667, 142.025, 8)).toBe('65420012')
  })

  it('e-Stat の境界データの頂点(142.02499999999998 のように少し小さい値)も、そのセルになる', () => {
    // e-Stat 境界データ(3次メッシュ 6542、JGD2011)の2件目の区画 65420001 の東端と、3件目 65420002 の西端
    expect(meshCode(43.33333333333333, 142.02499999999998, 8)).toBe('65420002')
    expect(meshCode(43.34166666666666, 142.02499999999998, 8)).toBe('65420012')
    // 4分の1(250m)の1件目 6542000011 の東端 = 2件目 6542000012 の西端
    expect(meshCode(43.33333333333333, 142.00312499999998, 10)).toBe('6542000012')
  })

  it('ランダムな点で往復が一致する(meshCode → meshBounds・meshCenter → meshCode)', () => {
    const next = random(2)
    const failures: string[] = []
    for (let i = 0; i < 20000; i++) {
      const lat = next() * 66.6
      const lon = 100 + next() * 99.9
      const code11 = meshCode(lat, lon, 11)
      for (const digits of ALL_DIGITS) {
        const code = meshCode(lat, lon, digits)
        const b = meshBounds(code)
        const c = meshCenter(code)
        if (code.length !== digits) failures.push(`${code} の桁数が ${digits} ではない`)
        if (!code11.startsWith(code)) failures.push(`${code11} が ${code} で始まらない`)
        if (!(b.south <= lat && lat < b.north && b.west <= lon && lon < b.east)) {
          failures.push(`(${lat}, ${lon}) が ${code} の範囲の外`)
        }
        if (meshCode(c.lat, c.lon, digits) !== code) failures.push(`${code} の中心が別のセル`)
        if (meshCode(b.south, b.west, digits) !== code) failures.push(`${code} の南西の角が別のセル`)
        if (c.lat <= b.south || c.lat >= b.north || c.lon <= b.west || c.lon >= b.east) {
          failures.push(`${code} の中心が範囲の外`)
        }
      }
    }
    expect(failures.slice(0, 10)).toEqual([])
  })

  it('範囲の外や数でない緯度経度はエラー', () => {
    expect(() => meshCode(Number.NaN, 142, 8)).toThrow('緯度が数値ではありません')
    expect(() => meshCode(43, Number.POSITIVE_INFINITY, 8)).toThrow('経度が数値ではありません')
    expect(() => meshCode(-0.1, 142, 8)).toThrow('範囲')
    expect(() => meshCode(66.7, 142, 8)).toThrow('範囲')
    expect(() => meshCode(43, 99.9, 8)).toThrow('範囲')
    expect(() => meshCode(43, 200, 8)).toThrow('範囲')
    expect(() => meshCode(43, 142, 5 as 4)).toThrow('桁数')
  })

  it('形式の正しくないコードはエラー', () => {
    for (const bad of ['', '654', '65421', '654280', '654208', '6542000', '654200005', '65420000000', '6542000011111', '6542a0', ' 6542', '6542 ']) {
      expect(() => meshBounds(bad), bad).toThrow('地域メッシュのコードとして読めません')
    }
  })
})

describe('parentCode', () => {
  it('上位の区画のコードを返し、区画は親の中に入る', () => {
    const code = '54382343123'
    expect(parentCode(code, 4)).toBe('5438')
    expect(parentCode(code, 6)).toBe('543823')
    expect(parentCode(code, 8)).toBe('54382343')
    expect(parentCode(code, 9)).toBe('543823431')
    expect(parentCode(code, 10)).toBe('5438234312')
    expect(parentCode('5438234312', 10)).toBe('5438234312')
    const child = meshBounds(code)
    for (const digits of [4, 6, 8, 9, 10] as const) {
      const parent = meshBounds(parentCode(code, digits))
      expect(parent.south).toBeLessThanOrEqual(child.south)
      expect(parent.west).toBeLessThanOrEqual(child.west)
      expect(parent.north).toBeGreaterThanOrEqual(child.north)
      expect(parent.east).toBeGreaterThanOrEqual(child.east)
    }
  })

  it('ランダムな点で、11 桁のコードの親は、その点の各桁のコードと同じ', () => {
    const next = random(3)
    for (let i = 0; i < 1000; i++) {
      const lat = 41 + next() * 5
      const lon = 139 + next() * 7
      const code11 = meshCode(lat, lon, 11)
      for (const digits of [4, 6, 8, 9, 10] as const) expect(parentCode(code11, digits)).toBe(meshCode(lat, lon, digits))
    }
  })

  it('子より小さい区画や、形式の正しくないコードはエラー', () => {
    expect(() => parentCode('54382343', 10)).toThrow('より大きい区画')
    expect(() => parentCode('5438x', 4)).toThrow('地域メッシュのコードとして読めません')
  })
})

describe('meshCodesInBounds', () => {
  it('セルの範囲そのものを渡すと、そのセルだけ', () => {
    expect(meshCodesInBounds(meshBounds('65423724341'), 11)).toEqual(['65423724341'])
    expect(meshCodesInBounds(meshBounds('6542'), 4)).toEqual(['6542'])
  })

  it('境界をまたぐ範囲は両側のセル。並びは南から北、西から東', () => {
    const b = meshBounds('65423724341')
    const h = b.north - b.south
    const w = b.east - b.west
    expect(meshCodesInBounds({ south: b.south, west: b.west, north: b.north + h / 2, east: b.east }, 11)).toEqual([
      '65423724341',
      '65423724343',
    ])
    expect(meshCodesInBounds({ south: b.south + h / 2, west: b.west + w / 2, north: b.north + h / 2, east: b.east + w / 2 }, 11)).toEqual([
      '65423724341',
      '65423724342',
      '65423724343',
      '65423724344',
    ])
  })

  it('点(面積の無い範囲)は、その点を含むセル', () => {
    const b = meshBounds('65423724341')
    expect(meshCodesInBounds({ south: b.south, west: b.west, north: b.south, east: b.west }, 11)).toEqual(['65423724341'])
    expect(meshCodesInBounds({ south: 43.77, west: 142.36, north: 43.77, east: 142.36 }, 11)).toEqual([meshCode(43.77, 142.36, 11)])
  })

  it('道北の範囲の1次メッシュ', () => {
    expect(meshCodesInBounds({ south: 43.5, west: 141.9, north: 44.2, east: 143.1 }, 4)).toEqual([
      '6541',
      '6542',
      '6543',
      '6641',
      '6642',
      '6643',
    ])
  })

  it('3次メッシュの範囲には 8分の1 が 64 個、すべて違うコードで、その3次メッシュに属する', () => {
    const codes = meshCodesInBounds(meshBounds('65423724'), 11)
    expect(codes).toHaveLength(64)
    expect(new Set(codes).size).toBe(64)
    for (const c of codes) expect(parentCode(c, 8)).toBe('65423724')
  })

  it('南が北より大きい範囲や、数でない値はエラー', () => {
    expect(() => meshCodesInBounds({ south: 44, west: 142, north: 43, east: 143 }, 4)).toThrow('南が北より大きい')
    expect(() => meshCodesInBounds({ south: 43, west: 142, north: Number.NaN, east: 143 }, 4)).toThrow('数値ではありません')
  })
})

describe('distanceM', () => {
  // 国土地理院「距離と方位角の計算」(https://vldb.gsi.go.jp/sokuchi/surveycalc/surveycalc/bl2stf.html)の
  // 計算結果(GRS80 楕円体の測地線長、2026-11-03 に API で取得)
  const GSI: [LatLon, LatLon, number][] = [
    [{ lat: 43.0583333333, lon: 141.3375 }, { lat: 43.0666666667, lon: 141.3375 }, 925.783],
    [{ lat: 43.0583333333, lon: 141.3375 }, { lat: 43.0583333333, lon: 141.35 }, 1018.297],
    [{ lat: 43.7628, lon: 142.3587 }, { lat: 43.7706, lon: 142.365 }, 1004.188],
    [{ lat: 35.681236, lon: 139.767125 }, { lat: 35.689487, lon: 139.691706 }, 6888.071],
  ]

  it.each(GSI)('国土地理院の計算と 1cm 以内で一致する(%o → %o:%s m)', (a, b, expected) => {
    expect(Math.abs(distanceM(a, b) - expected)).toBeLessThan(0.01)
    expect(distanceM(b, a)).toBe(distanceM(a, b))
  })

  it('旭川〜札幌(約 112km)でも国土地理院の計算と 0.002% 以内', () => {
    const d = distanceM({ lat: 43.7628, lon: 142.3587 }, { lat: 43.0686, lon: 141.3508 })
    expect(Math.abs(d - 112300.271) / 112300.271).toBeLessThan(2e-5)
  })

  it('同じ点は 0', () => {
    expect(distanceM({ lat: 43.77, lon: 142.36 }, { lat: 43.77, lon: 142.36 })).toBe(0)
  })
})

describe('cellAreaKm2', () => {
  it('北海道(旭川)の 125m セルはおよそ 0.0145 km²', () => {
    const area = cellAreaKm2(meshCode(43.7628, 142.3587, 11))
    expect(area).toBeGreaterThan(0.0144)
    expect(area).toBeLessThan(0.0147)
  })

  it.each(TABLE7)('%s の基準地域メッシュ %s の面積は統計局 表7(縦 × 横)と 0.0015 km² 以内', (_name, dashed, _lat, _lon, _h, _w, areaKm2) => {
    expect(Math.abs(cellAreaKm2(dashed.replaceAll('-', '')) - areaKm2)).toBeLessThan(0.0015)
  })

  it('子の区画の面積の合計は親の面積', () => {
    const parent = '65423724'
    const children = meshCodesInBounds(meshBounds(parent), 11)
    const sum = children.reduce((s, c) => s + cellAreaKm2(c), 0)
    expect(sum / cellAreaKm2(parent)).toBeCloseTo(1, 9)
    const quarters = ['1', '2', '3', '4'].map((d) => cellAreaKm2(`${parent}${d}`))
    expect(quarters.reduce((s, a) => s + a, 0) / cellAreaKm2(parent)).toBeCloseTo(1, 9)
  })

  it('南へ行くほど広い(那覇は札幌の約 1.2 倍)', () => {
    expect(cellAreaKm2('39272554') / cellAreaKm2('64414277')).toBeCloseTo(1.223, 2)
  })
})

describe('cellsWithinRadius', () => {
  /** 範囲内のすべてのセルを調べる、遅いが確かなやり方 */
  function bruteForce(points: LatLon[], radiusM: number): string[] {
    const margin = radiusM / 50000 + 0.01
    const lats = points.map((p) => p.lat)
    const lons = points.map((p) => p.lon)
    const candidates = meshCodesInBounds(
      { south: Math.min(...lats) - margin, west: Math.min(...lons) - margin * 1.5, north: Math.max(...lats) + margin, east: Math.max(...lons) + margin * 1.5 },
      11,
    )
    return candidates.filter((c) => points.some((p) => distanceM(meshCenter(c), p) <= radiusM))
  }

  it('半径 0:点がセルの中心ちょうどならそのセル、そうでなければ無し', () => {
    const code = '65423724341'
    expect(cellsWithinRadius([meshCenter(code)], 0)).toEqual([code])
    expect(cellsWithinRadius([{ lat: 43.7628, lon: 142.3587 }], 0)).toEqual([])
  })

  it('点が無ければ空', () => {
    expect(cellsWithinRadius([], 1600)).toEqual([])
  })

  it('中心までの距離がちょうど半径のセルも含む', () => {
    const p = { lat: 43.7628, lon: 142.3587 }
    const code = meshCode(p.lat + 0.004, p.lon + 0.006, 11)
    const r = distanceM(meshCenter(code), p)
    expect(cellsWithinRadius([p], r)).toContain(code)
    expect(cellsWithinRadius([p], r * (1 - 1e-12))).not.toContain(code)
  })

  it('すべてのセルを調べた結果と一致する(点が複数、重なりあり)', () => {
    const points = [
      { lat: 43.7628, lon: 142.3587 },
      { lat: 43.7706, lon: 142.365 },
      { lat: 43.75, lon: 142.4 },
      { lat: 43.33334, lon: 142.00001 }, // 1次メッシュ 6542 の南西の角の近く(6441・6442・6541 にまたがる)
    ]
    for (const r of [0, 130, 400, 1234.5]) {
      expect(cellsWithinRadius(points, r), `半径 ${r}m`).toEqual(bruteForce(points, r))
    }
  })

  it('点が複数のときは、点ごとの結果の和集合(重複なし、南から北・西から東の順)', () => {
    const a = { lat: 43.7628, lon: 142.3587 }
    const b = { lat: 43.7706, lon: 142.365 }
    const both = cellsWithinRadius([a, b, a], 800)
    const union = new Set([...cellsWithinRadius([a], 800), ...cellsWithinRadius([b], 800)])
    expect(new Set(both)).toEqual(union)
    expect(both).toHaveLength(union.size)
    const order = both.map((c) => meshCenter(c))
    for (let i = 1; i < order.length; i++) {
      const prev = order[i - 1]
      const cur = order[i]
      expect(prev.lat < cur.lat || (prev.lat === cur.lat && prev.lon < cur.lon)).toBe(true)
    }
  })

  it('セルの数はおよそ πr² ÷ セルの面積', () => {
    const p = { lat: 43.7628, lon: 142.3587 }
    for (const r of [400, 800, 1600]) {
      const codes = cellsWithinRadius([p], r)
      const expected = (Math.PI * r * r) / (cellAreaKm2(codes[0]) * 1e6)
      expect(Math.abs(codes.length / expected - 1), `半径 ${r}m:${codes.length} 個、期待 ${expected.toFixed(1)}`).toBeLessThan(0.05)
    }
  })

  it('半径が負や数でなければエラー', () => {
    expect(() => cellsWithinRadius([{ lat: 43.77, lon: 142.36 }], -1)).toThrow('半径')
    expect(() => cellsWithinRadius([{ lat: 43.77, lon: 142.36 }], Number.NaN)).toThrow('半径')
    expect(() => cellsWithinRadius([{ lat: 43.77, lon: 99 }], 100)).toThrow('範囲')
  })

  it('1,600 点 × 半径 1,600m を数秒以内に計算する', () => {
    // 道北バスの運行範囲くらい(旭川〜上川・富良野・留萌)に、重なりが少なくなるよう点をばらまく(実際の停留所より重い条件)
    const next = random(4)
    const points = Array.from({ length: 1600 }, () => ({ lat: 43.3 + next() * 0.9, lon: 141.6 + next() * 1.4 }))
    const start = performance.now()
    const codes = cellsWithinRadius(points, 1600)
    const ms = performance.now() - start
    console.info(`cellsWithinRadius:1,600 点 × 1,600m で ${codes.length.toLocaleString()} セル、${ms.toFixed(0)} ms`)
    expect(new Set(codes).size).toBe(codes.length)
    expect(ms).toBeLessThan(3000)
  })
})
