// @vitest-environment jsdom
import { act, cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { smallFeed } from '@/gtfs/edit/form2.fixture'
import { useDriversStore } from '@/store/drivers'
import { useGtfsStore } from '@/store/gtfs'
import PremiseStep from './PremiseStep'

afterEach(() => {
  cleanup()
  act(() => {
    useGtfsStore.getState().clear()
    useDriversStore.getState().reset()
  })
})

describe('PremiseStep(運行の前提の手順)', () => {
  it('GTFS を読み込む前は案内だけ', () => {
    render(<PremiseStep />)
    expect(screen.getByRole('heading', { name: '2. 運行の前提' })).toBeTruthy()
    expect(screen.getByText('GTFS を読み込むと、営業所と運転士の数を設定できます。')).toBeTruthy()
    expect(screen.queryByRole('region', { name: '運行の前提(営業所・運転士の数)' })).toBeNull()
  })

  it('読み込んだら運行の前提の欄だけを出す(欠員と周辺の施設の調査は、ほかの手順)', () => {
    act(() => useGtfsStore.getState().setLoaded({ label: 'test.zip', feed: smallFeed() }))
    render(<PremiseStep />)
    const premise = screen.getByRole('region', { name: '運行の前提(営業所・運転士の数)' })
    expect(within(premise).getByLabelText('在籍の運転士の数')).toBeTruthy()
    expect(screen.queryByLabelText('欠員(その日に乗務できない運転士の数)')).toBeNull()
    expect(screen.queryByRole('heading', { name: '周辺の事業者・施設の調査' })).toBeNull()
    expect(document.body.textContent).not.toContain('あなた')
  })
})
