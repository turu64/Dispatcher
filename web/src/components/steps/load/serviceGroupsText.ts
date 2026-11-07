/**
 * 読み込みの手順の「ダイヤのグループ分け」の文と、表の行の並び(docs/design-service-groups.md §5.1・§3.6)。
 * 画面の部品(ServiceGroupsCard.tsx)から、文と並びだけをここに分けて確かめる。表は読む専用(指摘19。docs/tasks-1105.md の U04)
 */
import type { PolicyKind } from '@/gtfs/edit/ops'
import { policyServicesFor } from '@/gtfs/groups/policy'
import { POLICY_KINDS, type Basis, type JevRole, type KindGroups, type KindRow, type Mark, type ServiceFeatures, type ServiceGroups, type Side } from '@/gtfs/groups/types'

export const KIND_LABELS: Record<PolicyKind, string> = {
  weekdayToSaturday: '平日を土曜ダイヤに',
  weekdayToSundayHoliday: '平日を日祝ダイヤに',
}

export const SIDE_LABELS: Record<Side, string> = {
  weekdayOnly: '平日だけ',
  replacement: '入れ替えに使う',
  both: '両方に走る',
  unsupported: '形2で表せない',
  unrelated: '関係しない',
}

export const BASIS_LABELS: Record<Basis, string> = {
  regular: 'ほぼ毎回',
  partial: '一部の日',
  special: '特定の日',
  noDays: '運行日なし',
}

export const MARK_LABELS: Record<Mark, string> = {
  agreed: '規則と Jev が一致',
  rule: '規則',
  jev: 'Jev の判断',
  conflict: '規則と Jev が食い違っています',
  undecided: '選んでください',
  edited: '直しました',
}

export const ROLE_LABELS: Record<JevRole, string> = {
  weekday: '平日',
  saturday: '土曜',
  sundayHoliday: '日祝',
}

/** 送り先の名前(送るかを聞くダイアログ・送ったことの文で使う) */
export const JEV_DESTINATION = 'TypeSafe AI Jev(Vercel AI Gateway 経由)'

/** 送る中身(jevRequest.ts の toWire と feed の項目に合わせる。変えたら README・docs/deploy.md も直す) */
export const JEV_SENT_ITEMS =
  'service_id・運行日の数と走る日の割合・便数・系統名と系統ごとの便数・行き先・始発と終着の時刻・運行日が 10 日以下の service の日付・事業者名・有効期間'

/** 送る中身と、送らないもの。送るかを聞くダイアログと、運営情報のページで使う */
export const JEV_SENT_SCOPE = `service ごとの集計(${JEV_SENT_ITEMS})を送ります。GTFS のファイル・停留所の位置・時刻表そのものは送りません。`

/** 転送先を TypeSafe AI に限っている点(サーバーが providerOptions.gateway.only を送る。2026-11-04 に確かめた。変わるなら直す) */
export const JEV_ROUTING_NOTE =
  'TypeSafe AI に限って送ります(Vercel がほかの会社に回さないよう指定しています。TypeSafe AI が答えないときは、確かめを失敗として扱います)。'

/** 送るかを聞くダイアログ(JevConsentDialog)の見出しとボタン */
export const JEV_CONSENT_TITLE = 'ダイヤの分け方を Jev に問い合わせますか'
export const JEV_CONSENT_ACCEPT = 'Jev に送る'
export const JEV_CONSENT_DECLINE = '送らずに規則だけで進める'

/** ダイアログの1文目:規則で決まらない service の数と送り先 */
export function jevConsentLead(asking: number): string {
  return `走る日の規則だけでは分け方を決めきれない service が ${asking} 個あります。その service ごとの集計を ${JEV_DESTINATION}に送って、分け方を確かめられます。`
}

/** 上限のために問い合わせない service の数の文(無ければ null) */
export function jevOmittedText(omitted: number): string | null {
  return omitted > 0 ? `上限のため、${omitted} 個の service は問い合わせません(規則で分けます)。` : null
}

/** 答えを得たあとに表の上に出す1行(§3.6) */
export const JEV_SENT_TEXT = `service ごとの集計(${JEV_SENT_ITEMS})を、${JEV_DESTINATION}に送り、分け方を確かめました。GTFS のファイル・停留所の位置・時刻表そのものは送っていません。`

function percent(v: number): string {
  return `${Math.round(v * 100)}%`
}

/** 走る日:「平日 97%」「土曜 0%」「日祝 0%」(画面では「・」でつなぐ) */
export function coverageParts(f: ServiceFeatures): string[] {
  return [`平日 ${percent(f.coverage.weekday)}`, `土曜 ${percent(f.coverage.saturday)}`, `日祝 ${percent(f.coverage.sundayHoliday)}`]
}

/** 便数・系統の列:「310 便・8 系統」 */
export function tripsText(f: ServiceFeatures): string {
  return `${f.tripCount.toLocaleString('ja-JP')} 便・${f.routeCount} 系統`
}

/** 単純でない GTFS で、表の上に出す「どこで直すか」の1文(読み込みの手順の表は読む専用) */
export const GROUPS_FIX_NOTE =
  '入れ替えはこの分け方のとおりに一括で行います。service ごとに直すときは、手順「減便の方針」の詳しい設定で「手動で選ぶ」を選びます。'

/**
 * 表の「扱い・入れる先」の列の文(読む専用)。入れ替えに使う service は「入れる先 01001」「使わない」「決まらない」、
 * 平日の側は「入れ替える」「なくす」「残す」(形2で表せない service で扱いが決まっていなければ「決まっていない」)
 */
export function rowValueText(row: KindRow, kg: KindGroups): string {
  if (row.side === 'replacement') {
    if (row.into !== null) return `入れる先 ${row.into}`
    return row.intoMark === 'undecided' ? '決まらない' : '使わない'
  }
  if (row.side === 'weekdayOnly' || row.side === 'unsupported') {
    if (row.treatment === 'keep') return '残す'
    if (row.treatment === null) return '決まっていない'
    return kg.rows.some((r) => r.side === 'replacement' && r.into === row.serviceId) ? '入れ替える' : 'なくす'
  }
  return '手を付けない'
}

/** 行の印(平日の側は扱いの印、入れ替えに使う側は割り当ての印) */
export function markOf(row: KindRow): Mark | null {
  if (row.side === 'replacement') return row.intoMark
  // 形2で表せない service の扱いが未決のときは印を出さない(確定は止めない。§3.4 S7)。減便の方針を止めることは問題の一覧で出す
  if (row.side === 'weekdayOnly' || row.side === 'unsupported') return row.basisMark
  return null
}

/** 確かめが要る行か(決まらない・食い違い・形2で表せない service の扱いが未決) */
export function rowNeedsAttention(row: KindRow): boolean {
  const mark = markOf(row)
  if (row.side === 'unsupported' && row.treatment === null) return true
  return mark === 'undecided' || mark === 'conflict'
}

export interface RowSection {
  key: 'undecided' | 'pairs' | 'erase' | 'keep' | 'unsupported'
  title: string
  rows: { row: KindRow; nested: boolean }[]
}

/**
 * 表の並び(§5.1):決まらない入れ替えに使う service → 入れ替える組(平日の service の下に入れ替えに使う service)
 * → なくす → 残す → 形2で表せない。両方に走る・関係しない・使わない入れ替えに使う service は others(閉じた開閉の中)
 */
export function orderRows(kg: KindGroups): { sections: RowSection[]; others: KindRow[] } {
  const rows = kg.rows
  const intoOf = new Map<string, KindRow[]>()
  for (const r of rows) {
    if (r.side !== 'replacement' || r.into === null) continue
    intoOf.set(r.into, [...(intoOf.get(r.into) ?? []), r])
  }
  const weekdayOnly = rows.filter((r) => r.side === 'weekdayOnly')
  // 主の平日の service を先頭に
  weekdayOnly.sort((a, b) => Number(b.serviceId === kg.mainWeekday) - Number(a.serviceId === kg.mainWeekday))

  const pairs: RowSection['rows'] = []
  const erase: RowSection['rows'] = []
  const keep: RowSection['rows'] = []
  for (const w of weekdayOnly) {
    const assigned = intoOf.get(w.serviceId) ?? []
    if (assigned.length > 0) {
      pairs.push({ row: w, nested: false }, ...assigned.map((row) => ({ row, nested: true })))
    } else if (w.treatment === 'keep') {
      keep.push({ row: w, nested: false })
    } else {
      erase.push({ row: w, nested: false })
    }
  }
  const undecided = rows.filter((r) => r.side === 'replacement' && r.into === null && r.intoMark === 'undecided').map((row) => ({ row, nested: false }))
  const unsupported = rows.filter((r) => r.side === 'unsupported').map((row) => ({ row, nested: false }))
  const sections: RowSection[] = [
    { key: 'undecided' as const, title: '入れる平日の service が決まらないもの', rows: undecided },
    { key: 'pairs' as const, title: '入れ替える', rows: pairs },
    { key: 'erase' as const, title: 'なくす', rows: erase },
    { key: 'keep' as const, title: '残す', rows: keep },
    { key: 'unsupported' as const, title: '形2で表せない', rows: unsupported },
  ].filter((s) => s.rows.length > 0)
  const others = rows.filter(
    (r) => r.side === 'both' || r.side === 'unrelated' || (r.side === 'replacement' && r.into === null && r.intoMark !== 'undecided'),
  )
  return { sections, others }
}

/**
 * 単純な GTFS の1行の要約(§5.1)。
 * 「平日 01・土曜 03・日祝 06 に分かれています(走る日から判定しました)。」、土曜と日祝が同じ service なら「土日祝」、
 * 入れ替えに使う service が無ければ「平日だけの S000002 は期間の間なくします。…」
 */
export function simpleSummary(groups: ServiceGroups): string {
  const sat = policyServicesFor(groups, 'weekdayToSaturday')
  const sun = policyServicesFor(groups, 'weekdayToSundayHoliday')
  if ('error' in sat || 'error' in sun) {
    const errors = 'error' in sat ? sat.error : 'error' in sun ? sun.error : []
    if (errors.some((e) => e.code === 'nothingToChange')) return '平日と土曜・日祝で同じダイヤのため、入れ替える便がありません。'
    return errors[0]?.message ?? '平日・土曜・日祝のダイヤに分けられませんでした。'
  }
  const w = sat.weekdayService
  const rs = sat.replacementService
  const rh = sun.replacementService
  if (hasEdits(groups)) {
    // 利用者が表で直したときは、「走る日から判定しました」「…だけに走る service はない」と言わない(直した結果なので)
    const parts = [`平日 ${w}`, ...(rs !== '' && rs === rh ? [`土日祝 ${rs}`] : [...(rs !== '' ? [`土曜 ${rs}`] : []), ...(rh !== '' ? [`日祝 ${rh}`] : [])])]
    const none = [...(rs === '' ? ['土曜'] : []), ...(rh === '' ? ['日祝'] : [])]
    const tail = none.length > 0 ? `${none.join('・')}ダイヤに変えるときは、入れ替えに使う service がないため、${w} の便を期間の間なくします。` : ''
    return `直した分け方:${parts.join('・')}。${tail}`
  }
  if (rs !== '' && rs === rh) return `平日 ${w}・土日祝 ${rs} に分かれています(走る日から判定しました)。`
  if (rs !== '' && rh !== '') return `平日 ${w}・土曜 ${rs}・日祝 ${rh} に分かれています(走る日から判定しました)。`
  if (rs === '' && rh === '') return `平日だけの ${w} は期間の間なくします。土曜・日祝だけに走る service はありません。`
  const [has, label, none] = rs !== '' ? [rs, '土曜', '日祝'] : [rh, '日祝', '土曜']
  return `平日 ${w}・${label} ${has} に分かれています(走る日から判定しました)。${none}だけに走る service はないため、${none}ダイヤに変えるときは ${w} をなくします。`
}

/** 利用者が表で直した行があるか */
export function hasEdits(groups: ServiceGroups): boolean {
  return POLICY_KINDS.some((k) => groups.byKind[k].rows.some((r) => r.intoMark === 'edited' || r.basisMark === 'edited'))
}

/** 単純でない GTFS の要約(§5.1) */
export function complexSummary(groups: ServiceGroups, attention: number): string {
  const head = `service_id が ${groups.features.services.length} 個あります。平日・土曜・日祝のダイヤにまとめた案を作りました。`
  if (attention === 0) return head
  // 両方のタブにあるときは、タブごとの数を添える(タブの数の合計と全体の数が合わないことがあるため)
  const sat = attentionCount(groups, 'weekdayToSaturday')
  const sun = attentionCount(groups, 'weekdayToSundayHoliday')
  const byTab = sat > 0 && sun > 0 ? `(土曜ダイヤに ${sat}・日祝ダイヤに ${sun}${sat + sun > attention ? '。両方に出るものがあります' : ''})` : ''
  return `${head}確かめが要るものが ${attention} 件あります${byTab}。`
}

/** 規則と Jev が食い違っている行の数(方針の種類をまたいで重ねない)。直さなければ規則の値で入れ替える */
export function conflictCount(groups: ServiceGroups): number {
  const ids = new Set<string>()
  for (const k of POLICY_KINDS) for (const r of groups.byKind[k].rows) if (markOf(r) === 'conflict') ids.add(r.serviceId)
  return ids.size
}

/** 答えた提供元の表示の名前(Vercel の providerMetadata の id。知らない id はそのまま) */
export const PROVIDER_NAMES: Record<string, string> = { 'typesafe-ai': 'TypeSafe AI', digitalocean: 'DigitalOcean' }

/** 確かめが要る service の数(方針の種類をまたいで重ねない) */
export function attentionCount(groups: ServiceGroups, kind?: PolicyKind): number {
  const kinds: PolicyKind[] = kind ? [kind] : ['weekdayToSaturday', 'weekdayToSundayHoliday']
  const ids = new Set<string>()
  for (const k of kinds) for (const r of groups.byKind[k].rows) if (rowNeedsAttention(r)) ids.add(r.serviceId)
  return ids.size
}

/** 入れる平日の service が決まらない service の数(方針の種類をまたいで重ねない) */
export function undecidedCount(groups: ServiceGroups): number {
  const ids = new Set<string>()
  for (const k of POLICY_KINDS) for (const r of groups.byKind[k].rows) if (r.intoMark === 'undecided') ids.add(r.serviceId)
  return ids.size
}
