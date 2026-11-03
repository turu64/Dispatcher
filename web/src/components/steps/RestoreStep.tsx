import { useMemo, useState, type ReactNode } from 'react'
import StepSection from '@/components/StepSection'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { createTripBriefer, restoreTotals, type TripBrief } from '@/gtfs/edit/diff'
import type { Form2Result } from '@/gtfs/edit/form2'
import { addBackReasons, planOf, type EditOp, type Form2Plan } from '@/gtfs/edit/ops'
import {
  compareByHints,
  createRestoreHinter,
  RESTORE_HINT_LABELS,
  type RestoreHint,
  type RestoreHintContext,
  type RestoreHintDetail,
} from '@/gtfs/edit/restore'
import { activeServiceIds } from '@/gtfs/calendar'
import { formatDateJa } from '@/lib/dates'
import { diffOf, lastVersion, useEditStore, type BaseGtfs, type Draft } from '@/store/edit'
import { useReachStore } from '@/store/reach'
import { buildRestoreHintContext } from '@/store/restoreHintContext'
import { draftActor, proposeAndCommit, replaceClaudeDraftMessage } from './editActions'
import { AskRestoreButton } from '@/components/chat/AskRestoreButton'
import { InlineConfirm, NoteList } from './editParts'
import {
  ACTOR_LABELS,
  addBackRejections,
  lostCellsText,
  RESTORE_DUTY_NOTE,
  restoreTotalsText,
  SCHOOL_HOLIDAY_NOTE,
  shortDateTime,
} from './editText'
import { STEP_IDS } from './stepIds'

/** 到達圏を使う2つの手がかりの説明(date は比較の日付 'YYYYMMDD') */
function reachHintNote(date: string): string {
  return `「停留所で唯一の便」と「外れたセルが戻る」は、${formatDateJa(date)}の到達圏の前後の比較から出しています。「外れたセルが戻る」の数は、この便だけを足し戻したときの値です(ほかの便の足し戻しとの重なりは考えていません)。`
}

/** 到達圏を使う2つの手がかりを出していない理由 */
const REACH_HINTS_ABSENT = {
  error: '到達圏の計算に失敗したので、「停留所で唯一の便」と「外れたセルが戻る」は出していません。',
  draft: '下書きを確かめている間は、「停留所で唯一の便」と「外れたセルが戻る」を出しません(地図と到達圏は下書きの結果のため)。承認するか、やめると出します。',
  computing: '到達圏を計算しているので、「停留所で唯一の便」と「外れたセルが戻る」は、計算が終わってから出します。',
  none: '到達圏の前後の比較ができると、「停留所で唯一の便」と「外れたセルが戻る」も出します。',
  notRunning: (date: string) =>
    `到達圏を比べる日(${formatDateJa(date)})は平日ダイヤの運行日ではないので、「停留所で唯一の便」と「外れたセルが戻る」は出していません。比べる日を平日にすると出します。`,
} as const

/**
 * 到達圏を使う2つの手がかりについて、手がかりの近くに出す注記。ctx があれば比較の日付つきの説明か、
 * 比較の日付に平日の便が走らない旨。ctx が無ければ出していない理由(docs/interfaces-1105.md §7 のとおり、比較が無ければ2つは出さない)
 */
function reachHintStatus(o: {
  ctx: RestoreHintContext | null
  weekdayRuns: boolean
  error: string | null
  draft: boolean
  computing: boolean
}): { kind: 'note' | 'absent'; text: string } {
  if (o.ctx) return o.weekdayRuns ? { kind: 'note', text: reachHintNote(o.ctx.date) } : { kind: 'absent', text: REACH_HINTS_ABSENT.notRunning(o.ctx.date) }
  if (o.error !== null) return { kind: 'absent', text: REACH_HINTS_ABSENT.error }
  if (o.draft) return { kind: 'absent', text: REACH_HINTS_ABSENT.draft }
  if (o.computing) return { kind: 'absent', text: REACH_HINTS_ABSENT.computing }
  return { kind: 'absent', text: REACH_HINTS_ABSENT.none }
}

/** 一度に並べる候補の数(「さらに表示」で増やす) */
const PAGE = 50

/**
 * 手順5:足し戻し(docs/interfaces-1104.md §8)。
 * 候補は、基準の平日便のうち、承認済みの編集後に同じ署名の便が無いもの(消える便)。手がかり(コードが出す)の多い順に並べ、
 * 系統・始発の時間帯・停留所名・手がかりで絞り込む。「足し戻す」「取り消す」は押したことを承認とみなす。
 */
export default function RestoreStep() {
  const base = useEditStore((s) => s.base)
  const history = useEditStore((s) => s.history)
  const versions = useEditStore((s) => s.versions)
  const draft = useEditStore((s) => s.draft)
  const plan = useMemo(() => planOf(history), [history])
  const version = lastVersion({ versions })

  return (
    <StepSection title="5. 足し戻し" id={STEP_IDS.restore}>
      {!base ? (
        <p className="text-sm text-muted-foreground">手順1で GTFS を読み込み、手順2で方針を承認すると、足し戻す便を選べます。</p>
      ) : !plan || !version ? (
        <p className="text-sm text-muted-foreground">手順2で減便の方針を承認すると、消える平日便から足し戻す便を選べます。</p>
      ) : (
        <RestorePanel base={base} plan={plan} version={version} draft={draft} />
      )}
    </StepSection>
  )
}

/** 始発の時間帯(diffWeekdayTrips の byStartBand と同じ区切り) */
function startBandOf(seconds: number | null): string {
  if (seconds === null) return '時刻なし'
  const h = seconds / 3600
  if (h < 6) return '6時より前'
  if (h >= 24) return '24時以降'
  const from = 6 + Math.floor((h - 6) / 3) * 3
  return `${from}〜${from + 3}時`
}

const START_BAND_ORDER = ['6時より前', '6〜9時', '9〜12時', '12〜15時', '15〜18時', '18〜21時', '21〜24時', '24時以降', '時刻なし']

interface Candidate {
  trip: TripBrief
  detail: RestoreHintDetail
}

function RestorePanel({ base, plan, version, draft }: { base: BaseGtfs; plan: Form2Plan; version: Form2Result; draft: Draft | null }) {
  const history = useEditStore((s) => s.history)
  const diff = useMemo(() => diffOf(base.feed, version), [base.feed, version])
  // 到達圏の前後の比較(基準と、承認済みの編集後の結果。同じ起点・同じセル・同じ時間帯)から、到達圏を使う2つの手がかり
  // (停留所で唯一の便・外れた場所が戻る)の ctx を作る。比較ができていなければ null で、2つは出さない
  // (承認前の下書きの結果を地図に出している間や、計算中も null。docs/interfaces-1105.md §7)
  const reachEdited = useReachStore((s) => s.edited)
  const reachOrigins = useReachStore((s) => s.origins)
  const reachComputing = useReachStore((s) => s.computing)
  const reachError = useReachStore((s) => s.error)
  const reachSnapshot = useReachStore((s) => s.snapshot)
  const ctx = useMemo(
    () =>
      buildRestoreHintContext(
        { edited: reachEdited, origins: reachOrigins, computing: reachComputing, error: reachError, snapshot: reachSnapshot },
        version.feed,
      ),
    [reachEdited, reachOrigins, reachComputing, reachError, reachSnapshot, version.feed],
  )
  const candidates = useMemo<Candidate[]>(() => {
    const hinter = createRestoreHinter(base.feed, version.feed, plan, [...diff.removed, ...diff.same], [...diff.same, ...diff.added])
    return diff.removed.map((trip) => ({ trip, detail: hinter(trip, ctx ?? undefined) })).sort(compareByHints)
  }, [base.feed, version.feed, plan, diff, ctx])

  const [route, setRoute] = useState('')
  const [band, setBand] = useState('')
  const [stopName, setStopName] = useState('')
  const [hint, setHint] = useState<RestoreHint | ''>('')
  const [selected, setSelected] = useState<string[]>([])
  const [reason, setReason] = useState('')
  const [limit, setLimit] = useState(PAGE)
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)
  // Claude の下書きを捨ててよいかを確かめている操作(画面の中で確かめる。ブラウザ標準の確認ダイアログは使わない)
  const [pending, setPending] = useState<{ op: EditOp; done: string; draftId: string; from: 'add' | 'withdraw' } | null>(null)

  const routes = useMemo(() => {
    const m = new Map<string, string>()
    for (const c of candidates) m.set(c.trip.routeId, c.trip.routeName)
    return [...m].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
  }, [candidates])
  const bands = useMemo(() => {
    const present = new Set(candidates.map((c) => startBandOf(c.trip.firstSeconds)))
    return START_BAND_ORDER.filter((b) => present.has(b))
  }, [candidates])
  const hintsPresent = useMemo(() => {
    const present = new Set(candidates.flatMap((c) => c.detail.hints))
    return (Object.keys(RESTORE_HINT_LABELS) as RestoreHint[]).filter((h) => present.has(h))
  }, [candidates])
  // 選んだ手がかりが候補から消えたら(到達圏の計算中・下書きの間は到達圏を使う2つが消える)、絞り込みは「すべて」に戻す
  const activeHint: RestoreHint | '' = hint !== '' && hintsPresent.includes(hint) ? hint : ''
  const weekdayRuns = useMemo(
    () => (ctx ? activeServiceIds(base.feed, ctx.date).has(plan.weekdayService.trim()) : false),
    [ctx, base.feed, plan.weekdayService],
  )
  const reachStatus = reachHintStatus({
    ctx,
    weekdayRuns,
    error: reachError,
    draft: draft !== null && reachEdited?.feed !== version.feed,
    computing: reachComputing,
  })

  const query = stopName.trim()
  const filtered = candidates.filter(
    (c) =>
      (route === '' || c.trip.routeId === route) &&
      (band === '' || startBandOf(c.trip.firstSeconds) === band) &&
      (query === '' || c.trip.stopNames.some((n) => n.includes(query))) &&
      (activeHint === '' || c.detail.hints.includes(activeHint)),
  )
  const shown = filtered.slice(0, limit)
  const candidateIds = new Set(candidates.map((c) => c.trip.tripId))
  const selectedNow = selected.filter((id) => candidateIds.has(id))

  // 利用者が方針の下書きを確かめている間は、足し戻さない(下書きを黙って置き換えないため)
  const policyDraft = draft?.kind === 'op' && draft.record.op.type === 'applyPolicy' && draftActor(draft) === 'user'
  const claudeDraft = draft && draftActor(draft) === 'claude' && draft.kind === 'op' && draft.record.op.type !== 'applyPolicy' ? draft : null

  function run(op: EditOp, done: string, from: 'add' | 'withdraw', replaceClaudeDraft = false): boolean {
    setMessage(null)
    setPending(null)
    const r = proposeAndCommit(op, { replaceClaudeDraft })
    if (r.status === 'needsConfirm') {
      setPending({ op, done, draftId: r.draft.id, from })
      return false
    }
    if (r.status === 'failed') setMessage({ ok: false, text: r.message })
    else setMessage({ ok: true, text: done })
    return true
  }

  // 確かめている間に Claude の下書きが無くなった(承認・やめるなど)ら、確かめは引き継がない
  // (足し戻し以外の Claude の下書き、方針の提案や元に戻す提案も、足し戻しで捨てることになる)
  const confirming = pending && draft && draftActor(draft) === 'claude' && draft.id === pending.draftId ? pending : null
  const confirmBox = (from: 'add' | 'withdraw') =>
    confirming && confirming.from === from ? (
      <InlineConfirm
        label="Claude の下書きを捨てる確認"
        message={replaceClaudeDraftMessage({ id: confirming.draftId })}
        confirmLabel="捨てて続ける"
        onConfirm={() => {
          if (run(confirming.op, confirming.done, from, true) && from === 'add') setSelected([])
        }}
        onCancel={() => setPending(null)}
      />
    ) : null

  function addBack() {
    if (selectedNow.length === 0) return
    const done = run(
      { type: 'addBack', items: selectedNow.map((tripId) => ({ tripId, reason: reason.trim(), schoolDaysOnly: false })) },
      `${selectedNow.length} 便を足し戻しました。`,
      'add',
    )
    // 確かめの途中(まだ足し戻していない)なら、選んだ便は残す
    if (done) setSelected([])
  }

  return (
    <div className="flex min-w-0 flex-col gap-3">
      {claudeDraft && <ClaudeDraftBanner draft={claudeDraft} />}
      <p className="text-sm">
        消える平日便 <span className="tabular-nums">{candidates.length}</span> 便から選びます(手がかりの多い順)。
      </p>
      <AskRestoreButton blocked={policyDraft ? '手順2の方針の下書きを承認するか、やめてから聞いてください。' : null} />
      <fieldset className="grid grid-cols-2 gap-2" aria-label="候補の絞り込み">
        <div className="flex min-w-0 flex-col gap-1">
          <Label htmlFor="restore-route" className="text-xs">
            系統
          </Label>
          <select id="restore-route" className="h-8 min-w-0 rounded-md border bg-background px-1 text-xs" value={route} onChange={(e) => setRoute(e.target.value)}>
            <option value="">すべて</option>
            {routes.map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
        </div>
        <div className="flex min-w-0 flex-col gap-1">
          <Label htmlFor="restore-band" className="text-xs">
            始発の時間帯
          </Label>
          <select id="restore-band" className="h-8 min-w-0 rounded-md border bg-background px-1 text-xs" value={band} onChange={(e) => setBand(e.target.value)}>
            <option value="">すべて</option>
            {bands.map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </select>
        </div>
        <div className="flex min-w-0 flex-col gap-1">
          <Label htmlFor="restore-stop" className="text-xs">
            停留所名(一部)
          </Label>
          <Input id="restore-stop" className="h-8 text-xs" value={stopName} onChange={(e) => setStopName(e.target.value)} />
        </div>
        <div className="flex min-w-0 flex-col gap-1">
          <Label htmlFor="restore-hint" className="text-xs">
            手がかり
          </Label>
          <select
            id="restore-hint"
            className="h-8 min-w-0 rounded-md border bg-background px-1 text-xs"
            value={activeHint}
            onChange={(e) => setHint(e.target.value as RestoreHint | '')}
          >
            <option value="">すべて</option>
            {hintsPresent.map((h) => (
              <option key={h} value={h}>
                {RESTORE_HINT_LABELS[h]}
              </option>
            ))}
          </select>
        </div>
      </fieldset>

      <ul className="flex flex-col divide-y rounded-md border text-xs" aria-label="足し戻す便の候補">
        {shown.length === 0 && <li className="px-2 py-1.5 text-muted-foreground">当てはまる便がありません。</li>}
        {shown.map((c) => {
          const checked = selected.includes(c.trip.tripId)
          return (
            <li key={c.trip.tripId} className="px-2 py-1">
              <label className="flex items-start gap-2">
                <input
                  type="checkbox"
                  className="mt-0.5 size-4 shrink-0 accent-primary"
                  checked={checked}
                  onChange={(e) =>
                    setSelected((s) => (e.target.checked ? [...s, c.trip.tripId] : s.filter((id) => id !== c.trip.tripId)))
                  }
                  aria-label={`${c.trip.firstDeparture ?? '時刻なし'} ${c.trip.routeName} ${c.trip.tripId} を選ぶ`}
                />
                <TripLine trip={c.trip} hints={c.detail.hints} lostCells={c.detail.lostCells} />
              </label>
            </li>
          )
        })}
      </ul>
      {(reachStatus.kind === 'absent' || hintsPresent.includes('onlyServiceAtStop') || hintsPresent.includes('restoresLostCells')) &&
        candidates.length > 0 && <p className="text-xs text-muted-foreground">{reachStatus.text}</p>}
      {filtered.length > shown.length && (
        <Button type="button" variant="outline" size="sm" className="self-start" onClick={() => setLimit((n) => n + PAGE)}>
          さらに表示(残り {filtered.length - shown.length} 便)
        </Button>
      )}

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="restore-reason" className="text-xs">
          足し戻す理由(選んだ便すべてに入れる。任意)
        </Label>
        <Input id="restore-reason" placeholder="例:高校の通学" value={reason} onChange={(e) => setReason(e.target.value)} />
      </div>
      {policyDraft && <p className="text-sm text-destructive">手順2の方針の下書きを承認するか、やめてから足し戻してください。</p>}
      {confirmBox('add') ?? (
        <Button type="button" className="self-start" disabled={selectedNow.length === 0 || policyDraft} onClick={addBack}>
          選んだ {selectedNow.length} 便を足し戻す
        </Button>
      )}
      {message && (
        <Alert variant={message.ok ? 'default' : 'destructive'} role={message.ok ? 'status' : 'alert'}>
          <AlertDescription>{message.text}</AlertDescription>
        </Alert>
      )}

      <AddedBackList
        base={base}
        version={version}
        reasons={addBackReasons(history)}
        disabled={policyDraft}
        confirm={confirmBox('withdraw')}
        onWithdraw={(tripId) => run({ type: 'withdrawAddBack', tripIds: [tripId] }, '足し戻しを取り消しました。', 'withdraw')}
      />
      <NoteList items={[SCHOOL_HOLIDAY_NOTE, RESTORE_DUTY_NOTE]} label="足し戻しの注意" />
    </div>
  )
}

/** 便の1行(始発時刻、系統、始発 → 終着、行き先、trip_id、手がかり) */
function TripLine({
  trip,
  hints,
  lostCells,
}: {
  trip: TripBrief
  hints?: readonly RestoreHint[]
  /** 外れた場所が戻る手がかりの、戻るセルの数と推計人口 */
  lostCells?: RestoreHintDetail['lostCells']
}) {
  return (
    <span className="flex min-w-0 flex-col gap-0.5">
      <span className="break-words">
        <span className="font-medium tabular-nums">{trip.firstDeparture ?? '—'}</span> {trip.routeName}:{trip.firstStopName} →{' '}
        {trip.lastStopName}
        {trip.headsign && `(${trip.headsign})`}
      </span>
      <span className="font-mono text-[10px] text-muted-foreground">
        {trip.tripId}
        {trip.feed === 'base' ? '(基準)' : '(編集後)'}
      </span>
      {hints && hints.length > 0 && (
        <span className="flex flex-wrap gap-1">
          {hints.map((h) => (
            <Badge key={h} variant="secondary" className="px-1 py-0 text-[10px]">
              {h === 'restoresLostCells' && lostCells ? lostCellsText(lostCells) : RESTORE_HINT_LABELS[h]}
            </Badge>
          ))}
        </span>
      )}
    </span>
  )
}

/** 足し戻した便の一覧、受け付けなかった便と理由、集計 */
function AddedBackList({
  base,
  version,
  reasons,
  disabled,
  confirm,
  onWithdraw,
}: {
  base: BaseGtfs
  version: Form2Result
  reasons: ReturnType<typeof addBackReasons>
  disabled: boolean
  /** Claude の下書きを捨ててよいかの確かめ(取り消すボタンを押したとき) */
  confirm: ReactNode
  onWithdraw: (tripId: string) => void
}) {
  const report = version.report.addBack
  const briefs = useMemo(() => {
    const brief = createTripBriefer(base.feed, 'base')
    const map = new Map<string, TripBrief>()
    for (const row of base.feed.tables.get('trips')?.rows ?? []) {
      const id = row.trip_id?.trim() ?? ''
      if (!map.has(id)) map.set(id, brief(row))
    }
    return map
  }, [base.feed])
  const totals = useMemo(() => restoreTotals(base.feed, report.accepted), [base.feed, report.accepted])
  const rejected = addBackRejections(report, version.plan.kind)
  if (version.plan.addBackTripIds.length === 0) return null

  return (
    <section className="flex flex-col gap-2 border-t pt-2" aria-label="足し戻した便">
      <h3 className="text-sm font-medium">足し戻した便({report.accepted.length} 便)</h3>
      {confirm}
      <p className="text-xs">{restoreTotalsText(totals)}</p>
      <ul className="flex flex-col divide-y rounded-md border text-xs">
        {report.accepted.map((id) => {
          const trip = briefs.get(id)
          const r = reasons.get(id)
          return (
            <li key={id} className="flex items-start justify-between gap-2 px-2 py-1">
              <span className="flex min-w-0 flex-col gap-0.5">
                {trip ? <TripLine trip={trip} /> : <span className="font-mono">{id}</span>}
                {r && (
                  <span className="text-muted-foreground">
                    理由:{r.reason === '' ? '(なし)' : r.reason}({ACTOR_LABELS[r.by]}、{shortDateTime(r.at)})
                  </span>
                )}
              </span>
              <Button type="button" variant="outline" size="sm" disabled={disabled} onClick={() => onWithdraw(id)} aria-label={`${id} の足し戻しを取り消す`}>
                取り消す
              </Button>
            </li>
          )
        })}
      </ul>
      {rejected.length > 0 && (
        <div className="flex flex-col gap-1">
          <h4 className="text-xs font-medium">受け付けなかった便({rejected.length} 便)</h4>
          <ul className="flex flex-col divide-y rounded-md border border-amber-400 bg-amber-50 text-xs text-amber-950">
            {rejected.map(({ tripId, reason }, i) => (
              <li key={`${tripId}-${i}`} className="flex items-start justify-between gap-2 px-2 py-1">
                <span className="min-w-0 break-words">
                  <span className="font-mono">{tripId}</span>:{reason}
                </span>
                <Button type="button" variant="outline" size="sm" disabled={disabled} onClick={() => onWithdraw(tripId)} aria-label={`${tripId} を一覧から除く`}>
                  除く
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  )
}

/** Claude が出した足し戻し・取り消しの下書き。承認するまで履歴も地図も変わらない */
function ClaudeDraftBanner({ draft }: { draft: Extract<Draft, { kind: 'op' }> }) {
  const [message, setMessage] = useState<string | null>(null)
  const op = draft.record.op
  const what = op.type === 'addBack' ? `便を ${op.items.length} 本足し戻す` : op.type === 'withdrawAddBack' ? `足し戻しを ${op.tripIds.length} 便取り消す` : ''
  return (
    <div className="flex flex-col gap-1.5 rounded-md border border-dashed px-2 py-1.5 text-xs">
      <p>
        下書き {draft.id}(Claude の提案):{what}。地図と表は、この下書きの結果を「下書き」として出しています。
      </p>
      {!draft.outcome.ok && <p className="text-destructive">{draft.outcome.message}</p>}
      {message && <p className="text-destructive">{message}</p>}
      <div className="flex gap-2">
        <Button
          type="button"
          size="sm"
          onClick={() => {
            const r = useEditStore.getState().commit()
            setMessage(r.ok ? null : r.message)
          }}
        >
          承認する
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={() => useEditStore.getState().discard()}>
          やめる
        </Button>
      </div>
    </div>
  )
}
