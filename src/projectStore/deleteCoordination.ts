/** Own deletion reference counts, durable group identity and latest absorbed payloads.
 * A group survives in-flight closures even after its registry entry is removed;
 * any successful delete forbids replay that could recreate a removed project. */
import type { ProjectContent } from '../model/content'

/** Snapshot taken on failure; undefined values mean no absorbed work, not empty content. */
interface AbsorbedWrites {
  doc: ProjectContent | undefined
  write: (() => Promise<void>) | undefined
}

/** One delete's capability; shared group objects and mutable maps stay private. */
export interface DeleteAttempt {
  /** Remember backend success for every overlapping attempt in this group. */
  succeed(): void
  /** Release this attempt's tombstone reference before success/failure recovery. */
  finish(): void
  /** Successful deletion discards any absorbed work permanently. */
  discard(): void
  /** Consume latest absorbed work; group success suppresses all replay. */
  recover(): AbsorbedWrites | undefined
}

/** Process-lifetime delete owner; entries end when the final overlapping attempt settles. */
export class ProjectDeleteCoordination {
  private readonly counts = new Map<string, number>()
  private readonly groups = new Map<string, { succeeded: boolean }>()
  private readonly documents = new Map<string, ProjectContent>()
  private readonly writes = new Map<string, () => Promise<void>>()

  /** The tombstone must be visible synchronously before deletion joins the serial queue. */
  begin(id: string): DeleteAttempt {
    const group = this.groups.get(id) ?? { succeeded: false }
    this.groups.set(id, group)
    this.counts.set(id, (this.counts.get(id) ?? 0) + 1)
    return {
      succeed: () => {
        group.succeeded = true
      },
      finish: () => this.finish(id),
      discard: () => this.discard(id),
      recover: () => {
        const absorbed = this.take(id)
        return group.succeeded ? undefined : absorbed
      },
    }
  }

  /** Report active deletion without exposing the refcount or its lifetime controls. */
  isDeleting(id: string): boolean {
    return this.counts.has(id)
  }

  /** Retain the latest snapshot; callers check the tombstone before absorption. */
  absorbSave(id: string, doc: ProjectContent): void {
    this.documents.set(id, doc)
  }

  /** Auxiliary writes are whole snapshots too, so only the latest closure is replayed. */
  absorbWrite(id: string, write: () => Promise<void>): void {
    this.writes.set(id, write)
  }

  /** Only the last overlapping attempt removes the shared tombstone and group entry. */
  private finish(id: string): void {
    const remaining = (this.counts.get(id) ?? 1) - 1
    if (remaining <= 0) {
      this.counts.delete(id)
      this.groups.delete(id)
    } else this.counts.set(id, remaining)
  }

  /** Remove absorbed work on both successful deletion and failed-attempt consumption. */
  private discard(id: string): void {
    this.documents.delete(id)
    this.writes.delete(id)
  }

  /** Consume before examining group success, matching recovery's original event order. */
  private take(id: string): AbsorbedWrites {
    const absorbed = { doc: this.documents.get(id), write: this.writes.get(id) }
    this.discard(id)
    return absorbed
  }
}
