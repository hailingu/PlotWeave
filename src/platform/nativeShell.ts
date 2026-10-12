/**
 * Read-only native shell projections and native intents. Feature action owners
 * register here; this transport never keeps an editable document or invokes
 * storage directly. Bounded same-page results and a retirement watermark prevent replay.
 */

/** Stable failure envelope shared with the Swift command boundary. */
interface IntentFailure {
  error: { code: string; message: string }
}

/** Feature action owner; returned values must be JSON-compatible projections. */
type IntentHandler = (command: string, args: Record<string, unknown>) => unknown

/** Native page identity and its WebKit projection sink. */
type ShellWindow = Window & {
  __pwNativeHost?: unknown
  __pwNativeIntent?: (request: unknown) => Promise<unknown>
  webkit?: {
    messageHandlers?: { canvasHost?: { postMessage: (value: unknown) => void } }
  }
}

/** Intent cache entry retains both the request fingerprint and its completion. */
interface IntentEntry {
  fingerprint: Promise<string | null>
  result: Promise<unknown>
  ordinal: number | null
  settled: boolean
}

const handlers = new Map<string, IntentHandler>()
const results = new Map<string, IntentEntry>()
let activeSession: string | null = null
let sequence = 0
let admission: Promise<void> = Promise.resolve()
let projections: Record<string, unknown> = {}
const INTENT_LIMIT = 4096
let retiredThrough = 0

/** Reserved production IDs carry a canonical safe ordinal; legacy opaque IDs retain their bounded contract. */
function intentOrdinal(id: string): number | null | undefined {
  if (!id.startsWith('native:')) return null
  const ordinal = Number(id.slice('native:'.length))
  return Number.isSafeInteger(ordinal) &&
    ordinal > 0 &&
    id === `native:${ordinal}`
    ? ordinal
    : undefined
}

/** Retires only completed ordered entries; the watermark rejects evicted IDs while pending results remain replayable. */
function admitResult(): boolean {
  if (results.size < INTENT_LIMIT) return true
  for (const [id, entry] of results) {
    if (!entry.settled || entry.ordinal === null) continue
    results.delete(id)
    retiredThrough = Math.max(retiredThrough, entry.ordinal)
    return true
  }
  return false
}

/** Narrows decoded JSON objects at the message trust boundary. */
function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

/** Reads only the explicit versioned Swift marker; never guesses a host. */
function sessionIdentity(): string | null {
  const marker = record((window as ShellWindow).__pwNativeHost)
  return marker?.kind === 'swift' &&
    marker.protocolVersion === 1 &&
    typeof marker.sessionId === 'string' &&
    marker.sessionId.length > 0
    ? marker.sessionId
    : null
}

/** A new page identity invalidates prior projections and cached intent results. */
function alignSession(session: string): void {
  if (activeSession === session) return
  activeSession = session
  results.clear()
  retiredThrough = 0
  projections = {}
  sequence = 0
  admission = Promise.resolve()
}

/** Structured failure without logging document contents or user payloads. */
function failure(code: string, message: string): IntentFailure {
  return { error: { code, message } }
}

/** Runs an owned feature action and prevents stale completion from succeeding. */
async function executeIntent(
  session: string,
  handler: IntentHandler,
  command: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  try {
    const value = await handler(command, args)
    return sessionIdentity() === session
      ? { ok: value ?? null }
      : failure(
          'PW_STALE_SESSION',
          '页面已重新加载，本次结果不能用于当前会话。',
        )
  } catch (error) {
    return failure(
      'PW_INTENT_FAILED',
      error instanceof Error ? error.message : String(error),
    )
  }
}

/** Keeps only a SHA-256 identity in the replay cache; crypto failures admit no mutation. */
async function fingerprintOf(
  command: string,
  args: Record<string, unknown>,
): Promise<string | null> {
  const subtle = globalThis.crypto?.subtle
  if (!subtle) return null
  const bytes = new TextEncoder().encode(JSON.stringify({ command, args }))
  try {
    const hash = await subtle.digest('SHA-256', bytes)
    return Array.from(new Uint8Array(hash), (byte) =>
      byte.toString(16).padStart(2, '0'),
    ).join('')
  } catch {
    return null
  } finally {
    bytes.fill(0)
  }
}

/** A duplicate compares digest identities, never retains raw serialized credentials. */
async function replayIntent(
  session: string,
  previous: IntentEntry,
  command: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const [prior, current] = await Promise.all([
    previous.fingerprint,
    Promise.resolve().then(() => fingerprintOf(command, args)),
  ])
  if (sessionIdentity() !== session)
    return failure('PW_STALE_SESSION', '原生命令不属于当前页面会话。')
  if (prior === null || current === null)
    return failure(
      'PW_INTENT_CRYPTO_UNAVAILABLE',
      '无法验证请求身份，本次命令未执行。',
    )
  return prior === current
    ? previous.result
    : failure('PW_REQUEST_CONFLICT', '请求身份已用于另一条命令。')
}

/** Validates identity before looking up the action owner or cached mutation. */
async function receiveIntent(payload: unknown): Promise<unknown> {
  const session = sessionIdentity()
  const request = record(payload)
  if (!session || request?.sessionId !== session)
    return failure('PW_STALE_SESSION', '原生命令不属于当前页面会话。')
  if (
    request.protocolVersion !== 1 ||
    typeof request.requestId !== 'string' ||
    request.requestId.length === 0 ||
    typeof request.command !== 'string'
  )
    return failure('PW_INVALID_NATIVE_INTENT', '原生命令的版本或身份无效。')
  const args = request.args === undefined ? {} : record(request.args)
  if (!args) return failure('PW_INVALID_NATIVE_INTENT', '命令参数必须是对象。')
  alignSession(session)
  const ordinal = intentOrdinal(request.requestId)
  if (ordinal === undefined)
    return failure('PW_INVALID_NATIVE_INTENT', '原生命令的顺序身份无效。')
  const command = request.command
  const previous = results.get(request.requestId)
  if (previous) return replayIntent(session, previous, command, args)
  if (ordinal !== null && ordinal <= retiredThrough)
    return failure('PW_NATIVE_INTENT_RETIRED', '这条命令已退役，不能重复执行。')
  const domain = command.split('.')[0] ?? ''
  const handler = handlers.get(domain)
  if (!handler)
    return failure('PW_INTENT_UNAVAILABLE', '当前界面无法执行这条命令。')
  if (!admitResult())
    return failure(
      'PW_REQUEST_LIMIT',
      '当前未完成或旧式请求过多，请等待后明确重试。',
    )
  return startIntent(
    session,
    request.requestId,
    ordinal,
    command,
    args,
    handler,
  )
}

/** Reserves identity synchronously and orders digest admission while feature-owned completions remain concurrent. */
function startIntent(
  session: string,
  requestId: string,
  ordinal: number | null,
  command: string,
  args: Record<string, unknown>,
  handler: IntentHandler,
): Promise<unknown> {
  // Insert before invoking the handler so a synchronous reentrant request also
  // observes the same result rather than repeating the side effect.
  const fingerprint = Promise.resolve().then(() => fingerprintOf(command, args))
  const ready = admission.then(() => fingerprint)
  admission = ready.then(
    () => undefined,
    () => undefined,
  )
  const result = ready.then((digest) => {
    if (sessionIdentity() !== session)
      return failure('PW_STALE_SESSION', '原生命令不属于当前页面会话。')
    if (digest === null)
      return failure(
        'PW_INTENT_CRYPTO_UNAVAILABLE',
        '无法验证请求身份，本次命令未执行。',
      )
    if (handlers.get(command.split('.')[0] ?? '') !== handler)
      return failure('PW_INTENT_UNAVAILABLE', '当前界面无法执行这条命令。')
    return executeIntent(session, handler, command, args)
  })
  const entry = { fingerprint, result, ordinal, settled: false }
  results.set(requestId, entry)
  void result.then(
    () => {
      entry.settled = true
    },
    () => {
      entry.settled = true
    },
  )
  return result
}

/** Registers one domain's current action owner; cleanup cannot remove a newer owner. */
export function registerNativeIntentHandler(
  domain: string,
  handler: IntentHandler,
): () => void {
  handlers.set(domain, handler)
  ;(window as ShellWindow).__pwNativeIntent = receiveIntent
  return () => {
    if (handlers.get(domain) === handler) handlers.delete(domain)
    if (handlers.size === 0) {
      delete (window as ShellWindow).__pwNativeIntent
      activeSession = null
      results.clear()
      projections = {}
      admission = Promise.resolve()
    }
  }
}

/** Publishes ordered domain snapshots; Swift treats the combined value as read-only. */
export function publishNativeProjection(
  domain: string,
  projection: unknown,
): void {
  const session = sessionIdentity()
  if (!session) return
  alignSession(session)
  projections = { ...projections, [domain]: projection }
  const sink = (window as ShellWindow).webkit?.messageHandlers?.canvasHost
  sink?.postMessage({
    event: 'projection',
    protocolVersion: 1,
    sessionId: session,
    sequence: ++sequence,
    projection: projections,
  })
}
