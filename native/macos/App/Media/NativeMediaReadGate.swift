import Foundation

/// Process-wide media concurrency is bounded through delivery completion, including requests waiting for storage actors.
actor NativeMediaReadGate {
    static let shared = NativeMediaReadGate(limit: 4)
    private let limit: Int
    private var held = Set<UUID>()
    private var waiting: [(UUID, CheckedContinuation<UUID, any Error>)] = []

    /// Injected limits support deterministic resource-lifecycle tests without replacing the production read path.
    init(limit: Int) { self.limit = max(1, limit) }

    /// Waiting cancellation is owned by the request; the cancellation message removes its continuation exactly once.
    func acquire() async throws -> UUID {
        try Task.checkCancellation()
        let token = UUID()
        if held.count < limit { held.insert(token); return token }
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                if Task.isCancelled { continuation.resume(throwing: CancellationError()) }
                else { waiting.append((token, continuation)) }
            }
        } onCancel: {
            Task { await self.cancel(token) }
        }
    }

    /// One completed/stopped delivery releases its identity and transfers capacity to the next live waiter.
    func release(_ token: UUID) {
        guard held.remove(token) != nil else { return }
        if !waiting.isEmpty {
            let next = waiting.removeFirst()
            held.insert(next.0)
            next.1.resume(returning: next.0)
        }
    }

    /// Observable occupancy supports capacity assertions without introspecting implementation source.
    func occupancy() -> Int { held.count }

    /// Removing a queued waiter cannot affect a permit already delivered to its request owner.
    private func cancel(_ token: UUID) {
        guard let index = waiting.firstIndex(where: { $0.0 == token }) else { return }
        let entry = waiting.remove(at: index)
        entry.1.resume(throwing: CancellationError())
    }
}
