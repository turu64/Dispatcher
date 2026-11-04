/**
 * グループ分けのテストで使う、手で作るフィードと判断材料(テスト専用)。
 */
import type { GtfsFeed, GtfsRow } from '../load'
import { basisOf, levelOf, LEVEL_THRESHOLDS, splitServiceName } from './features'
import { DAY_KEYS, type DayCounts, type DayKey, type FeedFeatures, type Level, type ServiceFeatures } from './types'

/** CSV の文字列(1行目が見出し)を行にする。値に ',' は使わない */
export function csvRows(csv: string): GtfsRow[] {
  const [header, ...lines] = csv.trim().split('\n')
  const fields = header.split(',')
  return lines.filter((l) => l.trim() !== '').map((l) => {
    const values = l.split(',')
    return Object.fromEntries(fields.map((f, i) => [f, values[i] ?? '']))
  })
}

/** 表の名前 → CSV の文字列から、フィードを作る */
export function feedFrom(tables: Record<string, string>): GtfsFeed {
  const map = new Map<string, { fileName: string; fields: string[]; rows: GtfsRow[] }>()
  for (const [name, csv] of Object.entries(tables)) {
    map.set(name, { fileName: `${name}.txt`, fields: csv.trim().split('\n')[0].split(','), rows: csvRows(csv) })
  }
  return { tables: map, warnings: [] }
}

export const DAYS_IN_PERIOD: DayCounts = { weekday: 100, saturday: 20, sundayHoliday: 25 }

/**
 * 判断材料を直接作る。days は区分ごとの運行日の数(期間の日数は DAYS_IN_PERIOD)。
 * routes は route_id の一覧(便は1系統1便ずつに割る)
 */
export function svc(
  serviceId: string,
  days: Partial<DayCounts>,
  opts: { trips?: number; routes?: string[]; headsigns?: string[]; dates?: string[] } = {},
): ServiceFeatures {
  const c: DayCounts = { weekday: days.weekday ?? 0, saturday: days.saturday ?? 0, sundayHoliday: days.sundayHoliday ?? 0 }
  const total = c.weekday + c.saturday + c.sundayHoliday
  const coverage: DayCounts = {
    weekday: c.weekday / DAYS_IN_PERIOD.weekday,
    saturday: c.saturday / DAYS_IN_PERIOD.saturday,
    sundayHoliday: c.sundayHoliday / DAYS_IN_PERIOD.sundayHoliday,
  }
  const levels = Object.fromEntries(DAY_KEYS.map((k) => [k, levelOf(c[k], DAYS_IN_PERIOD[k])])) as Record<DayKey, Level>
  const { basis, runs } = basisOf(levels, c)
  const routeIds = [...(opts.routes ?? ['R1'])].sort()
  const trips = opts.trips ?? 10
  return {
    serviceId,
    name: splitServiceName(serviceId),
    tripCount: trips,
    routeCount: routeIds.length,
    routes: routeIds.map((routeId) => ({ routeId, name: `系統${routeId}`, trips: Math.max(1, Math.floor(trips / routeIds.length)) })),
    routeIds,
    headsigns: opts.headsigns ?? ['駅前'],
    firstDeparture: '06:00',
    lastArrival: '22:00',
    runningDays: { ...c, total },
    coverage,
    levels,
    basis,
    runs,
    runningDates: total <= 10 ? (opts.dates ?? []) : null,
    nearThreshold: DAY_KEYS.filter((k) => {
      const v = coverage[k]
      return v > 0 && (Math.abs(v - LEVEL_THRESHOLDS.regular) <= 0.05 + 1e-9 || Math.abs(v - LEVEL_THRESHOLDS.partial) <= 0.05 + 1e-9)
    }),
  }
}

export function featuresOf(services: ServiceFeatures[], agency: string | null = 'テストバス'): FeedFeatures {
  return {
    agency,
    validity: { start: '20261001', end: '20270228' },
    daysInPeriod: { ...DAYS_IN_PERIOD },
    holidays: 'loaded',
    services: [...services].sort((a, b) => (a.serviceId < b.serviceId ? -1 : a.serviceId > b.serviceId ? 1 : 0)),
  }
}

/** 京都市営バスの形を小さくしたもの(§2.8) */
export function kyotoLike(): FeedFeatures {
  return featuresOf([
    svc('01001', { weekday: 98 }, { trips: 500, routes: ['A', 'B', 'C', 'D'] }),
    svc('01001_A', { weekday: 97 }, { trips: 30, routes: ['A', 'E'] }),
    svc('01001_C', { weekday: 1 }, { trips: 30, routes: ['A', 'E'], dates: ['20261102'] }),
    svc('01002_RIT', { weekday: 59 }, { trips: 20, routes: ['F'], headsigns: ['立命館大学'] }),
    svc('01005_MSN', { weekday: 90 }, { trips: 3, routes: ['A', 'G'] }),
    svc('03001', { saturday: 19 }, { trips: 400, routes: ['A', 'B', 'C'] }),
    svc('03001_A', { saturday: 18 }, { trips: 30, routes: ['A', 'E'] }),
    svc('03001_C', { saturday: 1 }, { trips: 30, routes: ['A', 'E'], dates: ['20261031'] }),
    svc('02001', { weekday: 2, saturday: 1, sundayHoliday: 25 }, { trips: 380, routes: ['A', 'B', 'C'] }),
    svc('02001_A', { sundayHoliday: 24 }, { trips: 28, routes: ['A', 'E'] }),
    svc('SRV_8_10600_01_A', { saturday: 2, sundayHoliday: 3 }, { trips: 4, routes: ['H'] }),
  ])
}
