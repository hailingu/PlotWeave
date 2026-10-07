import SwiftUI

/// Entry point of the native PlotWeave shell under development on the
/// `codex/swiftui-react-flow` branch.
///
/// One retained editor window keeps the Web document writer; the welcome card and native controls
/// consume read projections and issue session-bound intents through its coordinator.
/// Normal exit waits for that writer's persisted-edit flush.
@main
struct PlotWeaveNativeApp: App {
    /// AppKit routes normal close and application quit through Web flush; the project's red button returns home.
    @NSApplicationDelegateAdaptor(NativeApplicationDelegate.self) private var delegate

    /// App menus and the visible shell share one read projection/action owner.
    @State private var application = NativeApplicationState()

    var body: some Scene {
        Window("PlotWeave", id: "main") {
            NativeShellRoot(demoMode: Self.isHostedTest, application: application)
        }
        .windowToolbarStyle(.unified)
        .commands {
            CommandGroup(replacing: .newItem) {
                NativeProjectCreationButton(state: application)
                    .labelStyle(.titleOnly)
                    .keyboardShortcut("n", modifiers: .command)
                    .disabled(Self.isHostedTest)
            }
            CommandGroup(replacing: .appSettings) {
                Button("设置…") { application.send("app.settings") }
                    .keyboardShortcut(",", modifiers: .command)
                    .disabled(Self.isHostedTest || application.route == "loading" || application.busy)
            }
            CommandGroup(after: .sidebar) {
                NativeProjectLibraryButton(state: application)
                    .disabled(Self.isHostedTest)
            }
        }
    }

    /// Hosted tests launch only the in-memory fixture, never a page that auto-opens application data.
    private static var isHostedTest: Bool {
        Bundle.allBundles.contains { $0.bundleURL.pathExtension == "xctest" }
    }
}
