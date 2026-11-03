// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeBands } from '@/gtfs/departures'
import BandControl from './BandControl'

afterEach(cleanup)

describe('BandControl(地図の上の時間帯の切り替え)', () => {
  it('3時間ごとの6つの帯を出し、選んだ時刻を含む帯だけを押された状態にする', () => {
    render(<BandControl bands={makeBands(3)} selectedHour={10} onSelect={() => {}} />)
    const radios = screen.getAllByRole('radio')
    expect(radios.map((r) => r.textContent)).toEqual(['6〜9時', '9〜12時', '12〜15時', '15〜18時', '18〜21時', '21〜24時'])
    expect(radios.filter((r) => r.getAttribute('aria-checked') === 'true').map((r) => r.textContent)).toEqual(['9〜12時'])
  })

  it('1時間ごとは 18 の帯', () => {
    render(<BandControl bands={makeBands(1)} selectedHour={10} onSelect={() => {}} />)
    const radios = screen.getAllByRole('radio')
    expect(radios).toHaveLength(18)
    expect(radios.find((r) => r.getAttribute('aria-checked') === 'true')?.textContent).toBe('10〜11時')
  })

  it('選ばれている帯は主色で塗る(うっすらした灰色だけでは見分けにくい)', () => {
    render(<BandControl bands={makeBands(3)} selectedHour={10} onSelect={() => {}} />)
    const on = screen.getAllByRole('radio').find((r) => r.getAttribute('aria-checked') === 'true')!
    expect(on.className).toContain('data-[state=on]:bg-primary')
    expect(on.className).toContain('data-[state=on]:text-primary-foreground')
  })

  it('帯を押すと、その帯の開始時刻を渡す。選んでいる帯をもう一度押しても何も渡さない', () => {
    const onSelect = vi.fn()
    render(<BandControl bands={makeBands(3)} selectedHour={10} onSelect={onSelect} />)
    fireEvent.click(screen.getByRole('radio', { name: '18〜21時' }))
    expect(onSelect).toHaveBeenCalledWith(18)
    onSelect.mockClear()
    fireEvent.click(screen.getByRole('radio', { name: '9〜12時' }))
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('地図の上に重ねる位置に置き、見出しを付ける', () => {
    render(<BandControl bands={makeBands(3)} selectedHour={6} onSelect={() => {}} />)
    const region = screen.getByRole('region', { name: '地図に出す時間帯' })
    expect(region.className).toContain('absolute')
  })
})
