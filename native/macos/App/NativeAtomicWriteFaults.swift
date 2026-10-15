import Darwin
import Foundation
import Synchronization

/// Test-scoped system-call fault injection for the shared atomic-write protocol
/// (docs/data-model/persistence.md §10.0 文件提交与失败；issue #543).
/// Production runs keep no active injection, so the wrapper executes the real
/// system call unchanged and successful saves keep their layout, timestamps
/// and refusal behavior. Mirrors the Rust `store::persist::faults` baseline.
enum NativeAtomicWriteFaults {
    /// Persisted-write protocol stages a test may fail individually.
    enum Stage: Sendable, Equatable {
        /// fsync of the flushed temporary file before any commit probe.
        case temporaryFileSync
        /// The exclusive rename that commits the final name.
        case rename
        /// The parent-directory fsync durability barrier after a successful rename.
        case directorySync
    }

    /// The window is process-wide because the storage actor executes writes off the test thread.
    private static let state = Mutex(InjectionState())

    /// Scoped injection records reached stages and fails the selected one until the last reference is released.
    final class Injection {
        /// Registers one failing stage; nesting is a test defect because stages would leak across suites.
        init(failing stage: Stage) {
            state.withLock { slot in
                precondition(slot.failing == nil, "不允许嵌套原子写故障注入")
                slot.failing = stage
                slot.reached = []
            }
        }

        /// Protocol stages reached while this injection was active, in execution order.
        var reached: [Stage] { state.withLock { $0.reached } }

        /// Releasing the last reference ends the fault window so later saves converge.
        deinit {
            state.withLock { slot in
                slot.failing = nil
                slot.reached = []
            }
        }
    }

    /// Routes one real system call: records the reached stage, then fails it with EIO or runs it unchanged.
    static func syscall(_ stage: Stage, _ operation: () -> Int32) -> Int32 {
        let injected = state.withLock { slot -> Bool in
            guard slot.failing != nil else { return false }
            slot.reached.append(stage)
            return slot.failing == stage
        }
        if injected {
            errno = EIO
            return -1
        }
        return operation()
    }

    /// Mutable fixture state is confined to the mutex; no unchecked Sendable conformance is required.
    private struct InjectionState {
        /// The stage whose calls fail while the window is open; nil runs everything unchanged without recording.
        var failing: Stage?
        /// Reached stages self-verify that an injected failure actually met the guarded call site.
        var reached: [Stage] = []
    }
}
