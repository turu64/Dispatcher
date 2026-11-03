import type { RestoreHintContext } from '../gtfs/edit/restore'
import type { GtfsFeed } from '../gtfs/load'
import type { OriginStops } from '../reach/input'
import type { EditedSource, ReachSnapshot } from './reach'

/** buildRestoreHintContext が読む、到達圏の store の状態(useReachStore.getState() をそのまま渡せる) */
export interface ReachStateForHints {
  edited: EditedSource | null
  origins: OriginStops | null
  computing: boolean
  error: string | null
  snapshot: ReachSnapshot | null
}

// 同じ結果からは同じ ctx を返す(足し戻しの手がかりは、外れたセルの索引を ctx ごとに覚えておくため)
const cache = new WeakMap<ReachSnapshot, { origins: OriginStops; ctx: RestoreHintContext }>()

/**
 * 到達圏の store の状態から、足し戻しの手がかり(onlyServiceAtStop・restoresLostCells)の ctx を作る
 * (docs/interfaces-1105.md §7)。ctx は、同じ日付・同じ条件の基準と編集後の結果(同じ起点・同じセル・同じ時間帯)から作る。
 *
 * 前後の比較ができていなければ null を返す(画面とツールは、到達圏を使う2つの手がかりを出さない)。null になるのは:
 * - 編集後の GTFS が無い、または結果に基準(baseline)と比較(comparison)が無い
 * - 計算中(条件か編集後の GTFS が変わり、出ている結果が古い)、または計算に失敗した(出ている結果が古い)
 * - editedFeed を渡したとき、到達圏の store の編集後のフィードがそれと違う(承認前の下書きの結果など)
 *
 * 足し戻しの候補を、ある編集後のフィード(承認済みの版など)から作るときは、そのフィードを editedFeed に渡す。
 */
export function buildRestoreHintContext(state: ReachStateForHints, editedFeed?: GtfsFeed): RestoreHintContext | null {
  const { edited, origins, snapshot } = state
  if (!edited || !origins || !snapshot || state.computing || state.error !== null) return null
  if (editedFeed !== undefined && edited.feed !== editedFeed) return null
  const baseline = snapshot.baseline
  if (!baseline || !snapshot.comparison) return null

  const hit = cache.get(snapshot)
  if (hit && hit.origins === origins) return hit.ctx
  const ctx: RestoreHintContext = {
    before: baseline.departures,
    after: snapshot.departures,
    bands: snapshot.bands,
    beforeResult: baseline.result,
    afterResult: snapshot.result,
    date: snapshot.date,
    params: snapshot.params,
    stops: origins.stops,
  }
  cache.set(snapshot, { origins, ctx })
  return ctx
}
