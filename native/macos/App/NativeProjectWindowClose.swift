import AppKit

/// The project's red close control returns through the existing saved-navigation action, without closing its writer.
@MainActor
final class NativeProjectWindowCloseController: NSObject {
    /// Window replacement cannot redirect a previous editor's close button.
    private weak var window: NSWindow?
    /// The native projection/action owner remains the only route and busy authority.
    private weak var state: NativeApplicationState?
    /// Retaining no control avoids keeping a discarded window alive.
    private weak var button: NSButton?
    /// Native close resumes its original AppKit target and action outside project editing.
    private weak var originalTarget: AnyObject?
    /// The system selector is captured rather than inventing an alternative close path.
    private var originalAction: Selector?

    /// Only valid editing routes redirect the title control; welcome, settings and teardown restore it.
    func update(window: NSWindow?, state: NativeApplicationState?) {
        if self.window !== window { restore() }
        self.window = window
        self.state = state
        guard state?.route == "editor", state?.projectId != nil,
              let control = window?.standardWindowButton(.closeButton) else {
            restore()
            return
        }
        guard button !== control else { return }
        restore()
        button = control
        originalTarget = control.target
        originalAction = control.action
        control.target = self
        control.action = #selector(returnToLibrary(_:))
    }

    /// Repeated clicks await the same navigation; failed requests retain the route and can be explicitly retried.
    @objc private func returnToLibrary(_ sender: NSButton) {
        guard sender === button, sender.window === window,
              let state, state.route == "editor", state.projectId != nil else {
            return
        }
        guard !state.busy else { return }
        state.send("app.home")
    }

    /// Restoring the original title action preserves the existing delegate's close and quit approval protocol.
    private func restore() {
        // AppKit can zero a weak target before deinit; the owned selector still identifies our action.
        if button?.action == #selector(returnToLibrary(_:)), button?.target === self || button?.target == nil {
            button?.target = originalTarget
            button?.action = originalAction
        }
        button = nil
        originalTarget = nil
        originalAction = nil
    }

    /// Releasing a root leaves no custom close target on its retained system window.
    isolated deinit { restore() }
}
