import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'
import { loadGtfsZip, type GtfsFeed, type GtfsRow } from '../load'
import { validateEdit } from '../validate/edit'
import { serializeTable } from '../write'
import { diffWeekdayTrips, NOTICE47_BANDS, restoreTotals } from './diff'
import { applyForm2, type Form2Result } from './form2'
import type { Form2Plan } from './ops'
import { compareStrings, signatureDigest, sortByStopSequence, stopTimesByTrip, tripSignature } from './signature'

// 形2の正解データ(form2.golden.json)との照合。道北バスの 9/17 版(data/raw/gtfs/ に置く。コミットしない)があるときだけ走る。
// 正解データは、Python で別に書いた参照実装の出力の集計(取り決め 1104 §11)。照合は ZIP の SHA-256 が合うときだけ行う。
// 10/29 版との trip_id の一致は求めない(§5.4)。0151 の除外は GTFS から推定せず、方針の入力として渡す。
// 道北バスには便を指す transfers・attributions の行が無く、translations の record_id は全行が空なので、§5.2 の tripReferences に当たらない。

const ZIP = fileURLToPath(new URL('../../../../data/raw/gtfs/dohoku_bus_減便前.zip', import.meta.url))
const GOLDEN = fileURLToPath(new URL('./form2.golden.json', import.meta.url))
const GENERATED_AT = '202611041200'
const SCENARIOS = ['main', 'addBack24', 'replaceOnly', 'periodEnd', 'edgeCases'] as const
const FILES = ['trips', 'stop_times', 'calendar', 'calendar_dates', 'feed_info'] as const

interface GoldenSummary {
  output: {
    feedVersion: string
    feedStartDate: string
    feedEndDate: string
    validityDays: number
    tripCountByService: Record<string, number>
    weekday: {
      tripCount: number
      composition: { fromReplacement: number; keptExcludedRoutes: number; addedBack: number }
      versusInput: { sameSignature: number; removed: number; added: number }
      stopTimeCount: number
      tripsByNotice47Band: Record<string, number>
      stopsWithDeparturesBy3hBand: Record<string, number>
      signatureDigest: string
    }
    calendarDates: { kept: number; dropped: { service_id: string; date: string; exception_type: string }[] }
  }
  tripIds: Record<string, unknown>
  addBack: Record<string, unknown>
  rowOrder: { trips: string; stop_times: string }
  files: Record<string, { rows: number; sha256: string }>
  warnings: string[]
}
interface Golden {
  input: { sha256: string; feedVersion: string }
  generatedAt: string
  scenarios: Record<string, { policy: Omit<Form2Plan, 'kind'>; summary: GoldenSummary }>
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function trimmed(v: string | undefined): string {
  return v === undefined ? '' : v.trim()
}

/** 正解データの README の定義で、出力の平日便を数え直す(実装の集計関数は使わない) */
async function recountWeekday(feed: GtfsFeed, weekdayService: string) {
  const trips = (feed.tables.get('trips')?.rows ?? []).filter((t) => trimmed(t.service_id) === weekdayService)
  const groups = stopTimesByTrip(feed.tables.get('stop_times')?.rows ?? [])
  const notice47: Record<string, number> = { '06-09': 0, '10-14': 0, '15-19': 0, '20-05': 0 }
  const bands = ['06-09', '09-12', '12-15', '15-18', '18-21', '21-24']
  const stopsByBand = bands.map(() => new Set<string>())
  const signatures: string[] = []
  let stopTimeCount = 0
  for (const trip of trips) {
    const rows: GtfsRow[] = groups.get(trimmed(trip.trip_id)) ?? []
    stopTimeCount += rows.length
    signatures.push(tripSignature(trimmed(trip.route_id), rows))
    const first = sortByStopSequence(rows)[0]
    const h = Number(trimmed(first?.departure_time).split(':')[0])
    const key = h >= 6 && h <= 9 ? '06-09' : h >= 10 && h <= 14 ? '10-14' : h >= 15 && h <= 19 ? '15-19' : '20-05'
    notice47[key]++
    // 3時間ごとの出発のある停留所:pickup_type が 1 でない行(空は 0)。各便の最後の停留所は除かない。
    // アプリの departureCountsByBand は最後の停留所も除くので定義が違う。道北バスで一致するのは、
    // 全 1,169 便の最後の停留所が pickup_type=1 だから
    for (const r of rows) {
      if (trimmed(r.pickup_type) === '1') continue
      const dep = trimmed(r.departure_time)
      if (dep === '') continue
      const hour = Number(dep.split(':')[0])
      const b = Math.floor((hour - 6) / 3)
      if (hour >= 6 && hour < 24) stopsByBand[b].add(trimmed(r.stop_id))
    }
  }
  return {
    tripCount: trips.length,
    stopTimeCount,
    tripsByNotice47Band: notice47,
    stopsWithDeparturesBy3hBand: Object.fromEntries(bands.map((b, i) => [b, stopsByBand[i].size])),
    signatureDigest: await signatureDigest(signatures),
  }
}

const golden: Golden = JSON.parse(readFileSync(GOLDEN, 'utf-8'))

describe.skipIf(!existsSync(ZIP))('形2の正解データとの照合(道北バス 9/17 版)', () => {
  let base: GtfsFeed
  let matches = false
  const results = new Map<string, Form2Result>()
  const bytes = new Map<string, Map<string, Uint8Array>>()

  beforeAll(async () => {
    const buf = readFileSync(ZIP)
    const digest = sha256(buf)
    matches = digest === golden.input.sha256
    if (!matches) {
      console.warn(`道北バスの ZIP の SHA-256(${digest})が正解データ(${golden.input.sha256})と違うため、照合を飛ばします。`)
      return
    }
    base = await loadGtfsZip(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer)
    // applyForm2 は場面ごとに1回だけ呼び、結果を使い回す
    for (const name of SCENARIOS) {
      const outcome = applyForm2(base, { kind: 'weekdayToSaturday', ...golden.scenarios[name].policy }, { generatedAt: GENERATED_AT })
      if (!outcome.ok) throw new Error(`${name}: ${outcome.message}`)
      results.set(name, outcome.result)
      bytes.set(name, new Map(FILES.map((f) => [f, serializeTable(outcome.result.feed.tables.get(f)!)])))
    }
  })

  it('正解データの作成日時と入力の版が、照合の前提と同じ', () => {
    expect(golden.generatedAt).toBe(GENERATED_AT)
    if (!matches) return
    expect(trimmed(base.tables.get('feed_info')?.rows[0]?.feed_version)).toBe(golden.input.feedVersion)
  })

  for (const name of SCENARIOS) {
    describe(name, () => {
      it('5 つの表を書き出した SHA-256 と行数が正解データと同じ', () => {
        if (!matches) return
        const summary = golden.scenarios[name].summary
        for (const f of FILES) {
          const b = bytes.get(name)!.get(f)!
          const rows = results.get(name)!.feed.tables.get(f)!.rows.length
          expect({ file: f, rows, sha256: sha256(b) }).toEqual({ file: f, ...summary.files[`${f}.txt`] })
        }
      })

      it('trip_id・足し戻し・calendar_dates・有効期間・行の並び・警告の件数が正解データと同じ', () => {
        if (!matches) return
        const summary = golden.scenarios[name].summary
        const report = results.get(name)!.report
        const { rule, servicePartIndex, ...tripIds } = report.tripIds
        const { rule: goldenRule, ...goldenTripIds } = summary.tripIds
        expect(rule).toBe(goldenRule)
        expect(servicePartIndex).toBe(3)
        expect(tripIds).toEqual(goldenTripIds)
        expect(report.addBack).toEqual(summary.addBack)
        expect(report.calendarDates).toEqual(summary.output.calendarDates)
        expect(report.validity).toEqual({
          start: summary.output.feedStartDate,
          end: summary.output.feedEndDate,
          days: summary.output.validityDays,
        })
        expect(report.rowOrder).toEqual(summary.rowOrder)
        expect(report.warnings).toHaveLength(summary.warnings.length)
        expect(report.feedVersion.after).toBe(summary.output.feedVersion)
        expect(report.droppedServices).toEqual([])
      })

      it('平日便の差(残る・消える・入る)と公示第47号の時間帯の便数が、正解データの集計と同じ', () => {
        if (!matches) return
        const w = golden.scenarios[name].summary.output.weekday
        const result = results.get(name)!
        const diff = diffWeekdayTrips(base, result.feed, '01', result.plan.excludedRoutes)
        expect({ sameSignature: diff.same.length, removed: diff.removed.length, added: diff.added.length }).toEqual(w.versusInput)
        expect({
          fromReplacement: result.report.tripIds.derived.length,
          keptExcludedRoutes: result.report.tripIds.kept.length,
          addedBack: result.report.tripIds.addedBack.length,
        }).toEqual(w.composition)
        // byNotice47Band を系統について足し合わせると、正解データの tripsByNotice47Band になる
        const keys = ['06-09', '10-14', '15-19', '20-05']
        const sums = Object.fromEntries(
          NOTICE47_BANDS.map((band, i) => [keys[i], diff.byNotice47Band.filter((b) => b.band === band).reduce((n, b) => n + b.after, 0)]),
        )
        expect(sums).toEqual(w.tripsByNotice47Band)
      })

      it('validateEdit に error(exportOnly を含む)が無く、新しい有効期間は 15〜30 日', () => {
        if (!matches) return
        const result = results.get(name)!
        const issues = validateEdit(base, result, null)
        expect(issues.filter((i) => i.severity === 'error')).toEqual([])
        expect(issues.filter((i) => i.inherited)).toEqual([])
        expect(result.report.validity.days).toBeGreaterThanOrEqual(15)
        expect(result.report.validity.days).toBeLessThanOrEqual(30)
      })

      it('出力の平日便を数え直すと、便数・署名の digest・公示第47号の時間帯・3時間ごとの停留所の数が正解データと同じ', async () => {
        if (!matches) return
        const summary = golden.scenarios[name].summary
        const feed = results.get(name)!.feed
        const recount = await recountWeekday(feed, '01')
        const w = summary.output.weekday
        expect(recount).toEqual({
          tripCount: w.tripCount,
          stopTimeCount: w.stopTimeCount,
          tripsByNotice47Band: w.tripsByNotice47Band,
          stopsWithDeparturesBy3hBand: w.stopsWithDeparturesBy3hBand,
          signatureDigest: w.signatureDigest,
        })
        const byService: Record<string, number> = {}
        for (const t of feed.tables.get('trips')!.rows) byService[trimmed(t.service_id)] = (byService[trimmed(t.service_id)] ?? 0) + 1
        expect(Object.fromEntries(Object.entries(byService).sort(([a], [b]) => compareStrings(a, b)))).toEqual(
          summary.output.tripCountByService,
        )
      })
    })
  }

  it('addBack24 の出力は main とバイト単位で同じ(除外した系統の 4 便は ignoredExcludedRoute)', () => {
    if (!matches) return
    for (const f of FILES) expect(sha256(bytes.get('addBack24')!.get(f)!), f).toBe(sha256(bytes.get('main')!.get(f)!))
    expect(results.get('addBack24')!.report.addBack.ignoredExcludedRoute).toHaveLength(4)
  })

  it('レビューの集計と同じ数になる(使い回した trip_id、全曜日で便がなくなる系統、終発の早まり、足し戻しの集計)', () => {
    if (!matches) return
    const reusedCount = (name: string) => validateEdit(base, results.get(name)!, null).find((i) => i.code === 'tripIdReused')?.count
    // 写した便が、基準では別の便を指していた trip_id を使う(§5.2:除外なしで 16 便、0051・0151 を除外すると 15 便)
    expect(reusedCount('replaceOnly')).toBe(16)
    expect(reusedCount('main')).toBe(15)
    // 入れ替えると全曜日で便がなくなる、平日だけの系統(§3:65 系統のうち 19)
    const replaceOnly = diffWeekdayTrips(base, results.get('replaceOnly')!.feed, '01')
    // byRoute には、基準の平日に便の無い系統(写した便だけの系統)も入る
    expect(replaceOnly.byRoute.filter((r) => r.before > 0)).toHaveLength(65)
    expect(replaceOnly.vanishingRoutes).toBe(19)
    // main で前後とも便のある 55 系統のうち 12 系統の終発が早まる(0016 は 20:20 → 12:15)。0031 は 11 → 4 便
    const main = diffWeekdayTrips(base, results.get('main')!.feed, '01', ['0051', '0151'])
    const both = main.byRoute.filter((r) => r.before > 0 && r.after > 0)
    expect(both).toHaveLength(55)
    expect(both.filter((r) => (r.lastDepartureAfter ?? '') < (r.lastDepartureBefore ?? '')).length).toBe(12)
    expect(main.byRoute.find((r) => r.routeId === '0016')).toMatchObject({ lastDepartureBefore: '20:20', lastDepartureAfter: '12:15' })
    expect(main.byRoute.find((r) => r.routeId === '0031')).toMatchObject({ before: 11, after: 4 })
    expect(main.byRoute.filter((r) => r.excluded).map((r) => r.routeId)).toEqual(['0051', '0151'])
    // 足し戻した 20 便の営業運行時間を、stop_times から別に数えて照らす(§8 の粗い値は 915 分・06:50・19:26)
    const accepted = results.get('main')!.report.addBack.accepted
    const groups = stopTimesByTrip(base.tables.get('stop_times')!.rows)
    const secondsOf = (t: string | undefined) => {
      const [h, m, sec] = trimmed(t).split(':').map(Number)
      return h * 3600 + m * 60 + sec
    }
    let total = 0
    const firsts: number[] = []
    const lasts: number[] = []
    for (const id of accepted) {
      const rows = sortByStopSequence(groups.get(id)!)
      const first = secondsOf(rows[0].departure_time)
      const last = secondsOf(rows[rows.length - 1].arrival_time)
      total += last - first
      firsts.push(first)
      lasts.push(last)
    }
    const clock = (sec: number) => `${String(Math.floor(sec / 3600)).padStart(2, '0')}:${String(Math.floor((sec % 3600) / 60)).padStart(2, '0')}`
    const totals = restoreTotals(base, accepted)
    expect(totals).toEqual({
      trips: 20,
      serviceMinutes: Math.round(total / 60),
      unknownDuration: 0,
      earliestStart: clock(Math.min(...firsts)),
      latestEnd: clock(Math.max(...lasts)),
    })
    expect([totals.serviceMinutes, totals.earliestStart, totals.latestEnd]).toEqual([915, '06:50', '19:26'])
  })

  it('edgeCases で 0004_01_01_03_0710 の写しが 0004_01_01_01_0710_2 になる', () => {
    if (!matches) return
    const report = results.get('edgeCases')!.report
    expect(report.tripIds.derived.find((d) => d.from === '0004_01_01_03_0710')?.to).toBe('0004_01_01_01_0710_2')
    expect(report.tripIds.collisions).toEqual([
      { from: '0004_01_01_03_0710', candidate: '0004_01_01_01_0710', assigned: '0004_01_01_01_0710_2', collidedWithService: '01' },
    ])
  })
})
