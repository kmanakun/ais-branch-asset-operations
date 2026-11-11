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
