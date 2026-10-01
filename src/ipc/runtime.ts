/**
 * Tauri 运行环境判定的唯一来源（issue #473），供 IPC 门面和原生 UI 入口
 * 共享。只读取宿主哨兵，不加载 Tauri SDK；缓存时机由各调用方保持。
 */

/** IPC 桥属性存在即为 Tauri；无 window 或纯浏览器预览时安全返回 false。
 * __TAURI__ 仅在 withGlobalTauri 开启时注入，不作为运行环境依据。 */
export function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}
