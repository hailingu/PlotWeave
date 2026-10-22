import { useEffect } from 'react'

/** Opens app settings with the platform shortcut while respecting modal editing. */
export function useAppSettingsShortcut(open: () => void): void {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== ',' || (!event.metaKey && !event.ctrlKey)) return
      if (document.querySelector('dialog[aria-modal="true"]')) return
      event.preventDefault()
      open()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open])
}
