/**
 * 編集の手順(方針・足し戻し・出力)の画面で使う文言と、表示のための小さな補助。数は gtfs/edit・gtfs/validate が出す。
 */
import type { ServiceRole } from '@/gtfs/edit/services'
import type { EditRecord, PolicyKind, PolicyReason } from '@/gtfs/edit/ops'
import type { Form2Report } from '@/gtfs/edit/form2'
import type { GtfsFeed } from '@/gtfs/load'
import { isValidGtfsDate } from '@/gtfs/calendar'
import type { SampleGtfsInfo } from '@/gtfs/sample'
import { formatDateJa } from '@/lib/dates'

export const POLICY_KIND_LABELS: Record<PolicyKind, string> = {
  weekdayToSaturday: '平日を土曜ダイヤに',
  weekdayToSundayHoliday: '平日を日祝ダイヤに',
}

/** 写す元のダイヤの呼び方(「土曜ダイヤ」など) */
export const REPLACEMENT_LABELS: Record<PolicyKind, string> = {
  weekdayToSaturday: '土曜',
  weekdayToSundayHoliday: '日祝',
}

export const REASON_LABELS: Record<NonNullable<PolicyReason['category']>, string> = {
  temporaryShortage: '運転士の一時的な欠員',
  chronicShortage: '運転士の慢性的な不足',
  demandDecline: '需要の減少',
}

export const ROLE_LABELS: Record<ServiceRole, string> = {
  weekday: '平日(月〜金)',
  saturday: '土曜',
  sunday: '日曜',
  saturdaySunday: '土休日(土・日)',
  other: 'その他',
}

const DAY_CHARS = ['月', '火', '水', '木', '金', '土', '日']

/** calendar の曜日の列を「月火水木金・・」の形にする(走らない曜日は「・」)。calendar に行が無ければ「calendar なし」 */
export function daysPattern(days: readonly boolean[] | null): string {
  if (!days) return 'calendar なし'
  return days.map((d, i) => (d ? DAY_CHARS[i] : '・')).join('')
}

/** 'YYYYMMDD' を画面の書き方に。null は「当面の間」 */
export function periodText(start: string, end: string | null): string {
  return `${formatDateJa(start)}〜${end === null ? '当面の間' : formatDateJa(end)}`
}

/** 'YYYY-MM-DDThh:mm:ss+09:00' を「11月4日 09:30」にする */
export function shortDateTime(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(iso)
  if (!m) return iso
  return `${Number(m[2])}月${Number(m[3])}日 ${m[4]}:${m[5]}`
}

/** 'YYYYMMDDhhmm' を「2026年11月4日 12:00」にする */
export function generatedAtText(generatedAt: string): string {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(generatedAt)
  if (!m) return generatedAt
  return `${Number(m[1])}年${Number(m[2])}月${Number(m[3])}日 ${m[4]}:${m[5]}`
}

export const ACTOR_LABELS = { user: '利用者', claude: 'Claude(承認済み)' } as const

/** 履歴の1件の説明 */
export function describeRecord(record: EditRecord): string {
  const op = record.op
  if (op.type === 'applyPolicy') {
    const s = op.settings
    return `方針:${POLICY_KIND_LABELS[s.kind]}(${periodText(s.period.start, s.period.end)}${s.excludedRoutes.length > 0 ? `、${s.excludedRoutes.length} 系統を除外` : ''})`
  }
  if (op.type === 'addBack') return `足し戻し:${op.items.length} 便`
  return `足し戻しの取り消し:${op.tripIds.length} 便`
}

/** 足し戻しの分類(§5.3)ごとの、受け付けなかった理由 */
export function addBackRejections(
  report: Form2Report['addBack'],
  kind: PolicyKind,
): { tripId: string; reason: string }[] {
  const label = REPLACEMENT_LABELS[kind]
  return [
    ...report.duplicate.map((tripId) => ({ tripId, reason: '同じ便を2回選んでいます(2回目は数えません)。' })),
    ...report.notFound.map((tripId) => ({ tripId, reason: '基準の GTFS にこの便がありません。' })),
    ...report.notWeekday.map((tripId) => ({ tripId, reason: '平日ダイヤの便ではありません。' })),
    ...report.ignoredExcludedRoute.map((tripId) => ({
      tripId,
      reason: '入れ替えから外した系統の便なので、平日のダイヤのまま残っています。',
    })),
    ...report.ignoredAlreadyPresent.map(({ tripId, sameAs }) => ({
      tripId,
      reason: `${label}ダイヤに同じ時刻の便(${sameAs})があるため、足し戻す必要がありません。`,
    })),
  ]
}

/** ATTRIBUTION.md の中身と、画面に出す出典の文(§9)。generatedAt が null(まだ出力していない)なら加工日時は「出力した日時」 */
export function attributionOf(sample: SampleGtfsInfo | null, generatedAt: string | null): { file: string; screen: string } {
  const when = generatedAt === null ? '出力した日時' : generatedAtText(generatedAt)
  if (sample) {
    const text = `元データ:${sample.name} GTFS(北海道オープンデータプラットフォーム)。ライセンス:CC BY 4.0(https://creativecommons.org/licenses/by/4.0/deed.ja)。Dispatcher で減便を反映して加工しています(加工日時 ${when})。`
    return { file: `# 出典\n\n${text}\n`, screen: text }
  }
  return {
    file: `# 加工の記録\n\nこの GTFS は、Dispatcher で減便を反映して加工したものです(加工日時 ${when})。元の GTFS の出典と利用条件は、元の GTFS の提供者の表示に従ってください。\n`,
    screen: '元の GTFS の利用条件に従って、出典と加工した旨を示してください。',
  }
}

/** 足し戻した便の集計の表示(§8)。「運転時間」とは書かない */
export function restoreTotalsText(t: {
  trips: number
  serviceMinutes: number
  unknownDuration: number
  earliestStart: string | null
  latestEnd: string | null
}): string {
  const h = Math.floor(t.serviceMinutes / 60)
  const m = t.serviceMinutes % 60
  const range =
    t.earliestStart && t.latestEnd ? `最も早い始発 ${t.earliestStart}、最も遅い終着 ${t.latestEnd}` : '始発・終着の時刻なし'
  const unknown = t.unknownDuration > 0 ? `。時刻が読めず合計に入れなかった便 ${t.unknownDuration} 便` : ''
  return `足し戻した便 ${t.trips} 便、営業運行時間の合計 ${h}時間${m}分(始発から終着まで。回送・待機・点呼は含まず、必要な運転士の人数ではありません。${range})${unknown}`
}

export const RESTORE_DUTY_NOTE =
  '足し戻した便を担う運転士の勤務(休息期間は継続 11 時間以上を与えるよう努めることを基本とし、継続 9 時間を下回らないこと。1日の拘束は 13 時間以内(最大 15 時間、14 時間を超えるのは週 3 回までが目安)。連続運転は 4 時間まで)は、運行管理者が乗務割で確かめてください。Dispatcher は運転士ごとの勤務を判定しません。'

export const SCHOOL_HOLIDAY_NOTE =
  '足し戻した便は学校の休業日にも走ります。休校日運休の便は GTFS では表せないため、変更指示書と周知文で補ってください。'

export const UNDO_NOTE =
  '出力した GTFS だけでは元に戻せません。元に戻せるのは、この画面の編集の履歴と、読み込んだ元の GTFS を持っている間だけです(読み込み直すと履歴は消えます)。'

/** 「外れた場所が戻る」の手がかりの表示(戻るセルの数と、そこの推計人口) */
export function lostCellsText(lost: { cells: number; population: number }): string {
  return `外れたセルが戻る(${lost.cells.toLocaleString('ja-JP')} セル、約 ${Math.round(lost.population).toLocaleString('ja-JP')} 人)`
}

/**
 * service の calendar の行のうち、日付(start_date・end_date)が正しくない行の数。
 * 日付が正しくない行は運行日を生まないので、運行日の判定には数えない(calendar.ts・ops.ts と同じ)
 */
export function invalidCalendarRowCount(feed: GtfsFeed, serviceId: string): number {
  const id = serviceId.trim()
  let n = 0
  for (const row of feed.tables.get('calendar')?.rows ?? []) {
    if ((row.service_id ?? '').trim() !== id) continue
    if (!isValidGtfsDate((row.start_date ?? '').trim()) || !isValidGtfsDate((row.end_date ?? '').trim())) n++
  }
  return n
}

/** 平日の service が期間の中で1日も走らない(weekdayNotActive)ときに添える、日付の正しくない calendar の行の説明。無ければ null */
export function invalidCalendarNote(feed: GtfsFeed, serviceId: string): string | null {
  const n = invalidCalendarRowCount(feed, serviceId)
  if (n === 0) return null
  return `この service(${serviceId.trim()})の calendar に、日付の正しくない行が ${n} 行あります。日付の正しくない calendar の行は数えていません。calendar.txt の start_date・end_date を確かめてください。`
}
