import Foundation
import Testing
@testable import PlotWeaveNative

/// Test-host isolation is decided before XCTest loads its bundle, using the shared scheme's launch contract.
struct NativeLaunchModeTests {
    /// The TestAction flag alone must select the in-memory fixture during application bootstrap.
    @Test func testSchemeSelectsFixtureBeforeBundleLoads() {
        #expect(NativeLaunchMode.usesFixture(environment: ["PLOTWEAVE_NATIVE_TEST_HOST": "1"]))
    }

    /// Ordinary launches and unrelated environment values must retain the production entry point.
    @Test func ordinaryLaunchRemainsProduction() {
        for environment in [[:], ["PLOTWEAVE_NATIVE_TEST_HOST": "0"], ["UNRELATED": "1"]] {
            #expect(!NativeLaunchMode.usesFixture(environment: environment))
        }
    }

    /// The actual xcodebuild TestAction must supply isolation before the app-hosted suite starts.
    @Test func hostedRunReceivesSchemeIsolation() {
        #expect(NativeLaunchMode.usesFixture(environment: ProcessInfo.processInfo.environment))
    }
}
