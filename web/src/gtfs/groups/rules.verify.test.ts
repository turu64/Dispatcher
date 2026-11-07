import { describe, expect, it } from 'vitest'
import type { PolicyKind } from '../edit/ops'
import { compareStrings } from '../edit/signature'
import { describeServices, feedValidity, guessServiceChoice } from '../edit/services'
import { editGroups } from './edit'
import { computeServiceFeatures } from './features'
import { hasData, loadFeed, loadHolidays } from './groups.verify.fixture'
import { buildJevRequest } from './jevRequest'
import { policyServicesFor } from './policy'
import { proposeGroups } from './rules'
import type { KindGroups, ServiceGroups } from './types'

// 実データ(data/raw/gtfs/。コミットしない)で、docs/design-service-groups.md §2.8 の表と同じ結果になるか(§7.3 の受け入れ条件 3・4)。
// ファイルと祝日一覧が無いものはスキップする

interface KindExpect {
  /** 入れ替える組:平日の service → 入れ替えに使う service(昇順) */
  replace?: Record<string, string[]>
  /** 入れ替えに使う service が無く、なくす */
  erase?: string[]
  keep?: string[]
  unsupported?: string[]
  /** 入れ替えに使う側だが、平日には加えない */
  unused?: string[]
  nothingToChange?: boolean
  /** 問題の code(並びのまま)。無ければ nothingToChange の有無から決める(lowRouteOverlap などが出ないことも確かめる) */
  problems?: string[]
}

interface FeedExpect {
  file: string
  simple: boolean
  /** 主の平日の service(どちらの方針の種類でも同じ) */
  main: string | null
  sat: KindExpect
  sun: KindExpect
}

const SRV = [
  'SRV_8_02500_01',
  'SRV_8_10600_01',
  'SRV_8_10600_01_A',
  'SRV_8_10600_02',
  'SRV_8_10600_02_A',
  'SRV_8_10600_02_C',
  'SRV_8_20500_01',
  'SRV_8_20500_01_Q',
  'SRV_8_20600_01_C',
]
const KYOTO_KEEP = ['01002_RIT', '01003_KSU', '01004_BUK']
const kyotoReplace = (h: string) => ({
  '01001': [`${h}`],
  '01001_A': [`${h}_A`],
  '01001_C': [`${h}_C`],
  '01001_F': [`${h}_F`],
  '01001_GYB': [`${h}_GYB`],
})
const CHUO_SH = ['S000027', 'S000028', 'S000029', 'S000036', 'S000038', 'S000041', 'S000042', 'S000049']
const CHUO_UNUSED = ['S000004', 'S000034', 'S000048']

const TABLE: FeedExpect[] = [
  { file: 'dohoku_bus_減便前.zip', main: '01', simple: true, sat: { replace: { '01': ['03'] } }, sun: { replace: { '01': ['06'] } } },
  { file: 'dohoku_bus_減便後.zip', main: '01', simple: true, sat: { replace: { '01': ['03'] } }, sun: { replace: { '01': ['06'] } } },
  { file: 'engan_bus.zip', main: 'S000004', simple: true, sat: { replace: { S000004: ['S000006'] } }, sun: { replace: { S000004: ['S000006'] } } },
  { file: 'asahikawa_denki.zip', main: '01', simple: true, sat: { replace: { '01': ['03'] } }, sun: { replace: { '01': ['03'] } } },
  { file: 'meishi_bus.zip', main: 'S000002', simple: true, sat: { erase: ['S000002'] }, sun: { erase: ['S000002'] } },
  { file: 'haborocho_com.zip', main: 'S000001', simple: true, sat: { erase: ['S000001'] }, sun: { erase: ['S000001'] } },
  { file: 'nayoroshi_com.zip', main: null, simple: true, sat: { nothingToChange: true }, sun: { nothingToChange: true } },
  {
    file: 'Kyoto_City_Bus_GTFS-20260930.zip',
    main: '01001',
    simple: false,
    sat: { replace: kyotoReplace('03001'), erase: ['01005_MSN'], keep: KYOTO_KEEP, unused: SRV },
    sun: { replace: kyotoReplace('02001'), erase: ['01005_MSN'], keep: KYOTO_KEEP, unused: SRV },
  },
  {
    file: 'hokkaido_chuo.zip',
    main: 'S000001',
    simple: false,
    sat: {
      replace: { S000001: ['S000002', ...CHUO_SH] },
      erase: ['S000014', 'S000025'],
      keep: ['S000015'],
      unsupported: ['S000039', 'S000044'],
      unused: CHUO_UNUSED,
      problems: ['unsupportedService'],
    },
    sun: {
      replace: { S000001: ['S000003', 'S000005', 'S000006', ...CHUO_SH] },
      erase: ['S000014', 'S000025'],
      keep: ['S000015'],
      unsupported: ['S000040'],
      unused: CHUO_UNUSED,
      problems: ['unsupportedService'],
    },
  },
  { file: 'hokumon_bus.zip', main: 'S000002', simple: false, sat: { erase: ['S000002'], keep: ['S000003'] }, sun: { erase: ['S000002'], keep: ['S000003'] } },
  {
    file: 'shibetsu_kido.zip',
    main: 'S000001',
    simple: false,
    sat: { replace: { S000001: ['S000002'] }, erase: ['S000007'], keep: ['S000006', 'S000009'] },
    sun: { replace: { S000001: ['S000002'] }, erase: ['S000007'], keep: ['S000006', 'S000009'], unsupported: ['S000008'], problems: ['unsupportedService'] },
  },
  {
    file: 'sorachi_chuo_bus.zip',
    main: 'S000001',
    simple: false,
    sat: { replace: { S000001: ['S000002'] }, keep: ['S000003', 'S000004'] },
    sun: { replace: { S000001: ['S000002'] }, keep: ['S000003', 'S000004'] },
  },
]

function sorted(list: string[]): string[] {
  return [...list].sort(compareStrings)
}

/** 案を §2.8 の表と同じ形にまとめる */
function summarize(kg: KindGroups): Required<KindExpect> {
  const replace: Record<string, string[]> = {}
  for (const r of kg.rows) {
    if (r.side === 'replacement' && r.into !== null) (replace[r.into] ??= []).push(r.serviceId)
  }
  for (const k of Object.keys(replace)) replace[k] = sorted(replace[k])
  const weekday = kg.rows.filter((r) => r.side === 'weekdayOnly')
  return {
    replace,
    erase: weekday.filter((r) => r.treatment === 'erase' && !(r.serviceId in replace)).map((r) => r.serviceId),
    keep: weekday.filter((r) => r.treatment === 'keep').map((r) => r.serviceId),
    unsupported: kg.rows.filter((r) => r.side === 'unsupported').map((r) => r.serviceId),
    unused: kg.rows.filter((r) => r.side === 'replacement' && r.into === null).map((r) => r.serviceId),
    nothingToChange: kg.problems.some((p) => p.code === 'nothingToChange'),
    problems: kg.problems.map((p) => p.code),
  }
}

function fill(e: KindExpect): Required<KindExpect> {
  return {
    replace: Object.fromEntries(Object.entries(e.replace ?? {}).map(([k, v]) => [k, sorted(v)])),
    erase: e.erase ?? [],
    keep: e.keep ?? [],
    unsupported: e.unsupported ?? [],
    unused: e.unused ?? [],
    nothingToChange: e.nothingToChange ?? false,
    problems: e.problems ?? (e.nothingToChange ? ['nothingToChange'] : []),
  }
}

async function groupsOf(file: string): Promise<ServiceGroups> {
  return proposeGroups(computeServiceFeatures(await loadFeed(file), loadHolidays()))
}

describe('§2.8 の表', () => {
  for (const e of TABLE) {
    it.skipIf(!hasData(e.file))(`${e.file}`, async () => {
      const g = await groupsOf(e.file)
      expect(g.simple).toBe(e.simple)
      expect(g.byKind.weekdayToSaturday.mainWeekday).toBe(e.main)
      expect(g.byKind.weekdayToSundayHoliday.mainWeekday).toBe(e.main)
      expect(summarize(g.byKind.weekdayToSaturday)).toEqual(fill(e.sat))
      expect(summarize(g.byKind.weekdayToSundayHoliday)).toEqual(fill(e.sun))
      // 規則の案では決まらない行が無い
      for (const kind of ['weekdayToSaturday', 'weekdayToSundayHoliday'] as const) {
        expect(g.byKind[kind].rows.filter((r) => r.intoMark === 'undecided')).toEqual([])
      }
    }, 30_000)
  }
})

describe('単純な GTFS で、今の推定(guessServiceChoice)と同じ組になる', () => {
  for (const file of ['dohoku_bus_減便前.zip', 'dohoku_bus_減便後.zip', 'engan_bus.zip', 'asahikawa_denki.zip']) {
    it.skipIf(!hasData(file))(file, async () => {
      const feed = await loadFeed(file)
      const holidays = loadHolidays()
      const guess = guessServiceChoice(feed, describeServices(feed, holidays), feedValidity(feed)!)
      expect(guess.notes).toEqual([])
      const g = proposeGroups(computeServiceFeatures(feed, holidays))
      expect(g.simple).toBe(true)
      expect(policyServicesFor(g, 'weekdayToSaturday')).toEqual({
        kind: 'weekdayToSaturday',
        weekdayService: guess.weekday,
        replacementService: guess.saturday,
      })
      expect(policyServicesFor(g, 'weekdayToSundayHoliday')).toEqual({
        kind: 'weekdayToSundayHoliday',
        weekdayService: guess.weekday,
        replacementService: guess.sundayHoliday,
      })
      expect(buildJevRequest(g.features, g)).toBeNull()
    }, 30_000)
  }
})

describe('減便の方針に入れる値(実データ)', () => {
  const CHUO = 'hokkaido_chuo.zip'
  const KYOTO = 'Kyoto_City_Bus_GTFS-20260930.zip'

  it.skipIf(!hasData(CHUO))('北海道中央バス:形2で表せない service を「残す」にすると、多対1の組を返す', async () => {
    const g = await groupsOf(CHUO)
    const sat: PolicyKind = 'weekdayToSaturday'
    expect('error' in policyServicesFor(g, sat)).toBe(true)
    let e = editGroups(g, { kind: sat, serviceId: 'S000039', treatment: 'keep' })
    e = editGroups(e, { kind: sat, serviceId: 'S000044', treatment: 'keep' })
    expect(policyServicesFor(e, sat)).toEqual({
      kind: sat,
      weekdayService: 'S000001',
      replacementService: 'S000029',
      pairs: [
        { weekday: 'S000001', replacements: ['S000029', 'S000002', 'S000027', 'S000028', 'S000036', 'S000038', 'S000041', 'S000042', 'S000049'] },
        { weekday: 'S000014', replacements: [] },
        { weekday: 'S000025', replacements: [] },
      ],
      keptWeekdayServices: ['S000015', 'S000039', 'S000044'],
    })
    const sun: PolicyKind = 'weekdayToSundayHoliday'
    const h = editGroups(g, { kind: sun, serviceId: 'S000040', treatment: 'keep' })
    const p = policyServicesFor(h, sun)
    expect('error' in p ? null : p.keptWeekdayServices).toEqual(['S000015', 'S000040'])
  }, 30_000)

  it.skipIf(!hasData(KYOTO))('京都市営バス:主の組 01001 ← 03001 と、接尾辞の組', async () => {
    const g = await groupsOf(KYOTO)
    expect(policyServicesFor(g, 'weekdayToSaturday')).toEqual({
      kind: 'weekdayToSaturday',
      weekdayService: '01001',
      replacementService: '03001',
      pairs: [
        { weekday: '01001', replacements: ['03001'] },
        { weekday: '01001_A', replacements: ['03001_A'] },
        { weekday: '01001_C', replacements: ['03001_C'] },
        { weekday: '01001_F', replacements: ['03001_F'] },
        { weekday: '01001_GYB', replacements: ['03001_GYB'] },
        { weekday: '01005_MSN', replacements: [] },
      ],
      keptWeekdayServices: KYOTO_KEEP,
    })
  }, 30_000)

  it.skipIf(!hasData(KYOTO, CHUO))('Jev に問う target の数(§6.1:京都 19、北海道中央バス 27)', async () => {
    for (const [file, n] of [
      [KYOTO, 19],
      [CHUO, 27],
    ] as const) {
      const g = await groupsOf(file)
      const r = buildJevRequest(g.features, g)!
      expect(r.request.targets).toHaveLength(n)
      expect(r.omitted).toEqual([])
    }
  }, 30_000)
})
