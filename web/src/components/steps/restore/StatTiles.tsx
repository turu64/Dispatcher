import { cn } from '@/lib/utils'

/** 小さな数の枠の1つ(見出しと太字の数)。tone が warn なら、数を警告色にする(0 でないときだけ使う) */
export interface StatTile {
  label: string
  value: number | string
  tone?: 'warn'
}

/**
 * 平日便を戻す手順の、主な数の小さな枠の並び(読み込みの手順の枠と同じ形)。
 * 読み上げ用の1文を別に持つときは、呼ぶ側で aria-hidden を付ける
 */
export function StatTiles({ tiles, label, className, hidden = false }: { tiles: readonly StatTile[]; label?: string; className?: string; hidden?: boolean }) {
  return (
    <dl className={cn('grid grid-cols-3 gap-2', className)} aria-label={hidden ? undefined : label} aria-hidden={hidden || undefined}>
      {tiles.map((t) => (
        <div key={t.label} className="flex min-w-0 flex-col rounded-md bg-muted/50 px-2 py-1.5">
          <dt className="text-xs text-muted-foreground">{t.label}</dt>
          <dd className={cn('text-base font-semibold tabular-nums', t.tone === 'warn' && 'text-destructive')}>
            {typeof t.value === 'number' ? t.value.toLocaleString('ja-JP') : t.value}
          </dd>
        </div>
      ))}
    </dl>
  )
}
