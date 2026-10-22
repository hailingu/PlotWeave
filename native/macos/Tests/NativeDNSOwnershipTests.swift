import Foundation
import Synchronization
import Testing
@testable import PlotWeaveNative

/// Blocking resolver lifetime is tested with owned threads, without querying external DNS or the global worker.
@Suite(.serialized)
struct NativeDNSOwnershipTests {
    /// Cancellation stops the waiter while the underlying resolver continues to own its bounded slot.
    @Test func cancelledWaiterCannotFreeAStillRunningResolverSlot() async throws {
        let fixture = BlockingLookup()
        let worker = NativePublicDNS.Worker(lookup: fixture.lookup)
        let first = Task { try await worker.resolve("first", deadline: .now.advanced(by: .seconds(3))) }
        let second = Task { try await worker.resolve("second", deadline: .now.advanced(by: .seconds(3))) }
        defer { first.cancel(); second.cancel(); fixture.release() }
        try await NativeLocalTLSFixture.wait { fixture.threads.count == 2 }
        try await expectBusy(worker)
        first.cancel()
        do { _ = try await first.value; Issue.record("Cancelled DNS waiter succeeded") }
        catch is CancellationError { }
        try await expectBusy(worker)
        fixture.release()
        _ = try await second.value
        try await NativeLocalTLSFixture.wait { fixture.threads.allSatisfy(\.isFinished) }
        #expect(try await worker.resolve("after", deadline: .now.advanced(by: .seconds(2))) == ["after"])
    }

    /// Deadline completion cannot turn a late blocking lookup into success or leak its resource slot.
    @Test func deadlineAndResolverFailureReleaseTheirOwnedSlots() async throws {
        let fixture = BlockingLookup()
        let worker = NativePublicDNS.Worker(lookup: fixture.lookup)
        defer { fixture.release() }
        do {
            _ = try await worker.resolve("late", deadline: .now.advanced(by: .milliseconds(100)))
            Issue.record("Pending DNS lookup exceeded its deadline as success")
        } catch let failure as HostFailure { #expect(failure.code == "PW_MODEL_TIMEOUT") }
        #expect(fixture.threads.count == 1)
        fixture.release()
        try await NativeLocalTLSFixture.wait { fixture.threads.allSatisfy(\.isFinished) }
        let failedThreads = Mutex<[Thread]>([])
        let failureWorker = NativePublicDNS.Worker { _ in
            failedThreads.withLock { $0.append(Thread.current) }
            throw HostFailure(code: "fixture-failure", message: "synthetic")
        }
        for _ in 0..<3 {
            do { _ = try await failureWorker.resolve("bad", deadline: .now.advanced(by: .seconds(2))); Issue.record("Failed resolver succeeded") }
            catch let failure as HostFailure { #expect(failure.code == "fixture-failure") }
            try await NativeLocalTLSFixture.wait { failedThreads.withLock { $0.allSatisfy(\.isFinished) } }
        }
    }

    /// The third concurrent operation must fail before an unbounded thread can start.
    private func expectBusy(_ worker: NativePublicDNS.Worker) async throws {
        do { _ = try await worker.resolve("third", deadline: .now.advanced(by: .seconds(2))); Issue.record("Third resolver slot was accepted") }
        catch let failure as HostFailure { #expect(failure.code == "PW_DNS_BUSY") }
    }

    /// Only a real blocking thread waits on this semaphore; async test executors remain available.
    private final class BlockingLookup: Sendable {
        /// Thread receipts allow completion to be observed after the worker releases its slot.
        private let entered = Mutex<[Thread]>([])
        /// Only the owned resolver threads block on this test-controlled release.
        private let barrier = DispatchSemaphore(value: 0)
        /// Later lookup calls pass through after explicit teardown or release.
        private let released = Mutex(false)
        /// Snapshots preserve actual Foundation thread completion identities.
        var threads: [Thread] { entered.withLock { $0 } }
        /// Synthetic values pass through unchanged once the thread is released.
        func lookup(_ value: String) throws -> [String] {
            entered.withLock { $0.append(Thread.current) }
            if !released.withLock({ $0 }) { barrier.wait() }
            return [value]
        }
        /// Two signals release the maximum number of outstanding worker slots.
        func release() {
            released.withLock { $0 = true }
            barrier.signal()
            barrier.signal()
        }
    }
}
