import Foundation

/// Keeps sustained canvas measurements opt-in without reducing their scale or assertions.
enum NativeStressTestProfile {
    /// Xcode forwards the explicit TEST_RUNNER_ environment setting to the test host.
    static var enabled: Bool {
        isEnabled(in: ProcessInfo.processInfo.environment)
    }

    /// Only the exact value `1` enables stress; missing or malformed configuration stays lightweight.
    static func isEnabled(in environment: [String: String]) -> Bool {
        environment["PLOTWEAVE_NATIVE_STRESS_TESTS"] == "1"
    }
}
