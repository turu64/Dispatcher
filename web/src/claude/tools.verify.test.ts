// AI の便の検索(search_trips)の結果の大きさの、実データでの確かめ(波4のレビューの申し送り、指摘18.4)。
// 道北バスの 9/17 版(data/raw/gtfs/dohoku_bus_減便前.zip)と、到達圏の参照データ(data/out/ref/)、学校・病院の参照データ
// (data/out/ref/facilities/)があるときだけ走る(どれもコミットしない)。デモ用の調査結果(data/demo/research_dohoku.json)が
// あれば、保存済みの結果(デモ)を読み込んだときと同じく施設の調べた結果にも使う(facility_research が入る)。
// 画面と同じ流れ(apply_policy の下書き → 承認 → 到達圏の store の比較 → buildRestoreHintContext に施設を渡す)で、
// 平日を土曜ダイヤにする減便の方針(期間 11/9〜、外す系統なし)のなくなる便を、limit 50 で offset を進めながら読み、
// 1回に返る便の数と大きさを出力する。
// 1回の相談のツールの上限(12 回)の中で、なくなる便をすべて読めること(指摘15.2)を確かめる。最初の数回は判断材料の多い便
// (9 つの判断材料と学校・病院を持つ便)が並ぶため、1回に返る便の数は後ろの回より少ない
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'
import { feedServicePeriod } from '../gtfs/calendar'
import { loadGtfsZip, type GtfsFeed } from '../gtfs/load'
import { toStops } from '../gtfs/parse'
import { computeReach } from '../reach/reach'
import { fetchRefData } from '../reach/refData'
import { originStops } from '../reach/input'
import { facilityMeshes, fetchFacilities } from '../ref/facilities'
import { createEditStore, type EditState } from '../store/edit'
import { DEFAULT_PRIORITY_ORDER } from '../store/priority'
import { createReachStore } from '../store/reach'
import { buildRestoreHintContext, type FacilitySourceForHints } from '../store/restoreHintContext'
import { parseResult, type ResearchResult } from './research'
import { byteLength, MAX_RESULT_BYTES, runTool, type ToolDeps } from './tools'

const ZIP = fileURLToPath(new URL('../../../data/raw/gtfs/dohoku_bus_減便前.zip', import.meta.url))
const REF_DIR = fileURLToPath(new URL('../../../data/out/ref/', import.meta.url))
const FACILITY_DIR = `${REF_DIR}facilities/`
const DEMO = fileURLToPath(new URL('../../../data/demo/research_dohoku.json', import.meta.url))
const MESHES = ['6541', '6542', '6543', '6641', '6642', '6643']
const ready = existsSync(ZIP) && existsSync(FACILITY_DIR) && MESHES.every((m) => existsSync(`${REF_DIR}${m}.json`))

async function settle(store: ReturnType<typeof createReachStore>) {
  await new Promise((r) => setTimeout(r, 0))
  for (let i = 0; i < 4000 && store.getState().computing; i++) await new Promise((r) => setTimeout(r, 5))
}

const SEARCH = { scope: 'removed', route_ids: null, stop_name: null, depart_from: null, depart_to: null, limit: 50, hints: null }

describe.skipIf(!ready)('search_trips の大きさ(道北バス、学校・病院を読み込んだとき)', () => {
  let deps: ToolDeps
  let edit: () => EditState
  let facilityCount = 0
  let researched = 0

  beforeAll(async () => {
    const feed: GtfsFeed = await loadGtfsZip(new Uint8Array(readFileSync(ZIP)).buffer)
    const reach = createReachStore({
      compute: async (input) => computeReach(structuredClone(input)),
      loadRef: (mesh1s) =>
        fetchRefData(
          mesh1s,
          async (url) => {
            const mesh1 = url.replace('/api/ref/', '')
            return { ok: true, status: 200, json: async () => JSON.parse(readFileSync(`${REF_DIR}${mesh1}.json`, 'utf8')) }
          },
          new Map(),
        ),
      today: () => '20261105',
      paramDelayMs: 0,
    })
    const store = createEditStore({ now: () => new Date('2026-11-05T00:30:00Z'), onEdited: (e) => reach.getState().setEdited(e) })
    store.getState().setBase({ feed, zip: new ArrayBuffer(0), label: 'dohoku_bus_減便前.zip', sample: null })
    reach.getState().setSource({ feed, stops: toStops(feed).stops, period: feedServicePeriod(feed) })
    await settle(reach)

    const stops = originStops(feed, toStops(feed).stops).stops
    const loaded = await fetchFacilities(
      facilityMeshes(stops),
      async (url) => {
        const path = `${FACILITY_DIR}${url.split('/').pop()}.json`
        if (!existsSync(path)) return { ok: false, status: 404, json: async () => null }
        return { ok: true, status: 200, json: async () => JSON.parse(readFileSync(path, 'utf8')) }
      },
      new Map(),
    )
    if (!loaded.ok) throw new Error(loaded.message)
    const results = new Map<string, ResearchResult>(
      (existsSync(DEMO) ? (JSON.parse(readFileSync(DEMO, 'utf8')) as { results: unknown[] }).results : [])
        .map((v) => parseResult({ ...(v as object), origin: 'demo' }))
        .filter((r): r is ResearchResult => r !== null)
        .map((r) => [r.targetId, r] as const),
    )
    const source: FacilitySourceForHints = {
      facilities: { status: 'ready', key: 'verify', facilities: loaded.facilities, sources: [] },
      results,
      order: DEFAULT_PRIORITY_ORDER,
    }
    edit = () => store.getState()
    deps = {
      edit,
      reach,
      holidays: () => null,
      today: () => '20261105',
      policyServices: () => ({ weekday: '01', saturday: '03', sundayHoliday: null }),
      hintContext: (f) => buildRestoreHintContext(reach.getState(), f, source),
      hintWaitMs: 120_000,
    }
    const r = await runTool(
      'apply_policy',
      { kind: 'weekday_to_saturday', start_date: '20261109', end_date: null, excluded_route_ids: [], reason_category: null, reason_note: '' },
      deps,
    )
    if (r.isError) throw new Error(r.content)
    expect(store.getState().commit()).toEqual({ ok: true })
    await settle(reach)
    expect(reach.getState().error).toBeNull()
    // 重い場面(到達圏の比較と学校・病院がそろう)になっていること
    const ctx = deps.hintContext(reach.getState().edited!.feed)
    facilityCount = ctx?.facilities?.length ?? 0
    researched = ctx?.facilities?.filter((f) => f.research).length ?? 0
  }, 180_000)

  it('limit 50 で 20KB に収め、offset で続きを重ならず漏れなく、12 回以内で読める', async () => {
    expect(facilityCount).toBeGreaterThan(0)
    const seen = new Set<string>()
    const pages: { returned: number; bytes: number; withFacilities: number; research: number }[] = []
    let offset: number | null = 0
    let total = -1
    for (let i = 0; offset !== null && i < 20; i++) {
      const r = await runTool('search_trips', { ...SEARCH, offset }, deps)
      expect(r.isError).toBe(false)
      expect(byteLength(r.content)).toBeLessThanOrEqual(MAX_RESULT_BYTES)
      const body = JSON.parse(r.content) as {
        total: number
        returned: number
        offset: number
        next_offset: number | null
        facility_research?: unknown[]
        trips: { trip_id: string; nearby_facilities?: unknown[] }[]
      }
      total = body.total
      expect(body.offset).toBe(offset)
      for (const t of body.trips) {
        expect(seen.has(t.trip_id)).toBe(false)
        seen.add(t.trip_id)
      }
      pages.push({
        returned: body.returned,
        bytes: byteLength(r.content),
        withFacilities: body.trips.filter((t) => (t.nearby_facilities?.length ?? 0) > 0).length,
        research: body.facility_research?.length ?? 0,
      })
      offset = body.next_offset
    }
    console.log(
      `学校・病院 ${facilityCount} 施設(調べた結果つき ${researched})。なくなる便 ${total} 便を ${pages.length} 回で読みました。1回ごとの便の数と大きさ:` +
        pages.map((p) => `${p.returned} 便 ${(p.bytes / 1024).toFixed(1)}KB(学校・病院つき ${p.withFacilities}、facility_research ${p.research})`).join('、'),
    )
    expect(seen.size).toBe(total)
    expect(pages[0].withFacilities).toBeGreaterThan(0)
    // 1回の相談のツールの上限(12 回)で読み切れる。最初の回(判断材料の最も多い便)も 15 便を下回らない
    expect(pages.length).toBeLessThanOrEqual(12)
    expect(pages[0].returned).toBeGreaterThanOrEqual(15)
  }, 120_000)
})
