/**
 * 地域メッシュ(JIS X 0410、統計に用いる標準地域メッシュ)のコードと緯度経度の変換。
 *
 * 定義の出典:総務省統計局「地域メッシュ統計の概要」(https://www.stat.go.jp/data/mesh/pdf/gaiyo1.pdf)
 * の表3〜6、算出式(12ページ)、行政管理庁告示第143号(18〜20ページ)。
 *
 * | 区画 | 桁数 | 緯度 × 経度 |
 * | --- | --- | --- |
 * | 1次 | 4 | 40分 × 1度(上2桁は南端の緯度 × 1.5、下2桁は西端の経度 − 100) |
 * | 2次 | 6 | 5分 × 7分30秒(南から・西から 0〜7) |
 * | 3次(基準) | 8 | 30秒 × 45秒(南から・西から 0〜9) |
 * | 2分の1 | 9 | 15秒 × 22.5秒 |
 * | 4分の1 | 10 | 7.5秒 × 11.25秒 |
 * | 8分の1 | 11 | 3.75秒 × 5.625秒 |
 *
 * 分割地域メッシュの末尾の数字は、南西 1・南東 2・北西 3・北東 4。
 *
 * 計算はすべて 8分の1地域メッシュの「行」と「列」の整数で行う。
 * 緯度 1度 = 960 行、経度 1度 = 640 列で、どちらの向きも 1次 = 640、2次 = 80、3次 = 8 に分かれ、
 * 3次の中の 0〜7 の3ビットが上から 2分の1・4分の1・8分の1 の位置を表す。
 * 文字列のコードにするのは入口と出口だけにする。
 */

export interface LatLon {
  lat: number
  lon: number
}

export interface Bounds {
  south: number
  west: number
  north: number
  east: number
}

type Digits = 4 | 6 | 8 | 9 | 10 | 11

/** 緯度 1度あたりの 8分の1地域メッシュの行数(1度 = 3600秒 ÷ 3.75秒) */
const ROWS_PER_DEG = 960
/** 経度 1度あたりの 8分の1地域メッシュの列数(1度 = 3600秒 ÷ 5.625秒) */
const COLS_PER_DEG = 640
/** 1次メッシュの下2桁の基準になる経度 */
const LON_ORIGIN = 100
/** 1次メッシュの上2桁は 00〜99。緯度 0度以上 66.67度未満 */
const ROW_LIMIT = 100 * 640
/** 1次メッシュの下2桁は 00〜99。経度 100度以上 200度未満 */
const COL_LIMIT = 100 * 640

/** 区画の1辺が、8分の1地域メッシュの何行(何列)ぶんか */
const SPAN: Record<Digits, number> = { 4: 640, 6: 80, 8: 8, 9: 4, 10: 2, 11: 1 }

/**
 * 境界とみなす幅(8分の1地域メッシュの1行・1列に対する割合)。約 0.1mm。
 * 緯度 × 960 などの掛け算では、境界ちょうどの点が 26895.999999999985 のように南・西の隣へずれる。
 * e-Stat の境界データの頂点(142.02499999999998 など)も同じ。整数からこの幅の中にある値は境界の上とみなす。
 */
const SNAP = 1e-6

/** 小数の行・列の値を、境界の誤差を吸収して整数にする(南西の端は含み、北・東の端は隣) */
function snapFloor(x: number): number {
  const k = Math.round(x)
  return Math.abs(x - k) < SNAP ? k : Math.floor(x)
}

function rowOf(lat: number): number {
  if (!Number.isFinite(lat)) throw new RangeError(`緯度が数値ではありません:${lat}`)
  const row = snapFloor(lat * ROWS_PER_DEG)
  if (row < 0 || row >= ROW_LIMIT) {
    throw new RangeError(`緯度 ${lat} は地域メッシュの範囲(0度以上 66.67度未満)の外です`)
  }
  return row
}

function colOf(lon: number): number {
  if (!Number.isFinite(lon)) throw new RangeError(`経度が数値ではありません:${lon}`)
  const col = snapFloor((lon - LON_ORIGIN) * COLS_PER_DEG)
  if (col < 0 || col >= COL_LIMIT) {
    throw new RangeError(`経度 ${lon} は地域メッシュの範囲(100度以上 200度未満)の外です`)
  }
  return col
}

function checkDigits(digits: number): asserts digits is Digits {
  if (!(digits in SPAN)) throw new RangeError(`メッシュコードの桁数は 4・6・8・9・10・11 のどれかです:${digits}`)
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

/** 分割地域メッシュの番号。南西 1・南東 2・北西 3・北東 4 */
function quadrant(northBit: number, eastBit: number): number {
  return northBit * 2 + eastBit + 1
}

/** 8分の1地域メッシュの行・列から 11 桁のコードを作る */
function codeOf(row: number, col: number): string {
  const p = Math.floor(row / 640)
  const u = Math.floor(col / 640)
  const r1 = row % 640
  const c1 = col % 640
  const q = Math.floor(r1 / 80)
  const v = Math.floor(c1 / 80)
  const r2 = r1 % 80
  const c2 = c1 % 80
  const r = Math.floor(r2 / 8)
  const w = Math.floor(c2 / 8)
  const r3 = r2 % 8
  const c3 = c2 % 8
  const half = quadrant((r3 >> 2) & 1, (c3 >> 2) & 1)
  const quarter = quadrant((r3 >> 1) & 1, (c3 >> 1) & 1)
  const eighth = quadrant(r3 & 1, c3 & 1)
  return `${pad2(p)}${pad2(u)}${q}${v}${r}${w}${half}${quarter}${eighth}`
}

/** 4・6・8・9・10・11 桁。2次は 0〜7、3次は 0〜9、分割は 1〜4 */
const CODE_PATTERN = /^\d{4}(?:[0-7]{2}(?:\d{2}[1-4]{0,3})?)?$/

/** コードを読み、南西の端の行・列と、1辺の行数(列数)を返す */
function parse(code: string): { row: number; col: number; span: number } {
  if (typeof code !== 'string' || !CODE_PATTERN.test(code)) {
    throw new RangeError(`地域メッシュのコードとして読めません:${String(code)}`)
  }
  const digit = (i: number) => code.charCodeAt(i) - 48
  let row = (digit(0) * 10 + digit(1)) * 640
  let col = (digit(2) * 10 + digit(3)) * 640
  let span = 640
  if (code.length >= 6) {
    row += digit(4) * 80
    col += digit(5) * 80
    span = 80
  }
  if (code.length >= 8) {
    row += digit(6) * 8
    col += digit(7) * 8
    span = 8
  }
  for (let i = 8; i < code.length; i++) {
    span /= 2
    const k = digit(i) - 1
    row += (k >> 1) * span
    col += (k & 1) * span
  }
  return { row, col, span }
}

/**
 * 緯度経度(度、世界測地系)を含む地域メッシュのコード。
 * 境界の上の点は、そのセルの南西側の端を含む(北・東の端の上なら北・東の隣のセル)。
 */
export function meshCode(lat: number, lon: number, digits: 4 | 6 | 8 | 9 | 10 | 11): string {
  checkDigits(digits)
  return codeOf(rowOf(lat), colOf(lon)).slice(0, digits)
}

/** コードが表す区画の南・西・北・東の端(度) */
export function meshBounds(code: string): Bounds {
  const { row, col, span } = parse(code)
  // 整数どうしの割り算1回にして、丸めを1回で済ませる
  return {
    south: row / ROWS_PER_DEG,
    west: (LON_ORIGIN * COLS_PER_DEG + col) / COLS_PER_DEG,
    north: (row + span) / ROWS_PER_DEG,
    east: (LON_ORIGIN * COLS_PER_DEG + col + span) / COLS_PER_DEG,
  }
}

/** 区画の中心 */
export function meshCenter(code: string): LatLon {
  const { row, col, span } = parse(code)
  return centerOf(row, col, span)
}

function centerOf(row: number, col: number, span: number): LatLon {
  return {
    lat: (2 * row + span) / (2 * ROWS_PER_DEG),
    lon: (2 * LON_ORIGIN * COLS_PER_DEG + 2 * col + span) / (2 * COLS_PER_DEG),
  }
}

/** 上位の区画のコード。digits がコードの桁数と同じならそのまま返す */
export function parentCode(code: string, digits: 4 | 6 | 8 | 9 | 10): string {
  parse(code)
  checkDigits(digits)
  if (digits > code.length) {
    throw new RangeError(`${code}(${code.length} 桁)より大きい区画のコードではありません:${digits} 桁`)
  }
  return code.slice(0, digits)
}

/**
 * 範囲と重なる区画のコード(南の行から北へ、各行は西から東の順)。
 * 範囲の南・西の端は含み、北・東の端がちょうど区画の境界なら、その北・東の区画は含めない
 * (meshBounds の結果をそのまま渡すと、その区画だけが返る)。面積の無い範囲(点や線)は、その点を含む区画を返す。
 * 11 桁で広い範囲を渡すと数が多くなる(1次メッシュ1つで 409,600)。呼び出し側で範囲を絞る。
 */
export function meshCodesInBounds(b: Bounds, digits: 4 | 11): string[] {
  checkDigits(digits)
  const { south, west, north, east } = b
  if (![south, west, north, east].every(Number.isFinite)) {
    throw new RangeError('範囲の緯度経度が数値ではありません')
  }
  if (south > north || west > east) {
    throw new RangeError('範囲の南が北より大きいか、西が東より大きくなっています')
  }
  const span = SPAN[digits]
  const rowFirst = Math.floor(rowOf(south) / span)
  const colFirst = Math.floor(colOf(west) / span)
  const rowLast = Math.max(rowFirst, lastIndex(north * ROWS_PER_DEG, span, ROW_LIMIT, '緯度', north))
  const colLast = Math.max(colFirst, lastIndex((east - LON_ORIGIN) * COLS_PER_DEG, span, COL_LIMIT, '経度', east))

  const codes: string[] = []
  for (let r = rowFirst; r <= rowLast; r++) {
    for (let c = colFirst; c <= colLast; c++) codes.push(codeOf(r * span, c * span).slice(0, digits))
  }
  return codes
}

/** 北・東の端を含む区画の番号。端がちょうど区画の境界なら1つ手前(南・西)の区画 */
function lastIndex(x: number, span: number, limit: number, label: string, value: number): number {
  const k = Math.round(x)
  const onLine = Math.abs(x - k) < SNAP
  const index = onLine ? k : Math.floor(x)
  if (index < 0 || index > limit || (index === limit && !onLine)) {
    throw new RangeError(`${label} ${value} は地域メッシュの範囲の外です`)
  }
  const cell = Math.floor(index / span)
  return onLine && index % span === 0 ? cell - 1 : cell
}

// 距離:GRS80 楕円体のヒュベニの式。数 km の距離では国土地理院の測量計算(測地線長)と mm 単位で一致し、
// 100 km でも差は 0.002% ほど。球(半径 6,371km)のハーバサイン式は北海道で東西に 0.27% ずれるため使わない。
const GRS80_A = 6378137
const GRS80_F = 1 / 298.257222101
const GRS80_E2 = GRS80_F * (2 - GRS80_F)
const RAD = Math.PI / 180

/** 2点の平均緯度での、緯度 1ラジアンあたりの長さ(子午線曲率半径)と、経度 1ラジアンあたりの長さ */
function metresPerRadian(lat1: number, lat2: number): { ky: number; kx: number } {
  const meanLat = ((lat1 + lat2) / 2) * RAD
  const sin = Math.sin(meanLat)
  const w2 = 1 - GRS80_E2 * sin * sin
  const w = Math.sqrt(w2)
  const m = (GRS80_A * (1 - GRS80_E2)) / (w2 * w)
  const n = GRS80_A / w
  return { ky: m, kx: n * Math.cos(meanLat) }
}

/** 2点間の距離(m)。徒歩圏のような数 km までの距離に使う */
export function distanceM(a: LatLon, b: LatLon): number {
  const { ky, kx } = metresPerRadian(a.lat, b.lat)
  const dy = ky * (b.lat - a.lat) * RAD
  const dx = kx * (b.lon - a.lon) * RAD
  return Math.sqrt(dy * dy + dx * dx)
}

/**
 * どれかの点から、中心までの距離が radiusM 以内にある 8分の1地域メッシュ(11 桁)のコード。
 * 距離は distanceM(meshCenter(コード), 点) と同じ計算で、ちょうど radiusM のセルも含む。
 * 並びは南の行から北へ、各行は西から東。点ごとに周囲の候補のセルだけを調べ、重複は Set で除く。
 */
export function cellsWithinRadius(points: LatLon[], radiusM: number): string[] {
  if (!Number.isFinite(radiusM) || radiusM < 0) {
    throw new RangeError(`半径は 0 以上の数で指定してください:${radiusM}`)
  }
  if (points.length === 0) return []

  // 候補の範囲を点ごとに決める。緯度 1ラジアンの長さは赤道の子午線曲率半径 a(1−e²) より短くならず、
  // 経度 1ラジアンの長さは a × cos(範囲の北端の緯度) より短くならないので、この値で割れば候補を取りこぼさない。
  // 中心の行・列への換算の丸めに備えて、上下左右に1つずつ広げる。
  const windows = new Int32Array(points.length * 4)
  let rowBase = Infinity
  let colBase = Infinity
  let colMax = -Infinity
  const dLatDeg = radiusM / (GRS80_A * (1 - GRS80_E2) * RAD)
  points.forEach((p, i) => {
    const row = rowOf(p.lat)
    const col = colOf(p.lon)
    const northLat = Math.min(p.lat + dLatDeg, 89)
    const dLonDeg = radiusM / (GRS80_A * Math.cos(northLat * RAD) * RAD)
    const rowLo = Math.max(0, Math.ceil((p.lat - dLatDeg) * ROWS_PER_DEG - 0.5) - 1)
    const rowHi = Math.min(ROW_LIMIT - 1, Math.floor((p.lat + dLatDeg) * ROWS_PER_DEG - 0.5) + 1)
    const colLo = Math.max(0, Math.ceil((p.lon - dLonDeg - LON_ORIGIN) * COLS_PER_DEG - 0.5) - 1)
    const colHi = Math.min(COL_LIMIT - 1, Math.floor((p.lon + dLonDeg - LON_ORIGIN) * COLS_PER_DEG - 0.5) + 1)
    windows.set([Math.min(rowLo, row), Math.max(rowHi, row), Math.min(colLo, col), Math.max(colHi, col)], i * 4)
    rowBase = Math.min(rowBase, windows[i * 4])
    colBase = Math.min(colBase, windows[i * 4 + 2])
    colMax = Math.max(colMax, windows[i * 4 + 3])
  })

  // キーは範囲全体の左下からの通し番号(小さい整数のほうが Set が速い)
  const width = colMax - colBase + 1
  const keys = new Set<number>()
  points.forEach((p, i) => {
    const rowLo = windows[i * 4]
    const rowHi = windows[i * 4 + 1]
    const colLo = windows[i * 4 + 2]
    const colHi = windows[i * 4 + 3]
    for (let row = rowLo; row <= rowHi; row++) {
      const centerLat = centerOf(row, 0, 1).lat
      const { ky, kx } = metresPerRadian(centerLat, p.lat)
      const dy = ky * (p.lat - centerLat) * RAD
      if (Math.abs(dy) > radiusM) continue
      const rowKey = (row - rowBase) * width - colBase
      for (let col = colLo; col <= colHi; col++) {
        const centerLon = centerOf(0, col, 1).lon
        const dx = kx * (p.lon - centerLon) * RAD
        if (Math.sqrt(dy * dy + dx * dx) <= radiusM) keys.add(rowKey + col)
      }
    }
  })

  const sorted = Float64Array.from(keys).sort()
  const codes = new Array<string>(sorted.length)
  for (let i = 0; i < sorted.length; i++) {
    const key = sorted[i]
    const row = rowBase + Math.floor(key / width)
    const col = colBase + (key % width)
    codes[i] = codeOf(row, col)
  }
  return codes
}

// 面積:GRS80 楕円体の上で、緯線と経線に囲まれた区画の面積(正積緯度の式)。
// 縦 × 横で近似した値(統計局「地域メッシュ統計の概要」表7)とは 0.1% ほどの違いに収まる。
const GRS80_E = Math.sqrt(GRS80_E2)
const GRS80_B2 = (GRS80_A * (1 - GRS80_F)) ** 2

/** 赤道から緯度 lat までの帯の、経度 1ラジアンあたりの面積を b²/2 で割った値 */
function authalicTerm(lat: number): number {
  const s = Math.sin(lat * RAD)
  return s / (1 - GRS80_E2 * s * s) + Math.atanh(GRS80_E * s) / GRS80_E
}

/** 区画の面積(km²)。人口密度の計算に使う */
export function cellAreaKm2(code: string): number {
  const { row, span } = parse(code)
  const dLonRad = (span / COLS_PER_DEG) * RAD
  const band = authalicTerm((row + span) / ROWS_PER_DEG) - authalicTerm(row / ROWS_PER_DEG)
  return ((GRS80_B2 / 2) * dLonRad * band) / 1e6
}
