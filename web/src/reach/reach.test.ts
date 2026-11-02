import { describe, expect, it } from 'vitest'
import { cellAreaKm2, cellsWithinRadius, distanceM, meshCenter, meshCode, parentCode, type LatLon } from './mesh'
import {
  computeReach,
  DEFAULT_REACH_PARAMS,
  refDataFromJson,
  type ReachInput,
  type ReachParams,
  type ReachResult,
  type RefData,
  type RegionClass,
} from './reach'

// 旭川市内の 125m セル(meshCode(43.77, 142.36, 11))。中心は北緯 43.7703125 度、東経 142.36015625 度
const T = '65425228243'
const P = parentCode(T, 10) // 親の 250m セル '6542522824'。面積は約 0.058242 km²
const C = meshCenter(T)
/** P から北へ約 580m の 250m セル */
const P_NORTH = parentCode(meshCode(43.775, 142.36, 11), 10)

const RAD = Math.PI / 180

/** 250m セルの4つの 125m セル(南西・南東・北西・北東) */
function children(parent: string): string[] {
  return [1, 2, 3, 4].map((k) => `${parent}${k}`)
}

/**
 * from から、北から時計回りに bearing 度の向きへ、distanceM(from, 点) が d になる点。
 * 度への換算は近似なので、距離の比で数回直して d に合わせる(誤差は緯度経度の浮動小数の刻み 約 2e-9 m ほど)。
 */
function pointAt(from: LatLon, bearing: number, d: number): LatLon {
  const north = Math.cos(bearing * RAD)
  const east = Math.sin(bearing * RAD)
  let t = d
  let p = from
  for (let k = 0; k < 6; k++) {
    p = { lat: from.lat + (north * t) / 111_120, lon: from.lon + (east * t) / (111_320 * Math.cos(from.lat * RAD)) }
    const got = distanceM(from, p)
    if (got === 0) break
    t *= d / got
  }
  return p
}

function stop(p: LatLon, bandCounts: number[]) {
  return { lat: p.lat, lon: p.lon, bandCounts }
}

function refOf(pop: Record<string, number>, did: string[] = [], stations: LatLon[] = []): RefData {
  return { pop250: new Map(Object.entries(pop)), did125: new Set(did), stations }
}

function run(over: Partial<ReachInput>): ReachResult {
  return computeReach({
    stops: [],
    ref: null,
    fallbackClass: 'suburban',
    params: DEFAULT_REACH_PARAMS,
    bandCount: 2,
    ...over,
  })
}

/** セルの、時間帯ごとの到達できるか */
function reachOf(result: ReachResult, cell: string): boolean[] {
  const i = result.cells.indexOf(cell)
  if (i < 0) throw new Error(`${cell} は調べたセルに入っていません`)
  return result.reachable.map((band) => band[i])
}

function classOf(result: ReachResult, cell: string): RegionClass {
  const i = result.cells.indexOf(cell)
  if (i < 0) throw new Error(`${cell} は調べたセルに入っていません`)
  return result.classes[i]
}

function paramsWith(over: Partial<ReachParams>): ReachParams {
  return { ...DEFAULT_REACH_PARAMS, ...over }
}

describe('テスト用の点の置き方', () => {
  it('pointAt は、distanceM でちょうど指定の距離になる点を返す', () => {
    for (const bearing of [0, 45, 90, 180, 300]) {
      for (const d of [0.5, 400, 1600]) {
        expect(Math.abs(distanceM(C, pointAt(C, bearing, d)) - d)).toBeLessThan(1e-8)
      }
    }
  })
})

describe('computeReach:調べるセル', () => {
  it('参照データが無ければ、停留所から 1,600m 以内のセルをすべて調べる(人口では絞らない)', () => {
    const result = run({ stops: [stop(C, [1, 0])] })
    expect(result.cells).toEqual(cellsWithinRadius([C], 1600))
    expect(result.cells).toContain(T)
  })

  it('参照データがあれば、親の 250m セルの人口が 1 人以上のセルだけを調べる', () => {
    const result = run({
      stops: [stop(C, [1, 0])],
      ref: refOf({ [P]: 100, [P_NORTH]: 0 }),
    })
    // P_NORTH は人口 0、そのほかの 250m セルは pop250 に無い(0 人)
    expect(result.cells).toEqual(children(P))
    expect(result.cellPopulation).toEqual([25, 25, 25, 25])
  })

  it('人口が 1 人未満(0.5 人)の 250m セルも除く', () => {
    const result = run({ stops: [stop(C, [1, 0])], ref: refOf({ [P]: 0.5, [P_NORTH]: 1 }) })
    expect(result.cells).toEqual(children(P_NORTH))
  })

  it('最大の徒歩圏は、分数の最大 × 分速で決まる(駅の 20 分 × 80m = 1,600m)', () => {
    // 1,600m の少し内側と外側の 250m セルに人口を置く
    const inside = parentCode(meshCode(pointAt(C, 0, 1500).lat, C.lon, 11), 10)
    const outside = parentCode(meshCode(pointAt(C, 0, 1800).lat, C.lon, 11), 10)
    const result = run({ stops: [stop(C, [0, 0])], ref: refOf({ [inside]: 50, [outside]: 50 }) })
    expect(result.cells.every((c) => c.startsWith(inside))).toBe(true)
    expect(result.cells.length).toBeGreaterThan(0)
    // 分速を半分にすると、最大の徒歩圏は 800m になり、どちらも入らない
    const slow = run({ stops: [stop(C, [0, 0])], ref: refOf({ [inside]: 50, [outside]: 50 }), params: paramsWith({ speedMPerMin: 40 }) })
    expect(slow.cells).toEqual([])
  })

  it('駅のまわりのセルも調べる(停留所が無くても)', () => {
    const far = pointAt(C, 90, 5000)
    const farCell = meshCode(far.lat, far.lon, 11)
    const result = run({ stops: [], ref: refOf({ [parentCode(farCell, 10)]: 30 }, [], [far]) })
    expect(result.cells).toContain(farCell)
    expect(reachOf(result, farCell)).toEqual([true, true])
  })

  it('出発が1本も無い停留所も、調べるセルを決めるのには使う(到達はできない)', () => {
    const result = run({ stops: [stop(C, [0, 0])], ref: refOf({ [P]: 100 }) })
    expect(result.cells).toEqual(children(P))
    expect(result.reachable).toEqual([
      [false, false, false, false],
      [false, false, false, false],
    ])
  })

  it('停留所も駅も無ければ、セルは 0 個。時間帯の数だけ空の配列を返す', () => {
    const result = run({ bandCount: 3 })
    expect(result).toEqual({
      cells: [],
      classes: [],
      reachable: [[], [], []],
      usedFallback: true,
      excludedStops: 0,
      cellPopulation: [],
    })
  })
})

describe('computeReach:区分', () => {
  it('DID の中は都市部。外は親の 250m セルの人口密度で郊外と中山間・地方に分ける', () => {
    // P:100 人 ÷ 0.058242 km² ≒ 1,717 人/km²(郊外)。P_NORTH:10 人 ≒ 172 人/km²(中山間・地方)
    const result = run({ stops: [stop(C, [1, 0])], ref: refOf({ [P]: 100, [P_NORTH]: 10 }, [T]) })
    expect(result.usedFallback).toBe(false)
    const [sw, se, nw, ne] = children(P)
    expect(sw).toBe(T.slice(0, 10) + '1')
    expect(classOf(result, T)).toBe('urban') // T は P の北西(末尾 3)
    for (const c of [sw, se, ne]) expect(classOf(result, c)).toBe('suburban')
    expect(nw).toBe(T)
    for (const c of children(P_NORTH)) expect(classOf(result, c)).toBe('rural')
  })

  it('DID の中なら、人口密度が低くても都市部', () => {
    const result = run({ stops: [stop(C, [1, 0])], ref: refOf({ [P]: 1 }, [T]) })
    expect(classOf(result, T)).toBe('urban')
  })

  it('人口密度がしきい値ちょうどなら郊外、しきい値がわずかでも上なら中山間・地方', () => {
    const exact = 100 / cellAreaKm2(P)
    const at = run({ stops: [stop(C, [1, 0])], ref: refOf({ [P]: 100 }), params: paramsWith({ densityThreshold: exact }) })
    expect(classOf(at, T)).toBe('suburban')
    const above = run({
      stops: [stop(C, [1, 0])],
      ref: refOf({ [P]: 100 }),
      params: paramsWith({ densityThreshold: exact * (1 + Number.EPSILON) }),
    })
    expect(classOf(above, T)).toBe('rural')
  })

  it('既定のしきい値 1,000 人/km² の境目:面積 0.058242 km² のセルで 59 人(1,013 人/km²)は郊外、58 人(996 人/km²)は中山間・地方', () => {
    expect(cellAreaKm2(P)).toBeCloseTo(0.058242, 6)
    expect(classOf(run({ stops: [stop(C, [1, 0])], ref: refOf({ [P]: 59 }) }), T)).toBe('suburban')
    expect(classOf(run({ stops: [stop(C, [1, 0])], ref: refOf({ [P]: 58 }) }), T)).toBe('rural')
  })

  it('参照データが無ければ、すべてのセルを fallbackClass にし、推計人口は 0', () => {
    const result = run({ stops: [stop(C, [1, 0])], fallbackClass: 'rural' })
    expect(result.usedFallback).toBe(true)
    expect(new Set(result.classes)).toEqual(new Set(['rural']))
    expect(result.cellPopulation.every((n) => n === 0)).toBe(true)
    expect(result.cellPopulation).toHaveLength(result.cells.length)
  })
})

describe('computeReach:距離の境目', () => {
  const cases: { cls: RegionClass; ref: RefData; bus: number; rail: number }[] = [
    { cls: 'urban', ref: refOf({ [P]: 100 }, [T]), bus: 400, rail: 800 },
    { cls: 'suburban', ref: refOf({ [P]: 100 }), bus: 800, rail: 1200 },
    { cls: 'rural', ref: refOf({ [P]: 10 }), bus: 1200, rail: 1600 },
  ]

  for (const { cls, ref, bus, rail } of cases) {
    it(`${cls}:バス停は ${bus}m の 1cm 内側なら届き、1cm 外側なら届かない`, () => {
      const result = run({
        stops: [stop(pointAt(C, 0, bus - 0.01), [1, 0]), stop(pointAt(C, 180, bus + 0.01), [0, 1])],
        ref,
      })
      expect(classOf(result, T)).toBe(cls)
      expect(reachOf(result, T)).toEqual([true, false])
    })

    it(`${cls}:北東の斜めの向きでも、バス停は ${bus}m の 0.1mm 内側なら届く(候補の箱が狭すぎない)`, () => {
      const result = run({
        stops: [stop(pointAt(C, 45, bus - 1e-4), [1, 0]), stop(pointAt(C, 225, bus + 1e-4), [0, 1])],
        ref,
      })
      expect(reachOf(result, T)).toEqual([true, false])
    })

    it(`${cls}:鉄道駅は ${rail}m の 1cm 内側なら、出発の無い時間帯も含めてすべて届く`, () => {
      // T を調べるセルに入れるため、T の中心に出発の無い停留所を置く
      const seed = stop(C, [0, 0])
      const inside = run({ stops: [seed], ref: { ...ref, stations: [pointAt(C, 45, rail - 0.01)] } })
      expect(reachOf(inside, T)).toEqual([true, true])
      const outside = run({ stops: [seed], ref: { ...ref, stations: [pointAt(C, 45, rail + 0.01)] } })
      expect(reachOf(outside, T)).toEqual([false, false])
    })
  }

  it('既定の条件の都市部で、400m の 0.1mm 内側は届き、0.1mm 外側は届かない', () => {
    const ref = refOf({ [P]: 100 }, [T])
    expect(reachOf(run({ stops: [stop(pointAt(C, 120, 400 - 1e-4), [1, 1])], ref }), T)).toEqual([true, true])
    expect(reachOf(run({ stops: [stop(pointAt(C, 120, 400 + 1e-4), [1, 1])], ref }), T)).toEqual([false, false])
  })

  it('ちょうど徒歩圏の距離(分 × 分速 = 停留所までの距離)の停留所は届く。分速がわずかでも遅ければ届かない', () => {
    const s = pointAt(C, 30, 400)
    const d = distanceM(C, s)
    const minutes = { bus: 1, rail: 2 }
    const walkMinutes = { urban: minutes, suburban: minutes, rural: minutes }
    const ref = refOf({ [P]: 100 }, [T])
    // 1 分 × 分速 d = d(浮動小数でもちょうど d)
    const exact = run({ stops: [stop(s, [1, 0])], ref, params: paramsWith({ walkMinutes, speedMPerMin: d }) })
    expect(reachOf(exact, T)).toEqual([true, false])
    const slower = run({
      stops: [stop(s, [1, 0])],
      ref,
      params: paramsWith({ walkMinutes, speedMPerMin: d * (1 - Number.EPSILON) }),
    })
    expect(reachOf(slower, T)).toEqual([false, false])
  })

  it('セルの中心にある停留所から 400m 以内の 125m セルは 37 個(手計算)', () => {
    // 旭川付近では、隣のセルの中心まで南北 115.74m・東西 125.80m。南北 i 個・東西 j 個離れたセルの距離が 400m 以下になるのは
    // i = 0:|j| ≤ 3(377m)で 7 個、|i| = 1:|j| ≤ 3(394.8m)で 7 個ずつ、|i| = 2:|j| ≤ 2(326m)で 5 個ずつ、
    // |i| = 3:|j| ≤ 1(366m)で 3 個ずつ。7 + 14 + 10 + 6 = 37
    const result = run({ stops: [stop(C, [1, 0])], fallbackClass: 'urban' })
    const reached = result.cells.filter((_, i) => result.reachable[0][i])
    expect(reached).toHaveLength(37)
    expect(reached).toContain(T)
    expect(result.reachable[1].some(Boolean)).toBe(false)
    // 郊外(800m)なら 141 個、中山間・地方(1,200m)なら 315 個(cellsWithinRadius と同じ数)
    for (const [cls, n] of [['suburban', 141], ['rural', 315]] as const) {
      const r = run({ stops: [stop(C, [1, 0])], fallbackClass: cls })
      expect(r.reachable[0].filter(Boolean)).toHaveLength(n)
    }
  })
})

describe('computeReach:時間帯と駅', () => {
  it('時間帯ごとに、その時間帯に出発がある停留所だけを数える', () => {
    const ref = refOf({ [P]: 100 }, [T])
    const result = run({
      bandCount: 3,
      ref,
      stops: [
        stop(pointAt(C, 0, 200), [2, 0, 1]), // 届く:6〜9時と 12〜15時だけ出発がある
        stop(pointAt(C, 90, 300), [0, 0, 0]), // 届くが、出発が無い
        stop(pointAt(C, 180, 450), [0, 5, 0]), // 出発はあるが、都市部の 400m の外
      ],
    })
    expect(reachOf(result, T)).toEqual([true, false, true])
  })

  it('bandCounts が時間帯の数より短ければ、足りない時間帯は 0 とみなす', () => {
    const result = run({ bandCount: 3, ref: refOf({ [P]: 100 }, [T]), stops: [stop(C, [1])] })
    expect(reachOf(result, T)).toEqual([true, false, false])
  })

  it('時間帯が 32 を超えても数える', () => {
    const counts = new Array<number>(40).fill(0)
    counts[0] = 1
    counts[31] = 1
    counts[35] = 1
    const result = run({ bandCount: 40, ref: refOf({ [P]: 100 }, [T]), stops: [stop(C, counts)] })
    const reach = reachOf(result, T)
    expect(reach.map((v, b) => (v ? b : -1)).filter((b) => b >= 0)).toEqual([0, 31, 35])
  })

  it('駅は、停留所に出発が無い時間帯も含めて、すべての時間帯で使える', () => {
    const station = pointAt(C, 270, 700)
    const ref = refOf({ [P]: 100 }, [T], [station])
    const result = run({ bandCount: 3, ref, stops: [stop(pointAt(C, 0, 100), [0, 1, 0])] })
    expect(reachOf(result, T)).toEqual([true, true, true])
    // 都市部の駅の 800m の外なら、停留所の時間帯だけ
    const far = run({ bandCount: 3, ref: { ...ref, stations: [pointAt(C, 270, 850)] }, stops: [stop(pointAt(C, 0, 100), [0, 1, 0])] })
    expect(reachOf(far, T)).toEqual([false, true, false])
  })

  it('参照データが無ければ駅は無いものとして、fallbackClass のバス停の距離で判定する', () => {
    // 既定の fallbackClass は郊外(バス停 800m)
    const result = run({ stops: [stop(pointAt(C, 0, 790), [1, 0]), stop(pointAt(C, 180, 810), [0, 1])] })
    expect(result.usedFallback).toBe(true)
    expect(reachOf(result, T)).toEqual([true, false])
    // 中山間・地方なら 1,200m
    const rural = run({ fallbackClass: 'rural', stops: [stop(pointAt(C, 0, 1190), [1, 0]), stop(pointAt(C, 180, 1210), [0, 1])] })
    expect(reachOf(rural, T)).toEqual([true, false])
  })
})

describe('computeReach:範囲外の停留所', () => {
  it('(0, 0)・数でない値・地域メッシュの範囲外の停留所は除き、数を excludedStops に入れる', () => {
    const ok = stop(C, [1, 0])
    const bad = [
      stop({ lat: 0, lon: 0 }, [1, 1]),
      stop({ lat: Number.NaN, lon: 142 }, [1, 1]),
      stop({ lat: 43, lon: Number.POSITIVE_INFINITY }, [1, 1]),
      stop({ lat: 70, lon: 142 }, [1, 1]),
      stop({ lat: -1, lon: 142 }, [1, 1]),
      stop({ lat: 43, lon: 99.9 }, [1, 1]),
      stop({ lat: 43, lon: 200 }, [1, 1]),
    ]
    const result = run({ stops: [bad[0], ok, ...bad.slice(1)] })
    const expected = run({ stops: [ok] })
    expect(result.excludedStops).toBe(7)
    expect(expected.excludedStops).toBe(0)
    expect(result.cells).toEqual(expected.cells)
    expect(result.reachable).toEqual(expected.reachable)
  })

  it('すべての停留所が範囲外でも、例外にせず空の結果を返す', () => {
    const result = run({ stops: [stop({ lat: 0, lon: 0 }, [1, 1])] })
    expect(result.excludedStops).toBe(1)
    expect(result.cells).toEqual([])
  })

  it('手で作った RefData の範囲外の駅は使わない', () => {
    const result = run({ stops: [stop(C, [0, 0])], ref: refOf({ [P]: 100 }, [], [{ lat: 0, lon: 0 }, C]) })
    expect(reachOf(result, T)).toEqual([true, true])
  })
})

describe('computeReach:入力の誤り', () => {
  it('時間帯の数・分速・分数・しきい値・区分が正しくなければ、日本語のエラーにする', () => {
    expect(() => run({ bandCount: -1 })).toThrow('時間帯の数は 0 以上の整数')
    expect(() => run({ bandCount: 1.5 })).toThrow('時間帯の数は 0 以上の整数')
    expect(() => run({ params: paramsWith({ speedMPerMin: 0 }) })).toThrow('徒歩の分速は 0 より大きい数')
    expect(() => run({ params: paramsWith({ densityThreshold: Number.NaN }) })).toThrow('人口密度のしきい値は 0 以上の数')
    expect(() =>
      run({ params: paramsWith({ walkMinutes: { ...DEFAULT_REACH_PARAMS.walkMinutes, rural: { bus: -1, rail: 20 } } }) }),
    ).toThrow('中山間・地方のバス停までの徒歩の分数は 0 以上の数')
    expect(() => run({ fallbackClass: 'city' as RegionClass })).toThrow('参照データが無いときの区分が正しくありません')
  })
})

describe('refDataFromJson', () => {
  const file6542 = {
    mesh1: '6542',
    pop250: { '6542522824': 100, '6542522831': 3 },
    did125: ['65425228243'],
    stations: [{ name: '旭川', line: '函館線', operator: '北海道旅客鉄道', lat: 43.7628, lon: 142.3587 }],
    sources: ['令和2年国勢調査 地域メッシュ統計(e-Stat)を加工して作成'],
  }
  const file6642 = {
    mesh1: '6642',
    pop250: { '6642010123': 6 },
    did125: [],
    stations: [{ name: '剣淵', line: '宗谷線', operator: '北海道旅客鉄道', lat: 44.09645, lon: 142.36461 }],
    sources: [],
  }

  it('複数のファイルを1つの Map・Set・駅の一覧にまとめる', () => {
    const ref = refDataFromJson([file6542, file6642])
    expect(ref.pop250).toEqual(
      new Map([
        ['6542522824', 100],
        ['6542522831', 3],
        ['6642010123', 6],
      ]),
    )
    expect(ref.did125).toEqual(new Set(['65425228243']))
    expect(ref.stations).toEqual([
      { lat: 43.7628, lon: 142.3587 },
      { lat: 44.09645, lon: 142.36461 },
    ])
  })

  it('JSON の文字列を読んだものでも、0 個でも扱える', () => {
    expect(refDataFromJson([JSON.parse(JSON.stringify(file6642))]).pop250.get('6642010123')).toBe(6)
    expect(refDataFromJson([])).toEqual({ pop250: new Map(), did125: new Set(), stations: [] })
  })

  it('まとめた参照データで到達圏を計算できる', () => {
    const result = computeReach({
      stops: [stop(C, [1, 0])],
      ref: refDataFromJson([file6542]),
      fallbackClass: 'suburban',
      params: DEFAULT_REACH_PARAMS,
      bandCount: 2,
    })
    expect(classOf(result, T)).toBe('urban')
    expect(result.cells).toEqual([...children(P), ...children('6542522831')].sort())
  })

  it('形が違えば、どのファイルのどの値かを書いた日本語のエラーにする', () => {
    const broken = (patch: Record<string, unknown>) => ({ ...file6542, ...patch })
    expect(() => refDataFromJson('x' as unknown as unknown[])).toThrow('参照データは配列で渡してください')
    expect(() => refDataFromJson([null])).toThrow('参照データ(1 件目)がオブジェクトではありません')
    expect(() => refDataFromJson([file6642, [1]])).toThrow('参照データ(2 件目)がオブジェクトではありません')
    expect(() => refDataFromJson([broken({ pop250: undefined })])).toThrow('参照データ(6542)の pop250 がオブジェクトではありません')
    expect(() => refDataFromJson([broken({ pop250: [1] })])).toThrow('pop250 がオブジェクトではありません')
    expect(() => refDataFromJson([broken({ pop250: { '654252282': 1 } })])).toThrow(
      'pop250 に 10 桁の地域メッシュコードでないキーがあります:654252282',
    )
    expect(() => refDataFromJson([broken({ pop250: { '6542522824': '100' } })])).toThrow(
      'pop250 の 6542522824 の人口が 0 以上の数ではありません:100',
    )
    expect(() => refDataFromJson([broken({ pop250: { '6542522824': -1 } })])).toThrow('人口が 0 以上の数ではありません')
    expect(() => refDataFromJson([broken({ did125: '65425228243' })])).toThrow('参照データ(6542)の did125 が配列ではありません')
    expect(() => refDataFromJson([broken({ did125: ['6542522824'] })])).toThrow('did125 に 11 桁の地域メッシュコードでない値があります')
    expect(() => refDataFromJson([broken({ did125: [65425228243] })])).toThrow('did125 に 11 桁の地域メッシュコードでない値があります')
    expect(() => refDataFromJson([broken({ stations: undefined })])).toThrow('参照データ(6542)の stations が配列ではありません')
    expect(() => refDataFromJson([broken({ stations: ['旭川'] })])).toThrow('stations の 1 番目がオブジェクトではありません')
    expect(() => refDataFromJson([broken({ stations: [{ name: '旭川', lat: '43.76', lon: 142.35 }] })])).toThrow(
      'stations の「旭川」の緯度経度が、地域メッシュの範囲の数ではありません',
    )
    expect(() => refDataFromJson([broken({ stations: [{ name: '旭川', lat: 0, lon: 0 }] })])).toThrow(
      '地域メッシュの範囲の数ではありません',
    )
  })
})
