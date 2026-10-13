import AppKit
import SwiftUI
import Testing
@testable import PlotWeaveNative

/// Real AppKit window notifications keep exit ownership independent of project titles and native panels.
@MainActor
@Suite(.serialized)
struct NativeWindowLifecycleTests {
    /// Real shell mounting and AppKit ordering must attach exit ownership without a manually posted window event.
    @Test func hostedApplicationWindowHasExitDelegate() async throws {
        let delegate = NativeApplicationDelegate(quit: HostQuitController())
        delegate.applicationDidFinishLaunching(Notification(name: NSApplication.didFinishLaunchingNotification))
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1100, height: 750), styleMask: [.titled, .closable], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = NSHostingView(rootView: NativeShellRoot(demoMode: true, services: NativeHostServices(dataRoot: nil, quit: HostQuitController())))
        window.makeKeyAndOrderFront(nil)
        defer { window.delegate = nil; window.close(); window.contentView = nil }
        let deadline = ContinuousClock.now.advanced(by: .seconds(5))
        while ContinuousClock.now < deadline {
            if window.delegate === delegate { return }
            try await Task.sleep(for: .milliseconds(30))
        }
        Issue.record("实际 SwiftUI 主窗口未挂接统一退出保存 delegate")
    }

    /// Stable scene identity accepts the main window even after SwiftUI changes its navigation title.
    @Test func changingProjectTitleDoesNotLoseMainWindowDelegate() {
        let delegate = NativeApplicationDelegate(quit: HostQuitController())
        delegate.applicationDidFinishLaunching(Notification(name: NSApplication.didFinishLaunchingNotification))
        let window = NSWindow(contentRect: .zero, styleMask: [.titled, .closable], backing: .buffered, defer: false)
        window.identifier = NSUserInterfaceItemIdentifier("main")
        window.title = "第一集：项目名称"
        NotificationCenter.default.post(name: NSWindow.didBecomeMainNotification, object: window)
        #expect(window.delegate === delegate)
        window.title = "另一项目名称"
        NotificationCenter.default.post(name: NSWindow.didBecomeMainNotification, object: window)
        #expect(window.delegate === delegate)
        window.delegate = nil
    }

    /// After the writer closes through its approved flush, a later Dock quit does not await a destroyed page.
    @Test func dockQuitAfterFlushedWindowCloseCanTerminate() throws {
        let quit = HostQuitController()
        let delegate = NativeApplicationDelegate(quit: quit)
        delegate.applicationDidFinishLaunching(Notification(name: NSApplication.didFinishLaunchingNotification))
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 200, height: 100), styleMask: [.titled, .closable], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.identifier = NSUserInterfaceItemIdentifier("main")
        NotificationCenter.default.post(name: NSWindow.didBecomeMainNotification, object: window)
        quit.acknowledgeListener()
        #expect(delegate.windowShouldClose(window) == false)
        try quit.approve()
        #expect(delegate.applicationShouldTerminate(NSApplication.shared) == .terminateNow)
        #expect(quit.pendingIntent == nil)
    }

    /// An NSSavePanel can become main without taking the editor's close/flush delegate.
    @Test func nativeSavePanelCannotBecomeCanvasExitOwner() {
        let delegate = NativeApplicationDelegate(quit: HostQuitController())
        delegate.applicationDidFinishLaunching(Notification(name: NSApplication.didFinishLaunchingNotification))
        let panel = NSPanel(contentRect: .zero, styleMask: [.titled], backing: .buffered, defer: false)
        panel.title = "PlotWeave"
        NotificationCenter.default.post(name: NSWindow.didBecomeMainNotification, object: panel)
        #expect(panel.delegate !== delegate)
        panel.delegate = nil
    }
}
