import StepSection from '@/components/StepSection'

/** 出力の手順のタブ「変更指示書」(仮)。中身は docs/tasks-1103.md の後の波で作る */
export default function ChangeOrder() {
  return (
    <StepSection title="変更指示書">
      <p className="text-sm text-muted-foreground">承認した内容を1枚にまとめ、印刷できるようにします(準備中)。</p>
    </StepSection>
  )
}
