import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import JSZip from 'jszip'
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest'
import { activeServiceIds, addDays } from './calendar'
import { departureCountsByBand, makeBands } from './departures'
import { type GtfsFeed, type GtfsRow, loadGtfsZip } from './load'
import { toStops } from './parse'
import { handleGtfsWorkerRequest, startGtfsWorker, type GtfsWorkerScope } from './worker'
import { createGtfsWorkerClient, type GtfsWorkerLike } from './workerClient'

/** ZIP の中身を ArrayBuffer にする */
function bufferOf(path: string): ArrayBuffer {
  const buf = readFileSync(path)
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
}

/** 手書きの stops.txt だけを持つフィードを作る */
function feedWithStops(rows: GtfsRow[]): GtfsFeed {
  const fields = ['stop_id', 'stop_name', 'stop_lat', 'stop_lon', 'location_type', 'parent_station']
  return { tables: new Map([['stops', { fileName: 'stops.txt', fields, rows }]]), warnings: [] }
}

/** 画面側と Worker 側を structuredClone でつなぐ。本物の ZIP と feed を、複製を通して往復させるのに使う */
function createLoopback(load?: (data: Blob | ArrayBuffer) => Promise<GtfsFeed>) {
  const toWorkerSide: Array<(event: { data: unknown }) => void> = []
  const toClientSide: Array<(event: Event) => void> = []
  const scope: GtfsWorkerScope = {
    addEventListener: (_type, listener) => void toWorkerSide.push(listener),
    postMessage: (message) => {
      const copy = structuredClone(message)
      queueMicrotask(() => toClientSide.forEach((l) => l({ data: copy } as unknown as Event)))
    },
  }
  const worker: GtfsWorkerLike = {
    postMessage: (message) => {
      const copy = structuredClone(message)
      queueMicrotask(() => toWorkerSide.forEach((l) => l({ data: copy })))
    },
    addEventListener: (type, listener) => {
      if (type === 'message') toClientSide.push(listener)
    },
    terminate: () => {},
  }
  startGtfsWorker(scope, load)
  return worker
}

// 実データが無くても走る、検証担当が足した端のケース(緯度経度の読み取り)
describe('toStops の端のケース(検証担当)', () => {
  it('桁が極端に長い値は、無限大にならず数でない行として除く', () => {
    const { stops, invalid } = toStops(
      feedWithStops([
        { stop_id: 'huge', stop_lat: '9'.repeat(400), stop_lon: '142' },
        { stop_id: 'tiny', stop_lat: `0.${'0'.repeat(400)}1`, stop_lon: '142' },
        { stop_id: 'long', stop_lat: `43.${'1'.repeat(400)}`, stop_lon: '142' },
      ]),
    )
    // 小さすぎる値は 0 に、長い小数は丸められるだけで、どちらも範囲内の数として読む
    expect(stops.map((s) => s.id)).toEqual(['tiny', 'long'])
    expect(invalid).toBe(1)
  })

  it('全角の空白・改行なしの空白・BOM で囲まれた値も、前後の空白として取る', () => {
    const { stops, invalid } = toStops(
      feedWithStops([{ stop_id: '\u3000A\u00a0', stop_lat: '\ufeff43.5\u3000', stop_lon: '\u00a0142.5\n', parent_station: '\u3000P\u3000' }]),
    )
    expect(invalid).toBe(0)
    expect(stops).toEqual([{ id: 'A', name: '', lat: 43.5, lon: 142.5, locationType: 0, parentStation: 'P' }])
  })

  it('値の途中の空白は数として読まない', () => {
    const { stops, invalid } = toStops(
      feedWithStops([
        { stop_id: 'a', stop_lat: '43 .5', stop_lon: '142' },
        { stop_id: 'b', stop_lat: '4 3', stop_lon: '142' },
        { stop_id: 'c', stop_lat: '- 43', stop_lon: '142' },
        { stop_id: 'd', stop_lat: '--43', stop_lon: '142' },
        { stop_id: 'e', stop_lat: '+-43', stop_lon: '142' },
      ]),
    )
    expect(stops).toEqual([])
    expect(invalid).toBe(5)
  })

  it('同じ入力から呼ぶたびに同じ結果になり、結果の Stop は入力の行と独立している', () => {
    const feed = feedWithStops([{ stop_id: 'A', stop_name: '駅前', stop_lat: '43', stop_lon: '142' }])
    const a = toStops(feed)
    const b = toStops(feed)
    expect(a).toEqual(b)
    a.stops[0].name = '書き換え'
    expect(feed.tables.get('stops')?.rows[0].stop_name).toBe('駅前')
    expect(toStops(feed).stops[0].name).toBe('駅前')
  })
})

// 実データが無くても走る、検証担当が足した端のケース(Worker の失敗の知らせ方)
describe('読み込みの失敗は日本語のメッセージで知らせる(検証担当)', () => {
  /** 圧縮済みのデータを壊した ZIP。ZIP の目次は読めるので、開くところでは失敗せず、ファイルを読むところで失敗する */
  async function corruptedZip(): Promise<ArrayBuffer> {
    const zip = new JSZip()
    zip.file('stops.txt', `stop_id,stop_name,stop_lat,stop_lon\n${'A,駅前,43.76,142.36\n'.repeat(500)}`)
    const bytes = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' })
    // 先頭のファイルの圧縮データ(ローカルヘッダー 30 バイト + ファイル名 9 バイトの後ろ)を壊す
    for (let i = 39; i < 60; i++) bytes[i] = 0xff
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
  }

  const hasJapanese = (s: string) => /[\u3040-\u30ff\u3400-\u9fff\uff00-\uffef]/.test(s)

  // 元の Error をコンソールに残すので、テストの出力が荒れないよう黙らせ、出したことは確かめる
  let consoleError: MockInstance<typeof console.error>
  beforeEach(() => {
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
  })
  afterEach(() => consoleError.mockRestore())

  it('圧縮データが壊れた ZIP でも、ライブラリの英語のメッセージをそのまま出さない', async () => {
    const response = await handleGtfsWorkerRequest({ id: 1, data: await corruptedZip() })
    expect(response.ok).toBe(false)
    if (response.ok) return
    expect(hasJapanese(response.message)).toBe(true)
    // 元の Error は消さずにコンソールへ残す
    expect(consoleError).toHaveBeenCalledTimes(1)
  })

  it('ファイルを読み取れなかった Blob(英語の DOMException 相当)でも、日本語のメッセージにする', async () => {
    const unreadable = new Blob(['x'])
    vi.spyOn(unreadable, 'arrayBuffer').mockRejectedValue(new Error('The requested file could not be read, typically due to permission problems.'))
    const response = await handleGtfsWorkerRequest({ id: 2, data: unreadable })
    expect(response.ok).toBe(false)
    if (response.ok) return
    expect(hasJapanese(response.message)).toBe(true)
  })

  it('日本語のメッセージは、変えずにそのまま届ける', async () => {
    const response = await handleGtfsWorkerRequest({ id: 3, data: new ArrayBuffer(0) }, () =>
      Promise.reject(new Error('GTFS のファイル(.txt)が見つかりません。')),
    )
    expect(response).toEqual({ id: 3, ok: false, message: 'GTFS のファイル(.txt)が見つかりません。' })
    expect(consoleError).not.toHaveBeenCalled()
  })

  it('壊れた ZIP の失敗が、Worker を通した窓口でも日本語のメッセージで届く', async () => {
    const client = createGtfsWorkerClient(() => createLoopback())
    const error = await client.load(await corruptedZip()).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(Error)
    expect(hasJapanese((error as Error).message)).toBe(true)
  })
})

// 道北バスの GTFS(data/raw/gtfs/ に置く。コミットしない)で toStops を確かめる。ファイルがあるときだけ走る
const SAMPLES = [{ file: 'dohoku_bus_減便前.zip' }, { file: 'dohoku_bus_減便後.zip' }].map((s) => ({
  ...s,
  path: fileURLToPath(new URL(`../../../data/raw/gtfs/${s.file}`, import.meta.url)),
}))

// 実物の ZIP を読むので、全件を並列で走らせると既定の 5 秒を超えることがある。1件ごとに 30 秒まで待つ
for (const sample of SAMPLES) {
  describe.skipIf(!existsSync(sample.path))(`道北バス(${sample.file})の停留所`, () => {
    it('停留所は 1582 件で、除かれる行は無い', async () => {
      const buf = readFileSync(sample.path)
      const feed = await loadGtfsZip(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength))
      const { stops, invalid } = toStops(feed)

      expect(stops).toHaveLength(1582)
      expect(invalid).toBe(0)
      // stops.txt の行数と一致する(1 行も落ちず、増えもしない)
      expect(stops).toHaveLength(feed.tables.get('stops')?.rows.length ?? -1)
      // stop_id に重複が無い
      expect(new Set(stops.map((s) => s.id)).size).toBe(stops.length)
      // 道北バスの停留所はすべて location_type 0 で、親の駅を持たない
      expect(stops.every((s) => s.locationType === 0)).toBe(true)
      expect(stops.every((s) => s.parentStation === '')).toBe(true)
    }, 30_000)

    it('緯度経度が北海道北部の範囲に入る(列の取り違えが無い)', async () => {
      const buf = readFileSync(sample.path)
      const feed = await loadGtfsZip(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength))
      const { stops } = toStops(feed)

      const lats = stops.map((s) => s.lat)
      const lons = stops.map((s) => s.lon)
      expect(Math.min(...lats)).toBeGreaterThan(43)
      expect(Math.max(...lats)).toBeLessThan(45)
      expect(Math.min(...lons)).toBeGreaterThan(141)
      expect(Math.max(...lons)).toBeLessThan(144)
    }, 30_000)

    it('全行の緯度経度が、stops.txt の文字列を Number にした値と一致する', async () => {
      const feed = await loadGtfsZip(bufferOf(sample.path))
      const rows = feed.tables.get('stops')?.rows ?? []
      const { stops } = toStops(feed)
      expect(stops).toHaveLength(rows.length)
      for (const [i, stop] of stops.entries()) {
        // 1 件でも食い違えば、どの行かが分かるよう stop_id つきで比べる
        expect([stop.id, stop.lat, stop.lon, stop.name]).toEqual([
          rows[i].stop_id,
          Number(rows[i].stop_lat),
          Number(rows[i].stop_lon),
          rows[i].stop_name,
        ])
      }
    }, 30_000)

    it('運行日の出発を数えた停留所は、すべて toStops の id にある(stop_id の空白の扱いが両方で同じ)', async () => {
      const feed = await loadGtfsZip(bufferOf(sample.path))
      const ids = new Set(toStops(feed).stops.map((s) => s.id))
      const date = '20261104' // 水曜。減便前・減便後のどちらの運行期間にも入る
      const { counts } = departureCountsByBand(
        feed,
        { today: activeServiceIds(feed, date), yesterday: activeServiceIds(feed, addDays(date, -1)) },
        makeBands(3),
      )
      expect(counts.size).toBeGreaterThan(500) // 何も数えていないための一致にしない
      const missing = [...counts.keys()].filter((id) => !ids.has(id))
      expect(missing).toEqual([])
    }, 30_000)

    it('Worker を通した窓口で読んだ feed から、直接読んだときと同じ停留所が取れる(ZIP の実物・Blob も)', async () => {
      const data = bufferOf(sample.path)
      const direct = toStops(await loadGtfsZip(data))
      const client = createGtfsWorkerClient(() => createLoopback())
      const [fromBuffer, fromBlob] = await Promise.all([client.load(data), client.load(new Blob([data]))])
      expect(toStops(fromBuffer)).toEqual(direct)
      expect(toStops(fromBlob)).toEqual(direct)
      // 表の件数と、警告が、複製を通っても欠けない
      const expected = await loadGtfsZip(data)
      for (const [name, table] of expected.tables) {
        expect(fromBuffer.tables.get(name)?.rows.length).toBe(table.rows.length)
        expect(fromBuffer.tables.get(name)?.fields).toEqual(table.fields)
      }
      expect(fromBuffer.warnings).toEqual(expected.warnings)
      expect(data.byteLength).toBeGreaterThan(0) // 渡した ArrayBuffer を取り上げない
    }, 30_000)

    it('途中で切れた ZIP は、Worker を通した窓口でも日本語のメッセージで失敗し、続けて読める', async () => {
      const data = bufferOf(sample.path)
      const client = createGtfsWorkerClient(() => createLoopback())
      await expect(client.load(data.slice(0, Math.floor(data.byteLength / 2)))).rejects.toThrow('ZIP として開けませんでした')
      await expect(client.load(data)).resolves.toBeDefined()
    }, 30_000)

    it('先頭の停留所の値が stops.txt と合う', async () => {
      const buf = readFileSync(sample.path)
      const feed = await loadGtfsZip(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength))
      const { stops } = toStops(feed)
      expect(stops[0]).toEqual({
        id: '0010_01',
        name: '旭川駅前',
        lat: 43.764727,
        lon: 142.357912,
        locationType: 0,
        parentStation: '',
      })
    }, 30_000)
  })
}
