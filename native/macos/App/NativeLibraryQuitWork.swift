import Foundation

/// App-level registry of accepted native-library write batches; quit delivery and final approval wait for their settlement (issue #529).
@MainActor
final class NativeLibraryQuitWork {
    /// Entries retire only at actual task completion, so sheet cancellation still settles before approval.
    private var batches: Set<UUID> = []

    /// Final approval refuses while any accepted write batch is still in flight.
    var hasPendingBatches: Bool { !batches.isEmpty }

    /// Acceptance registers synchronously on the presentation's actor before the batch task can start.
    func accept(_ id: UUID) { batches.insert(id) }

    /// Only a batch's own completion retires its entry; late retirement after cancellation is harmless.
    func retire(_ id: UUID) { batches.remove(id) }

    /// Quit delivery waits to a fixed point over this retirement oracle in cancellable ticks: a direct task-handle await would not observe the delivery's own cancellation and would keep an obsolete delivery — with its promoted coordinator — suspended until the batch settles. The wait never cancels the batches themselves.
    func drain() async throws {
        while !batches.isEmpty { try await Task.sleep(for: .milliseconds(10)) }
    }
}
