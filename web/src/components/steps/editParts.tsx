/**
 * 編集の手順(方針・足し戻し・出力)で共通に使う表示の部品。
 * 重さ(誤り・注意・情報)は色だけでなく、記号と文字でも分かるようにする。
 */
import type { ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import type { ValidationIssue } from '@/gtfs/validate/edit'

const SEVERITY = {
  error: { mark: '✕', label: '誤り', className: 'border-destructive/50 bg-destructive/5 text-destructive' },
  warning: { mark: '!', label: '注意', className: 'border-amber-400 bg-amber-50 text-amber-950' },
  // 情報は枠で囲まず、行として並べる(誤り・注意だけを枠で目立たせる。2026-11-07 に利用者の指示)
  info: { mark: 'i', label: '情報', className: 'border-transparent px-0 py-0.5 text-foreground' },
} as const

const ORDER = { error: 0, warning: 1, info: 2 } as const

/** 検証の結果(validateEdit・timingNotices)の一覧。誤り → 注意 → 情報の順に並べる */
export function IssueList({ issues, title }: { issues: readonly ValidationIssue[]; title?: string }) {
  if (issues.length === 0) return null
  const sorted = [...issues].sort((a, b) => ORDER[a.severity] - ORDER[b.severity])
  return (
    <section className="flex flex-col gap-1.5" aria-label={title ?? '検証の結果'}>
      {title && <h3 className="text-sm font-medium">{title}</h3>}
      <ul className="flex flex-col gap-1.5">
        {sorted.map((issue, i) => {
          const s = SEVERITY[issue.severity]
          return (
            <li
              key={`${issue.code}-${i}`}
              data-severity={issue.severity}
              data-code={issue.code}
              className={`rounded-md border px-2 py-1.5 text-xs break-words ${s.className}`}
            >
              <span className="mr-1 inline-block font-semibold">
                <span aria-hidden="true">{s.mark} </span>
                {s.label}
                {issue.exportOnly && '(出力だけを止める)'}:
              </span>
              {issue.message}
              {issue.examples.length > 0 && issue.code !== 'publishNotes' && (
                <span className="mt-0.5 block font-mono text-[11px] opacity-80">
                  例:{issue.examples.join('、')}
                  {issue.count > issue.examples.length && ` ほか(全 ${issue.count} 件)`}
                </span>
              )}
            </li>
          )
        })}
      </ul>
    </section>
  )
}

/** 文言の箇条書き(§5.10 の文言など) */
export function NoteList({ items, label }: { items: readonly ReactNode[]; label?: string }) {
  if (items.length === 0) return null
  return (
    <ul className="flex list-disc flex-col gap-1 pl-4 text-xs" aria-label={label}>
      {items.map((t, i) => (
        <li key={i}>{t}</li>
      ))}
    </ul>
  )
}

/** 「前 → 後」の表示。後が前より少なければ ▼ を付けて目立たせる(色だけに頼らない) */
export function FromTo({ before, after, emphasizeDecrease = false }: { before: ReactNode; after: ReactNode; emphasizeDecrease?: boolean }) {
  return (
    <span className="tabular-nums">
      {before} → <span className={emphasizeDecrease ? 'font-semibold text-destructive' : undefined}>{after}</span>
      {emphasizeDecrease && (
        <>
          <span aria-hidden="true">▼</span>
          <span className="sr-only">(減る)</span>
        </>
      )}
    </span>
  )
}

/**
 * 画面の中の確認(ブラウザ標準の確認ダイアログの代わり)。押したボタンの場所に、文と「続ける」「やめる」を出す。
 * ページを止めないので、ブラウザ操作の自動化や録画でも困らない。「やめる」に最初の焦点を置き、うっかり Enter を押しても何も変えない。
 * onCancel では何も変えないこと、onConfirm でそれまでの動きをすることは、呼ぶ側が守る
 */
export function InlineConfirm({
  label,
  message,
  confirmLabel,
  cancelLabel = 'やめる',
  onConfirm,
  onCancel,
}: {
  /** 確認の名前(読み上げ・テスト用) */
  label: string
  message: ReactNode
  confirmLabel: string
  cancelLabel?: string
  onConfirm: () => void
  onCancel: () => void
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className="flex flex-col gap-1.5 rounded-md border border-amber-400 bg-amber-50 px-2 py-1.5 text-xs text-amber-950"
    >
      <p className="break-words">
        <span aria-hidden="true">! </span>
        {message}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" onClick={onConfirm}>
          {confirmLabel}
        </Button>
        <Button type="button" size="sm" variant="outline" autoFocus onClick={onCancel}>
          {cancelLabel}
        </Button>
      </div>
    </div>
  )
}
