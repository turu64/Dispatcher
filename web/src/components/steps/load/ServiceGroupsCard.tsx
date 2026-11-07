import { ChevronDownIcon } from 'lucide-react'
import { Fragment, useState } from 'react'
import { flushSync } from 'react-dom'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import type { PolicyKind } from '@/gtfs/edit/ops'
import { jevChoiceOf } from '@/gtfs/groups/rules'
import {
  POLICY_KINDS,
  type GroupProblem,
  type JevJudgeResponse,
  type KindGroups,
  type KindRow,
  type Mark,
  type ServiceFeatures,
  type ServiceGroups,
} from '@/gtfs/groups/types'
import { uncoveredRanges } from '@/gtfs/holidays'
import { formatDateJa } from '@/lib/dates'
import { draftName, useEditStore } from '@/store/edit'
import { useHolidayStore } from '@/store/holidays'
import { useServiceGroupsStore, type JevInfo } from '@/store/serviceGroups'
import JevConsentDialog from './JevConsentDialog'
import {
  attentionCount,
  BASIS_LABELS,
  complexSummary,
  conflictCount,
  GROUPS_FIX_NOTE,
  coverageParts,
  JEV_DESTINATION,
  JEV_SENT_TEXT,
  KIND_LABELS,
  MARK_LABELS,
  markOf,
  orderRows,
  PROVIDER_NAMES,
  ROLE_LABELS,
  rowValueText,
  SIDE_LABELS,
  simpleSummary,
  tripsText,
  undecidedCount,
} from './serviceGroupsText'

/** タブの文字(狭い欄に収める。読み上げの名前は KIND_LABELS) */
const TAB_LABELS: Record<PolicyKind, string> = { weekdayToSaturday: '土曜ダイヤに', weekdayToSundayHoliday: '日祝ダイヤに' }

/** 押したボタンが消えるとき、焦点を body に落とさないよう、描き直したあとで代わりの要素に移す */
function focusAfter(action: () => void, id: string) {
  flushSync(action)
  document.getElementById(id)?.focus()
}

/** Jev の欄の知らせ(role="status")。中断・捨てたあと・送るかに答えたあとに焦点を移す先 */
const JEV_STATUS_ID = 'jev-status'
/** 「Jev に問い合わせる」の下の、送り先の1文 */
const JEV_ASK_NOTE_ID = 'jev-ask-note'

const AMBER_TEXT = 'text-amber-900 dark:text-amber-300'

const MARK_CLASS: Record<Mark, string> = {
  agreed: 'border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-200',
  rule: 'border-border bg-muted text-muted-foreground',
  jev: 'border-sky-300 bg-sky-50 text-sky-900 dark:border-sky-700 dark:bg-sky-950/40 dark:text-sky-200',
  conflict: 'border-amber-400 bg-amber-50 text-amber-950 dark:border-amber-600 dark:bg-amber-950/40 dark:text-amber-200',
  undecided: 'border-destructive/50 bg-destructive/10 text-destructive',
  edited: 'border-border bg-muted text-foreground',
}

function MarkBadge({ mark }: { mark: Mark }) {
  return (
    <Badge variant="outline" data-mark={mark} className={`h-auto whitespace-normal ${MARK_CLASS[mark]}`}>
      {MARK_LABELS[mark]}
    </Badge>
  )
}

const PROBLEM_CLASS: Record<GroupProblem['severity'], string> = {
  error: 'border-destructive/50 bg-destructive/5 text-destructive',
  warning: 'border-amber-400 bg-amber-50 text-amber-950 dark:border-amber-600 dark:bg-amber-950/40 dark:text-amber-200',
  info: 'border-border bg-muted/40 text-foreground',
}
const PROBLEM_LABEL: Record<GroupProblem['severity'], string> = { error: '誤り', warning: '注意', info: '情報' }

function ProblemList({ problems }: { problems: readonly GroupProblem[] }) {
  if (problems.length === 0) return null
  return (
    <ul className="flex flex-col gap-1" aria-label="グループ分けの確かめ">
      {problems.map((p, i) => (
        <li key={`${p.code}-${i}`} data-code={p.code} className={`rounded-md border px-2 py-1 text-xs ${PROBLEM_CLASS[p.severity]}`}>
          <span className="mr-1 font-semibold">{PROBLEM_LABEL[p.severity]}:</span>
          {p.message}
        </li>
      ))}
    </ul>
  )
}

/**
 * 扱い・入れる先の列。読む専用(指摘19:直すのは減便の方針の手順の詳しい設定の手動の欄。docs/tasks-1105.md の U04)
 */
function RowValue({ row, kg }: { row: KindRow; kg: KindGroups }) {
  const text = rowValueText(row, kg)
  const mono = row.side === 'replacement' && row.into !== null
  return (
    <span className={`text-xs ${row.side === 'both' || row.side === 'unrelated' ? 'text-muted-foreground' : ''}`}>
      {mono ? (
        <>
          入れる先 <span className="font-mono">{row.into}</span>
        </>
      ) : (
        text
      )}
    </span>
  )
}

const COLUMNS = 2

function GroupRow({
  kind,
  row,
  kg,
  feature,
  nested,
  jevChoice,
}: {
  kind: PolicyKind
  row: KindRow
  kg: KindGroups
  feature: ServiceFeatures
  nested: boolean
  /** Jev が選んだ値(食い違いの行で、印の下に出す) */
  jevChoice: ReturnType<typeof jevChoiceOf>
}) {
  const [open, setOpen] = useState(false)
  const mark = markOf(row)
  const detailId = `sg-${kind}-${row.serviceId}`
  return (
    <>
      <TableRow data-service={row.serviceId}>
        <TableCell className={`align-top whitespace-normal ${nested ? 'pl-5' : ''}`}>
          <div className="font-mono break-all">
            {nested && <span aria-hidden="true">└ </span>}
            {row.serviceId}
          </div>
          <div className="text-xs text-muted-foreground">
            {SIDE_LABELS[row.side]}・{BASIS_LABELS[feature.basis]}
          </div>
          <div className="text-xs text-muted-foreground">
            {coverageParts(feature).map((p, i) => (
              <span key={i} className="whitespace-nowrap">
                {i > 0 && '・'}
                {p}
              </span>
            ))}
          </div>
          <div className="text-xs text-muted-foreground tabular-nums">{tripsText(feature)}</div>
          <Button
            type="button"
            variant="link"
            size="xs"
            className="h-auto px-0"
            aria-expanded={open}
            aria-controls={detailId}
            aria-label={`${row.serviceId} の判断材料`}
            onClick={() => setOpen((v) => !v)}
          >
            判断材料
          </Button>
        </TableCell>
        <TableCell className="align-top whitespace-normal">
          <div className="flex flex-col items-start gap-1">
            <RowValue row={row} kg={kg} />
            {mark && <MarkBadge mark={mark} />}
            {row.intoMark === 'conflict' && jevChoice.into !== undefined && (
              <span className="text-xs">
                Jev:<span className={jevChoice.into === null ? undefined : 'font-mono'}>{jevChoice.into ?? '使わない'}</span>
              </span>
            )}
            {row.basisMark === 'conflict' && jevChoice.basis !== undefined && (
              <span className="text-xs">
                Jev:{BASIS_LABELS[jevChoice.basis]}(規則:{BASIS_LABELS[feature.basis]})
              </span>
            )}
          </div>
        </TableCell>
      </TableRow>
      {open && (
        <TableRow id={detailId} className="bg-muted/30 hover:bg-muted/30">
          <TableCell colSpan={COLUMNS} className="whitespace-normal">
            <ul className="list-disc pl-5 text-xs">
              {row.reasons.map((r, i) => (
                <li key={i}>{r}</li>
              ))}
              {feature.runningDates && feature.runningDates.length > 0 && (
                <li>走る日:{feature.runningDates.map((d) => formatDateJa(d)).join('、')}</li>
              )}
              {feature.headsigns.length > 0 && <li>主な行き先:{feature.headsigns.join('、')}</li>}
            </ul>
          </TableCell>
        </TableRow>
      )}
    </>
  )
}

function KindTable({ groups, kind }: { groups: ServiceGroups; kind: PolicyKind }) {
  const [showOthers, setShowOthers] = useState(false)
  const kg = groups.byKind[kind]
  const byId = new Map(groups.features.services.map((s) => [s.serviceId, s]))
  const { sections, others } = orderRows(kg)
  const header = (
    <TableHeader>
      <TableRow>
        <TableHead className="whitespace-normal">service_id・走る日・便数</TableHead>
        <TableHead className="w-36 whitespace-normal">扱い・入れる先</TableHead>
      </TableRow>
    </TableHeader>
  )
  return (
    <div className="flex flex-col gap-2">
      <ProblemList problems={kg.problems} />
      <Table className="table-fixed" aria-label={`ダイヤのグループ分け(${KIND_LABELS[kind]})`}>
        {header}
        <TableBody>
          {sections.map((s) => (
            <Fragment key={s.key}>
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={COLUMNS} className="pt-3 text-xs font-semibold">
                  {s.title}
                </TableCell>
              </TableRow>
              {s.rows.map(({ row, nested }) => (
                <GroupRow
                  key={row.serviceId}
                  kind={kind}
                  row={row}
                  kg={kg}
                  feature={byId.get(row.serviceId)!}
                  nested={nested}
                  jevChoice={jevChoiceOf(groups, kind, row.serviceId)}
                />
              ))}
            </Fragment>
          ))}
        </TableBody>
      </Table>
      {others.length > 0 && (
        <div className="flex flex-col gap-1">
          <Button type="button" variant="ghost" size="xs" className="self-start" aria-expanded={showOthers} onClick={() => setShowOthers((v) => !v)}>
            両方に走る・関係しない・使わない service({others.length} 個)
          </Button>
          {showOthers && (
            <Table className="table-fixed" aria-label={`手を付けない service(${KIND_LABELS[kind]})`}>
              {header}
              <TableBody>
                {others.map((row) => (
                  <GroupRow
                    key={row.serviceId}
                    kind={kind}
                    row={row}
                    kg={kg}
                    feature={byId.get(row.serviceId)!}
                    nested={false}
                    jevChoice={jevChoiceOf(groups, kind, row.serviceId)}
                  />
                ))}
              </TableBody>
            </Table>
          )}
        </div>
      )}
    </div>
  )
}

function GroupTabs({ groups }: { groups: ServiceGroups }) {
  return (
    <Tabs defaultValue={POLICY_KINDS[0]}>
      <TabsList>
        {POLICY_KINDS.map((kind) => {
          const n = attentionCount(groups, kind)
          return (
            <TabsTrigger key={kind} value={kind} aria-label={n > 0 ? `${KIND_LABELS[kind]}(確かめが要るもの ${n} 件)` : KIND_LABELS[kind]}>
              {TAB_LABELS[kind]}
              {n > 0 && (
                <Badge variant="outline" className={MARK_CLASS.undecided} aria-label={`確かめが要るもの ${n} 件`}>
                  {n}
                </Badge>
              )}
            </TabsTrigger>
          )
        })}
      </TabsList>
      {POLICY_KINDS.map((kind) => (
        <TabsContent key={kind} value={kind}>
          <KindTable groups={groups} kind={kind} />
        </TabsContent>
      ))}
    </Tabs>
  )
}

/** 1つの target の、サーバーが Jev に送った本文。開いたときだけ描く */
function SentItem({ label, sent }: { label: string; sent: unknown }) {
  const [open, setOpen] = useState(false)
  return (
    <li className="flex flex-col gap-1">
      <Button type="button" variant="ghost" size="xs" className="self-start font-normal" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        {label}
      </Button>
      {open && (
        <pre className="max-h-64 overflow-auto rounded-md border bg-muted/40 p-2 text-[11px] leading-snug whitespace-pre-wrap break-all">
          {JSON.stringify(sent, null, 2)}
        </pre>
      )}
    </li>
  )
}

/** 「送った情報を見る」:results[].sent と failures[].sent(送った後に失敗したもの) */
function SentInfo({ response }: { response: JevJudgeResponse }) {
  const [open, setOpen] = useState(false)
  // service_id の順、同じ service は平日 → 土曜 → 日祝の順に並べる
  const roleOrder = { weekday: 0, saturday: 1, sundayHoliday: 2 } as const
  const items = [
    ...response.results.map((r) => ({ id: r.serviceId, role: r.role, key: `r-${r.serviceId}-${r.role}`, label: `${r.serviceId}(${ROLE_LABELS[r.role]})`, sent: r.sent })),
    ...response.failures
      .filter((f) => f.sent)
      .map((f) => ({ id: f.serviceId, role: f.role, key: `f-${f.serviceId}-${f.role}`, label: `${f.serviceId}(${ROLE_LABELS[f.role]}。答えなし)`, sent: f.sent })),
  ].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : roleOrder[a.role] - roleOrder[b.role]))
  if (items.length === 0) return null
  return (
    <div className="flex flex-col gap-1">
      <Button type="button" variant="outline" size="xs" className="self-start" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        送った情報を見る({items.length} 件)
      </Button>
      {open && (
        <div className="flex flex-col gap-1">
          <p className="text-xs text-muted-foreground">サーバーが Jev に実際に送った本文(State と質問)です。</p>
          <ul aria-label="Jev に送った情報" className="flex flex-col gap-1">
            {items.map((it) => (
              <SentItem key={it.key} label={it.label} sent={it.sent} />
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

/** 答えた提供元ごとの service_id(TypeSafe AI 以外だけ) */
function otherProviders(response: JevJudgeResponse | null): { name: string; ids: string[] }[] {
  const byProvider = new Map<string, Set<string>>()
  for (const r of response?.results ?? []) {
    if (r.provider === null || r.provider === 'typesafe-ai') continue
    byProvider.set(r.provider, (byProvider.get(r.provider) ?? new Set()).add(r.serviceId))
  }
  return [...byProvider].map(([p, ids]) => ({ name: PROVIDER_NAMES[p] ?? p, ids: [...ids].sort() }))
}

function idsText(ids: readonly string[]): string {
  return ids.length <= 5 ? ids.join('、') : `${ids.slice(0, 5).join('、')} ほか ${ids.length - 5}`
}

/** Jev の欄(§3.6)。単純な GTFS では出さない */
function JevPanel({ jev }: { jev: JevInfo }) {
  const stopJev = useServiceGroupsStore((s) => s.stopJev)
  const dropJev = useServiceGroupsStore((s) => s.dropJev)
  const askJev = useServiceGroupsStore((s) => s.askJev)
  const busy = jev.state === 'checking' || jev.state === 'sending'
  const answered = jev.state === 'done' || jev.state === 'partial'
  // 送らないと答えた・中断した・失敗した(回数の上限など)あとは、もう一度頼める
  const canAsk = jev.state === 'off' || jev.state === 'stopped' || jev.state === 'failed'
  const providers = otherProviders(jev.response)
  return (
    <section aria-label="Jev による確かめ" className="flex flex-col gap-1.5 rounded-md border px-3 py-2 text-xs">
      {/* 自動で送ったこと・その結果を、読み上げでも知らせる */}
      <div id={JEV_STATUS_ID} role="status" tabIndex={-1} className="flex flex-col gap-1.5 outline-none">
        {jev.state === 'awaitingConsent' && <p>Jev に送るかの答えを待っています。</p>}
        {busy && (
          <p className="flex flex-wrap items-center gap-2">
            <Spinner aria-hidden="true" role={undefined} aria-label={undefined} />
            <span>service ごとの集計を {JEV_DESTINATION}に送り、分け方を確かめています。</span>
          </p>
        )}
        {(answered || jev.state === 'dropped') && <p>{JEV_SENT_TEXT}</p>}
        {jev.message && <p>{jev.message}</p>}
        {(answered || jev.state === 'dropped') && jev.omitted.length > 0 && (
          <p>上限のため、{jev.omitted.length} 個の service は Jev に問い合わせていません(規則で分けています)。</p>
        )}
        {providers.map((p) => (
          <p key={p.name}>
            {idsText(p.ids)} は、{p.name} が答えました(TypeSafe AI ではありません)。
          </p>
        ))}
      </div>
      {(busy || answered || canAsk) && (
        <div className="flex flex-wrap gap-2">
          {busy && (
            <Button type="button" size="xs" variant="outline" onClick={() => focusAfter(stopJev, JEV_STATUS_ID)}>
              Jev への問い合わせをやめる
            </Button>
          )}
          {answered && (
            <Button type="button" size="xs" variant="outline" onClick={() => focusAfter(dropJev, JEV_STATUS_ID)}>
              Jev の判断を使わない
            </Button>
          )}
          {canAsk && (
            <Button type="button" size="xs" variant="outline" aria-describedby={JEV_ASK_NOTE_ID} onClick={() => void askJev()}>
              Jev に問い合わせる
            </Button>
          )}
        </div>
      )}
      {canAsk && (
        <p id={JEV_ASK_NOTE_ID} className="text-muted-foreground">
          押すと、service ごとの集計を {JEV_DESTINATION}に送ります。
        </p>
      )}
      {jev.response && <SentInfo response={jev.response} />}
    </section>
  )
}

/** 祝日一覧の注意(読めない・有効期間の一部が祝日一覧の外) */
function HolidayNote({ groups }: { groups: ServiceGroups }) {
  const holidays = useHolidayStore((s) => s.holidays)
  if (groups.features.holidays === 'missing') {
    return <p className={`text-xs ${AMBER_TEXT}`}>祝日一覧を読めないため、祝日を平日として数えています。</p>
  }
  const { start, end } = groups.features.validity
  if (holidays.status !== 'ready' || start === '' || end === '') return null
  const ranges = uncoveredRanges(holidays.list, start, end)
  if (ranges.length === 0) return null
  const text = ranges.map((r) => `${formatDateJa(r.start)}〜${formatDateJa(r.end)}`).join('、')
  return <p className={`text-xs ${AMBER_TEXT}`}>{text}は祝日一覧にないため、その間の祝日を平日として数えています。</p>
}

/**
 * 読み込みの手順の「ダイヤのグループ分け」(docs/design-service-groups.md §5.1・§3.6)。分けた結果を読む専用で見せる。
 * 単純な GTFS(道北バスなど)は1行の要約と「表を開く」、単純でない GTFS は要約・Jev の欄・方針の種類ごとの表。
 * 扱い・入れる先の直しと確定のボタンは置かない(指摘19。docs/tasks-1105.md の U04)。直すのは減便の方針の手順の詳しい設定
 * (「手動で選ぶ」)で、最後の確かめは減便の方針の「対象便を確かめる」
 */
export default function ServiceGroupsCard() {
  const status = useServiceGroupsStore((s) => s.status)
  const groups = useServiceGroupsStore((s) => s.groups)
  const jev = useServiceGroupsStore((s) => s.jev)
  const approved = useEditStore((s) => s.history.some((r) => r.op.type === 'applyPolicy'))
  // 承認待ちの減便の方針の下書き。グループ分けが変わっても、その下書きの組は変わらない
  const policyDraftId = useEditStore((s) => (s.draft?.kind === 'op' && s.draft.record.op.type === 'applyPolicy' ? s.draft.id : null))
  // 単純な GTFS は閉じておき、単純でない GTFS は開いておく(利用者が開け閉めしたらそれに従う)
  const [open, setOpen] = useState<boolean | null>(null)

  if (status === 'idle') return null
  if (status === 'waitingHolidays' || !groups) {
    return (
      <section aria-label="ダイヤのグループ分け" className="flex flex-col gap-1">
        <h3 className="text-sm font-medium">ダイヤのグループ分け</h3>
        <p className="text-xs text-muted-foreground">祝日一覧を読み込んでから、ダイヤのグループ分けを計算します。</p>
      </section>
    )
  }

  const tableOpen = open ?? !groups.simple
  const staleNote = approved ? (
    <p className={`text-xs ${AMBER_TEXT}`}>グループ分けが変わっても、減便の方針を承認し直すまで、出力には反映されません。</p>
  ) : policyDraftId !== null ? (
    <p className={`text-xs ${AMBER_TEXT}`}>
      グループ分けが変わっても、承認待ちの{draftName(policyDraftId)} には反映されません。減便の方針の手順で、下書きを作り直してください。
    </p>
  ) : null
  const toggle = (
    <Button type="button" variant="ghost" size="xs" className="self-start" aria-expanded={tableOpen} onClick={() => setOpen(!tableOpen)}>
      <ChevronDownIcon className={tableOpen ? 'rotate-180' : undefined} aria-hidden="true" />
      {tableOpen ? '表を閉じる' : '表を開く'}
    </Button>
  )

  if (groups.simple) {
    return (
      <section aria-label="ダイヤのグループ分け" className="flex flex-col gap-1.5">
        <h3 className="text-sm font-medium">ダイヤのグループ分け</h3>
        <p className="text-sm" data-testid="service-groups-summary" role="status">
          {simpleSummary(groups)}
        </p>
        <HolidayNote groups={groups} />
        {toggle}
        {tableOpen && (
          <>
            {staleNote}
            <GroupTabs groups={groups} />
          </>
        )}
      </section>
    )
  }

  const attention = attentionCount(groups)
  const conflicts = conflictCount(groups)
  const undecided = undecidedCount(groups)
  return (
    <section aria-label="ダイヤのグループ分け" className="flex flex-col gap-2">
      <h3 className="text-sm font-medium">ダイヤのグループ分け</h3>
      <p className="text-sm" data-testid="service-groups-summary" role="status">
        {complexSummary(groups, attention)}
      </p>
      <HolidayNote groups={groups} />
      <JevConsentDialog focusId={JEV_STATUS_ID} />
      {jev.state !== 'idle' && jev.state !== 'notNeeded' ? (
        <JevPanel jev={jev} />
      ) : (
        jev.message && <p className="text-xs text-muted-foreground">{jev.message}</p>
      )}
      <div className="flex flex-col gap-0.5 text-xs text-muted-foreground" data-testid="service-groups-next">
        {undecided > 0 && <p className="text-destructive">入れる平日の service が決まらないものが {undecided} 件あります。</p>}
        {conflicts > 0 && <p>規則と Jev が食い違っている {conflicts} 件は、規則の値で入れ替えます。</p>}
        <p>{GROUPS_FIX_NOTE}</p>
      </div>
      {toggle}
      {tableOpen && (
        <>
          {staleNote}
          <GroupTabs groups={groups} />
        </>
      )}
    </section>
  )
}
