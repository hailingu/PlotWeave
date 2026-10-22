/** Invalidate WebKit's cached handle queries while preserving each port's selector membership (#573). */
export function invalidateHandleQueries(handles: Element[]): void {
  for (const handle of handles) {
    for (const name of ['source', 'target']) {
      if (handle.classList.contains(name)) {
        handle.classList.remove(name)
        handle.classList.add(name)
      }
    }
  }
}
