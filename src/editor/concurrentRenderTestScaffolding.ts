/** Test-only lazy import gate: each case owns its pending work and completion. */
import { lazy, type ComponentType } from 'react'

/** A released module renders nothing and never introduces another state owner. */
function ReleasedGate() {
  return null
}

/** Suspend a real lazy descendant until the owning test explicitly releases it. */
export function createRenderGate() {
  let release!: (module: { default: ComponentType }) => void
  let requested = false
  const pending = new Promise<{ default: ComponentType }>((resolve) => {
    release = resolve
  })
  return {
    Component: lazy(() => {
      requested = true
      return pending
    }),
    wasRequested: () => requested,
    release: () => release({ default: ReleasedGate }),
  }
}

/** One case's lazy boundary; releasing it after unmount also drains its promise. */
export type RenderGate = ReturnType<typeof createRenderGate>
