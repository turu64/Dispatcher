import { Loader2, Sparkles } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import ChatPanel from '@/components/chat/ChatPanel'
import type { ChatStoreHook } from '@/components/chat/chatStatus'
import { stepLabel } from '@/components/chat/stepLabel'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useChatStore, type ChatItem } from '@/store/chat'
import { draftName, useEditStore } from '@/store/edit'
import { useSidePanelStore, type SidePanelTab } from '@/store/sidePanel'
import { useStepStore } from '@/store/steps'
import StepNav from './StepNav'
import StepPanels from './StepPanels'
import Stepper from './Stepper'

/** 「AI に相談」のタブの印と読み上げで数える発言(AI の返答・下書きの知らせ・エラー)のうち、最後のもの */
function lastNoticeable(items: readonly ChatItem[]): ChatItem | undefined {
  for (let i = items.length - 1; i >= 0; i--) {
    const kind = items[i].kind
    if (kind === 'assistant' || kind === 'draft' || kind === 'error') return items[i]
  }
  return undefined
}

/**
 * 見たかどうかを比べる鍵。AI の返答は最初の一部が届いた時点で発言になるので、流れている途中か終わったかも含める
 * (流れ始めを見てから「編集」に移ったときも、返答が終われば点を出すため)
 */
function noticeKey(item: ChatItem | undefined): string | undefined {
  if (!item) return undefined
  return item.kind === 'assistant' ? `${item.id}:${item.streaming ? 1 : 0}` : String(item.id)
}

/**
 * 「AI に相談」のタブの名前の横の印。「編集」のタブを開いている間に、AI が返答している(スピナー)、
 * または見ていない新しい発言がある(点)ときに出す。AI のタブを開いたら、見ていない印を消す
 */
function ChatTabMark({ store, open }: { store: ChatStoreHook; open: boolean }) {
  const replying = store((s) => s.replying)
  const latest = store((s) => noticeKey(lastNoticeable(s.items)))
  const [seen, setSeen] = useState(latest)
  if (open && seen !== latest) setSeen(latest)
  if (open) return null
  if (replying) {
    return (
      <>
        <Loader2 className="size-3.5 animate-spin text-muted-foreground" aria-hidden="true" />
        <span className="sr-only">(返答中)</span>
      </>
    )
  }
  if (latest !== undefined && latest !== seen) {
    return (
      <>
        <span className="size-2 rounded-full bg-primary" aria-hidden="true" />
        <span className="sr-only">(新しい発言あり)</span>
      </>
    )
  }
  return null
}

/** 「編集」のタブを開いている間に増えた発言の、読み上げの文 */
function announceText(item: ChatItem): string {
  switch (item.kind) {
    case 'draft':
      return `${draftName(item.draftId)} を作りました。${stepLabel(item.step)}で確かめて承認してください。`
    case 'error':
      return 'AI との会話でエラーが出ました。「AI に相談」のタブで確かめてください。'
    default:
      return 'AI が返答しました。「AI に相談」のタブで読めます。'
  }
}

/**
 * 「編集」のタブを開いている間は、会話の箱(aria-live)が隠れていて読み上げられないので、
 * 下書き・返答の終わり・エラーを、隠れない場所の role="status" で知らせる。
 * 「AI に相談」のタブを開いている間は入れない(会話の箱と二重に読まないため)
 */
function ChatAnnouncer({ store, open }: { store: ChatStoreHook; open: boolean }) {
  const item = store((s) => lastNoticeable(s.items))
  const [seen, setSeen] = useState(item)
  const [message, setMessage] = useState('')
  if (item !== seen) {
    setSeen(item)
    if (!open && item && !(item.kind === 'assistant' && item.streaming)) setMessage(announceText(item))
  }
  if (open && message !== '') setMessage('')
  return (
    <p role="status" className="sr-only">
      {message}
    </p>
  )
}

/**
 * 左の欄。上の端のタブで「編集」(手順の見出し・開いている手順の中身・下の「戻る」「次へ」)と「AI に相談」を切り替える。
 * GTFS を読み込む前からタブを出す(「AI に相談」は、読み込むまでは案内と読み込みの手順へのボタンだけ)。どちらのタブの中身も消さずに隠す
 * (入力中の文、会話と手順のスクロールの位置、手順の入力中の値を残すため)。
 * wide は、地図を隠して左の欄を広げている手順か(中身の幅を抑えて中央にそろえる)。
 * chatStore はテストで別の store を渡すためのもの
 */
export default function SidePanel({ wide, chatStore = useChatStore }: { wide: boolean; chatStore?: ChatStoreHook }) {
  const loaded = useEditStore((s) => s.base !== null)
  const pendingDraft = useEditStore((s) => s.draft !== null)
  const selected = useSidePanelStore((s) => s.tab)
  const tab: SidePanelTab = selected
  const current = useStepStore((s) => s.current)

  // 手順を切り替えたら、左の欄の先頭から見せる
  const scrollRef = useRef<HTMLDivElement>(null)
  const savedTop = useRef(0)
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = 0
    savedTop.current = 0
  }, [current])
  // 「編集」のタブに戻ったら、前のスクロールの位置に戻す(隠すと位置が 0 に戻るブラウザがあるため)
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (tab === 'edit' && el) el.scrollTop = savedTop.current
  }, [tab])

  // 「AI に相談」のタブを開いたまま印刷(Ctrl+P)すると、編集の中身(変更指示書・周知文の .print-area)が
  // 隠れたままでほぼ白紙になるため、印刷の直前に「編集」のタブへ切り替える。
  // beforeprint の中で描画を終えないと印刷に間に合わないので flushSync で反映する
  useEffect(() => {
    const onBeforePrint = () => {
      if (useSidePanelStore.getState().tab !== 'edit') flushSync(() => useSidePanelStore.getState().show('edit'))
    }
    window.addEventListener('beforeprint', onBeforePrint)
    return () => window.removeEventListener('beforeprint', onBeforePrint)
  }, [])

  // タブの中身(tabpanel)には Tab キーで止まらない(Radix の既定の 0 だと、手順の見出しの前に余分な止まりができるため)
  const panelProps = { tabIndex: -1 }

  return (
    <aside className="flex h-full flex-col bg-muted/30" aria-label="手順と AI に相談">
      <Tabs value={tab} onValueChange={(v) => useSidePanelStore.getState().show(v as SidePanelTab)} className="flex min-h-0 flex-1 flex-col gap-0">
        <div className="print-hide shrink-0 border-b bg-background px-3 py-2">
          {/*
            タブの列の位置は、どちらのタブを開いていても同じにする(押したタブがポインターの下から動かないように)。
            地図を隠す広い手順では、中身(編集は max-w-5xl、会話は max-w-3xl)の幅が違うので、タブの列を中央にそろえる。
            地図を出す手順では、外側の余白 12px に 4px を足して、下の中身(編集・会話とも左の余白 16px)の左の端に合わせる
          */}
          <div className={wide ? 'flex justify-center' : 'px-1'}>
            <TabsList aria-label="左の欄の表示" className="flex w-full max-w-sm">
              <TabsTrigger value="edit">
                編集
                {pendingDraft && (
                  <Badge variant="secondary" className="h-4 px-1.5 text-[10px]">
                    {/* 読み上げでは「編集(承認待ち)」と区切る */}
                    <span className="sr-only">(</span>承認待ち<span className="sr-only">)</span>
                  </Badge>
                )}
              </TabsTrigger>
              <TabsTrigger value="chat">
                AI に相談
                <ChatTabMark store={chatStore} open={tab === 'chat'} />
              </TabsTrigger>
            </TabsList>
          </div>
          <ChatAnnouncer store={chatStore} open={tab === 'chat'} />
        </div>

        <TabsContent value="edit" forceMount hidden={tab !== 'edit'} className="flex min-h-0 flex-1 flex-col" {...panelProps}>
          <Stepper wide={wide} />
          <div
            ref={scrollRef}
            className="min-h-0 flex-1 overflow-y-auto"
            onScroll={(e) => {
              if (tab === 'edit') savedTop.current = e.currentTarget.scrollTop
            }}
          >
            <div className={wide ? 'mx-auto flex w-full max-w-5xl flex-col gap-4 p-4' : 'flex flex-col gap-4 p-4'}>
              <StepPanels />
            </div>
          </div>
          <StepNav />
        </TabsContent>

        <TabsContent value="chat" forceMount hidden={tab !== 'chat'} className="flex min-h-0 flex-1 flex-col bg-background" {...panelProps}>
          {loaded ? <ChatPanel store={chatStore} active={tab === 'chat'} /> : <ChatBeforeLoad />}
        </TabsContent>
      </Tabs>
    </aside>
  )
}

/**
 * GTFS を読み込む前の「AI に相談」のタブ。会話は GTFS の読み込みで始まり、読み込み直しで終わる(docs/interfaces-1105.md)ので、
 * 読み込むまでは会話の欄を出さず、読み込みの手順へ移るボタンだけを出す
 */
function ChatBeforeLoad() {
  return (
    <section aria-label="AI に相談" className="print-hide flex min-h-0 flex-1 flex-col overflow-y-auto px-4 py-4">
      <div className="mx-auto my-auto flex w-full max-w-md flex-col items-center gap-3 text-center">
        <span aria-hidden="true" className="flex size-8 items-center justify-center rounded-full bg-primary/10 text-primary ring-1 ring-primary/15">
          <Sparkles className="size-4" />
        </span>
        <div className="flex flex-col gap-1">
          <p className="text-sm font-medium">GTFS を読み込むと、AI に相談できます</p>
          <p className="text-xs leading-relaxed text-muted-foreground">
            AI は読み込んだ GTFS をもとに、減便の方針の下書きや、平日に戻す便の候補を出します。
          </p>
        </div>
        <Button
          type="button"
          size="sm"
          onClick={() => {
            useSidePanelStore.getState().show('edit')
            useStepStore.getState().go('load')
          }}
        >
          手順「読み込み」を開く
        </Button>
      </div>
    </section>
  )
}
