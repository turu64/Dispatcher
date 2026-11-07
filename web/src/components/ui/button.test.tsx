// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Button } from './button'

afterEach(cleanup)

describe('Button の処理中の状態', () => {
  it('loading でなければ、元の名前で押せて、処理中の印は付かない', () => {
    const onClick = vi.fn()
    render(<Button onClick={onClick}>出力する</Button>)
    const button = screen.getByRole('button', { name: '出力する' })
    expect((button as HTMLButtonElement).disabled).toBe(false)
    expect(button.hasAttribute('aria-busy')).toBe(false)
    expect(button.hasAttribute('data-loading')).toBe(false)
    expect(button.querySelector('[data-slot="spinner"]')).toBeNull()
    fireEvent.click(button)
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it('loading のとき、無効になり、aria-busy と data-loading が付き、名前は既定の「処理中」になる', () => {
    const onClick = vi.fn()
    render(
      <Button loading onClick={onClick}>
        出力する
      </Button>,
    )
    const button = screen.getByRole('button', { name: '処理中' })
    expect((button as HTMLButtonElement).disabled).toBe(true)
    expect(button.getAttribute('aria-busy')).toBe('true')
    expect(button.hasAttribute('data-loading')).toBe(true)
    fireEvent.click(button)
    expect(onClick).not.toHaveBeenCalled()
  })

  it('loadingLabel で読み上げの名前を変えられる', () => {
    render(
      <Button loading loadingLabel="出力中">
        出力する
      </Button>,
    )
    expect((screen.getByRole('button', { name: '出力中' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('元の文字は DOM に残り(隠れるだけ)、スピナーは読み上げの対象にならない', () => {
    render(<Button loading>出力する</Button>)
    const button = screen.getByRole('button')
    const original = screen.getByText('出力する')
    expect(button.contains(original)).toBe(true)
    expect(original.classList.contains('invisible')).toBe(true)
    expect(original.getAttribute('aria-hidden')).toBe('true')
    const spinner = button.querySelector('[data-slot="spinner"]')
    if (!spinner) throw new Error('スピナーが無い')
    expect(spinner.getAttribute('aria-hidden')).toBe('true')
    expect(spinner.hasAttribute('role')).toBe(false)
    expect(spinner.hasAttribute('aria-label')).toBe(false)
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('loading を false に戻すと、元の名前で押せる', () => {
    const { rerender } = render(<Button loading>出力する</Button>)
    expect((screen.getByRole('button') as HTMLButtonElement).disabled).toBe(true)
    rerender(<Button>出力する</Button>)
    const button = screen.getByRole('button', { name: '出力する' })
    expect((button as HTMLButtonElement).disabled).toBe(false)
    expect(button.hasAttribute('aria-busy')).toBe(false)
  })

  it('loading でなくても disabled は従来どおり効く', () => {
    render(<Button disabled>出力する</Button>)
    const button = screen.getByRole('button', { name: '出力する' })
    expect((button as HTMLButtonElement).disabled).toBe(true)
    expect(button.hasAttribute('data-loading')).toBe(false)
  })

  it('asChild では子を包まず、無効の印だけ付ける', () => {
    render(
      <Button asChild loading>
        <a href="#x">開く</a>
      </Button>,
    )
    const link = screen.getByText('開く')
    expect(link.tagName).toBe('A')
    expect(link.getAttribute('aria-busy')).toBe('true')
    expect(link.hasAttribute('data-loading')).toBe(true)
  })
})
