import AppKit
import Testing
import WebKit
@testable import PlotWeaveNative

/// Test-host isolation is decided before XCTest loads its bundle, using the shared scheme's launch contract.
@Suite(.serialized, WebKitTestIsolation())
struct NativeLaunchModeTests {
    /// AGENTS.md's v0.2.0 release contract applies to the actual application bundle in both build configurations.
    @Test func applicationBundleUsesDesignatedVersion() {
        #expect(Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String == "0.2.0")
    }

    /// The TestAction flag alone must select the isolated host during application bootstrap.
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

    /// Bootstrap owns no canvas: each integration test must explicitly create and dispose its own real shell.
    @MainActor @Test func bootstrapDoesNotMountUnownedCanvas() {
        let visible = NSApp.windows.filter(\.isVisible)
        #expect(!visible.isEmpty)
        #expect(!visible.contains { Self.containsCanvas($0.contentView) })
    }

    /// Public view traversal observes actual hosted WebKit instances without depending on private SwiftUI types.
    @MainActor private static func containsCanvas(_ view: NSView?) -> Bool {
        guard let view else { return false }
        return view is WKWebView || view.subviews.contains(where: containsCanvas)
    }
}
