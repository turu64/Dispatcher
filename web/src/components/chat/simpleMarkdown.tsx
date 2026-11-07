import type { ReactNode } from 'react'
import { splitTableRow } from './markdownTable'

/**
 * AI の返答の簡単な整え(docs/interfaces-1105.md §6.4)。太字(**…**)、箇条書き(行頭の「- 」「* 」「・」)、
 * 見出し(行頭の「# 」〜「#### 」。少し大きい太字の1行にする)、表(GitHub 形式。「|」で始まる行が続き、2行目が
 * 「|---|:---:|」のような区切りの行のもの。2026-11-07 に利用者の指摘で足した)だけを解釈し、改行は保つ。
 * 区切りの行が無い「|」の行は表にせず、文字のまま出す。
 * HTML は解釈しない(文字のまま出す。React が escape する)。
 */

const BULLET = /^\s*(?:[-*・])\s+(.*)$/
const HEADING = /^\s*#{1,4}\s+(.*)$/
const TABLE_ROW = /^\s*\|.*\|\s*$/
const TABLE_DIVIDER = /^\s*\|?(?:\s*:?-+:?\s*\|)+\s*(?::?-+:?\s*)?\|?\s*$/

type Align = 'left' | 'center' | 'right' | undefined


function alignOf(cell: string): Align {
  const left = cell.startsWith(':')
  const right = cell.endsWith(':')
  return left && right ? 'center' : right ? 'right' : left ? 'left' : undefined
}

const ALIGN_CLASS: Record<NonNullable<Align>, string> = { left: 'text-left', center: 'text-center', right: 'text-right' }

function Table({ head, aligns, rows }: { head: string[]; aligns: Align[]; rows: string[][] }) {
  const cols = head.length
  const cls = (i: number) => `border px-2 py-1 align-top ${ALIGN_CLASS[aligns[i] ?? 'left']}`
  return (
    <div className="max-w-full overflow-x-auto">
      <table className="w-max min-w-full border-collapse text-xs">
        <thead className="bg-muted/60">
          <tr>
            {head.map((h, i) => (
              <th key={i} scope="col" className={`${cls(i)} font-semibold`}>
                {inlineBold(h)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, ri) => (
            <tr key={ri}>
              {Array.from({ length: cols }, (_, i) => (
                <td key={i} className={cls(i)}>
                  {inlineBold(r[i] ?? '')}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** 1行の中の **太字** を strong にする */
function inlineBold(line: string): ReactNode[] {
  const out: ReactNode[] = []
  const re = /\*\*([^*\n]+?)\*\*/g
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(line)) !== null) {
    if (m.index > last) out.push(line.slice(last, m.index))
    out.push(
      <strong key={m.index} className="font-semibold">
        {m[1]}
      </strong>,
    )
    last = m.index + m[0].length
  }
  if (last < line.length) out.push(line.slice(last))
  return out
}

export default function SimpleMarkdown({ text }: { text: string }) {
  const blocks: ReactNode[] = []
  let bullets: string[] = []
  let paragraph: string[] = []
  const flushBullets = () => {
    if (bullets.length === 0) return
    const items = bullets
    blocks.push(
      <ul key={`u${blocks.length}`} className="flex list-disc flex-col gap-0.5 pl-5 marker:text-muted-foreground">
        {items.map((b, i) => (
          <li key={i} className="pl-0.5">
            {inlineBold(b)}
          </li>
        ))}
      </ul>,
    )
    bullets = []
  }
  const flushParagraph = () => {
    if (paragraph.length === 0) return
    const lines = paragraph
    blocks.push(
      <p key={`p${blocks.length}`}>
        {lines.map((l, i) => (
          <span key={i}>
            {i > 0 && <br />}
            {inlineBold(l)}
          </span>
        ))}
      </p>,
    )
    paragraph = []
  }
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li]
    // 表:「|」の行の次が区切りの行なら、続く「|」の行までを1つの表にする
    if (TABLE_ROW.test(line) && li + 1 < lines.length && TABLE_DIVIDER.test(lines[li + 1])) {
      const head = splitTableRow(line)
      const divider = splitTableRow(lines[li + 1])
      if (divider.length === head.length) {
        flushBullets()
        flushParagraph()
        const rows: string[][] = []
        li += 2
        while (li < lines.length && TABLE_ROW.test(lines[li])) rows.push(splitTableRow(lines[li++]))
        li--
        blocks.push(<Table key={`t${blocks.length}`} head={head} aligns={divider.map(alignOf)} rows={rows} />)
        continue
      }
    }
    const heading = HEADING.exec(line)
    const m = BULLET.exec(line)
    if (heading) {
      flushBullets()
      flushParagraph()
      blocks.push(
        <p key={`h${blocks.length}`} className="pt-1.5 text-base leading-snug font-semibold first:pt-0">
          {inlineBold(heading[1])}
        </p>,
      )
    } else if (m) {
      flushParagraph()
      bullets.push(m[1])
    } else if (line.trim() === '') {
      flushBullets()
      flushParagraph()
    } else {
      flushBullets()
      paragraph.push(line)
    }
  }
  flushBullets()
  flushParagraph()
  return <div className="flex flex-col gap-2 leading-relaxed break-words">{blocks}</div>
}
