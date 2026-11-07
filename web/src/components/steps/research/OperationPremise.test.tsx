// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { PREMISE_SECTION_ID } from '@/components/steps/stepIds'
import { BOUND_LIMIT_MIN, DUTY_DEFAULTS } from '@/gtfs/edit/duties'
import { DOHOKU_SAMPLE_PLACES } from '@/lib/samplePlaces'
import { DEFAULT_WORK_DAYS, useDriversStore } from '@/store/drivers'
import { useGtfsStore } from '@/store/gtfs'
import OperationPremise from './OperationPremise'

afterEach(() => {
  cleanup()
  useDriversStore.setState({ shortage: null, roster: null, workDays: DEFAULT_WORK_DAYS, params: { ...DUTY_DEFAULTS }, places: [], placing: null })
  useGtfsStore.getState().clear()
})

const section = () => screen.getByRole('region', { name: '運行の前提(営業所・運転士の数)' })

/** 「勤務時間の設定」を押して Dialog を開く(押したボタンを返す) */
function openSettings() {
  const trigger = within(section()).getByRole('button', { name: '勤務時間の設定' })
  trigger.focus()
  fireEvent.click(trigger)
  return trigger
}

describe('OperationPremise(運行の前提の手順の運行の前提の欄)', () => {
  it('見出しと、在籍の運転士の数・週の出勤日数の欄、営業所を置く欄、推定の仮定の要約と「勤務時間の設定」のボタンを出す。欠員の欄は無い。焦点を置ける', () => {
    render(<OperationPremise />)
    const s = section()
    expect(s.id).toBe(PREMISE_SECTION_ID)
    expect(s.tabIndex).toBe(-1)
    expect(within(s).getByLabelText('在籍の運転士の数')).toBeTruthy()
    // 欠員は減便の方針の手順(policy/ShortageSection.tsx)で入れる
    expect(within(s).queryByLabelText('欠員(その日に乗務できない運転士の数)')).toBeNull()
    expect(s.textContent).toContain('欠員(その日に乗務できない運転士の数)は、手順「減便の方針」で入れます。')
    expect((within(s).getByLabelText('1人あたりの週の出勤日数') as HTMLInputElement).value).toBe('5')
    expect(within(s).getByTestId('places-editor')).toBeTruthy()
    // サンプルの GTFS でなければ、道北バスのサンプルのボタンは出さない
    expect(within(s).queryByRole('button', { name: /道北バスのサンプル/ })).toBeNull()
    expect(within(s).getByTestId('duty-settings-summary').textContent).toBe('拘束 13 時間・点呼 30/15 分・回送 時速 30km')
    // 仮定の入力は Dialog の中だけ(閉じている間は出さない)
    expect(within(s).getByRole('button', { name: '勤務時間の設定' })).toBeTruthy()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.queryByLabelText('入庫後の点呼')).toBeNull()
    expect(s.textContent).toContain('サーバーには送りません')
    expect(s.textContent).not.toContain('あなた')
  })

  it('在籍の運転士の数は 0〜9999 の整数か空', () => {
    render(<OperationPremise />)
    const input = screen.getByLabelText('在籍の運転士の数')
    fireEvent.change(input, { target: { value: '110' } })
    expect(useDriversStore.getState().roster).toBe(110)
    fireEvent.change(input, { target: { value: '10000' } })
    expect(screen.getByText('9999人以下にしてください')).toBeTruthy()
    expect(useDriversStore.getState().roster).toBe(110)
    fireEvent.change(input, { target: { value: '' } })
    expect(useDriversStore.getState().roster).toBeNull()
  })

  it('週の出勤日数は 1〜7 の整数で、全角の数字も受け付ける。読めない値(5.5・空・8)は入れない', () => {
    render(<OperationPremise />)
    const input = screen.getByLabelText('1人あたりの週の出勤日数')
    fireEvent.change(input, { target: { value: '６' } })
    expect(useDriversStore.getState().workDays).toBe(6)
    fireEvent.change(input, { target: { value: '5.5' } })
    expect(screen.getByText('1 以上の整数を入れてください')).toBeTruthy()
    expect(useDriversStore.getState().workDays).toBe(6)
    fireEvent.change(input, { target: { value: '' } })
    expect(screen.getByText('数を入れてください')).toBeTruthy()
    fireEvent.change(input, { target: { value: '8' } })
    expect(screen.getByText('7日以下にしてください')).toBeTruthy()
    expect(useDriversStore.getState().workDays).toBe(6)
    fireEvent.change(input, { target: { value: '7' } })
    expect(useDriversStore.getState().workDays).toBe(7)
  })

  it('サンプルの GTFS のときだけ、道北バスのサンプル(営業所5か所・在籍 150 人)を入れるボタンを出す。在籍は空のときだけ入れる', () => {
    useGtfsStore.setState({ sample: { available: true, name: '道北バス', source: '北海道オープンデータプラットフォーム', license: 'CC BY 4.0' } })
    render(<OperationPremise />)
    const button = screen.getByRole('button', { name: '道北バスのサンプル(営業所5か所・在籍 150 人)を入れる' })
    // 左の欄が狭くても名前を切らずに折り返す
    expect(button.className).toContain('whitespace-normal')
    expect(button.className).toContain('h-auto')
    expect(button.className).not.toContain('whitespace-nowrap')
    expect(section().textContent).toContain('在籍の運転士の数が空なら 150 を入れます')
    fireEvent.click(button)
    expect(useDriversStore.getState().roster).toBe(150)
    expect(useDriversStore.getState().places.map((p) => p.name)).toEqual(DOHOKU_SAMPLE_PLACES.map((p) => p.name))
    expect((screen.getByLabelText('在籍の運転士の数') as HTMLInputElement).value).toBe('150')
    expect(screen.getByRole('status').textContent).toBe('道北バスのサンプルの営業所を 5 か所置き、在籍の運転士の数に 150 を入れました。')
    // 入れてある在籍は変えない
    fireEvent.change(screen.getByLabelText('在籍の運転士の数'), { target: { value: '120' } })
    fireEvent.click(button)
    expect(useDriversStore.getState().roster).toBe(120)
    expect(screen.getByRole('status').textContent).toContain('在籍の運転士の数は、入れてあった数のままです。')
  })

  it('store の値が外から変わると(GTFS の読み込み直しで消えると)、欄の文字も合わせる', () => {
    render(<OperationPremise />)
    act(() => useDriversStore.getState().setRoster(110))
    expect((screen.getByLabelText('在籍の運転士の数') as HTMLInputElement).value).toBe('110')
    act(() => useDriversStore.getState().reset())
    expect((screen.getByLabelText('在籍の運転士の数') as HTMLInputElement).value).toBe('')
  })

  it('「勤務時間の設定」で Dialog を開き、拘束 15 時間・点呼を変えると store に入り、仮定の文と欄の要約も変わる。既定値に戻せる', async () => {
    render(<OperationPremise />)
    openSettings()
    const dialog = screen.getByRole('dialog', { name: '勤務時間の設定' })
    expect(document.getElementById(dialog.getAttribute('aria-describedby') ?? '')?.textContent).toContain('勤務の数の推定の仮定です')
    fireEvent.click(within(dialog).getByRole('radio', { name: '15 時間(延長の上限)' }))
    expect(useDriversStore.getState().params.maxBoundMin).toBe(BOUND_LIMIT_MIN.extended)
    expect(within(dialog).getByRole('list', { name: '推定の仮定' }).textContent).toContain('拘束時間は 15 時間以内')
    fireEvent.change(within(dialog).getByLabelText('入庫後の点呼'), { target: { value: '75' } })
    expect(useDriversStore.getState().params.postCheckMin).toBe(75)
    fireEvent.change(within(dialog).getByLabelText('回送の速さ'), { target: { value: '40' } })
    expect(useDriversStore.getState().params.deadheadKmh).toBe(40)
    // 閉じても値は残り、欄の要約が今の値になる
    fireEvent.click(within(dialog).getByRole('button', { name: '閉じる' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(useDriversStore.getState().params.postCheckMin).toBe(75)
    expect(screen.getByTestId('duty-settings-summary').textContent).toBe('拘束 15 時間・点呼 30/75 分・回送 時速 40km')
    openSettings()
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '既定値に戻す' }))
    expect(useDriversStore.getState().params).toEqual(DUTY_DEFAULTS)
  })

  it('Dialog は Escape で閉じ、開いたボタンに焦点が戻る。「閉じる」でも同じ', async () => {
    render(<OperationPremise />)
    const trigger = openSettings()
    const dialog = screen.getByRole('dialog', { name: '勤務時間の設定' })
    // 開いている間は、焦点が Dialog の中にある
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true))
    fireEvent.keyDown(dialog, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(trigger))

    openSettings()
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '閉じる' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(trigger))
  })

  it('営業所を停留所から選んで置ける(置く欄はこの手順にある)', () => {
    useGtfsStore.setState({ stops: [{ id: '1', name: '旭川駅前', lat: 43.7631, lon: 142.3582, locationType: 0, parentStation: '' }] })
    render(<OperationPremise />)
    fireEvent.change(screen.getByLabelText('停留所の名前で探して営業所を置く'), { target: { value: '旭川' } })
    fireEvent.click(within(screen.getByRole('list', { name: '停留所の検索の結果' })).getByRole('button', { name: '旭川駅前' }))
    expect(useDriversStore.getState().places.map((p) => [p.type, p.name])).toEqual([['office', '旭川駅前']])
    // 推定の仮定の文も、置いた場所の数になる
    openSettings()
    expect(within(screen.getByRole('dialog')).getByRole('list', { name: '推定の仮定' }).textContent).toContain('営業所(1 か所)')
  })
})
