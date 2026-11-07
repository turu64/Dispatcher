import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'
import { applyForm2, type Form2Result } from '../edit/form2'
import type { Form2Plan } from '../edit/ops'
import { loadGtfsZip, type GtfsFeed } from '../load'
import { writeGtfsZip } from '../write'
import { validateEdit, type ValidationIssue } from './edit'

// 検証器の規則(feed.ts)を道北バスの 9/17 版で確かめる。data/raw/gtfs/ に ZIP があるときだけ走る(コミットしない)。
// 方針は形2の正解データ(../edit/form2.golden.json)の場面を使う。照合は ZIP の SHA-256 が正解データと合うときだけ行い、合わなければ skipped になる。
// 入力の時点で stop_times に出てこない停留所は 122 か所、便の無い系統は 27 系統あり、どちらも unused* には数えない。

const ZIP = fileURLToPath(new URL('../../../../data/raw/gtfs/dohoku_bus_減便前.zip', import.meta.url))
const GOLDEN = fileURLToPath(new URL('../edit/form2.golden.json', import.meta.url))
const GENERATED_AT = '202611041200'
const SCENARIOS = ['main', 'replaceOnly', 'periodEnd', 'edgeCases'] as const

interface Golden {
  input: { sha256: string }
  scenarios: Record<string, { policy: Omit<Form2Plan, 'kind'> }>
}

const golden: Golden = JSON.parse(readFileSync(GOLDEN, 'utf-8'))
// ZIP が無いか、SHA-256 が正解データと違うときは、照合せずに skipped として出す(gtfs-jp-check の Skill は飛ばしたテストを報告する)
const matches = existsSync(ZIP) && createHash('sha256').update(readFileSync(ZIP)).digest('hex') === golden.input.sha256

function find(issues: ValidationIssue[], code: string): ValidationIssue | undefined {
  return issues.find((i) => i.code === code)
}

describe.skipIf(!matches)('検証器の規則(道北バス 9/17 版)', () => {
  let original: ArrayBuffer
  let base: GtfsFeed
  const issuesOf = new Map<string, ValidationIssue[]>()
  const results = new Map<string, Form2Result>()

  beforeAll(async () => {
    const buf = readFileSync(ZIP)
    original = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer
    base = await loadGtfsZip(original)
    for (const name of SCENARIOS) {
      const outcome = applyForm2(base, { kind: 'weekdayToSaturday', ...golden.scenarios[name].policy }, { generatedAt: GENERATED_AT })
      if (!outcome.ok) throw new Error(`${name}: ${outcome.message}`)
      results.set(name, outcome.result)
      issuesOf.set(name, validateEdit(base, outcome.result, null))
    }
  })

  it('main の出力に error が無く、入力からある問題も無い', () => {
    const issues = issuesOf.get('main')!
    expect(issues.filter((i) => i.severity === 'error')).toEqual([])
    expect(issues.filter((i) => i.inherited)).toEqual([])
    // 道北バスは時刻の書き方がそろい、署名が同じ便どうしでほかの列の違いも無い(§12.2)。feed_info は1行で、calendar は feed_info と端が同じ
    for (const code of ['timeFormatVariant', 'signatureColumnMismatch', 'feedInfoRows', 'calendarBeyondFeedInfo', 'calendarOutsideValidity']) {
      expect(find(issues, code)).toBeUndefined()
    }
  })

  it('main で stop_times から消える停留所は 90 か所前後', () => {
    const unused = find(issuesOf.get('main')!, 'unusedStops')
    expect(unused).toMatchObject({ severity: 'info', file: 'stops.txt' })
    expect(unused!.count).toBe(90)
    expect(unused!.message).toContain('90 か所')
  })

  it('replaceOnly では平日だけの 19 系統の便がすべて無くなる', () => {
    const issues = issuesOf.get('replaceOnly')!
    expect(issues.filter((i) => i.severity === 'error')).toEqual([])
    expect(find(issues, 'unusedRoutes')).toMatchObject({ severity: 'info', count: 19 })
  })

  it('ほかの場面にも error が無い', () => {
    for (const name of SCENARIOS) {
      expect({ name, errors: issuesOf.get(name)!.filter((i) => i.severity === 'error') }).toEqual({ name, errors: [] })
    }
  })

  it('入力に当てても、新しい error の規則に当たる対象が無い', () => {
    // 基準をそのまま「編集後」として渡すと、入力からある問題も新しい問題も出ない(規則が入力に当たらない)
    const main = results.get('main')!
    const issues = validateEdit(base, { ...main, feed: base }, null)
    for (const code of [
      'requiredFileMissing',
      'badCalendarDate',
      'badCalendarWeekday',
      'badTimeFormat',
      'stopSequenceNotIncreasing',
      'stopTimesEndpointBlank',
      'stopTimesDecreasing',
      'stopIdChanged',
      'routeIdChanged',
    ]) {
      expect(find(issues, code)).toBeUndefined()
    }
    expect(find(issues, 'unusedStops')).toBeUndefined()
    expect(find(issues, 'unusedRoutes')).toBeUndefined()
  })

  it('main の出力 ZIP を書き出して読み直しても、error が無く、検証の結果が同じ', async () => {
    const main = results.get('main')!
    const blob = await writeGtfsZip({ original, base, edited: main.feed, generatedAt: GENERATED_AT, attribution: '検証器のテスト\n' })
    const reread = await loadGtfsZip(await blob.arrayBuffer())
    const issues = validateEdit(base, { ...main, feed: reread }, null)
    expect(issues.filter((i) => i.severity === 'error')).toEqual([])
    expect(issues).toEqual(issuesOf.get('main'))
  })
})
