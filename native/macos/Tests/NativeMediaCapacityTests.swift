import Foundation
import Testing
@testable import PlotWeaveNative

/// Permit behavior keeps media capacity bounded and makes waiting cancellation independent of active delivery.
struct NativeMediaCapacityTests {
    /// A fifth delivery waits until one of four owners releases; duplicate release cannot add capacity.
    @Test func fifthRequestWaitsForRealPermitRelease() async throws {
        let gate = NativeMediaReadGate(limit: 4)
        var held: [UUID] = []
        for _ in 0..<4 { held.append(try await gate.acquire()) }
        let recorder = PermitRecorder()
        let fifth = Task { let token = try await gate.acquire(); await recorder.record(token); return token }
        try await Task.sleep(for: .milliseconds(20))
        #expect(await recorder.value == nil)
        #expect(await gate.occupancy() == 4)
        await gate.release(held[0])
        let acquired = try await fifth.value
        #expect(await recorder.value == acquired)
        #expect(await gate.occupancy() == 4)
        await gate.release(held[0])
        #expect(await gate.occupancy() == 4)
        for token in held.dropFirst() { await gate.release(token) }
        await gate.release(acquired)
        #expect(await gate.occupancy() == 0)
    }

    /// Cancellation removes a queued waiter without consuming or releasing another delivery's permit.
    @Test func cancelledWaiterDoesNotLeakCapacity() async throws {
        let gate = NativeMediaReadGate(limit: 1)
        let held = try await gate.acquire()
        let waiting = Task { try await gate.acquire() }
        try await Task.sleep(for: .milliseconds(10))
        waiting.cancel()
        await #expect(throws: CancellationError.self) { try await waiting.value }
        #expect(await gate.occupancy() == 1)
        await gate.release(held)
        let next = try await gate.acquire()
        #expect(await gate.occupancy() == 1)
        await gate.release(next)
        #expect(await gate.occupancy() == 0)
    }

    /// Records only observable acquisition outcome instead of inspecting a private waiter array.
    private actor PermitRecorder {
        private(set) var value: UUID?
        func record(_ value: UUID) { self.value = value }
    }
}
