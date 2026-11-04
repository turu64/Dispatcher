import { useChatStore } from './chat'
import { useEditStore } from './edit'
import { useGtfsStore } from './gtfs'
import { useMapStore } from './map'
import { usePriorityStore } from './priority'
import { REACH_VIEW_DEFAULTS, reachSettingDefaults, useReachStore } from './reach'
import { useResearchStore } from './research'
import { useServiceGroupsStore } from './serviceGroups'
import { useSidePanelStore } from './sidePanel'
import { useStepStore } from './steps'

/**
 * なぜ最初の状態に戻すか。
 * - reload:別の GTFS を読み込み直す前(LoadStep の open)。AI との会話は「読み込み直したため…」の知らせを残して終える
 * - delete:読み込んだ GTFS を削除したとき(LoadStep の「読み込んだ GTFS を削除」)。会話の発言も消し、画面を開いた直後と同じにする
 */
export type ResetReason = 'reload' | 'delete'

/**
 * 読み込んだ GTFS にかかわる状態を、画面を開いた直後と同じに戻す。GTFS の読み込み直しと削除は、どちらもここを通す。
 * **store を足したら、GTFS ごとの状態はここで初期値に戻すこと**(各 store の初期値の定義を使う)。
 *
 * 戻すもの(並びは呼ぶ順):
 * 1. store/gtfs:読み込んだ GTFS(clear)
 * 2. store/reach:到達圏の基準・編集後・計算の結果(setSource(null)。計算の番号を進めるので、Web Worker で計算中の結果は捨てる)と、
 *    地図の塗り分け・表示する時間帯(REACH_VIEW_DEFAULTS)。編集の store より先に捨てる(先に基準を捨てると、編集後を null にしたときに
 *    古い基準で計算し直してしまうため)
 *    削除では、到達圏の条件(しきい値・分数・時間帯の幅・区分。reachSettingDefaults)も戻す
 * 3. store/edit:編集の履歴・下書き・出力の feed_version(setBase(null))。これを見張って、ほかの store も戻る(下の「見張り」)。
 *    削除では、下書きの番号も 1 からに戻す(会話の発言も消えるので、前の「下書き #N」と重ならない)
 * 4. store/map:地図の施設の強調
 * 5. store/research:前提情報の手順の施設・事業者・選択・調査の結果・デモの調査結果(reset)
 * 6. store/serviceGroups:ダイヤのグループ分け(判断材料・案・利用者の直し・確定・Jev の答え)。Jev に送っている問い合わせは中断し、
 *    届いた答えを捨てる。Jev に送るかのスイッチは、読み込み直しでも削除でも残す(送るのを止めた選択を黙って戻さないため)
 * 7. store/chat:AI との会話。セッションを終え(DELETE /api/claude/session を keepalive で送る)、発言の一覧を消す(reset)
 * 8. store/steps:開いている手順を先頭(読み込み)に。store/sidePanel:左の欄のタブを「編集」に
 * 9. store/priority:重要拠点の優先順位(削除だけ)
 *
 * 見張り:3 の setBase(null) で、store/chat(watchBase。会話を終え、会話があれば RELOAD_NOTICE を出す)・store/steps・
 * store/sidePanel が、1 の clear で store/research・store/serviceGroups が、自分で戻る。ここでも呼ぶのは、戻すものを1か所で読めるようにするため
 * (2回呼んでも同じ結果になる。セッションの取っ手は1回目で捨てるので、DELETE は1回だけ)。
 *
 * 読み込み直しでは、利用者の設定(到達圏の条件・重要拠点の優先順位)と下書きの番号は残す(別の GTFS でも同じ条件で比べられるように。
 * 番号は、会話の欄に残る前の発言と重ならないように)。
 *
 * 戻さないもの:祝日一覧(store/holidays)、到達圏の参照データの取得の使い回し(store/reach の ref)、認証コード、
 * 地図(store/map の map)と地図の表示範囲(次の GTFS を読み込むと、その停留所に合わせ直す)、左の欄の幅などの見た目の設定。
 * Web Worker で動いている到達圏の計算は止めず、結果を捨てる(Worker は1つなので、すぐ次を読み込むと、前の計算の終わりを待つ)。
 * 手順の部品の中の値(出力の手順の前の出力の表示など)は、各部品が編集の基準(base)の変化を見て消す
 */
export function resetAll(reason: ResetReason): void {
  useGtfsStore.getState().clear()

  const deleting = reason === 'delete'

  // source が null なので、条件を戻しても計算は走らない
  useReachStore.getState().setSource(null)
  useReachStore.setState({ ...REACH_VIEW_DEFAULTS, ...(deleting ? reachSettingDefaults() : {}) })

  useEditStore.getState().setBase(null, { resetDraftIds: deleting })

  useMapStore.getState().setHighlighted(null)

  useResearchStore.getState().reset()

  useServiceGroupsStore.getState().reset()

  // 読み込み直しでは、見張り(watchBase)が会話を終えて「読み込み直したため…」の知らせを出している。
  // 削除では知らせも残さず、発言の一覧を空にする(「AI に相談」は読み込む前の案内に戻る)
  if (deleting) useChatStore.getState().reset()

  const { order, current } = useStepStore.getState()
  if (current !== order[0]) useStepStore.setState({ current: order[0] })
  useSidePanelStore.getState().show('edit')

  if (deleting) usePriorityStore.getState().reset()
}
