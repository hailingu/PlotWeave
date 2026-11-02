import Foundation
import Synchronization

/// A monotonic boundary returns on time even if an injected DNS or actor operation cannot stop immediately.
enum NativeDeadline {
    /// The race owns and cancels both child tasks; late results cannot trigger a second completion.
    static func run<Value: Sendable>(until deadline: ContinuousClock.Instant, operation: @escaping @Sendable () async throws -> Value) async throws -> Value {
        guard deadline > .now else { throw expired() }
        let owner = NativeDeadlineRace<Value>()
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { owner.start($0, deadline: deadline, operation: operation) }
        } onCancel: { owner.finish(.failure(CancellationError())) }
    }

    /// Timeout never reports success or guesses whether a remote model request had already completed.
    static func expired() -> HostFailure { HostFailure(code: "PW_MODEL_TIMEOUT", message: "请求超过时间预算，结果未知，请检查服务状态后再操作") }
}

/// Explicit task/continuation lifetime allows cancellation without awaiting an uncooperative external resolver.
private final class NativeDeadlineRace<Value: Sendable>: Sendable {
    /// All race participants mutate the same small state through a standard-library mutex.
    private struct State {
        /// Exactly one final result can be installed, including cancellation before continuation registration.
        var result: Result<Value, Error>?
        /// The waiter is resumed outside the mutex, preventing re-entrant lock ownership.
        var continuation: CheckedContinuation<Value, Error>?
        /// Owned work and timer are cleared together when any participant finishes.
        var work: Task<Void, Never>?
        /// The deadline timer is cancelled on success/error or caller cancellation.
        var timer: Task<Void, Never>?
    }
    /// The mutex is the only mutable storage; no unchecked Sendable conformance is required.
    private let state = Mutex(State())

    /// Registers the waiter before starting work, then binds both task handles even on immediate completion.
    func start(_ continuation: CheckedContinuation<Value, Error>, deadline: ContinuousClock.Instant, operation: @escaping @Sendable () async throws -> Value) {
        let previous = state.withLock { state -> Result<Value, Error>? in
            if let result = state.result { return result }
            state.continuation = continuation
            return nil
        }
        if let previous { continuation.resume(with: previous); return }
        let work = Task {
            do { finish(.success(try await operation())) }
            catch { finish(.failure(error)) }
        }
        let timer = Task {
            do { try await Task.sleep(until: deadline, clock: .continuous); finish(.failure(NativeDeadline.expired())) }
            catch { /* Completion owns timer cancellation; no new result is needed. */ }
        }
        let ended = state.withLock { state in
            if state.result != nil { return true }
            state.work = work
            state.timer = timer
            return false
        }
        if ended { work.cancel(); timer.cancel() }
    }

    /// A single participant resumes the waiter and releases both task references, including their capture cycles.
    func finish(_ result: Result<Value, Error>) {
        let owned = state.withLock { state -> (CheckedContinuation<Value, Error>?, Task<Void, Never>?, Task<Void, Never>?)? in
            guard state.result == nil else { return nil }
            state.result = result
            let owned = (state.continuation, state.work, state.timer)
            state.continuation = nil
            state.work = nil
            state.timer = nil
            return owned
        }
        guard let owned else { return }
        owned.1?.cancel()
        owned.2?.cancel()
        owned.0?.resume(with: result)
    }
}
