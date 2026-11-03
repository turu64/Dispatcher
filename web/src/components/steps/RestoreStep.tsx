import { useMemo, useState, type ReactNode } from 'react'
import StepSection from '@/components/StepSection'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { createTripBriefer, restoreTotals, type TripBrief } from '@/gtfs/edit/diff'
import type { Form2Result } from '@/gtfs/edit/form2'
import { addBackReasons, planOf, type EditOp, type Form2Plan } from '@/gtfs/edit/ops'
import {
  createRestoreHinter,
  nearFacilityText,
  RESTORE_HINT_LABELS,
  type NearFacility,
  type RestoreHint,
  type RestoreHintContext,
} from '@/gtfs/edit/restore'
import { overlapLongBreaks } from '@/gtfs/edit/facilityHours'
import { createRouteDirectionTimeline } from '@/gtfs/edit/stopDiff'
import { activeServiceIds } from '@/gtfs/calendar'
import { formatDateJa } from '@/lib/dates'
import { diffOf, lastVersion, useEditStore, type BaseGtfs, type Draft } from '@/store/edit'
import { usePriorityStore } from '@/store/priority'
import { useReachStore } from '@/store/reach'
import { useResearchStore, type FacilityState } from '@/store/research'
import { buildRestoreHintContext } from '@/store/restoreHintContext'
import { draftActor, proposeAndCommit, replaceClaudeDraftMessage } from './editActions'
import { AskRestoreButton } from '@/components/chat/AskRestoreButton'
import { InlineConfirm, NoteList } from './editParts'
import {
  ACTOR_LABELS,
  addBackRejections,
  RESTORE_DUTY_NOTE,
  restoreTotalsText,
  SCHOOL_HOLIDAY_NOTE,
  shortDateTime,
} from './editText'
import { STEP_IDS } from './stepIds'
import { CandidateGroups } from './restore/CandidateGroups'
import { compareByTime, compareCandidates, groupCandidates, tripEndpoints, type Candidate } from './restore/grouping'
import { AiPicks, FacilityEvidence, SelectedTrips } from './restore/PickLists'
import { TripLine } from './restore/TripLine'

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

/** 学校・病院の手がかりの説明(施設を読めていて、到達圏の比較があるとき) */
const FACILITY_HINT_NOTE =
  '「学校・病院の近く」は、停留所から徒歩圏(到達圏の徒歩の分数と同じ距離)にある中学校・高校・大学など・入院設備のある病院(国土数値情報)に、学校は 7〜9時着・14〜18時発、病院は 8〜11時着・11〜16時発で当たる便です。'

/** 学校・病院の手がかりの状態の文。出していれば説明、出していなければ理由 */
function facilityHintStatus(ctx: RestoreHintContext | null, facilities: FacilityState): string {
  if (!ctx) return '「学校・病院の近く」も、到達圏の前後の比較ができてから出します(徒歩圏の距離に到達圏の条件を使うため)。'
  if (ctx.facilities) return FACILITY_HINT_NOTE
  if (facilities.status === 'loading') return '前提情報の学校・病院を読み込んでいます。読み込むと「学校・病院の近く」も出します。'
  if (facilities.status === 'error')
    return '前提情報の学校・病院の参照データを読み込めなかったので、「学校・病院の近く」は出していません。手順「前提情報」で読み込み直せます。'
  return '手順「前提情報」で学校・病院を読み込むと、「学校・病院の近く」も出します。'
}

/** 時間帯の窓に当たる施設(優先順位の順) */
function matchedFacilities(facilities: readonly NearFacility[] | undefined): NearFacility[] {
  return (facilities ?? []).filter((n) => n.matches.length > 0)
}

/** 候補のうち、学校・病院の窓に当たる便の数を施設ごとに数える(優先順位、便の多い順、名前の順。上位 max 件) */
function facilityTally(candidates: readonly Candidate[], max: number): { list: { name: string; label: string; trips: number }[]; more: number } {
  const byId = new Map<string, { name: string; label: string; rank: number; trips: number }>()
  for (const c of candidates) {
    for (const n of matchedFacilities(c.detail.facilities)) {
      const f = n.facility
      const e = byId.get(f.targetId)
      if (e) e.trips++
      else byId.set(f.targetId, { name: f.name, label: f.categoryLabel, rank: f.rank, trips: 1 })
    }
  }
  const sorted = [...byId.values()].sort((a, b) => a.rank - b.rank || b.trips - a.trips || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  return { list: sorted.slice(0, max), more: Math.max(0, sorted.length - max) }
}

/** 一覧の下に出す、学校・病院の窓に当たる便の数の施設の上限 */
const MAX_FACILITY_TALLY = 8

/**
 * 足し戻しの手順(docs/interfaces-1104.md §8)。手順の番号は components/steps/registry.ts の並びで決まるので、文言に番号を書かない。
 * 候補は、基準の平日便のうち、承認済みの編集後に同じ署名の便が無いもの(消える便)。系統・始発の時間帯・停留所名・手がかりで絞り込む。
 * 一覧は系統ごとに折りたたみ(全曜日で便がなくなる系統が先頭)、開くと方向ごとに時刻の順に並べて編集後の最大間隔を添える。
 * 最初は手がかりのある便だけを出し、残りは「ほかの便を見る」で開く(docs/tasks-1103.md の指摘5。並べ方は restore/grouping.ts)。
 * 「AI に候補を聞く」の結果(Claude の足し戻しの下書き)の便は、一覧の先頭の「AI のおすすめ」にまとめる。
 * 足し戻す便ごとに「休校日運休(学)」の印を付けられる(addBack の schoolDaysOnly。GTFS には入れない)。
 * 「足し戻す」「取り消す」は押したことを承認とみなす。
 * 学校・病院の手がかり(nearFacility、T19)は、前提情報の施設と到達圏の条件から出し、施設ごとの便の数と、選んだ便の理由の文を出す。
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
        <p className="text-sm text-muted-foreground">GTFS を読み込み、減便の方針を承認すると、足し戻す便を選べます。</p>
      ) : !plan || !version ? (
        <p className="text-sm text-muted-foreground">減便の方針を承認すると、消える平日便から足し戻す便を選べます。</p>
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
  const reachRef = useReachStore((s) => s.ref)
  // 学校・病院の手がかり(T19)の材料。前提情報の施設・調査の結果・重要拠点の優先順位が変わったら作り直す
  const facilities = useResearchStore((s) => s.facilities)
  const researchResults = useResearchStore((s) => s.results)
  const priorityOrder = usePriorityStore((s) => s.order)
  const ctx = useMemo(
    () =>
      buildRestoreHintContext(
        { edited: reachEdited, origins: reachOrigins, computing: reachComputing, error: reachError, snapshot: reachSnapshot, ref: reachRef },
        version.feed,
        { facilities, results: researchResults, order: priorityOrder },
      ),
    [reachEdited, reachOrigins, reachComputing, reachError, reachSnapshot, reachRef, version.feed, facilities, researchResults, priorityOrder],
  )
  const candidates = useMemo<Candidate[]>(() => {
    const hinter = createRestoreHinter(base.feed, version.feed, plan, [...diff.removed, ...diff.same], [...diff.same, ...diff.added])
    return diff.removed.map((trip) => ({ trip, detail: hinter(trip, ctx ?? undefined) })).sort(compareCandidates)
  }, [base.feed, version.feed, plan, diff, ctx])
  // 方向は基準の便の始発・終着の stop_id で分ける(候補は基準の平日便なので、比べる日に走るとは限らず、編集後の並びからは取らない)
  const endpoints = useMemo(() => tripEndpoints(base.feed), [base.feed])
  const vanishing = useMemo(() => new Set(diff.byRoute.filter((r) => r.vanishes).map((r) => r.routeId)), [diff])
  // 編集後の最大間隔は、到達圏を比べる日の、承認済みの編集後のフィードで数える(比べる日が無いか不正なら出さない)
  const compareDate = useReachStore((s) => s.date)
  const editedTimeline = useMemo(() => {
    if (!compareDate) return null
    try {
      return createRouteDirectionTimeline(version.feed, compareDate)
    } catch {
      return null
    }
  }, [version.feed, compareDate])

  const [route, setRoute] = useState('')
  const [band, setBand] = useState('')
  const [stopName, setStopName] = useState('')
  const [hint, setHint] = useState<RestoreHint | ''>('')
  const [selected, setSelected] = useState<string[]>([])
  // 休校日運休(学)の印を付けた便(選んだ便のうち)
  const [school, setSchool] = useState<string[]>([])
  // 開いた系統と、「ほかの便を見る」を押した系統
  const [opened, setOpened] = useState<string[]>([])
  const [showAll, setShowAll] = useState<string[]>([])
  const [reason, setReason] = useState('')
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
  const facilityStatus = facilityHintStatus(ctx, facilities)
  const tally = useMemo(() => facilityTally(candidates, MAX_FACILITY_TALLY), [candidates])
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
  const groups = groupCandidates(filtered, endpoints, vanishing, editedTimeline)
  // 絞り込んでいる間は、当てはまる便のある系統を開いて出す
  const filtering = route !== '' || band !== '' || query !== '' || activeHint !== ''
  const candidateById = new Map(candidates.map((c) => [c.trip.tripId, c]))
  const selectedNow = selected.filter((id) => candidateById.has(id))
  const selectedSet = new Set(selectedNow)
  const schoolSet = new Set(school)
  // 学校の長期休業が減便の期間と重なる便の注意(休校日運休(学)の印は自動で付けない)。期間の終わりが「当面の間」なら出力の有効期間の末日まで
  const schoolNotes = schoolBreakNotes(
    selectedNow.map((id) => candidateById.get(id)!),
    { start: plan.period.start, end: plan.period.end ?? version.report.validity.end },
  )

  // 利用者が方針の下書きを確かめている間は、足し戻さない(下書きを黙って置き換えないため)
  const policyDraft = draft?.kind === 'op' && draft.record.op.type === 'applyPolicy' && draftActor(draft) === 'user'
  const claudeDraft = draft && draftActor(draft) === 'claude' && draft.kind === 'op' && draft.record.op.type !== 'applyPolicy' ? draft : null
  // AI のおすすめ:Claude の足し戻しの下書きにある便のうち、候補にあるもの(時刻の順)
  const aiOp = claudeDraft?.record.op.type === 'addBack' ? claudeDraft.record.op : null
  const aiItems = new Map((aiOp?.items ?? []).map((item) => [item.tripId.trim(), item]))
  const aiPicks = [...aiItems]
    .flatMap(([id, item]) => {
      const candidate = candidateById.get(id)
      return candidate ? [{ candidate, item }] : []
    })
    .sort((a, b) => compareByTime(a.candidate, b.candidate))

  function select(tripId: string, checked: boolean) {
    setSelected((s) => (checked ? (s.includes(tripId) ? s : [...s, tripId]) : s.filter((id) => id !== tripId)))
    // AI が休校日運休(学)とした便は、選んだときに印を付けておく(外せる)
    if (checked && aiItems.get(tripId)?.schoolDaysOnly) setSchool((s) => (s.includes(tripId) ? s : [...s, tripId]))
    if (!checked) setSchool((s) => s.filter((id) => id !== tripId))
  }

  function toggle(list: string[], id: string): string[] {
    return list.includes(id) ? list.filter((x) => x !== id) : [...list, id]
  }

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
          if (run(confirming.op, confirming.done, from, true) && from === 'add') clearSelection()
        }}
        onCancel={() => setPending(null)}
      />
    ) : null

  function clearSelection() {
    setSelected([])
    setSchool([])
  }

  function addBack() {
    if (selectedNow.length === 0) return
    const done = run(
      { type: 'addBack', items: selectedNow.map((tripId) => ({ tripId, reason: reason.trim(), schoolDaysOnly: schoolSet.has(tripId) })) },
      `${selectedNow.length} 便を足し戻しました。`,
      'add',
    )
    // 確かめの途中(まだ足し戻していない)なら、選んだ便は残す
    if (done) clearSelection()
  }

  return (
    <div className="flex min-w-0 flex-col gap-3">
      {claudeDraft && <ClaudeDraftBanner draft={claudeDraft} />}
      <p className="text-sm">
        消える平日便 <span className="tabular-nums">{candidates.length}</span> 便から選びます。系統ごとにまとめ、全曜日で便がなくなる系統を先に出します。
        系統を開くと、手がかりのある便を方向ごとに時刻の順に出します。
      </p>
      <AskRestoreButton blocked={policyDraft ? '減便の方針の下書きを承認するか、やめてから聞いてください。' : null} />
      <AiPicks picks={aiPicks} selected={selectedSet} onSelect={select} />
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

      <p className="text-xs text-muted-foreground">
        {compareDate && editedTimeline
          ? `編集後の最大間隔は、到達圏を比べる日(${formatDateJa(compareDate)})の、承認済みの編集後の便で数えています。`
          : '到達圏を比べる日が決まると、方向ごとに編集後の最大間隔を出します。'}
      </p>
      <CandidateGroups
        groups={groups}
        isOpen={(id) => filtering || opened.includes(id)}
        onToggle={(id) => {
          // 絞り込みで開いている系統を閉じるときは、絞り込みを外すまで閉じたことにしない(開いた一覧にも入れない)
          if (!filtering) setOpened((o) => toggle(o, id))
        }}
        showsAll={(id) => showAll.includes(id)}
        onShowAll={(id) => setShowAll((s) => (s.includes(id) ? s : [...s, id]))}
        selected={selectedSet}
        onSelect={select}
        aiIds={new Set(aiPicks.map((p) => p.candidate.trip.tripId))}
      />
      {(reachStatus.kind === 'absent' || hintsPresent.includes('onlyServiceAtStop') || hintsPresent.includes('restoresLostCells')) &&
        candidates.length > 0 && <p className="text-xs text-muted-foreground">{reachStatus.text}</p>}
      {candidates.length > 0 && (
        <section className="flex flex-col gap-0.5 text-xs text-muted-foreground" aria-label="学校・病院の手がかり">
          <p>{facilityStatus}</p>
          {ctx?.facilities &&
            (tally.list.length > 0 ? (
              <p>
                当たる便の数:
                {tally.list.map((t) => `${t.name}(${t.label})${t.trips} 便`).join('、')}
                {tally.more > 0 && `、ほか ${tally.more} 施設`}
              </p>
            ) : (
              <p>候補の便で、学校・病院の時間帯に当たる便はありません。</p>
            ))}
        </section>
      )}
      <SelectedTrips
        trips={selectedNow.map((id) => candidateById.get(id)!)}
        school={schoolSet}
        schoolNotes={schoolNotes}
        onSchool={(id, checked) => setSchool((s) => (checked ? (s.includes(id) ? s : [...s, id]) : s.filter((x) => x !== id)))}
        onRemove={(id) => select(id, false)}
      />

      <SelectedFacilityReasons trips={selectedNow.map((id) => candidateById.get(id)!)} onUse={setReason} />

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="restore-reason" className="text-xs">
          足し戻す理由(選んだ便すべてに入れる。任意)
        </Label>
        <Input id="restore-reason" placeholder="例:高校の通学" value={reason} onChange={(e) => setReason(e.target.value)} />
      </div>
      {policyDraft && <p className="text-sm text-destructive">減便の方針の下書きを承認するか、やめてから足し戻してください。</p>}
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

/**
 * 選んだ便ごとの、学校の長期休業が減便の期間と重なるときの注意の文(便の id → 文)。窓に当たる学校の、調べた長期休業
 * (HintFacility.longBreaks)のうち減便の期間と重なるものを、休業の名前と期間つきで出す。重ならなければ便の項目を作らない。
 * 期間が1年を超えると同じ休業が年ごとに重なる(overlapLongBreaks は年ごとに返す)が、文は年を含まないので、同じ文は1つにまとめる
 */
function schoolBreakNotes(trips: readonly Candidate[], period: { start: string; end: string | null }): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const c of trips) {
    const notes = new Set<string>()
    for (const n of matchedFacilities(c.detail.facilities)) {
      if (n.facility.kind !== 'school') continue
      for (const b of overlapLongBreaks(n.facility.longBreaks, period)) {
        notes.add(`${n.facility.name}:期間中に${b.name}(${b.text})が重なります。休校日運休(学)の印を付けるか確かめてください。`)
      }
    }
    if (notes.size > 0) out.set(c.trip.tripId, [...notes])
  }
  return out
}

/** 選んだ便ごとに出す、学校・病院の理由の文の上限 */
const MAX_REASONS_PER_TRIP = 3

/**
 * 選んだ便のうち、学校・病院の時間帯に当たる便の理由の文(施設名と種類つき。コードが出した文)。
 * 「理由に使う」で、足し戻す理由の欄にその文を入れる(書き換えられる)。
 * 理由の欄は選んだ便すべてに入り、文は便ごとの停留所・時刻を含むので、「理由に使う」は1便だけ選んだときに出す
 * (2便以上で使うと、ほかの便の履歴と変更指示書に、その便に当てはまらない停留所・時刻が残るため)
 */
function SelectedFacilityReasons({ trips, onUse }: { trips: readonly Candidate[]; onUse: (reason: string) => void }) {
  const rows = trips.flatMap((c) => {
    const matched = matchedFacilities(c.detail.facilities).slice(0, MAX_REASONS_PER_TRIP)
    return matched.length > 0 ? [{ c, matched, texts: matched.map(nearFacilityText) }] : []
  })
  if (rows.length === 0) return null
  const single = trips.length === 1
  return (
    <section className="flex flex-col gap-1 text-xs" aria-label="選んだ便の近くの学校・病院">
      <h3 className="font-medium">選んだ便の近くの学校・病院</h3>
      {!single && (
        <p className="text-muted-foreground">
          足し戻す理由は選んだ便すべてに入るので、この文を理由の欄に入れる「理由に使う」は、1便だけ選んだときに使えます。
        </p>
      )}
      <ul className="flex flex-col divide-y rounded-md border">
        {rows.map(({ c, matched, texts }) => (
          <li key={c.trip.tripId} className="flex flex-wrap items-start justify-between gap-x-2 gap-y-1 px-2 py-1">
            <span className="flex min-w-0 flex-col gap-0.5">
              <span>
                <span className="font-medium tabular-nums">{c.trip.firstDeparture ?? '—'}</span> {c.trip.routeName}{' '}
                <span className="font-mono text-[10px] text-muted-foreground">{c.trip.tripId}</span>
              </span>
              {texts.map((t, i) => (
                <span key={t} className="flex flex-col gap-0.5">
                  <span className="break-words text-muted-foreground">{t}</span>
                  <FacilityEvidence near={matched[i]} />
                </span>
              ))}
            </span>
            {single && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-6 px-1.5 text-xs"
                onClick={() => onUse(texts[0])}
                aria-label={`${c.trip.tripId} の学校・病院の文を、理由の欄に入れる`}
              >
                理由に使う
              </Button>
            )}
          </li>
        ))}
      </ul>
    </section>
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
                    {r.schoolDaysOnly && '・休校日運休(学)'}
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
