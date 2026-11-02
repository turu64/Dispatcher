import { create } from 'zustand'
import type { GtfsFeed } from '../gtfs/load'
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
  setLoaded: (loaded: LoadedGtfs) => void
  /** 読み込み直す前に、前の GTFS を捨てる */
  clear: () => void
}

/**
 * 読み込んだ GTFS を持つ。GTFS はブラウザの中だけに置き、サーバーには送らない。
 * 使う側は `useGtfsStore((s) => s.feed)` のように、必要な値だけ選んで読む。
 */
export const useGtfsStore = create<GtfsState>()((set) => ({
  feed: null,
  label: null,
  sample: null,
  setLoaded: ({ label, feed, sample }) => set({ feed, label, sample: sample ?? null }),
  clear: () => set({ feed: null, label: null, sample: null }),
}))
