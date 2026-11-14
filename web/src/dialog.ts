import { useEffect, useRef } from 'react'

let bodyScrollLockCount = 0
let bodyOverflowBeforeScrollLocks = ''
const activeDialogStack: HTMLElement[] = []

export function lockBodyScroll() {
  if (typeof document === 'undefined') return () => undefined
  if (bodyScrollLockCount === 0) bodyOverflowBeforeScrollLocks = document.body.style.overflow
  bodyScrollLockCount += 1
  document.body.style.overflow = 'hidden'
  let released = false
  return () => {
    if (released) return
    released = true
    bodyScrollLockCount = Math.max(0, bodyScrollLockCount - 1)
    if (bodyScrollLockCount === 0) document.body.style.overflow = bodyOverflowBeforeScrollLocks
  }
}

export function registerActiveDialog(element: HTMLElement | null) {
  if (!element) return () => undefined
  activeDialogStack.push(element)
  let unregistered = false
  return () => {
    if (unregistered) return
    unregistered = true
    const index = activeDialogStack.lastIndexOf(element)
    if (index !== -1) activeDialogStack.splice(index, 1)
  }
}

export function getTopmostActiveDialog(): HTMLElement | null {
  for (let index = activeDialogStack.length - 1; index >= 0; index -= 1) {
    const candidate = activeDialogStack[index]
    if (candidate.isConnected && !candidate.closest('[inert]')) return candidate
  }
  return null
}

export function isTopmostActiveDialog(element: HTMLElement | null) {
  if (!element || element.closest('[inert]')) return false
  const topmost = getTopmostActiveDialog()
  return !topmost || topmost === element
}

export function useDialogControls<T extends HTMLElement = HTMLDivElement>(onClose: () => void) {
  const dialogRef = useRef<T>(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const releaseBodyScroll = lockBodyScroll()
    const unregisterDialog = registerActiveDialog(dialogRef.current)
    const focusableSelector = 'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'
    const focusables = () => Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(focusableSelector) || [])

    const handleKeys = (event: KeyboardEvent) => {
      if (!isTopmostActiveDialog(dialogRef.current)) return
      if (event.key === 'Escape') {
        event.preventDefault()
        onCloseRef.current()
        return
      }
      if (event.key !== 'Tab') return
      const items = focusables()
      if (!items.length) {
        if (dialogRef.current) {
          event.preventDefault()
          dialogRef.current.focus()
        }
        return
      }
      const first = items[0]
      const last = items[items.length - 1]
      if (event.shiftKey && (document.activeElement === first || !dialogRef.current?.contains(document.activeElement))) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && (document.activeElement === last || !dialogRef.current?.contains(document.activeElement))) {
        event.preventDefault()
        first.focus()
      }
    }

    window.addEventListener('keydown', handleKeys)
    const focusFrame = window.requestAnimationFrame(() => {
      const target = focusables()[0] || dialogRef.current
      target?.focus()
    })

    return () => {
      window.cancelAnimationFrame(focusFrame)
      window.removeEventListener('keydown', handleKeys)
      unregisterDialog()
      releaseBodyScroll()
      if (previousFocus && previousFocus !== document.body && previousFocus.isConnected && !previousFocus.closest('[inert]')) {
        previousFocus.focus()
      } else {
        const parentDialog = getTopmostActiveDialog()
        ;(parentDialog?.querySelector<HTMLElement>(focusableSelector) || parentDialog)?.focus()
      }
    }
  }, [])

  return dialogRef
}
