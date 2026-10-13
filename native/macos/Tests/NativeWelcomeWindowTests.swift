import AppKit
import SwiftUI
import Testing
@testable import PlotWeaveNative

/// Verifies the welcome card's real window contract without opening a production data root.
@MainActor
@Suite(.serialized)
struct NativeWelcomeWindowTests {
    /// The actual close button must retain the window until the shared lifecycle controller can approve it.
    @Test func closeWaitsForListenerAndApproval() async throws {
        let quit = HostQuitController()
        let delegate = NativeApplicationDelegate(quit: quit)
        let presentation = NativeWelcomeWindowController()
        let window = makeWindow(presentation: presentation, deferredCanvasAttachment: true)
        defer { window.delegate = nil; window.close(); window.contentView = nil }
        try await Task.sleep(for: .milliseconds(500))
        let card = try #require(presentation.welcomeWindow)
        let button = try await NativeCreationControlFixture.button(in: card, named: "关闭欢迎页")
        // NativeApplicationDelegate's stable canvas marker appears after the original main-window event.
        window.contentView?.identifier = NSUserInterfaceItemIdentifier("plotweave.canvas")
        // Subscribe after attachment and do not yield to unrelated windows before this fixture's close.
        delegate.applicationDidFinishLaunching(Notification(name: NSApplication.didFinishLaunchingNotification))
        try NativeCreationControlFixture.press(button)
        #expect(window.delegate === delegate)
        #expect(card.isVisible && quit.pendingIntent == .close)
        #expect(throws: HostFailure.self) { try quit.approve() }
        #expect(card.isVisible && quit.pendingIntent == .close)
        quit.acknowledgeListener()
        try NativeCreationControlFixture.press(button)
        #expect(card.isVisible && quit.pendingIntent == .close)
        try quit.approve()
        #expect(!window.isVisible && !card.isVisible && presentation.welcomeWindow == nil && quit.pendingIntent == nil)
    }

    /// Coalesced route updates cannot leave an editor constrained by a welcome request that was superseded.
    @Test func rapidPresentationChangesRestoreOnlyTheirOwnWindow() async throws {
        let first = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1100, height: 750),
                             styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
        let second = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1000, height: 700),
                              styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
        first.isReleasedWhenClosed = false
        second.isReleasedWhenClosed = false
        defer { first.close(); second.close() }
        first.orderFrontRegardless()
        second.orderFrontRegardless()
        let originalFirst = first.frame
        let originalSecond = second.frame
        let state = NativeApplicationState()
        let controller = NativeWelcomeWindowController()
        controller.update(window: first, isWelcome: true, state: state)
        controller.update(window: first, isWelcome: false)
        try await Task.sleep(for: .milliseconds(100))
        #expect(first.frame == originalFirst && first.styleMask.contains(.resizable))
        controller.update(window: first, isWelcome: true)
        try await Task.sleep(for: .milliseconds(100))
        #expect(first.frame == originalFirst && first.alphaValue == 0 && first.ignoresMouseEvents)
        #expect(controller.welcomeWindow?.frame.size == NativeWelcomeMetrics.windowSize)
        controller.update(window: second, isWelcome: true)
        try await Task.sleep(for: .milliseconds(100))
        #expect(first.frame == originalFirst && first.styleMask.contains(.resizable) && first.alphaValue == 1 && !first.ignoresMouseEvents)
        #expect(second.frame == originalSecond && second.alphaValue == 0 && second.ignoresMouseEvents)
        let card = try #require(controller.welcomeWindow)
        #expect(card.frame.size == NSSize(width: 480, height: 632))
        NotificationCenter.default.post(name: NSWindow.willCloseNotification, object: first)
        #expect(card.isVisible && controller.welcomeWindow === card)
        controller.update(window: nil, isWelcome: false)
        try await Task.sleep(for: .milliseconds(100))
        #expect(second.frame == originalSecond && second.styleMask.contains(.resizable) && second.alphaValue == 1 && !second.ignoresMouseEvents)
        #expect(controller.welcomeWindow == nil && !card.isVisible)
    }

    /// The owner's 2× reference is a fixed 480 × 632 point window with its system title controls hidden.
    @Test func welcomeWindowIsFixedAndHidesStandardChrome() async throws {
        let presentation = NativeWelcomeWindowController()
        let window = makeWindow(presentation: presentation)
        defer { window.delegate = nil; window.close(); window.contentView = nil }
        try await Task.sleep(for: .milliseconds(500))
        let card = try #require(presentation.welcomeWindow)
        #expect(card.frame.size == NSSize(width: 480, height: 632))
        #expect(card.isVisible && window.alphaValue == 0 && window.ignoresMouseEvents)
        #expect(!card.styleMask.contains(.resizable))
        #expect(!card.styleMask.contains(.miniaturizable))
        #expect(card.collectionBehavior.contains(.fullScreenNone))
        #expect(card.titleVisibility == .hidden)
        #expect(card.titlebarAppearsTransparent)
        for kind in [NSWindow.ButtonType.closeButton, .miniaturizeButton, .zoomButton] {
            #expect(card.standardWindowButton(kind)?.isHidden != false)
        }
    }

    /// Dismantling the welcome presentation restores the same window's editor geometry and controls.
    @Test func removingWelcomeRestoresWindowConfiguration() async throws {
        let presentation = NativeWelcomeWindowController()
        let window = makeWindow(presentation: presentation)
        defer { window.delegate = nil; window.close(); window.contentView = nil }
        try await Task.sleep(for: .milliseconds(500))
        let originalFrame = window.frame
        window.contentView = NSView()
        try await Task.sleep(for: .milliseconds(100))
        #expect(presentation.welcomeWindow == nil && window.isVisible)
        #expect(window.styleMask.contains(.resizable))
        #expect(window.styleMask.contains(.miniaturizable))
        #expect(window.titleVisibility == .visible)
        #expect(window.frame == originalFrame)
        for kind in [NSWindow.ButtonType.closeButton, .miniaturizeButton, .zoomButton] {
            #expect(window.standardWindowButton(kind)?.isHidden == false)
        }
    }

    /// A pending native column layout must finish while the writer is still hidden and noninteractive.
    @Test func dismissFlushesPendingLayoutBeforeRestoringInteraction() async throws {
        let presentation = NativeWelcomeWindowController()
        let window = makeWindow(presentation: presentation, deferredCanvasAttachment: true)
        defer { presentation.update(window: nil, isWelcome: false); window.close(); window.contentView = nil }
        let content = LayoutProbeView()
        window.contentView = content
        try await Task.sleep(for: .milliseconds(100))
        #expect(presentation.welcomeWindow != nil && window.alphaValue == 0 && window.ignoresMouseEvents)
        content.layoutWasHidden = nil
        content.needsLayout = true
        presentation.update(window: window, isWelcome: false)
        try await Task.sleep(for: .milliseconds(100))
        #expect(content.layoutWasHidden == true)
        #expect(presentation.welcomeWindow == nil && window.alphaValue == 1 && !window.ignoresMouseEvents)
    }

    /// Public NSView layout observes visibility at the actual pending constraint pass, without replacing SwiftUI APIs.
    private final class LayoutProbeView: NSView {
        var layoutWasHidden: Bool?
        /// The probe records only its own window; unrelated application windows cannot satisfy the ordering contract.
        override func layout() {
            layoutWasHidden = window?.alphaValue == 0 && window?.ignoresMouseEvents == true
            super.layout()
        }
    }

    /// Nil-root shells cover composition; delayed marker attachment isolates the native close protocol from other suites.
    private func makeWindow(
        presentation: NativeWelcomeWindowController, deferredCanvasAttachment: Bool = false
    ) -> NSWindow {
        let window = NSWindow(
            contentRect: NSRect(x: 100, y: 100, width: 1100, height: 750),
            styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false
        )
        window.isReleasedWhenClosed = false
        if deferredCanvasAttachment {
            window.contentView = NSView()
            presentation.update(window: window, isWelcome: true, state: NativeApplicationState())
        } else {
            window.contentView = NSHostingView(rootView: NativeShellRoot(
                services: NativeHostServices(dataRoot: nil, quit: HostQuitController()), windowPresentation: presentation
            ))
        }
        window.makeKeyAndOrderFront(nil)
        return window
    }
}
