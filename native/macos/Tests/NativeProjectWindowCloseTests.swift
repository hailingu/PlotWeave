import AppKit
import Testing
@testable import PlotWeaveNative

/// The red-button adapter never leaves its custom action on a discarded or nonediting window (N78).
@MainActor
@Suite(.serialized)
struct NativeProjectWindowCloseTests {
    /// Switching windows or routes restores the actual native close action rather than another custom close path.
    @Test func replacementAndNoneditingRouteRestoreNativeClosing() throws {
        let state = try editorState()
        let first = makeWindow()
        let second = makeWindow()
        let firstClose = CloseRecorder()
        let secondClose = CloseRecorder()
        first.delegate = firstClose
        second.delegate = secondClose
        defer { first.delegate = nil; second.delegate = nil; first.close(); second.close() }
        let controller = NativeProjectWindowCloseController()
        controller.update(window: first, state: state)
        controller.update(window: second, state: state)
        try #require(first.standardWindowButton(.closeButton)).performClick(nil)
        #expect(firstClose.requests == 1 && secondClose.requests == 0)
        try state.receiveProjection([
            "protocolVersion": 1, "sessionId": "project-close", "sequence": 2,
            "projection": ["app": ["route": "settings", "loading": false]]
        ])
        controller.update(window: second, state: state)
        try #require(second.standardWindowButton(.closeButton)).performClick(nil)
        #expect(secondClose.requests == 1)
        #expect(state.route == "settings" && !state.busy)
    }

    /// A home projection can arrive before the coalesced titlebar update; a stale project click must not exit.
    @Test func completedNavigationIgnoresStaleProjectButton() throws {
        let state = try editorState()
        let window = makeWindow()
        let recorder = CloseRecorder()
        window.delegate = recorder
        defer { window.delegate = nil; window.close() }
        let controller = NativeProjectWindowCloseController()
        controller.update(window: window, state: state)
        try state.receiveProjection([
            "protocolVersion": 1, "sessionId": "project-close", "sequence": 2,
            "projection": ["app": ["route": "home", "loading": false]]
        ])
        let close = try #require(window.standardWindowButton(.closeButton))
        close.performClick(nil)
        #expect(recorder.requests == 0 && state.route == "home" && !state.busy)
        controller.update(window: window, state: state)
        close.performClick(nil)
        #expect(recorder.requests == 1)
    }

    /// Disposing the root restores native close approval while its retained window still exists.
    @Test func disposalRestoresNativeClosing() async throws {
        let state = try editorState()
        let window = makeWindow()
        let recorder = CloseRecorder()
        window.delegate = recorder
        defer { window.delegate = nil; window.close() }
        var controller: NativeProjectWindowCloseController? = NativeProjectWindowCloseController()
        controller?.update(window: window, state: state)
        controller = nil
        try await Task.sleep(for: .milliseconds(100))
        try #require(window.standardWindowButton(.closeButton)).performClick(nil)
        #expect(recorder.requests == 1 && !state.busy)
    }

    /// Read-only project metadata avoids a production canvas and every application data root.
    private func editorState() throws -> NativeApplicationState {
        let state = NativeApplicationState()
        state.beginSession("project-close")
        try state.receiveProjection([
            "protocolVersion": 1, "sessionId": "project-close", "sequence": 1,
            "projection": ["app": ["route": "editor", "loading": false,
                "project": ["id": "isolated-project", "name": "关闭回归"]]]
        ])
        return state
    }

    /// The real standard title control is tested without allowing the fixture to close before assertions.
    private func makeWindow() -> NSWindow {
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1000, height: 700),
                              styleMask: [.titled, .closable], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        return window
    }

    /// Actual delegate entry records restored native closing and keeps the fixture available for verification.
    private final class CloseRecorder: NSObject, NSWindowDelegate {
        /// Only real window close approval calls contribute to this observable count.
        var requests = 0
        /// Denial models the unchanged save barrier owned by the original application delegate.
        func windowShouldClose(_ sender: NSWindow) -> Bool { requests += 1; return false }
    }
}
