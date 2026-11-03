import StepSection from '@/components/StepSection'

/** 出力の手順のタブ「停留所の一覧」(仮)。中身は docs/tasks-1103.md の後の波で作る */
export default function StopChangesTable() {
  return (
    <StepSection title="停留所の一覧">
      <p className="text-sm text-muted-foreground">停留所ごとの本数・最終便・最大間隔の変化を出します(準備中)。</p>
    </StepSection>
  )
}
