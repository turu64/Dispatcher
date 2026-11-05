// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { PREMISE_SECTION_ID } from '@/components/steps/stepIds'
import { BOUND_LIMIT_MIN, DUTY_DEFAULTS } from '@/gtfs/edit/duties'
import { useDriversStore } from '@/store/drivers'
import { useGtfsStore } from '@/store/gtfs'
import OperationPremise from './OperationPremise'

afterEach(() => {
  cleanup()
  useDriversStore.setState({ shortage: null, roster: null, params: { ...DUTY_DEFAULTS }, places: [], placing: null })
  useGtfsStore.getState().clear()
})

const section = () => screen.getByRole('region', { name: '運行の前提(営業所・休憩施設・運転士の数)' })

describe('OperationPremise(前提情報の手順の運行の前提の欄)', () => {
  it('見出しと、在籍の運転士の数・欠員の欄、営業所などを置く欄、推定の仮定の開閉を出す。焦点を置ける', () => {
    render(<OperationPremise />)
    const s = section()
    expect(s.id).toBe(PREMISE_SECTION_ID)
    expect(s.tabIndex).toBe(-1)
    expect(within(s).getByLabelText('在籍の運転士の数(任意)')).toBeTruthy()
    expect(within(s).getByLabelText('欠員(その日に乗務できない運転士の数)')).toBeTruthy()
    expect(within(s).getByTestId('places-editor')).toBeTruthy()
    expect(within(s).getByText('勤務の数の推定の仮定を変える')).toBeTruthy()
    expect(s.textContent).toContain('サーバーには送りません')
    expect(s.textContent).not.toContain('あなた')
  })

  it('欠員を入れると store に入り、読めない値は入れず、空にすると入れていない状態に戻る', () => {
    render(<OperationPremise />)
    const input = screen.getByLabelText('欠員(その日に乗務できない運転士の数)')
    fireEvent.change(input, { target: { value: '２０' } })
    expect(useDriversStore.getState().shortage).toBe(20)
    fireEvent.change(input, { target: { value: '1.5' } })
    expect(screen.getByText('0 以上の整数を入れてください')).toBeTruthy()
    expect(useDriversStore.getState().shortage).toBe(20)
    fireEvent.change(input, { target: { value: '' } })
    expect(useDriversStore.getState().shortage).toBeNull()
  })

  it('在籍の運転士の数は 0〜9999 の整数か空', () => {
    render(<OperationPremise />)
    const input = screen.getByLabelText('在籍の運転士の数(任意)')
    fireEvent.change(input, { target: { value: '110' } })
    expect(useDriversStore.getState().roster).toBe(110)
    fireEvent.change(input, { target: { value: '10000' } })
    expect(screen.getByText('9999人以下にしてください')).toBeTruthy()
    expect(useDriversStore.getState().roster).toBe(110)
    fireEvent.change(input, { target: { value: '' } })
    expect(useDriversStore.getState().roster).toBeNull()
  })

  it('store の値が外から変わると(GTFS の読み込み直しで消えると)、欄の文字も合わせる', () => {
    render(<OperationPremise />)
    act(() => {
      useDriversStore.getState().setShortage(20)
      useDriversStore.getState().setRoster(110)
    })
    expect((screen.getByLabelText('欠員(その日に乗務できない運転士の数)') as HTMLInputElement).value).toBe('20')
    expect((screen.getByLabelText('在籍の運転士の数(任意)') as HTMLInputElement).value).toBe('110')
    act(() => useDriversStore.getState().reset())
    expect((screen.getByLabelText('欠員(その日に乗務できない運転士の数)') as HTMLInputElement).value).toBe('')
    expect((screen.getByLabelText('在籍の運転士の数(任意)') as HTMLInputElement).value).toBe('')
  })

  it('推定の仮定(拘束 15 時間・点呼)を変えると store に入り、仮定の文も変わる。既定値に戻せる', () => {
    render(<OperationPremise />)
    fireEvent.click(screen.getByText('勤務の数の推定の仮定を変える'))
    fireEvent.click(screen.getByRole('radio', { name: '15 時間(延長の上限)' }))
    expect(useDriversStore.getState().params.maxBoundMin).toBe(BOUND_LIMIT_MIN.extended)
    expect(screen.getByRole('list', { name: '推定の仮定' }).textContent).toContain('拘束時間は 15 時間以内')
    fireEvent.change(screen.getByLabelText('入庫後の点呼'), { target: { value: '75' } })
    expect(useDriversStore.getState().params.postCheckMin).toBe(75)
    fireEvent.click(screen.getByRole('button', { name: '既定値に戻す' }))
    expect(useDriversStore.getState().params).toEqual(DUTY_DEFAULTS)
  })

  it('営業所を停留所から選んで置ける(置く欄はこの手順にある)', () => {
    useGtfsStore.setState({ stops: [{ id: '1', name: '旭川駅前', lat: 43.7631, lon: 142.3582, locationType: 0, parentStation: '' }] })
    render(<OperationPremise />)
    fireEvent.click(screen.getByText('営業所・車庫・休憩施設を置く'))
    fireEvent.change(screen.getByLabelText('停留所の名前で探して営業所を置く'), { target: { value: '旭川' } })
    fireEvent.click(within(screen.getByRole('list', { name: '停留所の検索の結果' })).getByRole('button', { name: '旭川駅前' }))
    expect(useDriversStore.getState().places.map((p) => [p.type, p.name])).toEqual([['office', '旭川駅前']])
    // 推定の仮定の文も、置いた場所の数になる
    fireEvent.click(screen.getByText('勤務の数の推定の仮定を変える'))
    expect(screen.getByRole('list', { name: '推定の仮定' }).textContent).toContain('営業所・車庫(1 か所)')
  })
})
