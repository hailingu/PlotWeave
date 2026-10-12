import Foundation

/// The shared TestAction selects the memory fixture before any test bundle is loaded into the app.
enum NativeLaunchMode {
    /// An explicit launch contract avoids bundle-discovery races and never initializes production storage in tests.
    static func usesFixture(environment: [String: String]) -> Bool {
        environment["PLOTWEAVE_NATIVE_TEST_HOST"] == "1"
    }
}
