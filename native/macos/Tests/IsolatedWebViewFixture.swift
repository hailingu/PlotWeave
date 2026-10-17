import AppKit
import WebKit

/// Test-only web view factory that keeps every WKWebView fixture inside the
/// host-wide `WebKitTestIsolation` suite scope (issue #575). Constructing a
/// web view outside that scope would let one suite's pages enter another
/// suite's PID-difference attribution window, so the shared permit must be
/// proven before WebKit resources exist, not asserted afterwards by review.
enum IsolatedWebViewFixture {
    /// Why a fixture construction was refused.
    enum Failure: Error {
        /// The creating task does not hold the shared WebKit suite scope;
        /// join the suite to `WebKitTestIsolation()` before creating web views.
        case exclusiveSuiteScopeRequired
    }

    /// The scope precondition shared by every fixture construction site.
    static func assertSuiteScopeHeld() throws {
        guard WebKitTestIsolation.isHeld else { throw Failure.exclusiveSuiteScopeRequired }
    }

    /// Creates the suite's WKWebView only inside the shared scope, so an
    /// ungated suite fails at construction instead of silently reopening
    /// cross-suite WebContent pollution.
    @MainActor
    static func makeWebView(
        frame: NSRect = .zero,
        configuration: WKWebViewConfiguration = WKWebViewConfiguration()
    ) throws -> WKWebView {
        try assertSuiteScopeHeld()
        return WKWebView(frame: frame, configuration: configuration)
    }
}
