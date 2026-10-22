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
            if Self.isHostedTest {
                Text("原生回归测试宿主")
                    .frame(width: 320, height: 240)
            } else {
                NativeShellRoot(application: application)
            }
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

    /// Hosted tests bootstrap an inert window; individual tests own and dispose every shell and canvas fixture.
    private static var isHostedTest: Bool {
        NativeLaunchMode.usesFixture(environment: ProcessInfo.processInfo.environment)
    }
}
