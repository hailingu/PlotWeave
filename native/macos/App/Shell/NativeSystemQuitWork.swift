import Foundation

/// App-level registry of accepted direct native system deliveries; quit delivery and final approval wait for their settlement (issue #804).
@MainActor
final class NativeSystemQuitWork {
    /// Entries retire only at actual delivery completion, so preview dismissal still settles before approval.
    private var deliveries: Set<UUID> = []

    /// Final approval refuses while any accepted export delivery is still in flight.
    var hasPendingDeliveries: Bool { !deliveries.isEmpty }

    /// Acceptance registers synchronously on the presentation's actor before the delivery task can start.
    func accept(_ id: UUID) { deliveries.insert(id) }

    /// Only a delivery's own completion retires its entry; late retirement after cancellation is harmless.
    func retire(_ id: UUID) { deliveries.remove(id) }

    /// Quit delivery waits to a fixed point over this retirement oracle in cancellable ticks, exactly like
    /// the library batch wait: a direct task-handle await would not observe the delivery's own cancellation
    /// and would keep an obsolete delivery suspended. The wait never cancels the deliveries themselves.
    func drain() async throws {
        while !deliveries.isEmpty { try await Task.sleep(for: .milliseconds(10)) }
    }
}
