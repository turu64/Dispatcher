import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  ADD_BACK_ITEM_KEYS,
  POLICY_KIND_NAMES,
  REASON_CATEGORY_NAMES,
  RESTORE_HINT_KINDS,
  SEARCH_SCOPES,
  SERVER_TOOL_LABELS,
  STEP_HOURS_VALUES,
  TOOL_INPUT_KEYS,
  TOOL_LABELS,
  TOOL_NAMES,
} from './tools'

/**
 * ツールの定義の正は server/src/dispatcher_server/claude_tools.json(docs/interfaces-1105.md §3.1・§3.3)。
 * ブラウザのコードからは読み込まないので、ここで照らす。
 * カスタムツールに strict は無い(§3.1)ので、strict の有無は見ない。additionalProperties: false・enum・anyOf は
 * 入力の形の説明として残るので、runTool の確かめ(知らない項目を断る・決まった値)と照らす
 */
interface JsonSchema {
  type?: string
  enum?: unknown[]
  anyOf?: JsonSchema[]
  properties?: Record<string, JsonSchema>
  required?: string[]
  items?: JsonSchema
  additionalProperties?: boolean
}
interface ToolDefinition {
  name: string
  description: string
  input_schema: JsonSchema
}

const path = fileURLToPath(new URL('../../../server/src/dispatcher_server/claude_tools.json', import.meta.url))
const tools = JSON.parse(readFileSync(path, 'utf-8')) as ToolDefinition[]
const byName = new Map(tools.map((t) => [t.name, t]))

/** anyOf を開いて、enum の値を集める */
function enumOf(schema: JsonSchema | undefined): unknown[] {
  if (!schema) return []
  return [...(schema.enum ?? []), ...(schema.anyOf ?? []).flatMap(enumOf)]
}

describe('ツールの名前と required の項目が claude_tools.json と一致する', () => {
  it('名前と並びが同じ。サーバーが実行するツールの名前と重ならない', () => {
    expect(tools.map((t) => t.name)).toEqual([...TOOL_NAMES])
    expect(Object.keys(TOOL_LABELS).sort()).toEqual([...TOOL_NAMES].sort())
    for (const name of Object.keys(SERVER_TOOL_LABELS)) expect(TOOL_NAMES as readonly string[]).not.toContain(name)
  })

  it.each([...TOOL_NAMES])('%s の required と項目が、runTool の受け付ける項目と同じ(すべて required、ほかの項目は無し)', (name) => {
    const tool = byName.get(name)!
    expect(tool.input_schema.type).toBe('object')
    expect(tool.input_schema.additionalProperties).toBe(false)
    expect(tool.input_schema.required ?? []).toEqual([...TOOL_INPUT_KEYS[name]])
    expect(Object.keys(tool.input_schema.properties ?? {}).sort()).toEqual([...TOOL_INPUT_KEYS[name]].sort())
  })

  it('add_back_trips の items の1件の項目が同じ', () => {
    const items = byName.get('add_back_trips')!.input_schema.properties!.items.items!
    expect(items.additionalProperties).toBe(false)
    expect(items.required).toEqual([...ADD_BACK_ITEM_KEYS])
    expect(Object.keys(items.properties ?? {}).sort()).toEqual([...ADD_BACK_ITEM_KEYS].sort())
  })

  it('決まった値(kind・reason_category・scope・step_hours・hints)が同じ', () => {
    const policy = byName.get('apply_policy')!.input_schema.properties!
    expect(enumOf(policy.kind).sort()).toEqual(Object.keys(POLICY_KIND_NAMES).sort())
    expect(enumOf(policy.reason_category).sort()).toEqual(Object.keys(REASON_CATEGORY_NAMES).sort())
    expect(enumOf(byName.get('search_trips')!.input_schema.properties!.scope).sort()).toEqual([...SEARCH_SCOPES].sort())
    expect(enumOf(byName.get('summarize_impact')!.input_schema.properties!.step_hours)).toEqual([...STEP_HOURS_VALUES])
    // search_trips の hints は判断材料の識別子(restore.ts の RestoreHint)の配列か null
    const hints = byName.get('search_trips')!.input_schema.properties!.hints
    expect((hints.anyOf ?? []).map((a) => a.type).sort()).toEqual(['array', 'null'])
    expect(enumOf(hints.anyOf!.find((a) => a.type === 'array')!.items).sort()).toEqual([...RESTORE_HINT_KINDS].sort())
  })

  it('判断材料の説明は、画面の名前で書き、「唯一の便」と言い換えない(指摘15.3)。evening は 15〜21時', () => {
    const search = byName.get('search_trips')!.description
    expect(search).not.toContain('唯一の便)')
    expect(search).toContain('onlyTripInBand「時間帯の便がなくなる」')
    expect(search).toContain('onlyServiceAtStop「停留所の発車がなくなる」')
    expect(search).toContain('evening「夕方・夜(15〜21時)」')
    expect(search).not.toContain('15〜19時')
    for (const key of ['hint_texts', 'band', 'route_weekday_trips', 'truncated', 'next_offset']) expect(search).toContain(key)
    const impact = byName.get('summarize_impact')!.description
    for (const key of ['round_trip', 'facility_access', 'facility_access_unavailable', 'drivers']) expect(impact).toContain(key)
  })
})
