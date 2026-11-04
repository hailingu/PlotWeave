import { useCallback, useLayoutEffect, useMemo, useState } from 'react'

/** A completed canvas operation gets enough reading time without becoming document state. */
const FEEDBACK_HOLD_MS = 8_000

/** Each mounted project owns its publishers; returning to an id creates a new owner. */
interface FeedbackSession {
  readonly projectId: string
  active: boolean
}

/** Object identity distinguishes repeated messages and guards delayed expiry callbacks. */
interface ActionFeedback {
  message: string
  session: FeedbackSession
}

/** Own only completed-operation feedback; save failures, recovery errors and progress stay with their owners. */
export function useTransientActionFeedback(projectId: string) {
  const session = useMemo<FeedbackSession>(
    () => ({ projectId, active: false }),
    [projectId],
  )
  const [feedback, setFeedback] = useState<ActionFeedback | null>(null)
  useLayoutEffect(() => {
    session.active = true
    return () => {
      session.active = false
    }
  }, [session])
  useLayoutEffect(() => {
    if (feedback?.session !== session) return
    const timer = setTimeout(() => {
      if (session.active)
        setFeedback((current) => (current === feedback ? null : current))
    }, FEEDBACK_HOLD_MS)
    return () => clearTimeout(timer)
  }, [feedback, session])
  const report = useCallback(
    (message: string) => {
      if (session.active) setFeedback({ message, session })
    },
    [session],
  )
  return {
    message: feedback?.session === session ? feedback.message : null,
    report,
  }
}
