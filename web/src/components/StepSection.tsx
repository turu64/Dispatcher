import type { ReactNode } from 'react'
import { useStepTitle } from '@/components/layout/stepTitle'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

/**
 * 左の手順パネルの1手順分。見出し(「1. GTFS を読み込む」など)と中身。
 * 見出しの番号は、左の欄の手順の並びに付け替わる(layout/stepTitle.ts)。
 * id を渡すと、チャットの下書きの知らせの「編集で確かめる」ボタンがこの手順へ移れる(components/steps/stepIds.ts)
 */
export default function StepSection({ title, id, children }: { title: string; id?: string; children: ReactNode }) {
  const shown = useStepTitle(title)
  return (
    <Card size="sm" id={id} tabIndex={id ? -1 : undefined} className="outline-none">
      <CardHeader>
        <CardTitle role="heading" aria-level={2}>
          {shown}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">{children}</CardContent>
    </Card>
  )
}
