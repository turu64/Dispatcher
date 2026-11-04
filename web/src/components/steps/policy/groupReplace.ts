/**
 * 減便の方針の詳しい設定の「入れ替えるダイヤ」の手動の欄の選択を、store に渡す直し(GroupEdit)に変える(指摘19。docs/tasks-1105.md の U04、§2 の D3)。
 * 画面の部品(GroupReplaceFields.tsx)から、値の変換だけを分けて確かめる
 */
import type { PolicyKind } from '@/gtfs/edit/ops'
import type { GroupEdit, KindGroups, KindRow, ServiceGroups } from '@/gtfs/groups/types'

/** 入れ替えるダイヤの選び方。auto は案のまま一括で入れ替える(既定)、manual は service ごとに選ぶ */
export type ReplaceMode = 'auto' | 'manual'

/** 手動の欄の1行の選択:入れ替えない、または入れ替える(target が null は「便をなくす」、undefined は入れ替え先を変えない) */
export type ManualChoice = { replace: false } | { replace: true; target?: string | null }

/** 平日の service に今入っている入れ替えに使う service(service_id の昇順) */
export function assignedTo(kg: KindGroups, weekday: string): KindRow[] {
  return kg.rows.filter((r) => r.side === 'replacement' && r.into === weekday).sort((a, b) => (a.serviceId < b.serviceId ? -1 : a.serviceId > b.serviceId ? 1 : 0))
}

/**
 * 手動の欄の選択を、store に渡す直し(GroupEdit)の並びに変える。並びの順に当てる(editGroups は割り当てがある平日の service を
 * 「残す」にできないので、先に割り当てを外す)。今と同じ値の直しは入れない(印が「直しました」にならないように)
 */
export function manualEdits(kg: KindGroups, weekday: string, choice: ManualChoice): GroupEdit[] {
  const kind = kg.kind
  const row = kg.rows.find((r) => r.serviceId === weekday)
  if (!row || (row.side !== 'weekdayOnly' && row.side !== 'unsupported')) return []
  const assigned = assignedTo(kg, weekday)
  const unassign = (keep: string | null): GroupEdit[] =>
    assigned.filter((r) => r.serviceId !== keep).map((r) => ({ kind, serviceId: r.serviceId, into: null }))
  if (!choice.replace) {
    return [...unassign(null), ...(row.treatment === 'keep' ? [] : [{ kind, serviceId: weekday, treatment: 'keep' as const }])]
  }
  // 形2で表せない service は入れ替えられない(editGroups も受け付けない)
  if (row.side === 'unsupported') return []
  const erase: GroupEdit[] = row.treatment === 'erase' ? [] : [{ kind, serviceId: weekday, treatment: 'erase' }]
  if (choice.target === undefined) return erase
  if (choice.target === null) return [...erase, ...unassign(null)]
  const target = kg.rows.find((r) => r.serviceId === choice.target && r.side === 'replacement')
  if (!target) return []
  return [...erase, ...unassign(target.serviceId), ...(target.into === weekday ? [] : [{ kind, serviceId: target.serviceId, into: weekday }])]
}

/** 入れ替え先の表示:「03001」「03001 ほか 1」 */
export function targetsText(ids: readonly string[]): string {
  if (ids.length === 0) return '便をなくす'
  return ids.length === 1 ? ids[0] : `${ids[0]} ほか ${ids.length - 1}`
}

/** その方針の種類に、利用者が直した行があるか(手動で選んでいたか。減便の方針の入力を開いたときの既定の選び方に使う) */
export function hasKindEdits(groups: ServiceGroups | null, kind: PolicyKind): boolean {
  return groups?.byKind[kind].rows.some((r) => r.intoMark === 'edited' || r.basisMark === 'edited') ?? false
}
