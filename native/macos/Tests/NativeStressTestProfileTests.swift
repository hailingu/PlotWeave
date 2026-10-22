import Testing

/// Only an explicit opt-in may enable the expensive canvas measurements.
struct NativeStressTestProfileTests {
    /// Missing and unrecognized values keep ordinary regression lightweight.
    @Test func stressRequiresExplicitOptIn() {
        #expect(!NativeStressTestProfile.isEnabled(in: [:]))
        for value in ["", "0", "true", "yes", "2"] {
            #expect(!NativeStressTestProfile.isEnabled(in: ["PLOTWEAVE_NATIVE_STRESS_TESTS": value]))
        }
        #expect(NativeStressTestProfile.isEnabled(in: ["PLOTWEAVE_NATIVE_STRESS_TESTS": "1"]))
    }
}
