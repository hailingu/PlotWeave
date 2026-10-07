/** Tauri 与 Swift 两类宿主事件的统一入口，监听归属于当前页面生命周期。 */
import { detectHostKind } from './hostEnvironment'
import { currentSwiftHostSession, SwiftHostError } from './swiftHost'

/** 应用真正消费的宿主事件名；未知事件不能进入业务回调。 */
export type HostEventName = 'app-quit-requested' | 'library-diagnostics'

/** Swift 事件入口不直接读写业务状态，载荷由所属业务边界校验。 */
type HostEventWindow = Window & {
  __pwDispatchHostEvent?: (name: string, payload: unknown) => void
}

/** 同页监听共享分发器，单个消费者退订不会解除其他消费者。 */
interface SwiftEventState {
  sessionId: string
  listeners: Map<HostEventName, Set<(payload: unknown) => void>>
  dispose: () => void
}

const states = new WeakMap<HostEventWindow, SwiftEventState>()

/** 安装一次当前窗口的分发入口与 pagehide 清理。 */
function eventState(host: HostEventWindow, sessionId: string): SwiftEventState {
  const current = states.get(host)
  if (current?.sessionId === sessionId) return current
  current?.dispose()
  const listeners: SwiftEventState['listeners'] = new Map()
  const dispatch = (name: string, payload: unknown) => {
    if (currentSwiftHostSession() !== sessionId) return
    if (name !== 'app-quit-requested' && name !== 'library-diagnostics') return
    const reportFailure = (error: unknown) =>
      console.error('[Host] 事件消费失败', {
        code: 'PW_HOST_EVENT_HANDLER_FAILED',
        name,
        error,
      })
    // Callbacks may unsubscribe peers; this event retains its admitted listeners.
    for (const listener of new Set(listeners.get(name))) {
      try {
        void Promise.resolve(listener(payload)).catch(reportFailure)
      } catch (error) {
        reportFailure(error)
      }
    }
  }
  const dispose = () => {
    listeners.clear()
    if (states.get(host) === state) states.delete(host)
    if (host.__pwDispatchHostEvent === dispatch)
      delete host.__pwDispatchHostEvent
    host.removeEventListener('pagehide', dispose)
  }
  const state = { sessionId, listeners, dispose }
  host.__pwDispatchHostEvent = dispatch
  host.addEventListener('pagehide', dispose, { once: true })
  states.set(host, state)
  return state
}

/** 注册宿主事件并返回幂等退订；浏览器预览安全空操作且不加载 SDK。 */
export async function listenHostEvent<T = unknown>(
  name: HostEventName,
  receive: (payload: T) => void,
): Promise<() => void> {
  const hostKind = detectHostKind()
  if (hostKind === 'browser') return () => undefined
  if (hostKind === 'tauri') {
    const { listen } = await import('@tauri-apps/api/event')
    return listen<T>(name, ({ payload }) => receive(payload))
  }
  const sessionId = currentSwiftHostSession()
  if (sessionId === null)
    throw new SwiftHostError(
      'PW_HOST_COMMAND_UNAVAILABLE',
      '原生宿主事件通道未就绪',
    )
  const host = window as HostEventWindow
  const state = eventState(host, sessionId)
  const listener = (payload: unknown) => receive(payload as T)
  const listeners = state.listeners.get(name) ?? new Set()
  listeners.add(listener)
  state.listeners.set(name, listeners)
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) state.listeners.delete(name)
    if (state.listeners.size === 0) state.dispose()
  }
}
