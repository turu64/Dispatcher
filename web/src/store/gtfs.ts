import { create } from 'zustand'
import { feedServicePeriod } from '../gtfs/calendar'
import type { GtfsFeed } from '../gtfs/load'
import { toStops, type Stop } from '../gtfs/parse'
import type { SampleGtfsInfo } from '../gtfs/sample'

/** 読み込んだ GTFS と、その由来 */
export interface LoadedGtfs {
  /** 画面に出す名前(選んだファイル名、またはサンプルの名前) */
  label: string
  feed: GtfsFeed
  /** サンプルを読み込んだときの出典 */
  sample?: SampleGtfsInfo
}

interface GtfsState {
  /** 読み込んだ GTFS。まだ読み込んでいなければ null(後の手順はこれを読む) */
  feed: GtfsFeed | null
  label: string | null
  sample: SampleGtfsInfo | null
  /** stops.txt の停留所(toStops の結果。緯度経度が読めない行は除いてある) */
  stops: Stop[]
  /** 緯度経度が数でない・範囲外で、stops から除いた行の数 */
  invalidStops: number
  /** 運行期間(feedServicePeriod の結果)。運行日が1つも無ければ null */
  servicePeriod: { start: string; end: string } | null
  /** 読み込んだ GTFS を入れる。停留所と運行期間もここで求める */
  setLoaded: (loaded: LoadedGtfs) => void
  /** 読み込み直す前に、前の GTFS を捨てる */
  clear: () => void
}

/** 何も読み込んでいない状態(配列は毎回新しく作る) */
function empty(): Pick<GtfsState, 'feed' | 'label' | 'sample' | 'stops' | 'invalidStops' | 'servicePeriod'> {
  return { feed: null, label: null, sample: null, stops: [], invalidStops: 0, servicePeriod: null }
}

/**
 * 読み込んだ GTFS を持つ。GTFS はブラウザの中だけに置き、サーバーには送らない。
 * 使う側は `useGtfsStore((s) => s.feed)` のように、必要な値だけ選んで読む。
 */
export const useGtfsStore = create<GtfsState>()((set) => ({
  ...empty(),
  setLoaded: ({ label, feed, sample }) => {
    const { stops, invalid } = toStops(feed)
    set({ feed, label, sample: sample ?? null, stops, invalidStops: invalid, servicePeriod: feedServicePeriod(feed) })
  },
  clear: () => set(empty()),
}))
