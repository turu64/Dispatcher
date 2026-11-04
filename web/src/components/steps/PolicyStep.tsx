import { useMemo, useState } from 'react'
import StepSection from '@/components/StepSection'
import { planOf, policyReasonOf } from '@/gtfs/edit/ops'
import { lastVersion, useEditStore } from '@/store/edit'
import { STEP_IDS } from './stepIds'
import { EditHistoryPanel, PolicyReview, PolicySummary } from './policy/ApprovalPanel'
import { PolicyForm } from './policy/PolicyForm'
import { baseKeyOf, type OpDraft } from './policy/types'

// テストなどが従来の場所から読めるように残す
export { Notice47Table } from './policy/DiffTables'

/**
 * 減便の方針の手順(docs/interfaces-1104.md §3・§6)。
 * 方針を入れて「対象便を確かめる」で下書きにし、対象便を確かめて「この内容で進める」で承認する。
 * 承認したあとは、適用した方針と件数を出し、「方針を変える」で入力に戻る。編集の履歴(元に戻す・すべて戻す)もここに出す。
 */
export default function PolicyStep() {
  const base = useEditStore((s) => s.base)
  const history = useEditStore((s) => s.history)
  const versions = useEditStore((s) => s.versions)
  const draft = useEditStore((s) => s.draft)
  const [editing, setEditing] = useState(false)
  // GTFS を削除・読み込み直したら(基準が変わったら)、「方針を変える」の途中の状態を捨てる
  const [editingBase, setEditingBase] = useState(base)
  // AI の方針の下書き(apply_policy)が出たら、その値(理由・期間・種類・除外)を文の穴に入れる。
  // 確かめている間は入力を隠しているので、「やめる」で戻ったときに AI の値のまま直せる
  const [aiSeed, setAiSeed] = useState<OpDraft | null>(null)
  // 下書きを入れたときの履歴。どこかで承認・元に戻すなどして履歴が変わったら、AI の値は使わない(承認済みの方針か既定に戻す)
  const [seedHistory, setSeedHistory] = useState(history)
  if (base !== editingBase) {
    setEditingBase(base)
    setEditing(false)
    setAiSeed(null)
  }
  const plan = useMemo(() => planOf(history), [history])
  const reason = useMemo(() => policyReasonOf(history), [history])
  const version = lastVersion({ versions })
  const reviewing: OpDraft | null = draft?.kind === 'op' && draft.record.op.type === 'applyPolicy' ? draft : null
  if (reviewing && reviewing.record.by === 'claude' && aiSeed?.id !== reviewing.id) {
    setAiSeed(reviewing)
    setSeedHistory(history)
  } else if (aiSeed && history !== seedHistory) {
    setAiSeed(null)
  }
  const seedOp = aiSeed?.record.op.type === 'applyPolicy' ? aiSeed.record.op : null
  const showForm = base !== null && (plan === null || editing)

  return (
    <StepSection title="2. 減便の方針" id={STEP_IDS.policy}>
      {!base ? (
        <p className="text-sm text-muted-foreground">手順「読み込み」で GTFS を読み込むと、減便の方針を選べます。</p>
      ) : (
        <>
          {showForm && (
            // 確かめている間も入力は残す(「やめる」で戻ったときに、入れた値のまま直せるように)
            <div hidden={reviewing !== null}>
              <PolicyForm
                key={`${baseKeyOf(base)}-${editing ? history.length : 0}-${aiSeed?.id ?? ''}`}
                base={base}
                initial={seedOp ? seedOp.settings : editing ? plan : null}
                initialReason={seedOp ? seedOp.reason : editing ? reason : null}
                onCancel={plan && editing ? () => setEditing(false) : undefined}
              />
            </div>
          )}
          {reviewing && (
            <PolicyReview
              draft={reviewing}
              onCommitted={() => {
                setEditing(false)
                setAiSeed(null)
              }}
            />
          )}
          {plan && version && !editing && !reviewing && (
            <PolicySummary
              base={base}
              plan={plan}
              reason={reason}
              version={version}
              onChange={() => {
                setEditing(true)
                setAiSeed(null)
              }}
            />
          )}
          <EditHistoryPanel />
        </>
      )}
    </StepSection>
  )
}
