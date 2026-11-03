import type { ReactNode } from 'react'

/**
 * AI の返答の簡単な整え(docs/interfaces-1105.md §6.4)。太字(**…**)と箇条書き(行頭の「- 」「* 」「・」)だけを解釈し、
 * 改行は保つ。HTML は解釈しない(文字のまま出す。React が escape する)。
 */

const BULLET = /^\s*(?:[-*・])\s+(.*)$/

/** 1行の中の **太字** を strong にする */
function inlineBold(line: string): ReactNode[] {
  const out: ReactNode[] = []
  const re = /\*\*([^*\n]+?)\*\*/g
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(line)) !== null) {
    if (m.index > last) out.push(line.slice(last, m.index))
    out.push(<strong key={m.index}>{m[1]}</strong>)
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
      <ul key={`u${blocks.length}`} className="list-disc pl-4">
        {items.map((b, i) => (
          <li key={i}>{inlineBold(b)}</li>
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
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    const m = BULLET.exec(line)
    if (m) {
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
  return <div className="flex flex-col gap-1.5 break-words">{blocks}</div>
}
