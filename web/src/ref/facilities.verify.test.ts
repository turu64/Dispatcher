// 前提情報の調査の対象の候補と既定の選び方の、実データでの確かめ。
// 道北バスの 9/17 版(data/raw/gtfs/dohoku_bus_減便前.zip)と、施設の参照データ(data/out/ref/facilities)があるときだけ走る
// (どちらもコミットしない)。候補の数・既定の選び方を出力し、決まった並びであること・上限・自社を選ばないことを確かめる
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'
import { loadGtfsZip, type GtfsFeed } from '@/gtfs/load'
import { toStops } from '@/gtfs/parse'
import { originStops } from '@/reach/input'
import { DEFAULT_PRIORITY_ORDER } from '@/store/priority'
import { DEFAULT_MAX_TARGETS, defaultSelection, facilityMeshes, fetchFacilities, researchCandidates, type ResearchCandidate } from './facilities'

const ZIP = fileURLToPath(new URL('../../../data/raw/gtfs/dohoku_bus_減便前.zip', import.meta.url))
const REF = fileURLToPath(new URL('../../../data/out/ref/facilities/', import.meta.url))
const ready = existsSync(ZIP) && existsSync(REF)

describe.skipIf(!ready)('施設の候補(道北バス)', () => {
  let feed: GtfsFeed
  let candidates: ResearchCandidate[]
  let selected: string[]

  beforeAll(async () => {
    feed = await loadGtfsZip(new Uint8Array(readFileSync(ZIP)).buffer)
    const stops = originStops(feed, toStops(feed).stops).stops
    const mesh1s = facilityMeshes(stops)
    const result = await fetchFacilities(
      mesh1s,
      async (url) => {
        const path = `${REF}${url.split('/').pop()}.json`
        if (!existsSync(path)) return { ok: false, status: 404, json: async () => null }
        return { ok: true, status: 200, json: async () => JSON.parse(readFileSync(path, 'utf8')) }
      },
      new Map(),
    )
    if (!result.ok) throw new Error(result.message)
    const agencies = (feed.tables.get('agency')?.rows ?? []).map((r) => r.agency_name ?? '')
    candidates = researchCandidates(result.facilities, stops, agencies)
    selected = defaultSelection(candidates, DEFAULT_PRIORITY_ORDER, DEFAULT_MAX_TARGETS)
    const byKind = new Map<string, number>()
    for (const c of candidates) byKind.set(c.facility.kind, (byKind.get(c.facility.kind) ?? 0) + 1)
    const names = new Map(candidates.map((c) => [c.facility.targetId, c.facility.name]))
    console.log(
      `候補 ${candidates.length} 件(${[...byKind].map(([k, n]) => `${k} ${n}`).join('、')})、既定で選ぶ ${selected.length} 件:` +
        selected.map((id) => names.get(id)).join('・'),
    )
  }, 60_000)

  it('候補があり、既定の選び方は上限まで・自社を除く・同じ入力で同じ並び', () => {
    expect(candidates.length).toBeGreaterThan(0)
    // 上限は周辺のバス事業者を除いて数える
    expect(selected.filter((id) => candidates.find((c) => c.facility.targetId === id)?.facility.kind !== 'operator').length).toBeLessThanOrEqual(DEFAULT_MAX_TARGETS)
    expect(new Set(selected).size).toBe(selected.length)
    const own = candidates.filter((c) => c.ownOperator).map((c) => c.facility.targetId)
    expect(own.length).toBeGreaterThan(0)
    for (const id of own) expect(selected).not.toContain(id)
    expect(defaultSelection([...candidates].reverse(), DEFAULT_PRIORITY_ORDER, DEFAULT_MAX_TARGETS)).toEqual(selected)
  })
})
