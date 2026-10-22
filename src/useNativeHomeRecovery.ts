/** Native homepage recovery adapts existing App failure owners without duplicating persistence or mutation state. */
import { useRef } from 'react'
import type { OpenProjectError } from './home/OpenErrorBanner'
import type { useHomeActionFeedback } from './useHomeActionFeedback'

/** A read-only recovery identity binds the native button to its displayed failure owner. */
export interface NativeHomeRecovery {
  id: string
  action: 'load' | 'open' | 'create' | 'rename' | 'duplicate' | 'delete'
  canRetry: boolean
}

/** Existing App owners supply diagnostics and recovery; this adapter never reconstructs mutation arguments. */
interface RecoveryInput {
  exitBlocked: string | null
  loadError: string | null
  openFailure: OpenProjectError | null
  feedback: ReturnType<typeof useHomeActionFeedback>
  refresh: () => Promise<void>
  open: (id: string) => Promise<void>
}

/** Selects exactly the owner of the visible diagnostic, preserving the existing failure priority. */
function selectFailure(input: RecoveryInput) {
  if (input.exitBlocked !== null)
    return {
      owner: input.exitBlocked,
      error: input.exitBlocked,
      action: null,
      run: null,
    }
  if (input.loadError !== null)
    return {
      owner: input.loadError,
      error: input.loadError,
      action: 'load' as const,
      run: input.refresh,
    }
  if (input.openFailure !== null) {
    const failure = input.openFailure
    return {
      owner: failure,
      error: failure.detail,
      action: 'open' as const,
      run: () => input.open(failure.id),
    }
  }
  const failure = input.feedback.failure
  return {
    owner: failure,
    error: failure?.error.detail ?? null,
    action: failure?.error.action ?? null,
    run: failure?.retry ?? null,
  }
}

/** Native retry awaits the same owner and rejects stale or unsafe recovery instead of replaying another action. */
export function useNativeHomeRecovery(input: RecoveryInput) {
  const failure = selectFailure(input)
  const identity = useRef<{ owner: unknown; serial: number; claimed: boolean }>(
    {
      owner: null,
      serial: 0,
      claimed: false,
    },
  )
  if (identity.current.owner !== failure.owner) {
    identity.current = {
      owner: failure.owner,
      serial: identity.current.serial + 1,
      claimed: false,
    }
  }
  const recovery: NativeHomeRecovery | null =
    failure.action === null
      ? null
      : {
          id: String(identity.current.serial),
          action: failure.action,
          canRetry: failure.run !== null,
        }
  /** Explicit null refreshes transport diagnostics; absent identity retries the currently displayed owner. */
  async function retry(expectedId?: string | null) {
    if (expectedId === null) return input.refresh()
    if (expectedId !== undefined && expectedId !== recovery?.id)
      throw new Error('首页恢复目标已失效，请使用当前错误的恢复操作。')
    if (failure.error === null) return input.refresh()
    if (!failure.run)
      throw new Error('当前首页错误不允许重试，请按诊断核对项目。')
    if (
      recovery?.id !== String(identity.current.serial) ||
      identity.current.claimed
    )
      throw new Error('首页恢复操作已开始，请等待当前结果。')
    identity.current.claimed = true
    try {
      await failure.run()
    } finally {
      // A repeated list diagnostic retains its owner; only its completed read claim can reopen.
      if (
        failure.action === 'load' &&
        recovery?.id === String(identity.current.serial)
      )
        identity.current.claimed = false
    }
  }
  return { error: failure.error, recovery, retry }
}
