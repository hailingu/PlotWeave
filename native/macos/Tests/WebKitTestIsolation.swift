import Testing

/// Owns one host-wide WebKit suite scope, including awaits between PID samples.
struct WebKitTestIsolation: SuiteTrait, TestScoping {
    /// The enclosing suite owns the permit; inheriting it would deadlock child tests.
    let isRecursive = false

    /// Marks the scope in which process-difference attribution is permitted.
    @TaskLocal static var isHeld = false

    /// All trait instances share one permit across sibling suites in this host.
    private static let gate = SuiteGate()

    /// Runs the suite in the scope used by the WebContent sampler.
    func provideScope(
        for test: Test, testCase: Test.Case?,
        performing function: @Sendable () async throws -> Void
    ) async throws {
        try await Self.gate.run {
            try await Self.$isHeld.withValue(true) { try await function() }
        }
    }

    /// An async permit stays owned across suspension; actor isolation alone would not.
    private actor SuiteGate {
        /// A resumed waiter inherits ownership directly, without reopening the gate.
        private var occupied = false
        /// Suspended suites wait without blocking the main actor needed by WebKit.
        private var waiters: [CheckedContinuation<Void, Never>] = []

        /// Cancellation and thrown bodies both release ownership before propagating.
        func run(_ body: @Sendable () async throws -> Void) async throws {
            if occupied {
                await withCheckedContinuation { waiters.append($0) }
            } else {
                occupied = true
            }
            defer { release() }
            try Task.checkCancellation()
            try await body()
        }

        /// Transfers the permit to the next waiter, or makes it available again.
        private func release() {
            if waiters.isEmpty {
                occupied = false
            } else {
                waiters.removeFirst().resume()
            }
        }
    }
}
