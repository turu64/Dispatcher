import { Loader2 } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import ChatPanel from '@/components/chat/ChatPanel'
import type { ChatStoreHook } from '@/components/chat/chatStatus'
import { stepLabel } from '@/components/chat/stepLabel'
import { Badge } from '@/components/ui/badge'
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
 * GTFS を読み込むまではタブを出さず、編集の中身だけを出す。どちらのタブの中身も消さずに隠す
 * (入力中の文、会話と手順のスクロールの位置、手順の入力中の値を残すため)。
 * wide は、地図を隠して左の欄を広げている手順か(中身の幅を抑えて中央にそろえる)。
 * chatStore はテストで別の store を渡すためのもの
 */
export default function SidePanel({ wide, chatStore = useChatStore }: { wide: boolean; chatStore?: ChatStoreHook }) {
  const loaded = useEditStore((s) => s.base !== null)
  const pendingDraft = useEditStore((s) => s.draft !== null)
  const selected = useSidePanelStore((s) => s.tab)
  const tab: SidePanelTab = loaded ? selected : 'edit'
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

  // GTFS を読み込むまでは、タブの中身をタブの部品(tabpanel)として名乗らない(タブの列が無いため)
  const panelProps = loaded ? { tabIndex: -1 } : { role: undefined, 'aria-labelledby': undefined, tabIndex: undefined }

  return (
    <aside className="flex h-full flex-col bg-muted/30" aria-label="手順と AI に相談">
      <Tabs value={tab} onValueChange={(v) => useSidePanelStore.getState().show(v as SidePanelTab)} className="flex min-h-0 flex-1 flex-col gap-0">
        <div hidden={!loaded} className="print-hide shrink-0 border-b bg-background px-3 py-2">
          {/* 地図を隠す広い手順では、タブの列の左の端を、下の手順の中身(中央にそろえた幅)に合わせる */}
          <div className={wide ? 'mx-auto w-full max-w-5xl px-1' : undefined}>
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
          <Stepper />
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
          <ChatPanel store={chatStore} active={tab === 'chat'} />
        </TabsContent>
      </Tabs>
    </aside>
  )
}
