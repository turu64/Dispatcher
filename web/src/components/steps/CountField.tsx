import { useState } from 'react'
import type { OptionalCountResult } from '@/components/steps/reach/driverText'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

/**
 * 空でもよい人数の入力欄。空にすると「入れていない」(null)。打っている途中の値で store を壊さないよう、文字は手元に持つ。
 * 運行の前提の欄(在籍の運転士の数。research/OperationPremise.tsx)と、減便の方針の手順の欠員の欄(policy/ShortageSection.tsx)で使う
 */
export function CountField({
  id,
  label,
  value,
  max,
  placeholder,
  parse,
  onCommit,
}: {
  id: string
  label: string
  value: number | null
  max: number
  placeholder: string
  parse: (text: string) => OptionalCountResult
  onCommit: (value: number | null) => void
}) {
  const [text, setText] = useState(value === null ? '' : String(value))
  const [committed, setCommitted] = useState(value)
  const [error, setError] = useState<string | null>(null)
  if (value !== committed) {
    setCommitted(value)
    setText(value === null ? '' : String(value))
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
          type="text"
          inputMode="numeric"
          placeholder={placeholder}
          value={text}
          aria-invalid={error !== null}
          className="h-7 w-24 tabular-nums"
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
        <span className="shrink-0 text-xs text-muted-foreground">人(0〜{max})</span>
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  )
}
