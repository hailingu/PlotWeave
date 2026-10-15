import Foundation

/// App-level registry of accepted native-library write batches; quit delivery and final approval wait for their settlement (issue #529).
@MainActor
final class NativeLibraryQuitWork {
    /// Entries retire only at actual task completion, so sheet cancellation still settles before approval.
    private var batches: [UUID: Task<Void, Never>] = [:]

    /// Final approval refuses while any accepted write batch is still in flight.
    var hasPendingBatches: Bool { !batches.isEmpty }

    /// Acceptance registers synchronously on the presentation's actor before the batch task can start.
    func accept(_ id: UUID, task: Task<Void, Never>) { batches[id] = task }

    /// Only a batch's own completion retires its entry; late retirement after cancellation is harmless.
    func retire(_ id: UUID) { batches[id] = nil }

    /// Quit delivery waits to a fixed point; batches accepted meanwhile join the next round.
    func drain() async throws {
        while !batches.isEmpty {
            try Task.checkCancellation()
            for task in Array(batches.values) { _ = await task.value }
        }
    }
}
