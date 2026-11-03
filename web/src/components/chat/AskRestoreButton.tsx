import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { SENDING, useChatStore } from '@/store/chat'
import { askRestoreBlockedReason, useEnsureChatStatus, type ChatStoreHook } from './chatStatus'

/**
 * 足し戻しの手順の「AI に候補を聞く」ボタン(docs/interfaces-1105.md §6.4)。
 * 方針が承認され(この部品は方針の承認後にだけ置く)、AI が使えるときだけ押せる。押すと、候補を選ぶ依頼の文を送る。
 * このボタンで送っている間(送信の POST が終わるまで)だけ、ボタンを処理中の形にする(「送っています…」の文は出さない)。
 * store の sending は「AI に相談」のタブの「送る」や前提情報の調査でも立つので、そのときは押せなくするだけで処理中の形にはしない。
 * 送ると左の欄は「AI に相談」のタブに切り替わる(chat/ChatPanel が利用者の文を見て切り替える)。
 * 返答は「AI に相談」のタブに、平日に戻す下書きはこの手順の欄に出る
 */
export function AskRestoreButton({ blocked = null, store = useChatStore }: { blocked?: string | null; store?: ChatStoreHook }) {
  useEnsureChatStatus(store)
  const reason = store((s) => askRestoreBlockedReason(s)) ?? blocked
  const [pending, setPending] = useState(false)
  // このボタンで送っている間は処理中のボタンが知らせるので、送信中の理由を文に出さない。ほかで送っている間は理由を出す
  const note = reason === SENDING && pending ? null : reason
  return (
    <div className="flex flex-col gap-1">
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="self-start"
        disabled={reason !== null}
        loading={pending}
        loadingLabel="送信中"
        onClick={() => {
          setPending(true)
          void store
            .getState()
            .askRestore()
            .finally(() => setPending(false))
        }}
      >
        AI に候補を聞く
      </Button>
      {note ? (
        <p className="text-xs text-muted-foreground">{note}</p>
      ) : (
        <p className="text-xs text-muted-foreground">AI が、判断材料と停留所名から平日に戻したほうがよい便を選び、理由つきの下書きにします。承認は利用者が押します。</p>
      )}
    </div>
  )
}
