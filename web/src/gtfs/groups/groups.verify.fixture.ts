/**
 * 実データ(data/raw/gtfs/。コミットしない)を使うテストの読み込み(テスト専用)。ファイルが無ければ、呼ぶ側でスキップする
 */
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parseHolidayJson, type HolidayList } from '../holidays'
import { loadGtfsZip, type GtfsFeed } from '../load'

export function gtfsPath(file: string): string {
  return fileURLToPath(new URL(`../../../../data/raw/gtfs/${file}`, import.meta.url))
}

/** data/ の加工で作る祝日一覧の JSON(サーバーの GET /api/holidays と同じもの) */
export const HOLIDAYS_JSON = fileURLToPath(new URL('../../../../data/out/ref/holidays.json', import.meta.url))

export function hasData(...files: string[]): boolean {
  return existsSync(HOLIDAYS_JSON) && files.every((f) => existsSync(gtfsPath(f)))
}

export function loadHolidays(): HolidayList {
  return parseHolidayJson(JSON.parse(readFileSync(HOLIDAYS_JSON, 'utf8')))
}

const cache = new Map<string, Promise<GtfsFeed>>()

export function loadFeed(file: string): Promise<GtfsFeed> {
  let p = cache.get(file)
  if (!p) {
    const buf = readFileSync(gtfsPath(file))
    p = loadGtfsZip(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength))
    cache.set(file, p)
  }
  return p
}
