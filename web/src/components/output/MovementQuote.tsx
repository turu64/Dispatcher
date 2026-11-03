import { ExternalLink } from 'lucide-react'
import { checkedAtText, safeUrl } from '@/claude/research'
import { STALE_CHECK_DAYS, type MovementQuote } from '@/gtfs/edit/notice'

/** 古い確認日時に添える注意 */
export const STALE_QUOTE_NOTE = `${STALE_CHECK_DAYS}日より前の確認です。出典で確かめてください。`

const ORIGIN_TEXT = { web: 'Web で調べた結果', demo: 'デモ用の保存済みの結果' } as const

/**
 * 周辺の事業者について調べた減便の動きの引用(周知文の代替手段と変更指示書で共通)。
 * 事実は調べた結果をそのまま写し、要約や推測は足さない。出典(タイトルと URL)と確認日時はいつも出す。
 * maxFacts を渡すと、事実を先頭からその件数に絞り、残りは件数で示す(A4 に収めたい変更指示書で使う)
 */
export default function MovementQuoteView({ quote, maxFacts }: { quote: MovementQuote; maxFacts?: number }) {
  const facts = maxFacts !== undefined ? quote.facts.slice(0, maxFacts) : quote.facts
  const hidden = quote.facts.length - facts.length
  const shownNos = new Set(facts.map((f) => f.sourceNo).filter((n): n is number => n !== null))
  const sources = quote.sources.filter((s) => shownNos.has(s.no))
  return (
    <figure
      className={`flex flex-col gap-0.5 border-l-2 border-neutral-400 pl-2 text-xs ${maxFacts !== undefined ? 'print:text-[9px] print:leading-tight' : ''}`}
      aria-label={`${quote.operatorName}について調べた減便の動き`}
      data-testid={`movement-quote-${quote.targetId}`}
    >
      <figcaption className="font-medium">
        {quote.operatorName}について調べた結果(引用)
        <span className="ml-1 font-normal">
          確認日時 {checkedAtText(quote.checkedAt)}・{ORIGIN_TEXT[quote.origin]}
        </span>
      </figcaption>
      <ul className="flex flex-col gap-0.5">
        {facts.map((f, i) => (
          <li key={i}>
            {f.label}:{f.value}
            {f.sourceNo !== null && <sup className="ml-0.5">[{f.sourceNo}]</sup>}
          </li>
        ))}
      </ul>
      {hidden > 0 && <p>ほか {hidden} 件は、手順「前提情報」で確かめられます。</p>}
      {sources.length > 0 && (
        <ol className="flex flex-col gap-0.5" aria-label="出典">
          {sources.map((s) => {
            const href = safeUrl(s.url)
            return (
              <li key={s.no} className="flex flex-wrap gap-x-1">
                <span>[{s.no}]</span>
                <span>{s.title}</span>
                {href ? (
                  <a href={href} target="_blank" rel="noopener noreferrer" className="inline-flex min-w-0 items-center gap-0.5 break-all underline underline-offset-2">
                    {href}
                    <ExternalLink className="print-hide size-3 shrink-0" aria-hidden="true" />
                  </a>
                ) : (
                  <span>(URL を表示できません)</span>
                )}
              </li>
            )
          })}
        </ol>
      )}
      {quote.stale && <p role="note">{STALE_QUOTE_NOTE}</p>}
    </figure>
  )
}
