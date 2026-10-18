import AppKit
import SwiftUI
import Testing
@testable import PlotWeaveNative

/// Canvas failure recovery: the retained editor window stays visible and reachable; welcome geometry never masks it.
@MainActor
@Suite(.serialized)
struct NativeCanvasFailureRecoveryTests {
    /// Welcome belongs to startup/home only; a failed canvas must keep the in-window retry overlay visible.
    @Test func failureSuppressesWelcomeAndPreservesEditorWindow() {
        #expect(NativeShellRoot.welcomeAvailable(route: "loading", canvasUnavailable: false, demoMode: false))
        #expect(NativeShellRoot.welcomeAvailable(route: "home", canvasUnavailable: false, demoMode: false))
        #expect(!NativeShellRoot.welcomeAvailable(route: "loading", canvasUnavailable: true, demoMode: false))
        #expect(!NativeShellRoot.welcomeAvailable(route: "home", canvasUnavailable: true, demoMode: false))
        #expect(!NativeShellRoot.welcomeAvailable(route: "editor", canvasUnavailable: false, demoMode: false))
        #expect(!NativeShellRoot.welcomeAvailable(route: "loading", canvasUnavailable: false, demoMode: true))
    }

    /// The real welcome presenter restores the retained writer when the shell's failure rule flips isWelcome false.
    @Test func failureDismissesWelcomeAndRestoresWriterInteraction() async throws {
        let state = NativeApplicationState()
        let presentation = NativeWelcomeWindowController()
        let window = NSWindow(
            contentRect: NSRect(x: 100, y: 100, width: 1100, height: 750),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.isReleasedWhenClosed = false
        window.contentView = NSView()
        window.makeKeyAndOrderFront(nil)
        defer {
            presentation.update(window: nil, isWelcome: false)
            window.close()
            window.contentView = nil
        }
        presentation.update(window: window, isWelcome: true, state: state)
        try await Task.sleep(for: .milliseconds(500))
        #expect(presentation.welcomeWindow != nil)
        #expect(window.alphaValue == 0 && window.ignoresMouseEvents)
        state.invalidate("画布失败")
        presentation.update(
            window: window,
            isWelcome: NativeShellRoot.welcomeAvailable(
                route: state.route, canvasUnavailable: state.canvasUnavailable, demoMode: false
            ),
            state: state
        )
        try await Task.sleep(for: .milliseconds(100))
        #expect(presentation.welcomeWindow == nil)
        #expect(window.alphaValue == 1 && !window.ignoresMouseEvents)
    }

    /// A retried page can reach ready before its usable projection; the overlay must keep a retry control visible.
    @Test func readyWithoutProjectionKeepsRetryControlVisible() async throws {
        let state = WebCanvasState()
        state.markReady()
        let window = NSWindow(
            contentRect: NSRect(x: 120, y: 120, width: 720, height: 520),
            styleMask: [.titled], backing: .buffered, defer: false
        )
        window.isReleasedWhenClosed = false
        window.contentView = NSHostingView(
            rootView: CanvasLoadOverlay(state: state, demoMode: false, recoveryPending: true)
        )
        window.makeKeyAndOrderFront(nil)
        defer {
            window.close()
            window.contentView = nil
        }
        try await Task.sleep(for: .milliseconds(300))
        let button = try await NativeCreationControlFixture.button(in: window, named: "重试加载")
        try NativeCreationControlFixture.press(button)
        #expect(state.phase == .loading)
        #expect(state.reloadToken == 1)
    }
}
