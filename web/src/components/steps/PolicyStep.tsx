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
  if (base !== editingBase) {
    setEditingBase(base)
    setEditing(false)
  }
  const plan = useMemo(() => planOf(history), [history])
  const reason = useMemo(() => policyReasonOf(history), [history])
  const version = lastVersion({ versions })
  const reviewing: OpDraft | null = draft?.kind === 'op' && draft.record.op.type === 'applyPolicy' ? draft : null
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
                key={`${baseKeyOf(base)}-${editing ? history.length : 0}`}
                base={base}
                initial={editing ? plan : null}
                initialReason={editing ? reason : null}
                onCancel={plan && editing ? () => setEditing(false) : undefined}
              />
            </div>
          )}
          {reviewing && <PolicyReview draft={reviewing} onCommitted={() => setEditing(false)} />}
          {plan && version && !editing && !reviewing && (
            <PolicySummary base={base} plan={plan} reason={reason} version={version} onChange={() => setEditing(true)} />
          )}
          <EditHistoryPanel />
        </>
      )}
    </StepSection>
  )
}
