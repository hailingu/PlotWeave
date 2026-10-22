/** Settings exit registration shares save ownership without importing the lazy settings UI. */

/** A mounted settings saver owns both pending encryption and its serial persistence queue. */
export interface SettingsFlushGate {
  hasPending: () => boolean
  flush: () => Promise<void>
}
const gates = new Set<SettingsFlushGate>()

/** Registers a saver; owner-specific cleanup cannot unregister a newer mounted settings page. */
export function registerSettingsFlushGate(gate: SettingsFlushGate): () => void {
  gates.add(gate)
  return () => {
    gates.delete(gate)
  }
}

/** Pending credential work and unsaved settings must both keep the application alive. */
export function hasPendingSettingsSaves(): boolean {
  return Array.from(gates).some((gate) => gate.hasPending())
}

/** Returns the failed owner count; failures stay with the existing saver for explicit retry. */
export async function flushPendingSettingsSaves(): Promise<number> {
  const results = await Promise.allSettled(
    Array.from(gates, (gate) => gate.flush()),
  )
  return results.filter((result) => result.status === 'rejected').length
}
