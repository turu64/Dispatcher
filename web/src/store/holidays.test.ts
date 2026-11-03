import { describe, expect, it, vi } from 'vitest'
import type { HolidayList } from '../gtfs/holidays'
import { createHolidayStore } from './holidays'

function list(): HolidayList {
  return {
    names: new Map([['20261103', '文化の日']]),
    first: '19550101',
    coveredUntil: '20271231',
    source: '内閣府「国民の祝日について」の祝日一覧(syukujitsu.csv)を加工して作成',
  }
}

describe('createHolidayStore', () => {
  it('最初は idle', () => {
    const store = createHolidayStore({ fetchHolidays: async () => list() })
    expect(store.getState().holidays).toEqual({ status: 'idle' })
  })

  it('読み込み中は loading、読めたら ready で一覧を持つ', async () => {
    let resolve!: (l: HolidayList | null) => void
    const fetchHolidays = vi.fn(() => new Promise<HolidayList | null>((r) => (resolve = r)))
    const store = createHolidayStore({ fetchHolidays })
    const done = store.getState().load()
    expect(store.getState().holidays).toEqual({ status: 'loading' })
    const l = list()
    resolve(l)
    await done
    const s = store.getState().holidays
    expect(s.status).toBe('ready')
    if (s.status === 'ready') expect(s.list).toBe(l)
  })

  it('404(null)は missing', async () => {
    const store = createHolidayStore({ fetchHolidays: async () => null })
    await store.getState().load()
    expect(store.getState().holidays).toEqual({ status: 'missing' })
  })

  it('失敗は error で、メッセージを持つ', async () => {
    const store = createHolidayStore({
      fetchHolidays: async () => {
        throw new Error('祝日一覧を取得できませんでした(500)。')
      },
    })
    await store.getState().load()
    expect(store.getState().holidays).toEqual({ status: 'error', message: '祝日一覧を取得できませんでした(500)。' })
  })

  it('Error でない値を投げられてもメッセージを持つ', async () => {
    const store = createHolidayStore({
      fetchHolidays: async () => {
        throw ''
      },
    })
    await store.getState().load()
    expect(store.getState().holidays).toEqual({ status: 'error', message: '祝日一覧を読み込めませんでした。' })
  })

  it('読み込み中にもう一度呼んでも、取りに行くのは 1 回だけ', async () => {
    let resolve!: (l: HolidayList | null) => void
    const fetchHolidays = vi.fn(() => new Promise<HolidayList | null>((r) => (resolve = r)))
    const store = createHolidayStore({ fetchHolidays })
    const first = store.getState().load()
    const second = store.getState().load()
    expect(fetchHolidays).toHaveBeenCalledTimes(1)
    resolve(list())
    await Promise.all([first, second])
    expect(store.getState().holidays.status).toBe('ready')
  })

  it('読み込み済みなら、もう一度呼んでも取りに行かない', async () => {
    const fetchHolidays = vi.fn(async () => list())
    const store = createHolidayStore({ fetchHolidays })
    await store.getState().load()
    await store.getState().load()
    expect(fetchHolidays).toHaveBeenCalledTimes(1)
  })

  it('missing のあとは、もう一度呼べば読み直す', async () => {
    const fetchHolidays = vi.fn<() => Promise<HolidayList | null>>().mockResolvedValueOnce(null).mockResolvedValueOnce(list())
    const store = createHolidayStore({ fetchHolidays })
    await store.getState().load()
    expect(store.getState().holidays.status).toBe('missing')
    await store.getState().load()
    expect(fetchHolidays).toHaveBeenCalledTimes(2)
    expect(store.getState().holidays.status).toBe('ready')
  })

  it('error のあとは、もう一度呼べば読み直す', async () => {
    const fetchHolidays = vi
      .fn<() => Promise<HolidayList | null>>()
      .mockRejectedValueOnce(new Error('失敗'))
      .mockResolvedValueOnce(list())
    const store = createHolidayStore({ fetchHolidays })
    await store.getState().load()
    expect(store.getState().holidays).toEqual({ status: 'error', message: '失敗' })
    await store.getState().load()
    expect(store.getState().holidays.status).toBe('ready')
  })

  it('store ごとに状態が独立している', async () => {
    const a = createHolidayStore({ fetchHolidays: async () => list() })
    const b = createHolidayStore({ fetchHolidays: async () => null })
    await a.getState().load()
    expect(a.getState().holidays.status).toBe('ready')
    expect(b.getState().holidays.status).toBe('idle')
  })
})
