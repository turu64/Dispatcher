// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Button } from './button'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from './alert-dialog'

afterEach(cleanup)

function DeleteConfirm({ onDelete = () => {} }: { onDelete?: () => void }) {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant="outline">削除</Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>読み込んだ GTFS を削除しますか</AlertDialogTitle>
          <AlertDialogDescription>編集した内容も消えます。</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>やめる</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={onDelete}>
            削除する
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

function open() {
  const trigger = screen.getByRole('button', { name: '削除' })
  trigger.focus()
  fireEvent.click(trigger)
  return trigger
}

describe('AlertDialog', () => {
  it('開くと role=alertdialog になり、見出しと本文で名前と説明が付く', () => {
    render(<DeleteConfirm />)
    expect(screen.queryByRole('alertdialog')).toBeNull()
    open()
    const dialog = screen.getByRole('alertdialog', { name: '読み込んだ GTFS を削除しますか' })
    const describedBy = dialog.getAttribute('aria-describedby')
    expect(describedBy).toBeTruthy()
    expect(document.getElementById(describedBy ?? '')?.textContent).toBe('編集した内容も消えます。')
  })

  it('最初の焦点は取り消しのボタンに来る', async () => {
    render(<DeleteConfirm />)
    open()
    const cancel = screen.getByRole('button', { name: 'やめる' })
    await waitFor(() => expect(document.activeElement).toBe(cancel))
  })

  it('Action と Cancel は Button の variant を受け取る(Cancel の既定は outline)', () => {
    render(<DeleteConfirm />)
    open()
    const action = screen.getByRole('button', { name: '削除する' })
    const cancel = screen.getByRole('button', { name: 'やめる' })
    expect(action.getAttribute('data-variant')).toBe('destructive')
    expect(action.classList.contains('text-destructive')).toBe(true)
    expect(cancel.getAttribute('data-variant')).toBe('outline')
    expect(cancel.classList.contains('border-border')).toBe(true)
  })

  it('Escape で閉じ、開いたボタンに焦点が戻る', async () => {
    render(<DeleteConfirm />)
    const trigger = open()
    const dialog = screen.getByRole('alertdialog')
    fireEvent.keyDown(dialog, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(trigger))
  })

  it('取り消しで閉じ、操作は呼ばれず、開いたボタンに焦点が戻る', async () => {
    const onDelete = vi.fn()
    render(<DeleteConfirm onDelete={onDelete} />)
    const trigger = open()
    fireEvent.click(screen.getByRole('button', { name: 'やめる' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expect(onDelete).not.toHaveBeenCalled()
    await waitFor(() => expect(document.activeElement).toBe(trigger))
  })

  it('操作のボタンで onClick が呼ばれ、閉じる', async () => {
    const onDelete = vi.fn()
    render(<DeleteConfirm onDelete={onDelete} />)
    open()
    fireEvent.click(screen.getByRole('button', { name: '削除する' }))
    expect(onDelete).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
  })
})
