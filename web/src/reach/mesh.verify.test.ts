// 実データでの確かめ。ファイルが無ければスキップする(data/raw/ はコミットしない)。
//
// - e-Stat 境界データ(地域メッシュ、世界測地系 JGD2011、Shape 形式、1次メッシュ 6542)
//   https://www.e-stat.go.jp/gis/statmap-search/data?dlserveyId=S&code=6542&coordSys=1&format=shape&downloadType=5&datum=2011(3次 = 1km)
//   https://www.e-stat.go.jp/gis/statmap-search/data?dlserveyId=Q&code=6542&coordSys=1&format=shape&downloadType=5&datum=2011(4分の1 = 250m)
//   2026-11-03 に取得し、data/raw/mesh/estat_mesh_boundary_1km_6542.zip・estat_mesh_boundary_250m_6542.zip に置いた
// - 国勢調査(令和2年)250m メッシュ人口(data/raw/mesh/tblT001142Q6542.txt。参照データの担当が置いたもの)
// - 道北バスの GTFS(data/raw/gtfs/dohoku_bus_減便前.zip・dohoku_bus_減便後.zip)
// - 参照データの担当の出力(data/out/ref/*.json。data/ の Python で作ったコード)
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import { loadGtfsZip } from '../gtfs/load'
import {
  cellAreaKm2,
  cellsWithinRadius,
  distanceM,
  meshBounds,
  meshCenter,
  meshCode,
  meshCodesInBounds,
  parentCode,
  type Bounds,
  type LatLon,
} from './mesh'

const raw = (path: string) => fileURLToPath(new URL(`../../../data/raw/${path}`, import.meta.url))
const BOUNDARY_1KM = raw('mesh/estat_mesh_boundary_1km_6542.zip')
const BOUNDARY_250M = raw('mesh/estat_mesh_boundary_250m_6542.zip')
const POPULATION_250M = raw('mesh/tblT001142Q6542.txt')
const DOHOKU_GTFS = raw('gtfs/dohoku_bus_減便前.zip')
const DOHOKU_GTFS_AFTER = raw('gtfs/dohoku_bus_減便後.zip')
const REF_DIR = fileURLToPath(new URL('../../../data/out/ref/', import.meta.url))

interface BoundaryRecord extends Bounds {
  code: string
}

/** 同じ境界データを何度も読まないように、読んだ結果を使い回す */
const boundaryCache = new Map<string, Promise<BoundaryRecord[]>>()
function readBoundary(path: string): Promise<BoundaryRecord[]> {
  let records = boundaryCache.get(path)
  if (!records) {
    records = readBoundaryFile(path)
    boundaryCache.set(path, records)
  }
  return records
}

/** ZIP の中の Shape ファイル(.shp)の各図形の外接矩形と、属性(.dbf)の KEY_CODE を読む */
async function readBoundaryFile(path: string): Promise<BoundaryRecord[]> {
  const zip = await JSZip.loadAsync(readFileSync(path))
  const entry = (ext: string) => {
    const file = Object.values(zip.files).find((f) => f.name.toLowerCase().endsWith(ext))
    if (!file) throw new Error(`${path} に ${ext} がありません`)
    return file.async('uint8array')
  }
  const [shp, dbf] = await Promise.all([entry('.shp'), entry('.dbf')])
  const boxes = readShpBoxes(shp)
  const codes = readDbfColumn(dbf, 'KEY_CODE')
  expect(codes).toHaveLength(boxes.length)
  return boxes.map((b, i) => ({ ...b, code: codes[i] }))
}

/** .shp:100 バイトの見出しのあと、各レコードは 8 バイトの見出し(ビッグエンディアン)と内容。内容の 4 バイト目から外接矩形 */
function readShpBoxes(bytes: Uint8Array): Bounds[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const boxes: Bounds[] = []
  for (let p = 100; p < bytes.byteLength; ) {
    const contentBytes = view.getInt32(p + 4, false) * 2
    expect(view.getInt32(p + 8, true)).toBe(5) // ポリゴン
    boxes.push({
      west: view.getFloat64(p + 12, true),
      south: view.getFloat64(p + 20, true),
      east: view.getFloat64(p + 28, true),
      north: view.getFloat64(p + 36, true),
    })
    p += 8 + contentBytes
  }
  return boxes
}

/** .dbf:32 バイトの見出しと 32 バイトずつの列の定義(0x0D で終わり)、そのあと固定長のレコード(先頭 1 バイトは削除の印) */
function readDbfColumn(bytes: Uint8Array, name: string): string[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const count = view.getUint32(4, true)
  const headerBytes = view.getUint16(8, true)
  const recordBytes = view.getUint16(10, true)
  const text = (from: number, to: number) => String.fromCharCode(...bytes.subarray(from, to))
  let offset = 1
  let field: { offset: number; length: number } | undefined
  for (let p = 32; bytes[p] !== 0x0d; p += 32) {
    const length = bytes[p + 16]
    if (text(p, p + 11).replace(/\0.*$/s, '') === name) field = { offset, length }
    offset += length
  }
  if (!field) throw new Error(`.dbf に ${name} の列がありません`)
  const values: string[] = []
  for (let i = 0; i < count; i++) {
    const start = headerBytes + i * recordBytes + field.offset
    values.push(text(start, start + field.length).trim())
  }
  return values
}

/** 各区画について、コード・範囲・境界の扱いを確かめ、食い違いを返す */
function checkRecords(records: BoundaryRecord[], digits: 8 | 10): string[] {
  const failures: string[] = []
  for (const r of records) {
    const h = r.north - r.south
    const w = r.east - r.west
    const b = meshBounds(r.code)
    const near = (x: number, y: number) => Math.abs(x - y) < 1e-9
    if (!(near(b.south, r.south) && near(b.west, r.west) && near(b.north, r.north) && near(b.east, r.east))) {
      failures.push(`${r.code}:meshBounds が境界データと違う`)
    }
    // 境界データの頂点(142.02499999999998 のような値)をそのまま渡す
    if (meshCode(r.south, r.west, digits) !== r.code) failures.push(`${r.code}:南西の角が ${meshCode(r.south, r.west, digits)}`)
    const c = meshCenter(r.code)
    if (meshCode(c.lat, c.lon, digits) !== r.code) failures.push(`${r.code}:中心が別のセル`)
    const ne = meshCode(r.north, r.east, digits)
    if (ne !== meshCode(r.north + h / 2, r.east + w / 2, digits)) failures.push(`${r.code}:北東の角が北東の隣のセルではない(${ne})`)
  }
  return failures
}

describe.skipIf(!existsSync(BOUNDARY_1KM))('e-Stat 境界データ:3次メッシュ(1km)6542', () => {
  it('6,400 区画すべてで、コード・範囲・境界の扱いが境界データと一致する', async () => {
    const records = await readBoundary(BOUNDARY_1KM)
    expect(records).toHaveLength(80 * 80)
    expect(new Set(records.map((r) => r.code)).size).toBe(records.length)
    expect(checkRecords(records, 8).slice(0, 10)).toEqual([])
  })
})

describe.skipIf(!existsSync(BOUNDARY_250M))('e-Stat 境界データ:4分の1地域メッシュ(250m)6542', () => {
  it('102,400 区画すべてで、コード・範囲・境界の扱いが境界データと一致する', async () => {
    const records = await readBoundary(BOUNDARY_250M)
    expect(records).toHaveLength(320 * 320)
    expect(new Set(records.map((r) => r.code)).size).toBe(records.length)
    expect(checkRecords(records, 10).slice(0, 10)).toEqual([])

    // 8分の1(11 桁)は境界データが無いので、250m の区画を4つに分けて、末尾の番号(南西 1・南東 2・北西 3・北東 4)と親を確かめる
    const quarters = [
      [0.25, 0.25, '1'],
      [0.25, 0.75, '2'],
      [0.75, 0.25, '3'],
      [0.75, 0.75, '4'],
    ] as const
    const failures: string[] = []
    for (const r of records) {
      const h = r.north - r.south
      const w = r.east - r.west
      for (const [fy, fx, last] of quarters) {
        const code = meshCode(r.south + h * fy, r.west + w * fx, 11)
        if (code !== `${r.code}${last}` || parentCode(code, 10) !== r.code) failures.push(`${r.code} の ${last}:${code}`)
      }
    }
    expect(failures.slice(0, 10)).toEqual([])
  })

  it.skipIf(!existsSync(POPULATION_250M))('国勢調査の 250m メッシュ人口のコードは、すべて境界データの区画にある', async () => {
    const known = new Set((await readBoundary(BOUNDARY_250M)).map((r) => r.code))
    const lines = readFileSync(POPULATION_250M, 'latin1').split(/\r?\n/).slice(2).filter((l) => l !== '')
    expect(lines.length).toBeGreaterThan(1000)
    const missing: string[] = []
    for (const line of lines) {
      const [keyCode, , htksaki] = line.split(',')
      for (const code of [keyCode, htksaki]) {
        if (!code) continue
        if (!known.has(code) || parentCode(code, 4) !== '6542') missing.push(code)
      }
    }
    expect(missing.slice(0, 10)).toEqual([])
  })
})

describe('e-Stat 境界データの範囲を meshCodesInBounds に渡す(頂点は 142.02499999999998 のような値)', () => {
  it.skipIf(!existsSync(BOUNDARY_250M))('4分の1(250m)102,400 区画:8分の1 の4つ(南西 1・南東 2・北西 3・北東 4 の順)だけが返る', async () => {
    const failures: string[] = []
    for (const r of await readBoundary(BOUNDARY_250M)) {
      const got = meshCodesInBounds(r, 11)
      const want = ['1', '2', '3', '4'].map((d) => `${r.code}${d}`)
      if (got.join() !== want.join()) failures.push(`${r.code}:${got.join('・')}`)
    }
    expect(failures.slice(0, 10)).toEqual([])
  })

  it.skipIf(!existsSync(BOUNDARY_1KM))('3次(1km)6,400 区画:8分の1 が 64 個で、すべてその区画の子。1次では 6542 だけ', async () => {
    const failures: string[] = []
    for (const r of await readBoundary(BOUNDARY_1KM)) {
      const codes = meshCodesInBounds(r, 11)
      if (codes.length !== 64 || new Set(codes).size !== 64 || codes.some((c) => parentCode(c, 8) !== r.code)) {
        failures.push(`${r.code}:${codes.length} 個`)
      }
      const mesh1 = meshCodesInBounds(r, 4)
      if (mesh1.join() !== '6542') failures.push(`${r.code}:1次が ${mesh1.join('・')}`)
    }
    expect(failures.slice(0, 10)).toEqual([])
  })
})

describe.skipIf(!existsSync(DOHOKU_GTFS))('道北バスの停留所(dohoku_bus_減便前.zip)', () => {
  it('全停留所 × 半径 1,600m のセルを数秒以内に求め、結果は正しい', async () => {
    const buf = readFileSync(DOHOKU_GTFS)
    const feed = await loadGtfsZip(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength))
    const stops: LatLon[] = (feed.tables.get('stops')?.rows ?? [])
      .map((row) => ({ lat: Number(row.stop_lat), lon: Number(row.stop_lon) }))
      .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon) && p.lat > 0 && p.lon > 100)
    expect(stops.length).toBeGreaterThan(1000)

    const start = performance.now()
    const codes = cellsWithinRadius(stops, 1600)
    const ms = performance.now() - start
    const mesh1 = [...new Set(stops.map((p) => meshCode(p.lat, p.lon, 4)))].sort()
    console.info(
      `道北バス:${stops.length.toLocaleString()} 停留所 × 1,600m で ${codes.length.toLocaleString()} セル、${ms.toFixed(0)} ms。` +
        `停留所のある1次メッシュ:${mesh1.join('・')}`,
    )
    expect(ms).toBeLessThan(3000)
    expect(new Set(codes).size).toBe(codes.length)

    // 停留所のあるセルは必ず入る(セルの中心まで 90m ほど)
    const found = new Set(codes)
    expect(stops.filter((p) => !found.has(meshCode(p.lat, p.lon, 11)))).toEqual([])
    // 結果から間引いたセルは、どれかの停留所から 1,600m 以内
    const far = codes.filter((_, i) => i % 97 === 0).filter((c) => !stops.some((p) => distanceM(meshCenter(c), p) <= 1600))
    expect(far).toEqual([])
  })
})

/** 1点からの総当たり:範囲の中のすべての 8分の1 のセルを調べる(遅いが確かなやり方) */
function bruteForceOne(p: LatLon, radiusM: number): string[] {
  const dLat = radiusM / 110_000 + 0.002
  const dLon = radiusM / (110_000 * Math.cos((p.lat * Math.PI) / 180)) + 0.003
  // 地域メッシュの範囲(緯度 0〜66.67度、経度 100〜200度)で切り詰める
  const b = {
    south: Math.max(0, p.lat - dLat),
    west: Math.max(100, p.lon - dLon),
    north: Math.min(100 / 1.5, p.lat + dLat),
    east: Math.min(200, p.lon + dLon),
  }
  return meshCodesInBounds(b, 11).filter((c) => distanceM(meshCenter(c), p) <= radiusM)
}

/** GTFS の stops.txt の緯度経度を、元の文字列のまま読む */
async function readStopStrings(path: string): Promise<{ lat: string; lon: string }[]> {
  const buf = readFileSync(path)
  const feed = await loadGtfsZip(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength))
  return (feed.tables.get('stops')?.rows ?? [])
    .map((row) => ({ lat: (row.stop_lat ?? '').trim(), lon: (row.stop_lon ?? '').trim() }))
    .filter((s) => /^\d+(\.\d+)?$/.test(s.lat) && /^\d+(\.\d+)?$/.test(s.lon) && Number(s.lat) > 0 && Number(s.lon) > 100)
}

/**
 * 十進の文字列の緯度経度から、8分の1地域メッシュの行・列を整数(BigInt)で正確に求め、統計局の算出式どおりに 11 桁のコードにする。
 * 浮動小数を使わない、mesh.ts とは別の作り方。mesh.ts は境界の 1e-6 行・列(約 0.1mm)手前の値を境界の上とみなすので、それに合わせる。
 */
function exactMeshCode(latStr: string, lonStr: string): string {
  const fraction = (s: string): [bigint, bigint] => {
    const [i, f = ''] = s.split('.')
    return [BigInt(i + f), 10n ** BigInt(f.length)]
  }
  const index = (num: bigint, den: bigint): number => {
    const q = num / den
    const rest = num - q * den
    // 次の境界まで 1e-6 未満なら境界の上(mesh.ts の取り決め)
    return Number((den - rest) * 1_000_000n < den ? q + 1n : q)
  }
  const [latNum, latDen] = fraction(latStr)
  const [lonNum, lonDen] = fraction(lonStr)
  const row = index(latNum * 960n, latDen)
  const col = index((lonNum - 100n * lonDen) * 640n, lonDen)
  const p = Math.floor(row / 640)
  const u = Math.floor(col / 640)
  const q = Math.floor((row % 640) / 80)
  const v = Math.floor((col % 640) / 80)
  const r = Math.floor((row % 80) / 8)
  const w = Math.floor((col % 80) / 8)
  const s = row % 8
  const t = col % 8
  // 算出式:m = (s ÷ 4 の商) × 2 + (t ÷ 4 の商) + 1。4分の1・8分の1 も同じ形
  const m = Math.floor(s / 4) * 2 + Math.floor(t / 4) + 1
  const n = Math.floor((s % 4) / 2) * 2 + Math.floor((t % 4) / 2) + 1
  const o = (s % 2) * 2 + (t % 2) + 1
  return `${String(p).padStart(2, '0')}${String(u).padStart(2, '0')}${q}${v}${r}${w}${m}${n}${o}`
}

describe.each([
  ['dohoku_bus_減便前.zip', DOHOKU_GTFS],
  ['dohoku_bus_減便後.zip', DOHOKU_GTFS_AFTER],
])('道北バスの停留所(%s)で、取りこぼしが無いかを確かめる', (_name, path) => {
  it.skipIf(!existsSync(path))('停留所の緯度経度(小数 3〜13 桁の文字列)の 11 桁のコードが、整数で正確に求めた値と一致する', async () => {
    const strings = await readStopStrings(path)
    expect(strings.length).toBeGreaterThan(1000)
    const failures = strings
      .filter((s) => meshCode(Number(s.lat), Number(s.lon), 11) !== exactMeshCode(s.lat, s.lon))
      .map((s) => `${s.lat},${s.lon}:${meshCode(Number(s.lat), Number(s.lon), 11)}(期待 ${exactMeshCode(s.lat, s.lon)})`)
    expect(failures.slice(0, 10)).toEqual([])
  })

  it.skipIf(!existsSync(path))('半径 1,600m:選んだ停留所で、総当たりの結果と完全に一致し、全停留所の結果にも漏れなく入る', async () => {
    const stops = (await readStopStrings(path)).map((s) => ({ lat: Number(s.lat), lon: Number(s.lon) }))
    // 30 件おきの停留所と、1次メッシュの境界(緯度 40分ごと・経度 1度ごと)に近い 10 件
    const toLine = (p: LatLon) => {
      const dLat = Math.abs(p.lat * 1.5 - Math.round(p.lat * 1.5)) / 1.5
      const dLon = Math.abs(p.lon - Math.round(p.lon)) * Math.cos((p.lat * Math.PI) / 180)
      return Math.min(dLat, dLon)
    }
    const nearLine = [...stops].sort((a, b) => toLine(a) - toLine(b)).slice(0, 10)
    const picked = [...stops.filter((_, i) => i % 30 === 0), ...nearLine]
    expect(nearLine.every((p) => toLine(p) < 0.015)).toBe(true) // 1.6km より近い

    const all = new Set(cellsWithinRadius(stops, 1600))
    const failures: string[] = []
    for (const p of picked) {
      const want = bruteForceOne(p, 1600)
      const got = cellsWithinRadius([p], 1600)
      if (got.join() !== want.join()) failures.push(`(${p.lat}, ${p.lon}):${got.length} 個(総当たり ${want.length} 個)`)
      const missing = want.filter((c) => !all.has(c))
      if (missing.length > 0) failures.push(`(${p.lat}, ${p.lon}):全停留所の結果に ${missing.length} 個が無い`)
    }
    expect(failures.slice(0, 10)).toEqual([])
  })
})

interface RefJson {
  mesh1: string
  pop250: Record<string, number>
  did125: string[]
  stations: { name: string; lat: number; lon: number }[]
}
const refFiles = existsSync(REF_DIR) ? readdirSync(REF_DIR).filter((f) => /^\d{4}\.json$/.test(f)) : []

describe.skipIf(refFiles.length === 0)('参照データ(data/out/ref、Python で作ったコード)と mesh.ts の取り決めが合う', () => {
  it.each(refFiles)('%s:pop250 は 10 桁、did125 は 11 桁で、どちらもこの1次メッシュの区画。駅もこの1次メッシュの中', (file) => {
    const ref = JSON.parse(readFileSync(`${REF_DIR}${file}`, 'utf8')) as RefJson
    expect(`${ref.mesh1}.json`).toBe(file)
    const failures: string[] = []
    for (const [code, people] of Object.entries(ref.pop250)) {
      if (code.length !== 10 || parentCode(code, 4) !== ref.mesh1) failures.push(`pop250 ${code}`)
      if (!(Number.isInteger(people) && people > 0)) failures.push(`pop250 ${code} の人口 ${people}`)
    }
    for (const code of ref.did125) {
      const c = meshCenter(code)
      if (code.length !== 11 || parentCode(code, 4) !== ref.mesh1 || meshCode(c.lat, c.lon, 11) !== code) failures.push(`did125 ${code}`)
    }
    if (new Set(ref.did125).size !== ref.did125.length) failures.push('did125 に重複がある')
    for (const s of ref.stations) {
      if (meshCode(s.lat, s.lon, 4) !== ref.mesh1) failures.push(`駅 ${s.name}(${s.lat}, ${s.lon})`)
    }
    expect(failures.slice(0, 10)).toEqual([])
  })

  it.skipIf(!existsSync(BOUNDARY_250M) || !refFiles.includes('6542.json'))('6542 の pop250 のキーは、すべて e-Stat 境界データの 250m の区画', async () => {
    const known = new Set((await readBoundary(BOUNDARY_250M)).map((r) => r.code))
    const ref = JSON.parse(readFileSync(`${REF_DIR}6542.json`, 'utf8')) as RefJson
    expect(Object.keys(ref.pop250).filter((c) => !known.has(c))).toEqual([])
  })
})

describe('別の計算方法との比較(実データは使わない)', () => {
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

  it('小数 1〜8 桁の緯度経度 10 万点で、meshCode が整数で正確に求めた値と一致する', () => {
    const next = random(11)
    const failures: string[] = []
    for (let i = 0; i < 100_000; i++) {
      const decimals = 1 + Math.floor(next() * 8)
      const lat = (24 + next() * 22).toFixed(decimals)
      const lon = (123 + next() * 30).toFixed(decimals)
      const got = meshCode(Number(lat), Number(lon), 11)
      if (got !== exactMeshCode(lat, lon)) failures.push(`${lat},${lon}:${got}(期待 ${exactMeshCode(lat, lon)})`)
    }
    expect(failures.slice(0, 10)).toEqual([])
  })

  it('distanceM は、GRS80 の測地線長(Vincenty の逆解法)と 2km 以内で 1mm 未満、20km 以内で 1e-6 未満の差', () => {
    const A = 6378137
    const F = 1 / 298.257222101
    const B = A * (1 - F)
    const R = Math.PI / 180
    const vincenty = (a: LatLon, b: LatLon): number => {
      const L = (b.lon - a.lon) * R
      const u1 = Math.atan((1 - F) * Math.tan(a.lat * R))
      const u2 = Math.atan((1 - F) * Math.tan(b.lat * R))
      const [s1, c1, s2, c2] = [Math.sin(u1), Math.cos(u1), Math.sin(u2), Math.cos(u2)]
      let lambda = L
      let sinS = 0
      let cosS = 0
      let sigma = 0
      let cos2a = 0
      let cos2m = 0
      for (let k = 0; k < 100; k++) {
        const sl = Math.sin(lambda)
        const cl = Math.cos(lambda)
        sinS = Math.hypot(c2 * sl, c1 * s2 - s1 * c2 * cl)
        if (sinS === 0) return 0
        cosS = s1 * s2 + c1 * c2 * cl
        sigma = Math.atan2(sinS, cosS)
        const sinA = (c1 * c2 * sl) / sinS
        cos2a = 1 - sinA * sinA
        cos2m = cosS - (2 * s1 * s2) / cos2a
        const C = (F / 16) * cos2a * (4 + F * (4 - 3 * cos2a))
        const prev = lambda
        lambda = L + (1 - C) * F * sinA * (sigma + C * sinS * (cos2m + C * cosS * (-1 + 2 * cos2m * cos2m)))
        if (Math.abs(lambda - prev) < 1e-13) break
      }
      const uu = (cos2a * (A * A - B * B)) / (B * B)
      const AA = 1 + (uu / 16384) * (4096 + uu * (-768 + uu * (320 - 175 * uu)))
      const BB = (uu / 1024) * (256 + uu * (-128 + uu * (74 - 47 * uu)))
      const ds =
        BB * sinS * (cos2m + (BB / 4) * (cosS * (-1 + 2 * cos2m * cos2m) - (BB / 6) * cos2m * (-3 + 4 * sinS * sinS) * (-3 + 4 * cos2m * cos2m)))
      return B * AA * (sigma - ds)
    }
    // 国土地理院の値(mesh.test.ts と同じ)で、この Vincenty の式自体を確かめておく
    expect(Math.abs(vincenty({ lat: 35.681236, lon: 139.767125 }, { lat: 35.689487, lon: 139.691706 }) - 6888.071)).toBeLessThan(0.001)

    const next = random(12)
    let worstShort = 0
    let worstRelative = 0
    for (let i = 0; i < 5000; i++) {
      const a = { lat: 41.3 + next() * 4.3, lon: 139.8 + next() * 5.6 }
      const d = i % 2 === 0 ? next() * 2000 : next() * 20000
      const angle = next() * 2 * Math.PI
      const b = { lat: a.lat + (d * Math.cos(angle)) / 111_000, lon: a.lon + (d * Math.sin(angle)) / (111_000 * Math.cos(a.lat * R)) }
      const h = distanceM(a, b)
      const v = vincenty(a, b)
      if (v <= 2000) worstShort = Math.max(worstShort, Math.abs(h - v))
      if (v > 1) worstRelative = Math.max(worstRelative, Math.abs(h - v) / v)
    }
    expect(worstShort).toBeLessThan(0.001)
    expect(worstRelative).toBeLessThan(1e-6)
  })

  it('cellAreaKm2 は、楕円体の面積要素 M(φ)·N(φ)·cosφ の数値積分(シンプソン)と 1e-9 未満の差', () => {
    const A = 6378137
    const F = 1 / 298.257222101
    const E2 = F * (2 - F)
    const R = Math.PI / 180
    const integrand = (phi: number) => {
      const s = Math.sin(phi)
      const w2 = 1 - E2 * s * s
      return ((A * (1 - E2)) / w2 ** 1.5) * (A / Math.sqrt(w2)) * Math.cos(phi)
    }
    const numeric = (code: string) => {
      const b = meshBounds(code)
      const n = 100
      const lo = b.south * R
      const h = ((b.north - b.south) * R) / n
      let sum = integrand(lo) + integrand(lo + n * h)
      for (let i = 1; i < n; i++) sum += integrand(lo + i * h) * (i % 2 === 1 ? 4 : 2)
      return ((sum * h) / 3) * (b.east - b.west) * R / 1e6
    }
    const next = random(13)
    const failures: string[] = []
    for (let i = 0; i < 500; i++) {
      const lat = next() * 66.6
      const lon = 100 + next() * 99.9
      for (const digits of [4, 6, 8, 9, 10, 11] as const) {
        const code = meshCode(lat, lon, digits)
        const relative = Math.abs(cellAreaKm2(code) / numeric(code) - 1)
        if (!(relative < 1e-9)) failures.push(`${code}:${relative}`)
      }
    }
    expect(failures.slice(0, 10)).toEqual([])
  })

  it('cellsWithinRadius:日本の各地・緯度経度の端・セルの中心や角の点・半径 0〜5,000m で、総当たりと一致する', () => {
    const next = random(14)
    const failures: string[] = []
    const cases: { points: LatLon[]; radius: number }[] = []
    for (let i = 0; i < 120; i++) {
      const base = { lat: 24 + next() * 22, lon: 123 + next() * 22 }
      const points = Array.from({ length: 1 + Math.floor(next() * 3) }, () => {
        const p = { lat: base.lat + (next() - 0.5) * 0.05, lon: base.lon + (next() - 0.5) * 0.05 }
        const kind = next()
        if (kind < 0.25) return meshCenter(meshCode(p.lat, p.lon, 11))
        if (kind < 0.5) {
          const b = meshBounds(meshCode(p.lat, p.lon, 11))
          return { lat: b.south, lon: b.west }
        }
        return p
      })
      cases.push({ points, radius: [0, 62.5, 400, 800, 1600, 5000][i % 6] * (next() < 0.5 ? 1 : 1 + next() * 0.01) })
    }
    // 地域メッシュの範囲の端(候補の範囲を切り詰める処理を通す)
    for (const p of [
      { lat: 0.001, lon: 142 },
      { lat: 66.6666, lon: 199.9999 },
      { lat: 43, lon: 100.001 },
      { lat: 0, lon: 100 },
    ]) {
      cases.push({ points: [p], radius: 1600 })
    }
    for (const { points, radius } of cases) {
      const want = [...new Set(points.flatMap((p) => bruteForceOne(p, radius)))].sort((a, b) => {
        const ca = meshCenter(a)
        const cb = meshCenter(b)
        return ca.lat - cb.lat || ca.lon - cb.lon
      })
      const got = cellsWithinRadius(points, radius)
      if (got.join() !== want.join()) failures.push(`${JSON.stringify(points)} 半径 ${radius}:${got.length} 個(総当たり ${want.length} 個)`)
    }
    expect(failures.slice(0, 10)).toEqual([])
  })
})
