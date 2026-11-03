import { ChevronDown, ChevronRight } from 'lucide-react'
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import {
  canStop,
  CLAUDE_UNAVAILABLE,
  RECONNECTING,
  researchText,
  RESEARCH_KEEP_OPEN,
  SEND_INFO_NOTE,
  sendBlockedReason,
  THINKING,
  useChatStore,
  usageText,
} from '@/store/chat'
import { useEditStore } from '@/store/edit'
import ChatMessages from './ChatMessages'
import SentLog from './SentLog'
import { useEnsureChatStatus, type ChatStoreHook } from './chatStatus'

const EXAMPLE = '例:「平日を土曜ダイヤにしてください。期間は 11/9 から当面の間」'

/**
 * 左の手順の欄の下の「AI に相談」(docs/interfaces-1105.md §6.4)。折りたためる。GTFS を読み込むまでは出さない。
 * どの手順を開いていても同じ場所に出す(方針の指示と質問は、どの手順からも出るため)。
 * 方針の指示と質問だけを送る(操作はほかの手順のボタンで行う)。AI が使えなくても、ほかの手順はすべてボタンで動く。
 * 会話の箱は overscroll-behavior: contain にし、中のスクロールが端に着いても左の欄やページに伝わらないようにする
 */
export default function ChatPanel({ store = useChatStore }: { store?: ChatStoreHook }) {
  const base = useEditStore((s) => s.base)
  if (!base) return null
  return <ChatPanelBody store={store} />
}

function ChatPanelBody({ store }: { store: ChatStoreHook }) {
  const s = store()
  const [open, setOpen] = useState(true)
  const [text, setText] = useState('')
  const [tokenText, setTokenText] = useState('')
  const listRef = useRef<HTMLDivElement>(null)
  useEnsureChatStatus(store)

  // 送れなかった文は入力欄に戻す(入力欄が空のときだけ。書きかけを消さない)。store 側の印は、描画のあとで消す
  const unsent = s.unsent
  const [seenUnsent, setSeenUnsent] = useState<string | null>(null)
  if (unsent !== seenUnsent && (unsent !== null || seenUnsent !== null)) {
    setSeenUnsent(unsent)
    if (unsent !== null) setText((p) => (p === '' ? unsent : p))
  }
  useEffect(() => {
    if (unsent !== null) store.setState({ unsent: null })
  }, [unsent, store])

  // 手順の「AI に候補を聞く」などで利用者の文や下書きの知らせが増えたとき、閉じていれば開く
  const last = s.items[s.items.length - 1]
  const lastId = last?.id
  const [seenId, setSeenId] = useState(lastId)
  if (lastId !== seenId) {
    setSeenId(lastId)
    if (last?.kind === 'user' || last?.kind === 'draft') setOpen(true)
  }

  // 新しい発言が出たら、いちばん下まで流す
  const textLength = last?.kind === 'assistant' ? last.text.length : 0
  useEffect(() => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [s.items.length, textLength, s.replying, open])

  const status = s.status
  const unavailable = status.state === 'ready' && !status.available
  const statusFailed = status.state === 'error'
  const checking = status.state === 'unknown' || status.state === 'loading'
  const needToken = status.state === 'ready' && status.available && status.tokenRequired && !s.token
  const blocked = unavailable || statusFailed || checking || needToken ? 'unavailable' : sendBlockedReason(s)
  const research = researchText(s.research)
  const stoppable = canStop(s)

  function submit() {
    const t = text.trim()
    if (t === '' || blocked !== null) return
    setText('')
    void s.send(t)
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.nativeEvent.isComposing) {
      e.preventDefault()
      submit()
    }
  }

  function onToken(e: FormEvent) {
    e.preventDefault()
    s.setToken(tokenText)
    if (tokenText.trim() !== '') setTokenText('')
  }

  return (
    <section aria-label="AI に相談" className="print-hide flex max-h-[40vh] shrink-0 flex-col border-t bg-background">
      <h2 className="shrink-0 text-sm font-semibold">
        <button
          type="button"
          className="flex w-full items-center gap-1 px-4 py-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-expanded={open}
          aria-controls="chat-body"
          onClick={() => setOpen((o) => !o)}
        >
          {open ? <ChevronDown className="size-4" aria-hidden="true" /> : <ChevronRight className="size-4" aria-hidden="true" />}
          AI に相談
        </button>
      </h2>
      <div id="chat-body" hidden={!open} className="flex min-h-0 flex-1 flex-col gap-2 px-4 pb-3">
        <div ref={listRef} role="log" aria-label="AI との会話" aria-live="polite" className="min-h-16 flex-1 overflow-y-auto overscroll-contain">
          {s.items.length === 0 && !checking && !unavailable && !statusFailed && (
            <p className="text-xs text-muted-foreground">
              減便の方針の指示や、質問を送れます。{EXAMPLE}。AI は GTFS を書き換えません。下書きを作るので、承認はあなたが押します。
            </p>
          )}
          <ChatMessages items={s.items} />
          {s.replying && (
            <p role="status" className="mt-2 text-xs text-muted-foreground">
              {THINKING}
            </p>
          )}
          {s.connection === 'reconnecting' && (
            <p role="status" className="mt-2 text-xs text-muted-foreground">
              {RECONNECTING}
            </p>
          )}
          {research && (
            <p role="status" className="mt-2 text-xs">
              {research}
              {s.research.active && <span className="block text-muted-foreground">{RESEARCH_KEEP_OPEN}</span>}
            </p>
          )}
        </div>

        <div className="flex shrink-0 flex-col gap-2 overflow-y-auto overscroll-contain">
          {checking && <p className="text-xs text-muted-foreground">AI の状態を確かめています…</p>}
          {unavailable && (
            <p role="status" className="text-xs">
              <span aria-hidden="true">! </span>
              {CLAUDE_UNAVAILABLE}。ほかの手順は、すべてボタンで使えます。
            </p>
          )}
          {status.state === 'error' && (
            <div className="flex flex-col gap-1.5">
              <p role="alert" className="text-xs text-destructive">
                <span aria-hidden="true">✕ </span>
                {status.message}
              </p>
              <Button type="button" size="sm" variant="outline" className="self-start" onClick={() => void s.loadStatus()}>
                もう一度確かめる
              </Button>
            </div>
          )}
          {(needToken || s.tokenError) && status.state === 'ready' && status.tokenRequired && (
            <form className="flex flex-col gap-1.5" onSubmit={onToken} aria-label="合言葉の入力">
              <Label htmlFor="chat-token" className="text-xs">
                合言葉
              </Label>
              <div className="flex gap-2">
                <Input
                  id="chat-token"
                  type="password"
                  autoComplete="off"
                  className="h-8 text-xs"
                  value={tokenText}
                  aria-invalid={s.tokenError !== null}
                  onChange={(e) => setTokenText(e.target.value)}
                />
                <Button type="submit" size="sm" variant="outline" disabled={tokenText.trim() === ''}>
                  設定
                </Button>
              </div>
              {s.tokenError && (
                <p role="alert" className="text-xs text-destructive">
                  <span aria-hidden="true">✕ </span>
                  {s.tokenError}
                </p>
              )}
            </form>
          )}

          {s.budgetReached ? (
            <div className="flex flex-col gap-1.5">
              <p className="text-xs text-muted-foreground">この会話には、もう送れません。</p>
              <Button type="button" size="sm" className="self-start" onClick={() => s.startOver()}>
                新しく始める
              </Button>
            </div>
          ) : (
            <form
              className="flex flex-col gap-1.5"
              aria-label="AI への送信"
              onSubmit={(e) => {
                e.preventDefault()
                submit()
              }}
            >
              <Textarea
                aria-label="AI への指示や質問"
                className="min-h-14 text-xs"
                rows={2}
                value={text}
                disabled={unavailable || statusFailed}
                placeholder="⌘+Enter(Windows は Ctrl+Enter)で送ります"
                onChange={(e) => setText(e.target.value)}
                onKeyDown={onKeyDown}
              />
              <div className="flex flex-wrap items-center gap-2">
                <Button type="submit" size="sm" disabled={blocked !== null || text.trim() === ''}>
                  送る
                </Button>
                {stoppable && (
                  <Button type="button" size="sm" variant="outline" onClick={() => void s.stop()}>
                    止める
                  </Button>
                )}
                {blocked && blocked !== 'unavailable' && (
                  <span role="status" className="text-xs text-muted-foreground">
                    {blocked}
                  </span>
                )}
              </div>
            </form>
          )}

          <p className="text-[11px] text-muted-foreground">{SEND_INFO_NOTE}</p>
          {s.usage && (
            <p className="text-[11px] text-muted-foreground">
              {usageText(s.usage)}
              <span className="block">定価で数えた額で、請求額とは違うことがあります</span>
            </p>
          )}
          <SentLog entries={s.sentLog} />
        </div>
      </div>
    </section>
  )
}
