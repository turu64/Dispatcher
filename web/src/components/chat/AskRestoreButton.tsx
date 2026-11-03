import { Button } from '@/components/ui/button'
import { useChatStore } from '@/store/chat'
import { askRestoreBlockedReason, useEnsureChatStatus, type ChatStoreHook } from './chatStatus'

/**
 * 足し戻しの手順の「AI に候補を聞く」ボタン(docs/interfaces-1105.md §6.4)。
 * 方針が承認され(この部品は方針の承認後にだけ置く)、AI が使えるときだけ押せる。押すと、候補を選ぶ依頼の文を送る。
 * 返答と足し戻しの下書きは「AI に相談」の欄と、この手順の欄に出る
 */
export function AskRestoreButton({ blocked = null, store = useChatStore }: { blocked?: string | null; store?: ChatStoreHook }) {
  useEnsureChatStatus(store)
  const reason = store((s) => askRestoreBlockedReason(s)) ?? blocked
  return (
    <div className="flex flex-col gap-1">
      <Button type="button" variant="outline" size="sm" className="self-start" disabled={reason !== null} onClick={() => void store.getState().askRestore()}>
        AI に候補を聞く
      </Button>
      {reason ? (
        <p className="text-xs text-muted-foreground">{reason}</p>
      ) : (
        <p className="text-xs text-muted-foreground">手がかりと停留所名から、足し戻したほうがよい便を選んで、理由つきの下書きにします。承認はあなたが押します。</p>
      )}
    </div>
  )
}
