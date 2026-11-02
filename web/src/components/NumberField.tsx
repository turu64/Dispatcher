import { useState } from 'react'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import type { ParseResult } from '@/reach/input'

/**
 * 数の入力欄。打っている途中の値(空など)で store の値を壊さないよう、文字は手元に持ち、
 * parse が通ったときだけ onCommit に渡す。通らなければ理由を欄の下に出す。
 * store の値が外から変わったら(「既定値に戻す」など)、欄の文字も合わせる。
 */
export default function NumberField({
  id,
  label,
  value,
  unit,
  parse,
  onCommit,
  max,
  step,
  integer = false,
}: {
  id: string
  label: string
  value: number
  unit: string
  parse: (text: string) => ParseResult
  onCommit: (value: number) => void
  max?: number
  step?: number
  /** 整数だけを受け付ける欄(画面の数字のキーボードを出す。受け付けるかどうかは parse が決める) */
  integer?: boolean
}) {
  const [text, setText] = useState(String(value))
  const [committed, setCommitted] = useState(value)
  const [error, setError] = useState<string | null>(null)
  if (value !== committed) {
    setCommitted(value)
    setText(String(value))
    setError(null)
  }

  return (
    <div className="flex min-w-0 flex-col gap-1">
      <Label htmlFor={id} className="text-xs">
        {label}
      </Label>
      <div className="flex items-center gap-1">
        <Input
          id={id}
          type="number"
          inputMode={integer ? 'numeric' : 'decimal'}
          min={0}
          max={max}
          step={step ?? 1}
          value={text}
          aria-invalid={error !== null}
          className="h-7 tabular-nums"
          onChange={(e) => {
            const t = e.target.value
            setText(t)
            const r = parse(t)
            if (!r.ok) {
              setError(r.message)
              return
            }
            setError(null)
            setCommitted(r.value)
            onCommit(r.value)
          }}
        />
        <span className="shrink-0 text-xs text-muted-foreground">{unit}</span>
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  )
}
