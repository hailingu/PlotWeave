/** Own failed documents, generations, timer lifecycle and confirmed retry identities.
 * Pending edits survive editor navigation for the process lifetime (#162);
 * successful saves/deletes clear registrations, while generation counters remain. */
import type { ProjectContent } from '../model/content'

const SAVE_RETRY_DELAY_MS = 5000

/** Retry policy has no dependency on the queue or deletion owner; composition injects saving. */
export class ProjectSaveRetries {
  private readonly documents = new Map<string, ProjectContent>()
  private readonly timers = new Map<
    string,
    { timer: ReturnType<typeof setTimeout>; generation: number }
  >()
  private readonly generations = new Map<string, number>()
  private readonly persisted = new Map<string, ProjectContent>()

  /** Bind normal save entry and the existing synchronous persisted-document notification. */
  constructor(
    private readonly retry: (id: string, doc: ProjectContent) => Promise<void>,
    private readonly notifyPersisted: (doc: ProjectContent) => void,
  ) {}

  /** Every actual enqueue supersedes any timer from an older save generation. */
  begin(id: string): number {
    const generation = (this.generations.get(id) ?? 0) + 1
    this.generations.set(id, generation)
    return generation
  }

  /** Preserve notification-before-removal order and same-object persisted memory. */
  complete(id: string, doc: ProjectContent): void {
    const registered = this.documents.get(id)
    if (registered !== undefined) {
      if (registered === doc) {
        this.persisted.set(id, doc)
        this.notifyPersisted(doc)
      }
      this.documents.delete(id)
    }
  }

  /** Register only genuinely unpersisted content; latest failure owns the timer. */
  fail(id: string, doc: ProjectContent, generation: number): boolean {
    if (this.persisted.get(id) === doc) return false
    this.documents.set(id, doc)
    this.clearTimer(id)
    this.timers.set(id, {
      timer: setTimeout(() => this.fire(id), SAVE_RETRY_DELAY_MS),
      generation,
    })
    return true
  }

  /** Stop the trigger without dropping the newest unpersisted edit at delete start. */
  clearTimer(id: string): void {
    const entry = this.timers.get(id)
    if (entry !== undefined) {
      clearTimeout(entry.timer)
      this.timers.delete(id)
    }
  }

  /** Clear a registration only when the serialized delete actually reaches execution. */
  clear(id: string): void {
    this.clearTimer(id)
    this.documents.delete(id)
  }

  /** A completed deletion ends the same-object redundant-rewrite exemption. */
  forgetPersisted(id: string): void {
    this.persisted.delete(id)
  }

  /** Read current pending content through the coordinator's narrow public query. */
  document(id: string): ProjectContent | undefined {
    return this.documents.get(id)
  }

  /** Compare identity after asynchronous verification so stale documents cannot return. */
  replace(id: string, expected: ProjectContent, next: ProjectContent): boolean {
    if (this.documents.get(id) !== expected) return false
    this.documents.set(id, next)
    return true
  }

  /** Snapshot unresolved ids for exit feedback without exporting mutable state. */
  pendingIds(): string[] {
    return Array.from(this.documents.keys())
  }

  /** Exit readiness includes registrations whose timer has already been consumed. */
  hasPending(): boolean {
    return this.documents.size > 0
  }

  /** Try each new registration generation once per flush; stale no-ops do not count. */
  fireUnfired(fired: Map<string, number>): void {
    for (const id of Array.from(this.documents.keys())) {
      const entry = this.timers.get(id)
      if (entry === undefined || fired.get(id) === entry.generation) continue
      if (!this.fire(id)) continue
      // Normal enqueue synchronously advances generation; record the consumed retry's generation.
      fired.set(id, this.generations.get(id) ?? 0)
    }
  }

  /** Detect registrations created while exit flushing awaited another project's chain. */
  hasUnfired(fired: Map<string, number>): boolean {
    for (const id of this.documents.keys()) {
      const entry = this.timers.get(id)
      if (entry !== undefined && fired.get(id) !== entry.generation) return true
    }
    return false
  }

  /** Timer and exit flush share stale-generation rejection and the normal save entry. */
  private fire(id: string): boolean {
    const entry = this.timers.get(id)
    if (entry === undefined) return false
    this.clearTimer(id)
    if (this.generations.get(id) !== entry.generation) return false
    const doc = this.documents.get(id)
    if (doc === undefined) return false
    void this.retry(id, doc).catch(() => undefined)
    return true
  }
}
