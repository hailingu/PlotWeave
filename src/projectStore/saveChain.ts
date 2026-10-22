/** Project save/delete composition (#634): private queue, retry and deletion owners.
 * Preserve serialization, retry-generation identity, tombstone reference counts and
 * recovery timing. Public consumers keep the existing narrow #162 API.
 * Owners intentionally survive navigation for the process lifetime; no mutable
 * registry escapes. Pending registrations clear on save success/delete execution;
 * settled tails and generations remain identity/history as before. */
import { serializeProject } from '../model/convert'
import type { ProjectContent } from '../model/content'
import { IPC_COMMANDS } from '../ipc/commands'
import { ipcInvoke } from '../ipc/invoke'
import { ProjectSaveQueue } from './saveQueue'
import { ProjectSaveRetries } from './saveRetries'
import { ProjectDeleteCoordination } from './deleteCoordination'
import type { DeleteAttempt } from './deleteCoordination'
import {
  notifyProjectSaved,
  notifyRetryPersisted,
  notifyProjectWriteReplayFailure,
} from './saveNotifications'
import { createDiagnostic } from '../diagnostics'

/** 失败事件显式绑定级别、域与机器码；旧前缀和上下文原样交付。 */
const logEvents = {
  projectAuxiliaryWriteDuringDelete: createDiagnostic(
    'WARN',
    'plotweave::frontend::project_store',
    'PROJECT_AUXILIARY_WRITE_DURING_DELETE',
  ),
  projectSaveDuringDelete: createDiagnostic(
    'WARN',
    'plotweave::frontend::project_store',
    'PROJECT_SAVE_DURING_DELETE',
  ),
  projectSaveFailed: createDiagnostic(
    'ERROR',
    'plotweave::frontend::project_store',
    'PROJECT_SAVE_FAILED',
  ),
  projectAuxiliaryReplayFailed: createDiagnostic(
    'ERROR',
    'plotweave::frontend::project_store',
    'PROJECT_AUXILIARY_REPLAY_FAILED',
  ),
}

export {
  onProjectSaved,
  notifyProjectSaved,
  onRetryPersisted,
  notifyRetryPersisted,
  onProjectWriteReplayFailure,
} from './saveNotifications'
export type {
  ProjectSavedListener,
  RetryPersistedListener,
  ProjectWriteReplayFailureListener,
} from './saveNotifications'

const queue = new ProjectSaveQueue()
const retries = new ProjectSaveRetries(
  (id, doc) => enqueueSave(id, doc),
  notifyRetryPersisted,
)
const deletions = new ProjectDeleteCoordination()

/** Serialize auxiliary snapshot writes with document saves; active deletion absorbs latest. */
export function enqueueProjectWrite(
  id: string,
  write: () => Promise<void>,
): Promise<void> {
  if (deletions.isDeleting(id)) {
    deletions.absorbWrite(id, write)
    logEvents.projectAuxiliaryWriteDuringDelete(
      '[projectStore] 项目删除中，吸收附属数据写入',
      id,
    )
    return Promise.resolve()
  }
  return queue.append(id, write)
}

/** Exit readiness observes both failed registrations and in-flight recovery/queue work. */
export function hasPendingProjectSaves(): boolean {
  return retries.hasPending() || queue.hasPending()
}

/** Try each registration generation once, including registrations created during awaits.
 * Keep the existing await boundaries: no await is inserted when no link is pending. */
export async function flushPendingProjectSaves(): Promise<string[]> {
  const fired = new Map<string, number>()
  for (;;) {
    retries.fireUnfired(fired)
    while (queue.hasPending()) {
      await queue.settlePending()
    }
    if (!retries.hasUnfired(fired)) break
  }
  return retries.pendingIds()
}

/** Strip session-only state at the existing IPC persistence boundary. */
export async function tauriSave(
  id: string,
  doc: ProjectContent,
  expectExisting = false,
): Promise<void> {
  await ipcInvoke(IPC_COMMANDS.saveProject, {
    id,
    doc: serializeProject(doc, id),
    expectExisting,
  })
}

/** Enqueue document saves, preserving rejection/absorption and notification ordering. */
export function enqueueSave(
  id: string,
  doc: ProjectContent,
  expectExisting = false,
): Promise<void> {
  if (deletions.isDeleting(id)) {
    if (expectExisting) {
      return Promise.reject(new Error(`项目删除中，拒绝写入副本：${id}`))
    }
    deletions.absorbSave(id, doc)
    logEvents.projectSaveDuringDelete(
      '[projectStore] 项目删除中，吸收本次保存排队',
      id,
    )
    return Promise.resolve()
  }
  const generation = retries.begin(id)
  return queue.append(id, async () => {
    try {
      await tauriSave(id, doc, expectExisting)
      retries.complete(id, doc)
      notifyProjectSaved(id)
    } catch (err) {
      if (retries.fail(id, doc, generation)) {
        logEvents.projectSaveFailed(
          '[projectStore] 保存失败，已登记后台重试',
          err,
        )
      }
      throw err
    }
  })
}

/** Requeue failed deletion's retained retry, then absorbed latest document and auxiliary write.
 * A successful overlapping attempt suppresses all replay, preventing resurrection. */
function replayDeleteFailure(
  id: string,
  retained: ProjectContent | undefined,
  attempt: DeleteAttempt,
): void {
  const absorbed = attempt.recover()
  if (absorbed === undefined) return
  if (retained !== undefined)
    void enqueueSave(id, retained).catch(() => undefined)
  if (absorbed.doc !== undefined)
    void enqueueSave(id, absorbed.doc).catch(() => undefined)
  if (absorbed.write !== undefined) {
    void enqueueProjectWrite(id, absorbed.write).catch((err) => {
      logEvents.projectAuxiliaryReplayFailed(
        '[projectStore] 回吐重排的附属写入失败',
        id,
        err,
      )
      notifyProjectWriteReplayFailure(id, err)
    })
  }
}

/** Put deletion after existing writes; retain pending retry until actual delete execution.
 * Track recovery and the caught delete tail separately, preserving the original microtasks. */
export function enqueueDelete(id: string): Promise<void> {
  const attempt = deletions.begin(id)
  retries.clearTimer(id)
  const run = queue.predecessor(id)
  let retainedRetryDoc: ProjectContent | undefined
  const next = run.then(async () => {
    retainedRetryDoc = retries.document(id)
    retries.clear(id)
    await ipcInvoke(IPC_COMMANDS.deleteProject, { id })
    attempt.succeed()
  })
  const recovery = next
    .finally(() => {
      attempt.finish()
      retries.forgetPersisted(id)
    })
    .then(
      () => attempt.discard(),
      () => replayDeleteFailure(id, retainedRetryDoc, attempt),
    )
  queue.track(recovery)
  const stored = next.catch(() => undefined)
  queue.store(id, stored)
  return next
}

/** Wait until the observed project's tail stays identical across an await. */
export function waitForSaveChainIdle(id: string): Promise<void> {
  return queue.waitForIdle(id)
}

/** Expose an opaque tail token for identity comparisons, never its registry. */
export function saveChainTokenOf(id: string): Promise<unknown> | undefined {
  return queue.token(id)
}

/** Read the newest failed snapshot through the existing public narrow query. */
export function pendingRetryDocOf(id: string): ProjectContent | undefined {
  return retries.document(id)
}

/** Replace only the same registered object after asynchronous load verification. */
export function replacePendingRetryDoc(
  id: string,
  expected: ProjectContent,
  next: ProjectContent,
): boolean {
  return retries.replace(id, expected, next)
}
