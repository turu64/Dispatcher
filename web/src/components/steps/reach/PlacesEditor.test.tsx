// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DUTY_DEFAULTS } from '@/gtfs/edit/duties'
import { feedOf } from '@/gtfs/edit/form2.fixture'
import type { GtfsFeed } from '@/gtfs/load'
import type { Stop } from '@/gtfs/parse'
import { MAX_PLACES, PLACES_FILE_FORMAT, serializePlaces } from '@/lib/placesFile'
import { compareDrivers, dutyKindOf, useDriversStore, type UserPlace } from '@/store/drivers'
import { useGtfsStore } from '@/store/gtfs'
import { DriverView } from './DriverPanel'
import { placesEffectText, searchStops } from './places'
import PlacesEditor, { PlacesEditorView, type PlacesEditorProps } from './PlacesEditor'

afterEach(() => {
  cleanup()
  useDriversStore.setState({ shortage: null, params: { ...DUTY_DEFAULTS }, places: [], placing: null })
  useGtfsStore.getState().clear()
})

const stop = (id: string, name: string, lat: number, lon: number, locationType = 0): Stop => ({ id, name, lat, lon, locationType, parentStation: '' })

const STOPS: Stop[] = [
  stop('1', '旭川駅前', 43.7631, 142.3582),
  // 上りと下り(同じ名前で 300m 以内)は1つにまとめる
  stop('2', '旭川駅前', 43.7633, 142.3585),
  stop('3', '東旭川', 43.78, 142.45),
  stop('4', '旭川空港', 43.67, 142.45),
  // 同じ名前でも遠ければ別に出す
  stop('5', '東旭川', 43.9, 142.6),
  // 駅舎(location_type 1)は出さない
  stop('6', '旭川駅', 43.763, 142.358, 1),
]

const PLACE: UserPlace = { id: 'p1', type: 'office', kind: 'depot', name: '営業所A', lat: 43.77, lon: 142.36 }

function renderView(overrides: Partial<PlacesEditorProps> = {}) {
  const props: PlacesEditorProps = {
    places: [],
    placing: null,
    stops: STOPS,
    onAdd: vi.fn(),
    onRename: vi.fn(),
    onRemove: vi.fn(),
    onReplace: vi.fn(),
    onStartPlacing: vi.fn(),
    onCancelPlacing: vi.fn(),
    download: vi.fn(),
    now: () => new Date(2026, 10, 5, 12, 30),
    ...overrides,
  }
  render(<PlacesEditorView {...props} />)
  return props
}

describe('searchStops(停留所の名前で探す)', () => {
  it('名前の一部で探し、名前で始まるものを先に出す。上りと下りはまとめ、遠い同じ名前は分ける', () => {
    expect(searchStops(STOPS, '旭川').map((m) => m.name)).toEqual(['旭川駅前', '旭川空港', '東旭川', '東旭川'])
    expect(searchStops(STOPS, '旭川駅')).toEqual([{ name: '旭川駅前', lat: 43.7631, lon: 142.3582 }])
  })

  it('全角・半角と空白の違いを無視し、空の語では何も出さない', () => {
    expect(searchStops([stop('1', 'ＡＢＣ 前', 43, 142)], 'abc前').map((m) => m.name)).toEqual(['ＡＢＣ 前'])
    expect(searchStops(STOPS, '  ')).toEqual([])
  })

  it('出す数に上限がある', () => {
    const many = Array.from({ length: 30 }, (_, i) => stop(String(i), `停留所${i}`, 43 + i * 0.1, 142))
    expect(searchStops(many, '停留所')).toHaveLength(20)
    expect(searchStops(many, '停留所', 5)).toHaveLength(5)
  })
})

describe('PlacesEditorView(営業所・車庫・休憩施設を置く欄)', () => {
  it('種類を選んで「地図で置く」を押すと、その種類で置き始める', () => {
    const props = renderView()
    fireEvent.click(screen.getByRole('radio', { name: '車庫' }))
    expect(screen.getByText('車庫:出庫・入庫の場所')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '地図で車庫を置く' }))
    expect(props.onStartPlacing).toHaveBeenCalledWith('garage')
  })

  it('置いている途中は、押して置くことと Esc でやめることを出し、「置くのをやめる」でやめる', () => {
    const props = renderView({ placing: 'rest' })
    expect(screen.getByRole('status').textContent).toBe('地図を押すと休憩施設を置きます。Esc でやめます。')
    fireEvent.click(screen.getByRole('button', { name: '置くのをやめる' }))
    expect(props.onCancelPlacing).toHaveBeenCalled()
  })

  it('停留所の名前で探して選ぶと、選んだ種類でその停留所の位置に足す', () => {
    const props = renderView()
    fireEvent.click(screen.getByRole('radio', { name: '休憩施設' }))
    fireEvent.change(screen.getByLabelText('停留所の名前で探して休憩施設を置く'), { target: { value: '空港' } })
    const results = screen.getByRole('list', { name: '停留所の検索の結果' })
    fireEvent.click(within(results).getByRole('button', { name: '旭川空港' }))
    expect(props.onAdd).toHaveBeenCalledWith({ type: 'rest', name: '旭川空港', lat: 43.67, lon: 142.45 })
    // 選んだら検索の語を消す
    expect(screen.queryByRole('list', { name: '停留所の検索の結果' })).toBeNull()
  })

  it('一致する停留所が無ければその旨を出す', () => {
    renderView()
    fireEvent.change(screen.getByLabelText('停留所の名前で探して営業所を置く'), { target: { value: '札幌' } })
    expect(screen.getByText('一致する停留所がありません。')).toBeTruthy()
  })

  it('名前は Enter か欄を離れたときに変え、空なら元に戻す。消すができる', () => {
    const props = renderView({ places: [PLACE] })
    const input = screen.getByLabelText('営業所の名前') as HTMLInputElement
    fireEvent.change(input, { target: { value: '旭川営業所' } })
    expect(props.onRename).not.toHaveBeenCalled()
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(props.onRename).toHaveBeenCalledWith('p1', '旭川営業所')
    fireEvent.change(input, { target: { value: '  ' } })
    fireEvent.blur(input)
    expect(input.value).toBe('営業所A')
    expect(props.onRename).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: '営業所Aを消す' }))
    expect(props.onRemove).toHaveBeenCalledWith('p1')
  })

  it('JSON に書き出す(置いていなければ押せない)', () => {
    const empty = renderView()
    expect((screen.getByRole('button', { name: 'JSON に書き出す' }) as HTMLButtonElement).disabled).toBe(true)
    expect(empty.download).not.toHaveBeenCalled()
    cleanup()
    const props = renderView({ places: [PLACE] })
    fireEvent.click(screen.getByRole('button', { name: 'JSON に書き出す' }))
    expect(props.download).toHaveBeenCalledWith('dispatcher_places_202611051230.json', serializePlaces([PLACE]))
    expect(screen.getByRole('status').textContent).toBe('1 か所を JSON に書き出しました。')
  })

  it('JSON を読み込むと一覧を置き換え、読み飛ばした行の数を出す', async () => {
    const props = renderView({ places: [PLACE] })
    const text = JSON.stringify({
      format: PLACES_FILE_FORMAT,
      version: 1,
      places: [{ type: 'garage', name: '車庫B', lat: 43.8, lon: 142.4 }, { type: 'garage', name: '', lat: 43.8, lon: 142.4 }],
    })
    fireEvent.change(screen.getByTestId('places-file'), { target: { files: [new File([text], 'places.json', { type: 'application/json' })] } })
    await waitFor(() => expect(props.onReplace).toHaveBeenCalledWith([{ type: 'garage', name: '車庫B', lat: 43.8, lon: 142.4 }]))
    expect(screen.getByRole('status').textContent).toBe('1 か所を読み込みました。読めない行 1 行を読み飛ばしました。')
  })

  it('形の合わない JSON は読み込まず、理由を出す', async () => {
    const props = renderView()
    fireEvent.change(screen.getByTestId('places-file'), { target: { files: [new File(['[]'], 'x.json')] } })
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('営業所・車庫・休憩施設の JSON ではありません'))
    expect(props.onReplace).not.toHaveBeenCalled()
  })

  it(`上限の ${MAX_PLACES} か所に達したら、置き始められない`, () => {
    const places = Array.from({ length: MAX_PLACES }, (_, i) => ({ ...PLACE, id: `p${i}`, name: `営業所${i}` }))
    renderView({ places })
    expect((screen.getByRole('button', { name: '地図で営業所を置く' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText(`置ける場所は ${MAX_PLACES} か所までです。`)).toBeTruthy()
  })
})

describe('PlacesEditor(store とつなぐ)', () => {
  it('読み込んだ GTFS の停留所から選んで足すと、store の一覧に入る', () => {
    useGtfsStore.getState().setLoaded({
      label: 'a.zip',
      feed: feedOf({ stops: [{ stop_id: 'A', stop_name: '駅前', stop_lat: '43.76', stop_lon: '142.36' }] }),
    })
    render(<PlacesEditor />)
    fireEvent.change(screen.getByLabelText('停留所の名前で探して営業所を置く'), { target: { value: '駅' } })
    fireEvent.click(screen.getByRole('button', { name: '駅前' }))
    expect(useDriversStore.getState().places).toMatchObject([{ type: 'office', kind: 'depot', name: '駅前', lat: 43.76, lon: 142.36 }])
    fireEvent.click(screen.getByRole('button', { name: '地図で営業所を置く' }))
    expect(useDriversStore.getState().placing).toBe('office')
    act(() => useDriversStore.getState().cancelPlacing())
    fireEvent.click(screen.getByRole('button', { name: '駅前を消す' }))
    expect(useDriversStore.getState().places).toEqual([])
  })
})

describe('DriverView の、置く前と後の勤務の数', () => {
  /** 6:00 から1時間ごとに A→A の 30 分の便を 6 便(1つの勤務) */
  function shuttle(): GtfsFeed {
    const trips = Array.from({ length: 6 }, (_, i) => ({ route_id: 'R1', service_id: 'WK', trip_id: `R1_${String(6 + i).padStart(2, '0')}00_WK` }))
    return feedOf({
      stops: [{ stop_id: 'A', stop_name: '駅前', stop_lat: '43.76', stop_lon: '142.36' }],
      calendar: [
        { service_id: 'WK', monday: '1', tuesday: '1', wednesday: '1', thursday: '1', friday: '1', saturday: '0', sunday: '0', start_date: '20261001', end_date: '20261130' },
      ],
      trips,
      stop_times: trips.flatMap((t) => {
        const h = t.trip_id.slice(3, 5)
        return [
          { trip_id: t.trip_id, arrival_time: `${h}:00:00`, departure_time: `${h}:00:00`, stop_id: 'A', stop_sequence: '1' },
          { trip_id: t.trip_id, arrival_time: `${h}:30:00`, departure_time: `${h}:30:00`, stop_id: 'A', stop_sequence: '2' },
        ]
      }),
    })
  }

  it('場所を置くと、表の下に置く前と後の勤務の数を出す(置かなければ出さない)', () => {
    const base = shuttle()
    // 約 50km 離れた車庫:出庫・入庫の回送が加わり、運転時間 9 時間を超えるので勤務が分かれる
    const far: UserPlace = { id: 'g', type: 'garage', kind: dutyKindOf('garage'), name: '車庫', lat: 44.21, lon: 142.36 }
    const input = { base, edited: null, date: '20261104', weekdayServices: null, params: { ...DUTY_DEFAULTS }, shortage: null }
    const without = compareDrivers({ ...input, places: [] })
    const placed = compareDrivers({ ...input, places: [far] })
    const view = (c: typeof placed, places: UserPlace[]) =>
      render(<DriverView comparison={c} params={c.before.duties.params} places={places} onOpenPremise={() => {}} />)
    view(without, [])
    expect(screen.queryByTestId('places-effect')).toBeNull()
    cleanup()
    view(placed, [far])
    const after = placed.before.duties.dutyCount
    expect(after).toBeGreaterThan(1)
    expect(screen.getByTestId('places-effect').textContent).toBe(
      `営業所・車庫・休憩施設(1 か所)を置く前と後の勤務の数(目安):減便前 1 → ${after}(+${after - 1})。表と判定は置いた後の数です。`,
    )
    // 断り書きも、営業所・車庫を置いた文に替わる
    expect(screen.getByRole('list', { name: '要る運転士の数の断り書き' }).textContent).toContain('最寄りの営業所・車庫との直線距離から見積もっています')
  })

  it('減便後があれば両方を出し、変わらなければその旨を書く', () => {
    expect(placesEffectText({ count: 2, before: { without: 82, with: 90 }, after: { without: 57, with: 57 } })).toBe(
      '営業所・車庫・休憩施設(2 か所)を置く前と後の勤務の数(目安):減便前 82 → 90(+8)、減便後 57 → 57(変わらない)。表と判定は置いた後の数です。',
    )
  })
})
