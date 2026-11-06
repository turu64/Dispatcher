import { useMemo, useState } from 'react'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import type { EditRecord, Form2Plan, PolicyReason } from '@/gtfs/edit/ops'
import type { Form2Result } from '@/gtfs/edit/form2'
import { form2Texts, timingNotices } from '@/gtfs/validate/edit'
import { appToday } from '@/lib/dates'
import { blockingIssues, diffOf, draftName, useEditStore, type BaseGtfs } from '@/store/edit'
import { draftActor, replaceClaudeDraftMessage } from '../editActions'
import { FromTo, InlineConfirm, IssueList, NoteList } from '../editParts'
import {
  ACTOR_LABELS,
  describeRecord,
  groupSentence,
  periodText,
  POLICY_KIND_LABELS,
  reasonCategoryLabel,
  REPLACEMENT_LABELS,
  shortDateTime,
  UNDO_NOTE,
} from '../editText'
import { ADDED_TEXT_CLASS, DiffCounts, Notice47Table, REMOVED_TEXT_CLASS, RouteDiffList, StartBandTable } from './DiffTables'
import { PairList } from './PairList'
import { totals } from './stats'
import type { OpDraft } from './types'

// ---- 対象便を確かめる(§6) ----

export function PolicyReview({ draft, onCommitted }: { draft: OpDraft; onCommitted: () => void }) {
  const [vanishChecked, setVanishChecked] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  // 実施日までの日数などに使う今日(日本時間)。画面を開いた日
  const [today] = useState(() => appToday())
  const op = draft.record.op
  if (op.type !== 'applyPolicy') return null
  const byClaude = draft.record.by === 'claude'
  const heading = `対象便を確かめる(${draftName(draft.id)}${byClaude ? '・AI の提案' : ''})`

  const discard = () => useEditStore.getState().discard()
  if (!draft.outcome.ok || !draft.diff) {
    return (
      <section className="flex flex-col gap-2" aria-label="対象便の確認">
        <h3 className="text-sm font-medium">{heading}</h3>
        <Alert variant="destructive">
          <AlertDescription>
            <p>この減便の方針は適用できません。</p>
            {!draft.outcome.ok &&
              draft.outcome.message.split('\n').map((line) => (
                <p key={line} className="whitespace-pre-wrap">
                  {line}
                </p>
              ))}
          </AlertDescription>
        </Alert>
        <Button type="button" variant="outline" className="self-start" onClick={discard}>
          やめる
        </Button>
      </section>
    )
  }

  const result = draft.outcome.result
  const diff = draft.diff
  const texts = form2Texts(result, today)
  const timing = timingNotices(result, today)
  const blocking = blockingIssues(draft.issues)
  const needVanishCheck = diff.vanishingRoutes > 0
  const canCommit = blocking.length === 0 && (!needVanishCheck || vanishChecked)

  function commit() {
    setMessage(null)
    const r = useEditStore.getState().commit()
    if (r.ok) onCommitted()
    else setMessage(r.message)
  }

  return (
    <section className="flex min-w-0 flex-col gap-3" aria-label="対象便の確認">
      <h3 className="text-sm font-medium">{heading}</h3>
      {op.settings.pairs === undefined ? (
        <p className="text-xs">
          {POLICY_KIND_LABELS[op.settings.kind]}。期間 {periodText(op.settings.period.start, op.settings.period.end)}。平日{' '}
          <span className="font-mono">{op.settings.weekdayService}</span> を <span className="font-mono">{op.settings.replacementService}</span>{' '}
          の便に入れ替えます。
        </p>
      ) : (
        <div className="flex flex-col gap-1 text-xs">
          <p>
            {POLICY_KIND_LABELS[op.settings.kind]}。期間 {periodText(op.settings.period.start, op.settings.period.end)}。{groupSentence(op.settings, result.report)}
          </p>
          <PairList settings={op.settings} report={result.report} />
        </div>
      )}
      <DiffCounts diff={diff} result={result} />
      <RouteDiffList diff={diff} />
      <StartBandTable diff={diff} />
      <Notice47Table diff={diff} />
      <NoteList items={texts.validity} label="有効期間と期間の外" />
      <NoteList items={texts.changes} label="何が変わるか" />
      <IssueList issues={[...draft.issues, ...timing]} title="確かめること" />
      {needVanishCheck && (
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            checked={vanishChecked}
            onChange={(e) => setVanishChecked(e.target.checked)}
            className="mt-0.5 size-4 shrink-0 accent-primary"
          />
          全曜日で便がなくなる系統があることを確かめました
        </label>
      )}
      {blocking.length > 0 && <p className="text-sm text-destructive">誤りがあるため、この内容では承認できません。</p>}
      {message && (
        <Alert variant="destructive">
          <AlertDescription>{message}</AlertDescription>
        </Alert>
      )}
      <div className="flex flex-wrap gap-2">
        <Button type="button" disabled={!canCommit} onClick={commit}>
          承認する
        </Button>
        <Button type="button" variant="outline" onClick={discard}>
          やめる
        </Button>
      </div>
    </section>
  )
}

// ---- 承認したあと ----

export function PolicySummary({
  base,
  plan,
  reason,
  version,
  onChange,
}: {
  base: BaseGtfs
  plan: Form2Plan
  reason: PolicyReason | null
  version: Form2Result
  onChange: () => void
}) {
  const diff = useMemo(() => diffOf(base.feed, version), [base.feed, version])
  const { before, after } = totals(diff)
  const names = new Map(diff.byRoute.map((r) => [r.routeId, r.routeName]))
  return (
    <section className="flex flex-col gap-2" aria-label="承認した減便の方針">
      <dl className="flex flex-col gap-0.5 text-sm">
        <div>
          <dt className="inline">承認した減便の方針:</dt>
          <dd className="inline font-medium">{POLICY_KIND_LABELS[plan.kind]}</dd>
        </div>
        <div>
          <dt className="inline">期間:</dt>
          <dd className="inline">{periodText(plan.period.start, plan.period.end)}</dd>
        </div>
        {plan.pairs === undefined ? (
          <div>
            <dt className="inline">service:</dt>
            <dd className="inline">
              平日 <span className="font-mono">{plan.weekdayService}</span> ← {REPLACEMENT_LABELS[plan.kind]}{' '}
              <span className="font-mono">{plan.replacementService}</span>
            </dd>
          </div>
        ) : (
          <div>
            <dt>ダイヤ:{groupSentence(plan, version.report)}</dt>
            <dd>
              <PairList settings={plan} report={version.report} />
            </dd>
          </div>
        )}
        <div>
          <dt className="inline">除外した系統:</dt>
          <dd className="inline">
            {plan.excludedRoutes.length === 0 ? 'なし' : plan.excludedRoutes.map((r) => names.get(r) ?? r).join('、')}
          </dd>
        </div>
        <div>
          <dt className="inline">理由:</dt>
          <dd className="inline">
            {reasonCategoryLabel(reason) ?? '選んでいません'}
            {reason?.note && `(${reason.note})`}
          </dd>
        </div>
        <div>
          <dt className="inline">平日便:</dt>
          <dd className="inline">
            <FromTo before={before} after={after} emphasizeDecrease={after < before} /> 便(
            <span className={diff.removed.length > 0 ? REMOVED_TEXT_CLASS : undefined}>なくなる便 {diff.removed.length}</span>・
            <span className={diff.added.length > 0 ? ADDED_TEXT_CLASS : undefined}>加わる便 {diff.added.length}</span>・同じ便 {diff.same.length})
          </dd>
        </div>
        <div className={diff.vanishingRoutes > 0 ? 'font-semibold text-destructive' : undefined}>
          <dt className="inline">全曜日で便がなくなる系統:</dt>
          <dd className="inline">{diff.vanishingRoutes} 系統</dd>
        </div>
      </dl>
      <Button type="button" variant="outline" size="sm" className="self-start" onClick={onChange}>
        減便の方針を変える
      </Button>
    </section>
  )
}

/** 編集の履歴と、元に戻す・すべて戻す。Claude の「元に戻す」の下書きもここで承認する */
export function EditHistoryPanel() {
  const history = useEditStore((s) => s.history)
  const draft = useEditStore((s) => s.draft)
  const draftId = draft?.id ?? null
  // 押したボタンの場所に出す確認(ブラウザ標準の確認ダイアログは使わない)。
  // 押したときの履歴(store は変えるたびに新しい配列にする)と下書きの id を覚え、どちらかが変わったら確認を消す。
  // 隠すだけにすると、件数が同じに戻ったときや下書きが無くなったときに、押していない確認がまた出てしまう
  const [pending, setPending] = useState<{ kind: 'undo' | 'undoAll'; history: EditRecord[]; draftId: string | null } | null>(null)
  if (pending && (pending.history !== history || pending.draftId !== draftId)) setPending(null)
  const undoDraft = draft?.kind === 'undo' ? draft : null
  if (history.length === 0 && !undoDraft) return null

  // Claude の下書きがあれば、元に戻す操作はそれを捨てる(確かめてから)
  const claudeDraft = draft && draftActor(draft) === 'claude' ? draft : null
  const confirming =
    pending &&
    pending.history === history &&
    pending.draftId === draftId &&
    history.length > 0 &&
    (pending.kind === 'undoAll' || claudeDraft !== null)
      ? pending.kind
      : null
  const undo = () => {
    if (claudeDraft) setPending({ kind: 'undo', history, draftId })
    else useEditStore.getState().undo()
  }
  const undoAll = () => setPending({ kind: 'undoAll', history, draftId })
  const cancel = () => setPending(null)
  const confirm = () => {
    setPending(null)
    if (confirming === 'undoAll') useEditStore.getState().undoAll()
    else useEditStore.getState().undo()
  }

  return (
    <section className="flex flex-col gap-2 border-t pt-2" aria-label="編集の履歴">
      <h3 className="text-sm font-medium">編集の履歴(承認済み)</h3>
      <ol className="flex list-decimal flex-col gap-0.5 pl-5 text-xs">
        {history.map((r, i) => (
          <li key={i} className="break-words">
            {describeRecord(r)}({ACTOR_LABELS[r.by]}、{shortDateTime(r.at)})
          </li>
        ))}
      </ol>
      {undoDraft && (
        <div className="flex flex-col gap-1.5 rounded-md border border-dashed px-2 py-1.5 text-xs">
          <p>
            {draftName(undoDraft.id)}{draftActor(undoDraft) === 'claude' && '(AI の提案)'}:最後の操作を元に戻します。地図と表には、戻したあとの状態を「下書き」として表示しています。
          </p>
          <div className="flex gap-2">
            <Button type="button" size="sm" onClick={() => useEditStore.getState().commit()}>
              元に戻す操作を承認する
            </Button>
            <Button type="button" size="sm" variant="outline" onClick={() => useEditStore.getState().discard()}>
              やめる
            </Button>
          </div>
        </div>
      )}
      {confirming === 'undoAll' ? (
        <InlineConfirm
          label="すべて戻す確認"
          message={
            <>
              本当にすべて戻しますか。すべての編集({history.length} 件)を戻して、読み込んだ GTFS のままにします。
              {claudeDraft && <>AI の{draftName(claudeDraft.id)} も破棄します。</>}
            </>
          }
          confirmLabel="すべて戻す"
          onConfirm={confirm}
          onCancel={cancel}
        />
      ) : confirming === 'undo' && claudeDraft ? (
        <InlineConfirm
          label="AI の下書きを破棄する確認"
          message={replaceClaudeDraftMessage(claudeDraft)}
          confirmLabel="破棄して続ける"
          onConfirm={confirm}
          onCancel={cancel}
        />
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" size="sm" disabled={history.length === 0} onClick={undo}>
            元に戻す
          </Button>
          <Button type="button" variant="outline" size="sm" disabled={history.length === 0} onClick={undoAll}>
            すべて戻す
          </Button>
        </div>
      )}
      <p className="text-xs text-muted-foreground">{UNDO_NOTE}</p>
    </section>
  )
}
