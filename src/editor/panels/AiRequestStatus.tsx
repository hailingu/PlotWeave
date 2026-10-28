import type { AiTurnFeedback } from './aiTurnStatus'

/** Keep readable request feedback beside the composer, independently of timeline scroll position. */
export function AiRequestStatus({
  feedback,
}: {
  readonly feedback: AiTurnFeedback | null
}) {
  if (!feedback) return null
  return (
    <div
      className="pw-ai-feedback"
      role="status"
      aria-live="polite"
      aria-atomic="true"
      aria-busy={feedback.busy}
    >
      <strong>{feedback.title}</strong>
      <span>{feedback.detail}</span>
    </div>
  )
}
