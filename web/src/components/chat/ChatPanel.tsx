import { ArrowUp, CircleAlert, Info, Search, Sparkles, Square } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import {
  canStop,
  CLAUDE_UNAVAILABLE,
  isPreparing,
  PREPARING,
  RECONNECTING,
  researchText,
  RESEARCH_KEEP_OPEN,
  SEND_INFO_NOTE,
  SENDING,
  sendBlockedReason,
  THINKING,
  useChatStore,
  usageText,
} from '@/store/chat'
import { useEditStore } from '@/store/edit'
import { useSidePanelStore } from '@/store/sidePanel'
import ChatMessages, { AiAvatar, TypingDots } from './ChatMessages'
import SentLog from './SentLog'
import { useEnsureChatStatus, type ChatStoreHook } from './chatStatus'

/**
 * 会話が空のときの例文の札。押すと入力欄に入る(送らない。送るのは利用者が「送る」を押したとき)。
 * どれも AI のツールで答えられるもの。減便の方針がまだ無いうちは方針の下書き(apply_policy)の例、
 * 方針を承認したか下書きがあれば、平日に戻す候補(search_trips)と影響(summarize_impact)の例を出す
 * (この2つは方針が無いと答えられないため)
 */
const POLICY_EXAMPLES = ['平日を土曜ダイヤにしてください。期間は 11/9 から当面の間', '平日を日祝ダイヤにしてください。期間は 11/16 から 11/30 まで'] as const
const AFTER_POLICY_EXAMPLES = [
  '通学・通院に使われる便のうち、平日に戻したほうがよい便の候補を教えてください',
  '減便すると、到達圏から外れる区画や発車がなくなる停留所はどれくらいありますか',
] as const

/**
 * 左の欄の「AI に相談」のタブの中身(docs/interfaces-1105.md §6.4)。左の欄の高さいっぱいに出す。GTFS を読み込むまでは出さない。
 * どの手順を開いていても同じ中身(方針の指示と質問は、どの手順からも出るため)。タブを切り替えても消さずに隠す(入力中の文を残すため)。
 * 方針の指示と質問だけを送る(操作はほかの手順のボタンで行う)。AI が使えなくても、ほかの手順はすべてボタンで動く。
 * 会話の箱は overscroll-behavior: contain にし、中のスクロールが端に着いても左の欄やページに伝わらないようにする。
 * active は、このタブを開いているか(隠れている間は会話の箱の高さが 0 になるため、開いたときに位置を合わせ直す)
 */
export default function ChatPanel({ store = useChatStore, active = true }: { store?: ChatStoreHook; active?: boolean }) {
  const base = useEditStore((s) => s.base)
  if (!base) return null
  return <ChatPanelBody store={store} active={active} />
}

function ChatPanelBody({ store, active }: { store: ChatStoreHook; active: boolean }) {
  const s = store()
  const hasPolicy = useEditStore((e) => e.history.length > 0 || e.draft !== null)
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

  // 手順の「AI に候補を聞く」などで利用者の文が増えたら(利用者が押した操作なので)、左の欄を「AI に相談」のタブにする。
  // AI が下書きを作ったとき(draft)は切り替えない(「編集」のタブに「承認待ち」の印が出て、知らせの「編集で確かめる」で移る)
  const last = s.items[s.items.length - 1]
  const lastId = last?.id
  const lastKind = last?.kind
  // 隠れていたこのタブに切り替えたときは、押したボタン(隠れた「編集」のタブの中)にあった焦点を、開いた後で会話の箱に移す
  const seenId = useRef(lastId)
  const focusOnShow = useRef(false)
  useEffect(() => {
    if (lastId === seenId.current) return
    seenId.current = lastId
    if (lastKind !== 'user') return
    if (!active) focusOnShow.current = true
    useSidePanelStore.getState().show('chat')
  }, [lastId, lastKind, active])
  useEffect(() => {
    if (!active || !focusOnShow.current) return
    focusOnShow.current = false
    listRef.current?.focus({ preventScroll: true })
  }, [active])

  // 新しい発言が出たら、いちばん下まで流す。隠れている間に増えた分は、タブを開いたときに流す。
  // 増えていなければ、開いたときに前のスクロールの位置に戻す(隠すと位置が 0 に戻るブラウザがあるため)
  const textLength = last?.kind === 'assistant' ? last.text.length : 0
  const contentKey = `${s.items.length}:${textLength}:${s.replying ? 1 : 0}`
  const shownKey = useRef<string | null>(null)
  const savedTop = useRef(0)
  useLayoutEffect(() => {
    const el = listRef.current
    if (!active || !el) return
    if (shownKey.current !== contentKey) el.scrollTop = el.scrollHeight
    else el.scrollTop = savedTop.current
    shownKey.current = contentKey
  }, [contentKey, active])

  const status = s.status
  const unavailable = status.state === 'ready' && !status.available
  const statusFailed = status.state === 'error'
  const checking = status.state === 'unknown' || status.state === 'loading'
  const needToken = status.state === 'ready' && status.available && status.tokenRequired && !s.token
  const blocked = unavailable || statusFailed || checking || needToken ? 'unavailable' : sendBlockedReason(s)
  const research = researchText(s.research)
  const stoppable = canStop(s)
  const preparing = isPreparing(s)

  // 「送る」を押して送っている間(送信の POST が終わるまで)だけ、このボタンを処理中の形にする。
  // store の sending は周辺の施設の調査・「AI に候補を聞く」の送信でも立つので、押していないボタンを処理中にしないよう、ここで持つ
  const [submitting, setSubmitting] = useState(false)

  function submit() {
    const t = text.trim()
    if (t === '' || blocked !== null) return
    setText('')
    setSubmitting(true)
    void s.send(t).finally(() => setSubmitting(false))
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

  // 例文の札を押したら、入力欄が空のときだけ入れて(書きかけを消さない)、焦点を移す(送らない)
  const boxRef = useRef<HTMLTextAreaElement>(null)
  function pickExample(example: string) {
    setText((p) => (p.trim() === '' ? example : p))
    boxRef.current?.focus()
  }

  const empty = s.items.length === 0 && !checking && !unavailable && !statusFailed
  const examples = hasPolicy ? AFTER_POLICY_EXAMPLES : POLICY_EXAMPLES
  // AI の返答が流れている間は、返答の吹き出しの中に入力中の点を出す(下の「考えています…」の行には出さない)。
  // 吹き出しに点を出すのは最後の発言のときだけ(ChatMessages)なので、点は常に1組
  const streaming = last?.kind === 'assistant' && last.streaming

  return (
    // 名前は外側のタブの中身(tabpanel「AI に相談」)が持つので、ここでは付けない(読み上げで二重にしない)
    <section className="print-hide flex min-h-0 flex-1 flex-col">
      {/* 地図を隠す手順では左の欄が広いので、会話が横に伸びすぎないよう幅を抑えて中央にそろえる */}
      <div className="mx-auto flex min-h-0 w-full max-w-3xl flex-1 flex-col gap-3 px-4 pt-3 pb-3">
        {/*
          会話が空のときの案内と例文の札は、会話の箱(role=log・aria-live)の外に置く
          (状態が分かって案内が出たときに、会話の発言として読み上げないため。操作の部品を log の中に入れないため)
        */}
        {empty && (
          <div className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain px-2 py-4 text-center">
            {/* 案内は縦の中央に置く(中身が欄より高いときは上から見せるため、justify-center ではなく my-auto) */}
            <div className="my-auto flex w-full flex-col items-center gap-3">
            <span aria-hidden="true" className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary ring-1 ring-primary/15">
              <Sparkles className="size-4" />
            </span>
            <div className="flex flex-col gap-1">
              <p className="text-sm font-medium">減便の方針の指示や質問を送れます</p>
              <p className="text-xs leading-relaxed text-muted-foreground">
                AI は GTFS を直接書き換えず、下書きを作成します。内容を確かめてから「承認する」を押してください。
              </p>
            </div>
            <div role="group" aria-label="例文(押すと入力欄に入ります)" className="flex w-full max-w-md flex-col items-stretch gap-1.5">
              {examples.map((example) => (
                <Button
                  key={example}
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-auto justify-start rounded-xl px-3 py-1.5 text-left text-xs leading-snug font-normal whitespace-normal text-muted-foreground hover:text-foreground"
                  onClick={() => pickExample(example)}
                >
                  {example}
                </Button>
              ))}
            </div>
            </div>
          </div>
        )}
        <div
          ref={listRef}
          role="log"
          aria-label="AI との会話"
          aria-live="polite"
          tabIndex={-1}
          className={`${empty ? '-mt-3 min-h-0 flex-none' : 'min-h-16 flex-1'} overflow-y-auto overscroll-contain rounded-sm pr-1.5 [scrollbar-gutter:stable] outline-none focus-visible:ring-2 focus-visible:ring-ring/50`}
          onScroll={(e) => {
            if (active) savedTop.current = e.currentTarget.scrollTop
          }}
        >
          <ChatMessages items={s.items} store={store} />
          {(preparing || s.replying) && (
            <div className={`flex items-center gap-2 ${streaming ? 'mt-1.5 pl-9' : 'mt-3'}`}>
              {!streaming && (
                <>
                  <AiAvatar />
                  <span className="flex h-8 items-center rounded-2xl rounded-tl-sm bg-muted px-3 text-muted-foreground">
                    <TypingDots />
                  </span>
                </>
              )}
              <div className="flex min-w-0 flex-col">
                {preparing && (
                  <p role="status" className="text-xs text-muted-foreground">
                    {PREPARING}
                  </p>
                )}
                {s.replying && (
                  <p role="status" className="text-xs text-muted-foreground">
                    {THINKING}
                  </p>
                )}
              </div>
            </div>
          )}
          {s.connection === 'reconnecting' && (
            <p role="status" className="mt-2 pl-9 text-xs text-muted-foreground">
              {RECONNECTING}
            </p>
          )}
          {research && (
            <div className="mt-3 ml-9 flex items-start gap-2 rounded-lg border bg-muted/40 px-2.5 py-2">
              <Search className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
              <p role="status" className="min-w-0 text-xs">
                {research}
                {s.research.active && <span className="block text-muted-foreground">{RESEARCH_KEEP_OPEN}</span>}
              </p>
            </div>
          )}
        </div>

        <div className="flex max-h-[50%] shrink-0 flex-col gap-2 overflow-y-auto overscroll-contain">
          {checking && <p className="text-xs text-muted-foreground">AI の状態を確かめています…</p>}
          {unavailable && (
            <Alert role="status" className="px-3 py-2 text-xs">
              <Info aria-hidden="true" />
              <AlertDescription className="text-xs">
                {CLAUDE_UNAVAILABLE}ほかの手順はすべてボタンで使えます。
              </AlertDescription>
            </Alert>
          )}
          {status.state === 'error' && (
            <div className="flex flex-col items-start gap-1.5">
              <Alert variant="destructive" className="border-destructive/30 bg-destructive/5 px-3 py-2 text-xs">
                <CircleAlert aria-hidden="true" />
                <AlertDescription className="text-xs">{status.message}</AlertDescription>
              </Alert>
              {/* ボタンは知らせ(role=alert)の外に置く(読み上げの領域の中に操作を入れない) */}
              <Button type="button" size="sm" variant="outline" onClick={() => void s.loadStatus()}>
                もう一度確かめる
              </Button>
            </div>
          )}
          {(needToken || s.tokenError) && status.state === 'ready' && status.tokenRequired && (
            <form className="flex flex-col gap-1.5 rounded-lg border bg-muted/30 p-2.5" onSubmit={onToken} aria-label="認証コードの入力">
              <Label htmlFor="chat-token" className="text-xs">
                認証コード
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
                <p role="alert" className="flex items-center gap-1 text-xs text-destructive">
                  <CircleAlert className="size-3.5 shrink-0" aria-hidden="true" />
                  {s.tokenError}
                </p>
              )}
            </form>
          )}

          {s.budgetReached ? (
            <div className="flex flex-col gap-1.5 rounded-lg border bg-muted/30 p-2.5">
              <p className="text-xs text-muted-foreground">この会話にはもう送れません。</p>
              <Button type="button" size="sm" className="self-start" onClick={() => s.startOver()}>
                新しく始める
              </Button>
            </div>
          ) : (
            <form
              aria-label="AI への送信"
              onSubmit={(e) => {
                e.preventDefault()
                submit()
              }}
            >
              {/* 入力欄と送るボタンを1つの枠に入れる。入力欄は文の長さに合わせて伸びる(上限を超えたら中でスクロール) */}
              <div
                data-slot="composer"
                className="flex flex-col rounded-xl border border-input bg-background shadow-xs transition-colors focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50 has-[textarea:disabled]:bg-muted/50 dark:bg-input/30"
              >
                <Textarea
                  ref={boxRef}
                  aria-label="AI への指示や質問"
                  className="field-sizing-content max-h-[min(10rem,25dvh)] min-h-14 resize-none overflow-y-auto rounded-xl border-0 bg-transparent px-3 pt-2.5 pb-1 text-sm shadow-none focus-visible:ring-0 disabled:bg-transparent md:text-sm dark:bg-transparent dark:disabled:bg-transparent"
                  rows={2}
                  value={text}
                  disabled={unavailable || statusFailed}
                  placeholder="⌘+Enter(Windows は Ctrl+Enter)で送ります"
                  onChange={(e) => setText(e.target.value)}
                  onKeyDown={onKeyDown}
                />
                <div className="flex items-end gap-2 px-2 pb-2">
                  {/* 準備中の「AI を準備しています…」と、「送る」で送っている間の処理中のボタンのほかは、理由の文を出す */}
                  <div className="min-w-0 flex-1 pb-1 pl-1">
                    {blocked && blocked !== 'unavailable' && !(blocked === SENDING && (submitting || preparing)) && (
                      <span role="status" className="text-xs text-muted-foreground">
                        {blocked}
                      </span>
                    )}
                  </div>
                  {stoppable && (
                    <Button type="button" size="sm" variant="outline" className="rounded-full" onClick={() => void s.stop()}>
                      <Square data-icon="inline-start" className="fill-current" aria-hidden="true" />
                      止める
                    </Button>
                  )}
                  {/* 「送る」で送っている間は送るボタンを処理中の形にし、「送っています…」の文は出さない(処理中の知らせはボタンだけ) */}
                  <Button
                    type="submit"
                    size="icon-sm"
                    className="rounded-full"
                    disabled={blocked !== null || text.trim() === ''}
                    loading={submitting}
                    loadingLabel="送信中"
                  >
                    <ArrowUp aria-hidden="true" />
                    <span className="sr-only">送る</span>
                  </Button>
                </div>
              </div>
            </form>
          )}

          {/* 送る情報の注意と利用額は、入力欄の下に小さくまとめる */}
          <div className="flex flex-col gap-1 px-1 text-[11px] leading-snug text-muted-foreground">
            <p>{SEND_INFO_NOTE}</p>
            {s.usage && (
              <p>
                {usageText(s.usage)}
                <span className="block">定価で数えた額で、請求額とは違うことがあります。</span>
              </p>
            )}
            <SentLog entries={s.sentLog} />
          </div>
        </div>
      </div>
    </section>
  )
}
