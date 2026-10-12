import { useEffect, useRef } from 'react'
import type { ProjectSummary } from './home/projects'
import type { NativeHomeRecovery } from './useNativeHomeRecovery'
import { isSwiftHost } from './platform/hostEnvironment'
import {
  publishNativeProjection,
  registerNativeIntentHandler,
} from './platform/nativeShell'

/** App coordination capabilities; native navigation never calls persistence directly. */
interface AppActions {
  create: () => Promise<void>
  open: (id: string) => Promise<void>
  rename: (id: string, name: string) => Promise<void>
  duplicate: (id: string) => Promise<void>
  delete: (id: string) => Promise<void>
  home: () => void
  settings: () => void
  retry: (recoveryId?: string | null) => Promise<void>
}

/** Read-only app state rendered by SwiftUI without retaining document ownership. */
interface NativeAppShellInput {
  projects: ProjectSummary[]
  loading: boolean
  error: string | null
  recovery: NativeHomeRecovery | null
  settingsOpen: boolean
  project: { id: string; name: string } | null
  actions: AppActions
}

/** Requires explicit non-empty target arguments before invoking an App action. */
function text(args: Record<string, unknown>, key: string): string {
  const value = args[key]
  if (typeof value !== 'string' || value.trim().length === 0)
    throw new Error(`命令参数 ${key} 无效。`)
  return value
}

/** Routes native project intents through the existing App recovery/save coordination. */
function execute(
  input: NativeAppShellInput,
  command: string,
  args: Record<string, unknown>,
) {
  const actions = input.actions
  switch (command) {
    case 'app.create':
      return actions.create()
    case 'app.open':
      return actions.open(text(args, 'id'))
    case 'app.rename':
      return actions.rename(text(args, 'id'), text(args, 'name'))
    case 'app.duplicate':
      return actions.duplicate(text(args, 'id'))
    case 'app.delete':
      return actions.delete(text(args, 'id'))
    case 'app.home':
      return actions.home()
    case 'app.settings':
      return actions.settings()
    case 'app.retry':
      if (
        args.recoveryId !== undefined &&
        args.recoveryId !== null &&
        typeof args.recoveryId !== 'string'
      )
        throw new Error('恢复身份无效。')
      return actions.retry(args.recoveryId)
    default:
      throw new Error('未知的项目导航命令。')
  }
}

/** Keeps a stable intent owner across page changes and publishes current UI state. */
export function useNativeAppShell(input: NativeAppShellInput): void {
  const latest = useRef(input)
  latest.current = input
  useEffect(() => {
    if (!isSwiftHost()) return
    return registerNativeIntentHandler('app', (command, args) =>
      execute(latest.current, command, args),
    )
  }, [])
  useEffect(() => {
    let route = 'home'
    if (input.settingsOpen) route = 'settings'
    else if (input.project) route = 'editor'
    publishNativeProjection('app', {
      route,
      project: input.project,
      projects: input.projects,
      loading: input.loading,
      error: input.error,
      recovery: input.recovery,
    })
  }, [
    input.projects,
    input.loading,
    input.error,
    input.recovery,
    input.settingsOpen,
    input.project,
  ])
}
