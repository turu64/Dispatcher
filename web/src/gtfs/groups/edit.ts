/**
 * 利用者の直し(docs/design-service-groups.md §3.4・§5.1)。
 *
 * - 直した行は印が edited になり、Jev の答えを合わせ直しても戻らない
 * - 直すたびに、案を判断材料・Jev の答え・直しから組み立て直す(割り当てを変えたら、関係する平日の service の既定の扱いも変わる)
 * - 受け付けない直し(その行が無い、役割に合わない値)は、何も変えずに同じ groups を返す。
 *   割り当てのある平日の service を「残す」にしようとしたときは、変えずに問題 keptHasReplacements を出す
 */
import { POLICY_KINDS, type GroupEdit, type ServiceGroups } from './types'
import { buildByKind, editsOf } from './rules'

export function editGroups(groups: ServiceGroups, edit: GroupEdit): ServiceGroups {
  const kindGroups = groups.byKind[edit.kind]
  const row = kindGroups.rows.find((r) => r.serviceId === edit.serviceId)
  if (!row) return groups
  const edits = editsOf(groups)
  const kindEdits = edits[edit.kind]

  if ('into' in edit) {
    if (row.side !== 'replacement') return groups
    if (edit.into !== null && !kindGroups.rows.some((r) => r.serviceId === edit.into && r.side === 'weekdayOnly')) return groups
    kindEdits.into.set(edit.serviceId, edit.into)
  } else if ('treatment' in edit) {
    if (row.side === 'unsupported') {
      if (edit.treatment !== 'keep') return groups
    } else if (row.side === 'weekdayOnly') {
      const assigned = kindGroups.rows.some((r) => r.side === 'replacement' && r.into === edit.serviceId)
      if (edit.treatment === 'keep' && assigned) {
        kindEdits.rejectedKeep.push(edit.serviceId)
        return { ...groups, byKind: buildByKind(groups.features, groups.jev, edits) }
      }
    } else {
      return groups
    }
    kindEdits.treatment.set(edit.serviceId, edit.treatment)
  } else {
    // 食い違いを受け入れる:今の値のまま edited にする
    let changed = false
    if (row.intoMark === 'conflict') {
      kindEdits.into.set(edit.serviceId, row.into)
      changed = true
    }
    if (row.basisMark === 'conflict') {
      kindEdits.treatment.set(edit.serviceId, row.treatment)
      changed = true
    }
    if (!changed) return groups
  }
  return { ...groups, byKind: buildByKind(groups.features, groups.jev, edits) }
}

/** その service の直しを、すべての方針の種類で捨てて、規則と Jev の案に戻す */
export function resetToProposal(groups: ServiceGroups, serviceId: string): ServiceGroups {
  const edits = editsOf(groups)
  for (const kind of POLICY_KINDS) {
    edits[kind].into.delete(serviceId)
    edits[kind].treatment.delete(serviceId)
  }
  return { ...groups, byKind: buildByKind(groups.features, groups.jev, edits) }
}

/** 確定できるか:決まらない行(undecided)が 0 件(§3.4 の S7)。食い違いと形2で表せない service は止めない */
export function canConfirm(groups: ServiceGroups): boolean {
  return POLICY_KINDS.every((kind) => groups.byKind[kind].rows.every((r) => r.intoMark !== 'undecided'))
}
