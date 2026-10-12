import AppKit
import SwiftUI
import Testing
import WebKit
@testable import PlotWeaveNative

/// Panel lifecycle against the real shell composition
/// (`docs/swiftui-react-flow-migration-plan.md` §4.2): toggling the
/// inspector and collapsing the sidebar must keep the very same WKWebView
/// instance and the loaded page alive. Also seeds M13 by asserting the
/// host appearance sync lands on the real web page.
@MainActor
struct ShellWebCanvasLifecycleTests {

    private struct Timeout: Error {}

    /// Mutable holder feeding a controllable appearance reader.
    @MainActor
    private final class ForcedSnapshot {
        var value: CanvasAppearanceState.Snapshot

        init(_ value: CanvasAppearanceState.Snapshot) {
            self.value = value
        }
    }

    @Test func panelTogglesKeepWebViewAndPageAlive() async throws {
        let layout = ShellLayoutState()
        let forced = ForcedSnapshot(
            CanvasAppearanceState.Snapshot(
                colorScheme: "light",
                reduceTransparency: false,
                increaseContrast: false,
                reduceMotion: false
            )
        )
        let appearance = CanvasAppearanceState(reader: { forced.value })
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1200, height: 800),
            styleMask: [.titled],
            backing: .buffered,
            defer: false
        )
        window.isReleasedWhenClosed = false
        window.contentView = NSHostingView(
            rootView: NativeShellRoot(layout: layout, appearance: appearance, demoMode: true)
        )
        window.orderFront(nil)
        defer { window.close() }

        let webView = try await waitForWebView(in: window)
        try await waitForReadyCanvas(webView)
        let initialScheme = try await waitForHostColorScheme(webView, expected: "light")
        #expect(
            initialScheme == "light",
            "host appearance must land before the panel toggles"
        )
        try await webView.evaluateJavaScript("window.__pwLifecycleProbe = 314159")
        let identity = ObjectIdentifier(webView)

        layout.toggleInspector()
        try await settle()
        let expandedCanvasWidth = webView.bounds.width
        try NativeSidebarControlFixture.press(in: window)
        try await settle()
        #expect(!layout.sidebarVisible)
        #expect(webView.bounds.width > expandedCanvasWidth, "折叠实际侧栏必须释放画布宽度")
        try NativeSidebarControlFixture.press(in: window)
        try await settle()
        #expect(layout.sidebarVisible)
        #expect(abs(webView.bounds.width - expandedCanvasWidth) < 1, "重新展开恢复原画布宽度")

        #expect(ObjectIdentifier(try await waitForWebView(in: window)) == identity)
        let probe = try await webView.evaluateJavaScript(
            "window.__pwLifecycleProbe"
        ) as? Int
        #expect(probe == 314159, "the page must not reload across panel toggles")
        try await waitForReadyCanvas(webView)

        forced.value = CanvasAppearanceState.Snapshot(
            colorScheme: "dark",
            reduceTransparency: true,
            increaseContrast: true,
            reduceMotion: true
        )
        appearance.refresh()
        let pushed = try await waitForHostColorScheme(webView, expected: "dark")
        #expect(pushed == "dark", "appearance pushes must reach the live page")
        let contrast = try await webView.evaluateJavaScript(
            "document.documentElement.getAttribute('data-host-increase-contrast')"
        ) as? String
        #expect(contrast == "true")
    }

    /// M17: the document-start user script must expose the Swift host marker
    /// (protocol version, host kind and fresh session UUID) before any app script runs
    /// — the web side's host identification consumes this versioned marker
    /// (plan §2.3/§3, matrix M17) and must never fall back to memory mode.
    @Test func documentStartScriptInjectsSwiftHostMarker() async throws {
        let layout = ShellLayoutState()
        let appearance = CanvasAppearanceState()
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1200, height: 800),
            styleMask: [.titled],
            backing: .buffered,
            defer: false
        )
        window.isReleasedWhenClosed = false
        window.contentView = NSHostingView(
            rootView: NativeShellRoot(layout: layout, appearance: appearance, demoMode: true)
        )
        window.orderFront(nil)
        defer { window.close() }

        let webView = try await waitForWebView(in: window)
        try await waitForReadyCanvas(webView)
        let marker = try await webView.evaluateJavaScript(
            "window.__pwNativeHost"
        ) as? [String: Any]
        #expect(marker?["kind"] as? String == "swift")
        #expect(marker?["protocolVersion"] as? Int == 1)
        let session = marker?["sessionId"] as? String
        #expect(session.flatMap(UUID.init(uuidString:)) != nil)
        let hasBridge = try await webView.evaluateJavaScript(
            "Boolean(window.webkit.messageHandlers.plotweaveHost)"
        ) as? Bool
        #expect(hasBridge == true)
    }

    /// Inspector access must opt in for Debug without opening Release pages;
    /// the real shell keeps the configured WebView alive across panel updates.
    @Test func canvasInspectionFollowsNativeBuildConfiguration() async throws {
        let layout = ShellLayoutState()
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1200, height: 800),
            styleMask: [.titled],
            backing: .buffered,
            defer: false
        )
        window.isReleasedWhenClosed = false
        window.contentView = NSHostingView(
            rootView: NativeShellRoot(
                layout: layout, appearance: CanvasAppearanceState(), demoMode: true
            )
        )
        window.orderFront(nil)
        defer { window.close() }

        let webView = try await waitForWebView(in: window)
        try await waitForReadyCanvas(webView)
        #if DEBUG
        #expect(webView.isInspectable, "Debug canvas must allow WebKit timeline recording")
        #else
        #expect(!webView.isInspectable, "Release canvas must retain WebKit's closed default")
        #endif
        let identity = ObjectIdentifier(webView)
        layout.toggleInspector()
        try await settle()
        #expect(ObjectIdentifier(try await waitForWebView(in: window)) == identity)
        #if DEBUG
        #expect(webView.isInspectable)
        #else
        #expect(!webView.isInspectable)
        #endif
        try await waitForReadyCanvas(webView)
    }

    /// Reads the semantic attribute the web side applies from host sync.
    private func hostColorScheme(_ webView: WKWebView) async throws -> String? {
        try await webView.evaluateJavaScript(
            "document.documentElement.getAttribute('data-host-color-scheme')"
        ) as? String
    }

    /// Node rendering and host appearance have independent completion; wait for the value the caller asserts.
    private func waitForHostColorScheme(_ webView: WKWebView, expected: String) async throws -> String? {
        let deadline = ContinuousClock.now.advanced(by: .seconds(5))
        var scheme = try await hostColorScheme(webView)
        while scheme != expected && ContinuousClock.now < deadline {
            try await Task.sleep(for: .milliseconds(50))
            scheme = try await hostColorScheme(webView)
        }
        return scheme
    }

    /// Lets SwiftUI apply the layout change before re-asserting identity.
    private func settle() async throws {
        try await Task.sleep(for: .milliseconds(400))
    }

    /// Finds the shell's WKWebView once SwiftUI mounted the canvas section.
    private func waitForWebView(in window: NSWindow) async throws -> WKWebView {
        let deadline = ContinuousClock.now.advanced(by: .seconds(10))
        while ContinuousClock.now < deadline {
            if let contentView = window.contentView,
                let webView = Self.firstWebView(in: contentView) {
                return webView
            }
            try await Task.sleep(for: .milliseconds(50))
        }
        throw Timeout()
    }

    /// Waits until the demo canvas reports its full node set again.
    private func waitForReadyCanvas(_ webView: WKWebView) async throws {
        let deadline = ContinuousClock.now.advanced(by: .seconds(17))
        while ContinuousClock.now < deadline {
            let nodes = try await webView.evaluateJavaScript(
                "document.querySelectorAll('.react-flow__node').length"
            ) as? Int
            if nodes == 9 { return }
            try await Task.sleep(for: .milliseconds(100))
        }
        Issue.record("canvas did not render its 9 demo nodes in time")
    }

    /// Depth-first search for the hosted web view inside the SwiftUI tree.
    private static func firstWebView(in view: NSView) -> WKWebView? {
        if let webView = view as? WKWebView { return webView }
        for subview in view.subviews {
            if let found = firstWebView(in: subview) { return found }
        }
        return nil
    }
}
