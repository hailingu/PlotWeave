/** Project-local serial tails and process-wide settlement tracking; no retry/delete policy.
 * Owners live for the process, preserving the #162 navigation-lifetime exception.
 * Settled tails intentionally remain available as opaque identity tokens. */
export class ProjectSaveQueue {
  private readonly tails = new Map<string, Promise<unknown>>()
  private readonly unsettled = new Set<Promise<unknown>>()

  /** Ignore predecessor failure without adding a task before the caller's work. */
  predecessor(id: string): Promise<unknown> {
    return (this.tails.get(id) ?? Promise.resolve()).catch(() => undefined)
  }

  /** Append one operation using exactly the shared project's current tail. */
  append(id: string, work: () => Promise<void>): Promise<void> {
    const next = this.predecessor(id).then(work)
    this.store(id, next)
    return next
  }

  /** Publish a tail and track its settlement; deletion can publish its caught tail. */
  store(id: string, link: Promise<unknown>): void {
    this.track(link)
    this.tails.set(id, link)
  }

  /** Track recovery separately so an exit probe cannot miss replay still being queued. */
  track(link: Promise<unknown>): void {
    this.unsettled.add(link)
    void link
      .catch(() => undefined)
      .then(() => {
        this.unsettled.delete(link)
      })
  }

  /** Observe pending operations rather than retained settled tails. */
  hasPending(): boolean {
    return this.unsettled.size > 0
  }

  /** Return the current settlement batch without inserting another async boundary. */
  settlePending(): Promise<PromiseSettledResult<unknown>[]> {
    return Promise.allSettled(Array.from(this.unsettled))
  }

  /** Expose identity only, never the mutable tail registry. */
  token(id: string): Promise<unknown> | undefined {
    return this.tails.get(id)
  }

  /** Recheck identity after each await: a newer save may have joined while waiting. */
  async waitForIdle(id: string): Promise<void> {
    for (;;) {
      const chain = this.tails.get(id)
      if (chain === undefined) return
      await chain.catch(() => undefined)
      if (this.tails.get(id) === chain) return
    }
  }
}
