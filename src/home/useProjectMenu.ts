/** Own the home menu's trigger, anchor and dismissal without changing project actions. */
import { useCallback, useEffect, useState, type MouseEvent } from 'react'

/** Current menu identity, screen position, and keyboard focus return target. */
export interface ProjectMenuState {
  readonly id: string
  readonly x: number
  readonly y: number
  readonly keyboard: boolean
  readonly trigger: HTMLButtonElement
}

/** Keyboard activation uses the button bounds; pointer and context menus keep coordinates. */
export function useProjectMenu() {
  const [menu, setMenu] = useState<ProjectMenuState | null>(null)
  const closeMenu = useCallback(() => setMenu(null), [])
  const openMenu = (
    event: MouseEvent<HTMLButtonElement>,
    project: { id: string },
  ) => {
    event.preventDefault()
    const keyboard = event.type === 'click' && event.detail === 0
    const trigger = event.currentTarget
    const rect = keyboard ? trigger.getBoundingClientRect() : null
    setMenu({
      id: project.id,
      x: rect?.left ?? event.clientX,
      y: rect?.bottom ?? event.clientY,
      keyboard,
      trigger,
    })
  }
  useEffect(() => {
    if (!menu) return
    const onDown = (event: PointerEvent) => {
      const target = event.target
      if (target instanceof Element && !target.closest('.editor-ctx'))
        closeMenu()
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      closeMenu()
      if (menu.keyboard && menu.trigger.isConnected) menu.trigger.focus()
    }
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [menu, closeMenu])
  return { menu, openMenu, closeMenu }
}
