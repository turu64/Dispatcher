import { describe, expect, it } from 'vitest'
import { buildReachStops, originStops } from '../../reach/input'
import { cellsWithinRadius, distanceM, meshCenter } from '../../reach/mesh'
import { computeReach, type RefData } from '../../reach/reach'
import { servicesFor } from '../calendar'
import { departureCountsByBand, makeBands } from '../departures'
import type { GtfsFeed } from '../load'
import { toStops } from '../parse'
import { diffWeekdayTrips } from './diff'
import { applyForm2 } from './form2'
import { basePlan, smallFeed } from './form2.fixture'
import type { Form2Plan } from './ops'
import { compareByHints, createRestoreHinter, restoreHints, type RestoreHint, type RestoreHintContext } from './restore'
import { cellAt, centerAt, DATE, REACH_PARAMS, reachBaseFeed, reachPlan, reachRef, reachSetup, STATION_CELL, STOP_CELLS } from './restore.fixture'

// 小さなフィード(form2.fixture.ts)を「平日を土曜ダイヤに」した版で、消える平日便は R1_0800_WK・R2_0900_WK・R3_0730_WK
function setup() {
  const base = smallFeed()
  const plan = basePlan()
  const outcome = applyForm2(base, plan, { generatedAt: '202611041200' })
  if (!outcome.ok) throw new Error(outcome.message)
  const edited = outcome.result.feed
  const diff = diffWeekdayTrips(base, edited, plan.weekdayService)
  const hinter = createRestoreHinter(base, edited, plan, [...diff.removed, ...diff.same], [...diff.same, ...diff.added])
  const byId = new Map(diff.removed.map((t) => [t.tripId, t]))
  return { base, plan, edited, diff, hinter, byId }
}

describe('足し戻しの手がかり(restoreHints)', () => {
  it('系統の終発の便と、足し戻さないと帯の便が 0 になる便に印を付ける', () => {
    const { hinter, byId } = setup()
    // R1 の平日は 07:00 と 08:00。08:00 は終発で、朝(6〜9時)。6〜9時台には写した土曜便が残るので、帯の便は 0 にならない
    expect(hinter(byId.get('R1_0800_WK')!).hints).toEqual(['lastTripOfRoute', 'morning'])
    // R2 の平日は 09:00 の1本だけ(始発かつ終発)。土曜便は 10:00 なので、6〜9時台(公示第47号)の便が 0 になる。9:00 は朝に入らない
    expect(hinter(byId.get('R2_0900_WK')!).hints).toEqual(['firstTripOfRoute', 'lastTripOfRoute', 'onlyTripInBand'])
    // R3 は平日だけの系統で、入れ替えると全曜日で便がなくなる
    expect(hinter(byId.get('R3_0730_WK')!)).toEqual({
      hints: ['weekdayOnlyRoute', 'routeWouldVanish', 'firstTripOfRoute', 'lastTripOfRoute', 'onlyTripInBand', 'morning'],
      lostCells: null,
    })
  })

  it('1つの便だけを調べても、索引を作って調べた結果と同じ', () => {
    const { base, plan, edited, hinter, byId } = setup()
    for (const trip of byId.values()) expect(restoreHints(base, edited, plan, trip)).toEqual(hinter(trip))
  })

  it('手がかりの多い順に並べる', () => {
    const { diff, hinter } = setup()
    const sorted = diff.removed
      .map((trip) => ({ trip, detail: hinter(trip) }))
      .sort(compareByHints)
      .map((c) => c.trip.tripId)
    expect(sorted).toEqual(['R3_0730_WK', 'R2_0900_WK', 'R1_0800_WK'])
  })

  it('手がかりの数が同じなら始発の時刻順にする', () => {
    const { byId } = setup()
    const a = { trip: byId.get('R1_0800_WK')!, detail: { hints: ['morning' as const], lostCells: null } }
    const b = { trip: byId.get('R3_0730_WK')!, detail: { hints: ['morning' as const], lostCells: null } }
    expect([a, b].sort(compareByHints).map((c) => c.trip.tripId)).toEqual(['R3_0730_WK', 'R1_0800_WK'])
  })
})

// ---- 到達圏を使う2つ(docs/interfaces-1105.md §7)。restore.fixture.ts の小さなフィードと到達圏を使う ----

const REACH_HINTS: RestoreHint[] = ['onlyServiceAtStop', 'restoresLostCells']

function reachHinter() {
  const setup = reachSetup()
  const { base, edited, plan } = setup
  const diff = diffWeekdayTrips(base, edited, plan.weekdayService)
  const hinter = createRestoreHinter(base, edited, plan, [...diff.removed, ...diff.same], [...diff.same, ...diff.added])
  const byId = new Map(diff.removed.map((t) => [t.tripId, t]))
  return { ...setup, diff, hinter, byId }
}

/** 停留所(STOP_CELLS の名前)から距離 r 以内に中心があるセルのコード */
function cellsNear(stop: string, r: number): Set<string> {
  const [dr, dc] = STOP_CELLS[stop]
  return new Set(cellsWithinRadius([centerAt(dr, dc)], r))
}

/**
 * 総当たりで数え直す(索引を使わない):乗れる行(停留所と時間帯の組。手で書き出したもの)ごとに、すべてのセルを見て、
 * その時間帯に減便で外れ、停留所からの距離がセルの区分のバス停の距離以内のものを集める
 */
function bruteForce(ctx: RestoreHintContext, rows: [string, number][]): { cells: number; population: number } {
  const { beforeResult: before, afterResult: after, params } = ctx
  const got = new Set<number>()
  for (const [stop, b] of rows) {
    const [dr, dc] = STOP_CELLS[stop]
    const p = centerAt(dr, dc)
    before.cells.forEach((code, i) => {
      const lost = before.coverable[i] && before.reachable[b][i] && !after.reachable[b][i]
      const r = params.walkMinutes[before.classes[i]].bus * params.speedMPerMin
      if (lost && distanceM(meshCenter(code), p) <= r) got.add(i)
    })
  }
  let population = 0
  for (const i of got) population += before.cellPopulation[i]
  return { cells: got.size, population }
}

describe('足し戻しの手がかり:到達圏を使う2つ(onlyServiceAtStop・restoresLostCells)', () => {
  it('手で作った到達圏の前提:停留所のまわり 240m に 11 セル、P と Q の重なりは 2 セル、駅の徒歩圏との重なりは 2 セル', () => {
    const { ctx } = reachSetup()
    expect(cellsNear('P', 240).size).toBe(11)
    const p = cellsNear('P', 240)
    const q = cellsNear('Q', 240)
    expect([...p].filter((c) => q.has(c)).sort()).toEqual([cellAt(1, 0), cellAt(2, 0)].sort())
    const station = new Set(cellsWithinRadius([centerAt(...STATION_CELL)], 240))
    expect([...p].filter((c) => station.has(c)).sort()).toEqual([cellAt(-1, 0), cellAt(-2, 0)].sort())
    // すべて中山間・地方で、推計人口は 10 人
    expect(new Set(ctx.beforeResult.classes)).toEqual(new Set(['rural']))
    expect(new Set(ctx.beforeResult.cellPopulation)).toEqual(new Set([10]))
    // 起点は Z(どの便でも最後の停留所)を除く 6 つ
    expect(ctx.stops.map((s) => s.id).sort()).toEqual(['D', 'E', 'F', 'G', 'P', 'Q'])
    // 6〜9時に外れるのは P(駅の 2 セルを除く 9)・D・E のまわり、9〜12時は Q のまわり
    const lostIn = (b: number) => ctx.beforeResult.reachable[b].filter((r, i) => r && !ctx.afterResult.reachable[b][i]).length
    expect([0, 1, 2, 3, 4, 5].map(lostIn)).toEqual([9 + 11 + 11, 11, 0, 0, 0, 0])
  })

  it('ctx を渡すと、乗れる停留所の時間帯で外れたセルの数と推計人口を出す', () => {
    const { hinter, byId, ctx } = reachHinter()
    const a = hinter(byId.get('A_0700_WK')!, ctx)
    expect(a.hints.filter((h) => REACH_HINTS.includes(h))).toEqual(['onlyServiceAtStop', 'restoresLostCells'])
    // P のまわりの 11 セルのうち、駅の徒歩圏の 2 セルは前後とも到達できるので外れたセルにならない
    expect(a.lostCells).toEqual({ cells: 9, population: 90 })
    expect(hinter(byId.get('D_0745_WK')!, ctx).lostCells).toEqual({ cells: 11, population: 110 })
    expect(hinter(byId.get('E_0750_WK')!, ctx).lostCells).toEqual({ cells: 11, population: 110 })
  })

  it('2つの時間帯で戻る同じセルは1つと数え、推計人口も1回だけ足す', () => {
    const { hinter, byId, ctx } = reachHinter()
    // B は 6〜9時の P(9 セル)と 9〜12時の Q(11 セル)。(1,0) と (2,0) は両方で戻るが、1つと数える(9 + 11 − 2)
    expect(hinter(byId.get('B_0855_WK')!, ctx)).toMatchObject({
      hints: expect.arrayContaining(['onlyServiceAtStop', 'restoresLostCells']),
      lostCells: { cells: 18, population: 180 },
    })
  })

  it('降車だけの停留所と、便の最後の行は数えない', () => {
    const { hinter, byId, ctx } = reachHinter()
    // C は F(編集後も 6〜9時の出発が残る)・D(pickup_type=1)・E(最後の行)。D と E のまわりは外れているが、C では乗れない
    const c = hinter(byId.get('C_0720_WK')!, ctx)
    expect(c.hints.filter((h) => REACH_HINTS.includes(h))).toEqual([])
    expect(c.lostCells).toBeNull()
  })

  it('比較の日付に基準で走らない便と、編集後の便には出さない', () => {
    const { hinter, byId, ctx, diff } = reachHinter()
    // 20261103 は WK が運休(calendar_dates)。外れたセルはあっても、その日に走らない便には出さない
    const holiday = { ...ctx, date: '20261103' }
    for (const trip of byId.values()) {
      const d = hinter(trip, holiday)
      expect(d.hints.filter((h) => REACH_HINTS.includes(h))).toEqual([])
      expect(d.lostCells).toBeNull()
    }
    // 編集後(feed が edited)の便は、基準の便の表に無いので出さない
    for (const trip of diff.added) expect(hinter(trip, ctx).lostCells).toBeNull()
    expect(hinter({ ...byId.get('A_0700_WK')!, feed: 'edited' }, ctx).lostCells).toBeNull()
  })

  it('索引を使った結果が、総当たりで数え直した結果と同じ', () => {
    const { hinter, byId, ctx } = reachHinter()
    const rows: Record<string, [string, number][]> = {
      A_0700_WK: [['P', 0]],
      B_0855_WK: [
        ['P', 0],
        ['Q', 1],
      ],
      C_0720_WK: [['F', 0]],
      D_0745_WK: [['D', 0]],
      E_0750_WK: [['E', 0]],
    }
    expect([...byId.keys()].sort()).toEqual(Object.keys(rows).sort())
    for (const [id, list] of Object.entries(rows)) {
      const expected = bruteForce(ctx, list)
      expect(hinter(byId.get(id)!, ctx).lostCells).toEqual(expected.cells > 0 ? expected : null)
    }
  })

  it('ctx を渡しても、ほかの手がかりは ctx が無いときと同じ。1つの便だけを調べても同じ', () => {
    const { base, edited, plan, hinter, byId, ctx } = reachHinter()
    for (const trip of byId.values()) {
      const withCtx = hinter(trip, ctx)
      const without = hinter(trip)
      expect(without.lostCells).toBeNull()
      expect(without.hints.some((h) => REACH_HINTS.includes(h))).toBe(false)
      expect(withCtx.hints.filter((h) => !REACH_HINTS.includes(h))).toEqual(without.hints)
      expect(restoreHints(base, edited, plan, trip, ctx)).toEqual(withCtx)
    }
  })

  it('外れたセルが戻らなくても、乗れる停留所で編集後の出発が 0 なら onlyServiceAtStop を出す', () => {
    const { hinter, byId, ctx } = reachHinter()
    // P のまわりのセルが、編集後も別の理由で到達できるとみなした比較(外れたセルは 0、P の出発は 0 のまま)
    const noLost: RestoreHintContext = { ...ctx, afterResult: { ...ctx.afterResult, reachable: ctx.beforeResult.reachable } }
    const a = hinter(byId.get('A_0700_WK')!, noLost)
    expect(a.hints.filter((h) => REACH_HINTS.includes(h))).toEqual(['onlyServiceAtStop'])
    expect(a.lostCells).toBeNull()
  })

  it('基準と編集後の結果の形が合わない ctx はエラーにする', () => {
    const { hinter, byId, ctx } = reachHinter()
    const broken: RestoreHintContext = { ...ctx, bands: ctx.bands.slice(0, 3) }
    expect(() => hinter(byId.get('A_0700_WK')!, broken)).toThrow('到達圏の比較の形が合いません')
  })
})

// ---- 到達圏の計算と照らす(取り決めの定義を写した計算どうしの比較では見つからない、定義のずれを見つける) ----

/** reachSetup と同じ手順で、基準・方針・参照データ・時間帯の幅を変えた ctx を作る(起点と分母は基準から。1103 の追記3) */
function ctxFor(o: { base?: GtfsFeed; plan?: Form2Plan; ref?: RefData; stepHours?: 1 | 3 } = {}) {
  const base = o.base ?? reachBaseFeed()
  const plan = o.plan ?? reachPlan()
  const ref = o.ref ?? reachRef()
  const bands = makeBands(o.stepHours ?? 3)
  const origins = originStops(base, toStops(base).stops)
  const edit = (p: Form2Plan) => {
    const outcome = applyForm2(base, p, { generatedAt: '202611041200' })
    if (!outcome.ok) throw new Error(outcome.message)
    return outcome.result.feed
  }
  const countsOf = (feed: GtfsFeed) => departureCountsByBand(feed, servicesFor(feed, DATE), bands)
  const reachOf = (counts: Map<string, number[]>) =>
    computeReach({
      stops: buildReachStops(origins.stops, counts, bands.length),
      ref,
      fallbackClass: 'suburban',
      params: REACH_PARAMS,
      bandCount: bands.length,
    })
  const edited = edit(plan)
  const before = countsOf(base)
  const after = countsOf(edited)
  const ctx: RestoreHintContext = {
    before,
    after,
    bands,
    beforeResult: reachOf(before.counts),
    afterResult: reachOf(after.counts),
    date: DATE,
    params: REACH_PARAMS,
    stops: origins.stops,
  }
  const diff = diffWeekdayTrips(base, edited, plan.weekdayService)
  const hinter = createRestoreHinter(base, edited, plan, [...diff.removed, ...diff.same], [...diff.same, ...diff.added])
  const byId = new Map(diff.removed.map((t) => [t.tripId, t]))
  return { base, plan, edited, ctx, hinter, byId, edit, countsOf, reachOf }
}

/** A_0700_WK の P の行(乗れる行)の時刻を変えた基準のフィード */
function baseWithATime(time: string): GtfsFeed {
  const base = reachBaseFeed()
  for (const row of base.tables.get('stop_times')!.rows) {
    if (row.trip_id === 'A_0700_WK' && row.stop_id === 'P') {
      row.arrival_time = time
      row.departure_time = time
    }
  }
  return base
}

describe('足し戻しの手がかり:到達圏の計算との往復', () => {
  for (const stepHours of [3, 1] as const) {
    it(`候補を1便ずつ足し戻して到達圏を計算し直すと、戻るセルと出発が 0 から増える停留所が手がかりと一致する(${stepHours}時間ごと)`, () => {
      const { plan, ctx, hinter, byId, edit, countsOf, reachOf } = ctxFor({ stepHours })
      const { beforeResult: before, afterResult: after } = ctx
      expect(byId.size).toBe(5)
      for (const [tripId, trip] of byId) {
        const added = edit({ ...plan, addBackTripIds: [tripId] })
        const counts = countsOf(added)
        const result = reachOf(counts.counts)
        // 足し戻した後に到達できるようになった「減便で外れた」セル(時間帯をまたいで重なりを除く)
        const restored = new Set<number>()
        ctx.bands.forEach((_, b) => {
          before.cells.forEach((_, i) => {
            if (before.coverable[i] && before.reachable[b][i] && !after.reachable[b][i] && result.reachable[b][i]) restored.add(i)
          })
        })
        let population = 0
        for (const i of restored) population += before.cellPopulation[i]
        const detail = hinter(trip, ctx)
        expect(detail.lostCells, tripId).toEqual(restored.size > 0 ? { cells: restored.size, population } : null)
        expect(detail.hints.includes('restoresLostCells'), tripId).toBe(restored.size > 0)
        // 編集後の出発が 0 で、足し戻すと 1 以上になる停留所と時間帯があるか
        let zeroToSome = false
        for (const [stop, list] of counts.counts) {
          list.forEach((n, b) => {
            if (n > 0 && (ctx.after.counts.get(stop)?.[b] ?? 0) === 0) zeroToSome = true
          })
        }
        expect(detail.hints.includes('onlyServiceAtStop'), tripId).toBe(zeroToSome)
      }
    })
  }

  it('時間帯は開始を含み終わりを含まない。24時以降の出発は数えない', () => {
    // 比較(ctx)は元のフィードのもの:6〜9時に外れるのは P(9 セル)・D・E のまわり、9〜12時は Q のまわり(P と重なるのは 2 セル)
    const { ctx } = reachSetup()
    const hintsAt = (time: string) => {
      const base = baseWithATime(time)
      const { edited, plan } = reachSetup()
      const diff = diffWeekdayTrips(base, edited, plan.weekdayService)
      const hinter = createRestoreHinter(base, edited, plan, [...diff.removed, ...diff.same], [...diff.same, ...diff.added])
      return hinter(diff.removed.find((t) => t.tripId === 'A_0700_WK')!, ctx)
    }
    // 08:59:59 は 6〜9時:P のまわりの 9 セル
    expect(hintsAt('08:59:59').lostCells).toEqual({ cells: 9, population: 90 })
    // 09:00:00 は 9〜12時:9〜12時に外れるのは Q のまわりで、P から届くのは重なりの 2 セル
    expect(hintsAt('09:00:00').lostCells).toEqual({ cells: 2, population: 20 })
    expect(hintsAt('09:00:00').hints).toContain('onlyServiceAtStop')
    // 24:00:00 と 25:10:00 は 6〜24時の外
    for (const t of ['24:00:00', '25:10:00']) {
      const d = hintsAt(t)
      expect(d.lostCells, t).toBeNull()
      expect(d.hints.some((h) => REACH_HINTS.includes(h)), t).toBe(false)
    }
  })

  it('出発が空で到着だけの行は、到達圏の出発の数と同じく数えない(到着の時刻で代えない)', () => {
    const { ctx } = reachSetup()
    const hintsWith = (arrival: string, departure: string) => {
      const base = reachBaseFeed()
      for (const row of base.tables.get('stop_times')!.rows) {
        if (row.trip_id === 'A_0700_WK' && row.stop_id === 'P') {
          row.arrival_time = arrival
          row.departure_time = departure
        }
      }
      const { edited, plan } = reachSetup()
      const diff = diffWeekdayTrips(base, edited, plan.weekdayService)
      const hinter = createRestoreHinter(base, edited, plan, [...diff.removed, ...diff.same], [...diff.same, ...diff.added])
      return hinter(diff.removed.find((t) => t.tripId === 'A_0700_WK')!, ctx)
    }
    const withDeparture = hintsWith('07:00:00', '07:00:00')
    const arrivalOnly = hintsWith('07:00:00', '')
    const noTime = hintsWith('', '')
    // 出発がある行は P のまわり(6〜9時)を数える
    expect(withDeparture.lostCells?.cells ?? 0).toBeGreaterThanOrEqual(9)
    // 到着だけの行は、時刻の無い行と同じ扱い(P を数えない)。到達圏と関係ない手がかり(始発の時刻から決まるもの)は比べない
    const reachPart = (d: typeof arrivalOnly) => ({
      hints: d.hints.filter((h) => REACH_HINTS.includes(h)),
      lostCells: d.lostCells,
    })
    expect(reachPart(arrivalOnly)).toEqual(reachPart(noTime))
    expect(reachPart(arrivalOnly)).not.toEqual(reachPart(withDeparture))
  })

  it('1時間ごとの時間帯でも、乗れる行の時刻が入る時間帯で数える', () => {
    const { ctx, hinter, byId } = ctxFor({ stepHours: 1 })
    expect(ctx.bands).toHaveLength(18)
    // B は 8〜9時の P(9 セル)と 9〜10時の Q(11 セル)。重なりの 2 セルは1つと数える
    expect(hinter(byId.get('B_0855_WK')!, ctx).lostCells).toEqual({ cells: 18, population: 180 })
    // A は 7〜8時の P だけ
    expect(hinter(byId.get('A_0700_WK')!, ctx).lostCells).toEqual({ cells: 9, population: 90 })
    const rows: Record<string, [string, number][]> = {
      A_0700_WK: [['P', 1]],
      B_0855_WK: [
        ['P', 2],
        ['Q', 3],
      ],
      D_0745_WK: [['D', 1]],
      E_0750_WK: [['E', 1]],
    }
    for (const [id, list] of Object.entries(rows)) {
      const expected = bruteForce(ctx, list)
      expect(hinter(byId.get(id)!, ctx).lostCells, id).toEqual(expected.cells > 0 ? expected : null)
    }
  })

  it('セルの区分ごとのバス停の距離で数える(DID の中の都市部は短い)', () => {
    // P のまわりのセルを DID にすると都市部になり、バス停の距離は 1分(80m)。P のセルの中心だけが届く
    const ref = reachRef()
    const did125 = new Set(cellsNear('P', 240))
    const { ctx, hinter, byId } = ctxFor({ ref: { ...ref, did125 } })
    const pCells = [...cellsNear('P', 240)]
    const indexOf = new Map(ctx.beforeResult.cells.map((c, i) => [c, i]))
    for (const c of pCells) expect(ctx.beforeResult.classes[indexOf.get(c)!]).toBe('urban')
    expect(hinter(byId.get('A_0700_WK')!, ctx).lostCells).toEqual({ cells: 1, population: 10 })
    // 中山間・地方のまま(240m)なら 9 セル
    const rural = ctxFor()
    expect(rural.hinter(rural.byId.get('A_0700_WK')!, rural.ctx).lostCells).toEqual({ cells: 9, population: 90 })
    // 総当たり(区分ごとの距離)とも一致する
    expect(hinter(byId.get('B_0855_WK')!, ctx).lostCells).toEqual(
      bruteForce(ctx, [
        ['P', 0],
        ['Q', 1],
      ]),
    )
  })
})
