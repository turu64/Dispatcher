import type { ReactNode } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

/**
 * 左の手順パネルの1手順分。見出し(「1. GTFS を読み込む」など)と中身。
 * id を渡すと、チャットの「手順へ移る」ボタンがこの手順へ移れる(components/chat/ChatPanel.tsx)
 */
export default function StepSection({ title, id, children }: { title: string; id?: string; children: ReactNode }) {
  return (
    <Card size="sm" id={id} tabIndex={id ? -1 : undefined} className="outline-none">
      <CardHeader>
        <CardTitle role="heading" aria-level={2}>
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">{children}</CardContent>
    </Card>
  )
}
