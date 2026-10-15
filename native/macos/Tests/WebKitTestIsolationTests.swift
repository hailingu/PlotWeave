import Testing

/// Regression coverage for the cross-suite ownership window in PR #574 review 17.
struct WebKitTestIsolationTests {
    /// Removing the shared permit must expose overlapping owners across an await.
    @Test func concurrentSuiteScopesNeverOverlap() async throws {
        let test = try #require(Test.current)
        let occupancy = Occupancy()
        try await withThrowingTaskGroup(of: Void.self) { group in
            for _ in 0..<4 {
                group.addTask {
                    try await WebKitTestIsolation().provideScope(for: test, testCase: nil) {
                        await occupancy.enter()
                        try await Task.sleep(for: .milliseconds(30))
                        await occupancy.leave()
                    }
                }
            }
            try await group.waitForAll()
        }
        #expect(await occupancy.peak == 1)
        #expect(await occupancy.completed == 4)
    }

    /// Throwing bodies must release their ownership before a later suite starts.
    @Test func thrownScopeReleasesOwnership() async throws {
        let test = try #require(Test.current)
        await #expect(throws: FixtureFailure.self) {
            try await WebKitTestIsolation().provideScope(for: test, testCase: nil) {
                throw FixtureFailure()
            }
        }
        try await WebKitTestIsolation().provideScope(for: test, testCase: nil) {
            #expect(WebKitTestIsolation.isHeld)
        }
        #expect(!WebKitTestIsolation.isHeld)
    }

    /// Cancellation must skip the resource body and leave the permit available.
    @Test func cancelledScopeReleasesOwnership() async throws {
        let test = try #require(Test.current)
        let cancelled = Task {
            withUnsafeCurrentTask { $0?.cancel() }
            try await WebKitTestIsolation().provideScope(for: test, testCase: nil) {
                Issue.record("a cancelled suite must not enter the WebKit resource")
            }
        }
        await #expect(throws: CancellationError.self) { try await cancelled.value }
        try await WebKitTestIsolation().provideScope(for: test, testCase: nil) {
            #expect(WebKitTestIsolation.isHeld)
        }
    }

    /// A one-PID difference is never ownership evidence without the shared scope.
    @Test func attributionRequiresExclusiveSuiteScope() {
        #expect(throws: WebProcessMemorySampler.AttributionFailure.exclusiveSuiteScopeRequired) {
            _ = try WebProcessMemorySampler.pageWebContentPids(since: [])
        }
    }

    /// Existing processes cannot become page-owned merely by entering an isolated scope.
    @Test func unchangedProcessSetIsRejected() async throws {
        let test = try #require(Test.current)
        try await WebKitTestIsolation().provideScope(for: test, testCase: nil) {
            let baseline = WebProcessMemorySampler.webContentPids()
            #expect(throws: WebProcessMemorySampler.AttributionFailure.ambiguousProcessCount(0)) {
                _ = try WebProcessMemorySampler.pageWebContentPids(since: baseline)
            }
        }
    }

    /// A synthetic failure identifies the original error without replacing it.
    private struct FixtureFailure: Error {}

    /// Tracks observable concurrent ownership without inspecting helper implementation.
    private actor Occupancy {
        /// Simultaneous owners and completed bodies are independent of execution order.
        private var active = 0
        private(set) var peak = 0
        private(set) var completed = 0

        /// Records entry before the body suspends, exposing a reentrant actor-only gate.
        func enter() {
            active += 1
            peak = max(peak, active)
        }

        /// Records that a body has left the shared resource.
        func leave() {
            active -= 1
            completed += 1
        }
    }
}
