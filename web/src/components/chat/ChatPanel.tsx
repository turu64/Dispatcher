import { useEffect, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
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
import ChatMessages from './ChatMessages'
import SentLog from './SentLog'
import { useEnsureChatStatus, type ChatStoreHook } from './chatStatus'

const EXAMPLE = '例:「平日を土曜ダイヤにしてください。期間は 11/9 から当面の間」'

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
  // store の sending は前提情報の調査・「AI に候補を聞く」の送信でも立つので、押していないボタンを処理中にしないよう、ここで持つ
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

  return (
    // 名前は外側のタブの中身(tabpanel「AI に相談」)が持つので、ここでは付けない(読み上げで二重にしない)
    <section className="print-hide flex min-h-0 flex-1 flex-col">
      {/* 地図を隠す手順では左の欄が広いので、会話が横に伸びすぎないよう幅を抑えて中央にそろえる */}
      <div className="mx-auto flex min-h-0 w-full max-w-3xl flex-1 flex-col gap-2 px-4 pt-2 pb-3">
        <div
          ref={listRef}
          role="log"
          aria-label="AI との会話"
          aria-live="polite"
          tabIndex={-1}
          className="min-h-16 flex-1 overflow-y-auto overscroll-contain rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          onScroll={(e) => {
            if (active) savedTop.current = e.currentTarget.scrollTop
          }}
        >
          {s.items.length === 0 && !checking && !unavailable && !statusFailed && (
            <p className="text-xs text-muted-foreground">
              減便の方針の指示や質問を送れます。{EXAMPLE}。AI は GTFS を直接書き換えず、下書きを作成します。内容を確かめてから「承認する」を押してください。
            </p>
          )}
          <ChatMessages items={s.items} />
          {preparing && (
            <p role="status" className="mt-2 text-xs text-muted-foreground">
              {PREPARING}
            </p>
          )}
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

        <div className="flex max-h-[50%] shrink-0 flex-col gap-2 overflow-y-auto overscroll-contain border-t pt-2">
          {checking && <p className="text-xs text-muted-foreground">AI の状態を確かめています…</p>}
          {unavailable && (
            <p role="status" className="text-xs">
              <span aria-hidden="true">! </span>
              {CLAUDE_UNAVAILABLE}ほかの手順はすべてボタンで使えます。
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
            <form className="flex flex-col gap-1.5" onSubmit={onToken} aria-label="認証コードの入力">
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
                <p role="alert" className="text-xs text-destructive">
                  <span aria-hidden="true">✕ </span>
                  {s.tokenError}
                </p>
              )}
            </form>
          )}

          {s.budgetReached ? (
            <div className="flex flex-col gap-1.5">
              <p className="text-xs text-muted-foreground">この会話にはもう送れません。</p>
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
                {/* 「送る」で送っている間は送るボタンを処理中の形にし、「送っています…」の文は出さない(処理中の知らせはボタンだけ) */}
                <Button type="submit" size="sm" disabled={blocked !== null || text.trim() === ''} loading={submitting} loadingLabel="送信中">
                  送る
                </Button>
                {stoppable && (
                  <Button type="button" size="sm" variant="outline" onClick={() => void s.stop()}>
                    止める
                  </Button>
                )}
                {/* 準備中の「AI を準備しています…」と、「送る」で送っている間の処理中のボタンのほかは、理由の文を出す */}
                {blocked && blocked !== 'unavailable' && !(blocked === SENDING && (submitting || preparing)) && (
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
              <span className="block">定価で数えた額で、請求額とは違うことがあります。</span>
            </p>
          )}
          <SentLog entries={s.sentLog} />
        </div>
      </div>
    </section>
  )
}
