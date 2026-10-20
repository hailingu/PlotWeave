import SwiftUI

/// Native navigation, toolbar, inspector and business views surround one persistent Web canvas session.
struct NativeShellRoot: View {
    let demoMode: Bool
    /// Isolated-fixture fragment (`fixture` demo default or `perf:N` M15 scales).
    let demoFragment: String
    let services: NativeHostServices?
    /// An optional integration receipt follows the leaf consumer, including requests rejected by its guards.
    private let onInspectorProjectionHandled: (@MainActor (HostJSON) -> Void)?
    /// Optional receipt exposes native presentation writes independently of projected edit requests.
    private let onInspectorVisibilitySet: (@MainActor (Bool) -> Void)?
    @State private var layout: ShellLayoutState
    @State private var appearance: CanvasAppearanceState
    @State private var application: NativeApplicationState
    /// Welcome presentation retains the editor while forwarding normal closing to its save owner.
    @State private var windowPresentation: NativeWelcomeWindowController

    /// Injected services isolate integration fixtures from production and Tauri application data.
    init(
        layout: ShellLayoutState = ShellLayoutState(),
        appearance: CanvasAppearanceState = CanvasAppearanceState(),
        demoMode: Bool = false,
        demoFragment: String = "fixture",
        services: NativeHostServices? = nil,
        application: NativeApplicationState = NativeApplicationState(),
        windowPresentation: NativeWelcomeWindowController = NativeWelcomeWindowController(),
        onInspectorProjectionHandled: (@MainActor (HostJSON) -> Void)? = nil,
        onInspectorVisibilitySet: (@MainActor (Bool) -> Void)? = nil
    ) {
        self.demoMode = demoMode
        self.demoFragment = demoFragment
        self.services = services
        self.onInspectorProjectionHandled = onInspectorProjectionHandled
        self.onInspectorVisibilitySet = onInspectorVisibilitySet
        _layout = State(initialValue: layout)
        _appearance = State(initialValue: appearance)
        _application = State(initialValue: application)
        _windowPresentation = State(initialValue: windowPresentation)
    }

    /// Compose the retained canvas and native panels from navigation, visibility and presentation state.
    var body: some View {
        @Bindable var layout = layout
        @Bindable var application = application
        NavigationSplitView(
            columnVisibility: Binding(
                get: { editorPanelsAvailable && layout.sidebarVisible ? .all : .detailOnly },
                set: { visibility in
                    guard editorPanelsAvailable else { return }
                    layout.sidebarVisible = visibility != .detailOnly
                }
            )
        ) {
            NativeNavigationView(state: application, demoMode: demoMode)
                .toolbar(removing: .sidebarToggle)
        } detail: {
            WebCanvasSection(
                appearance: appearance, demoMode: demoMode, demoFragment: demoFragment,
                application: application, services: services
            )
        }
        .toolbar { NativeEditorToolbar(state: application, layout: layout) }
        .inspector(isPresented: inspectorVisibilityBinding($layout.inspectorVisible)) {
            NativeInspectorView(state: application, visible: editorPanelsAvailable && layout.inspectorVisible)
                .inspectorColumnWidth(min: 300, ideal: 360, max: 640)
                .toolbar { NativeInspectorToolbar(state: application, layout: layout) }
        }
        .navigationTitle(application.projectName)
        .background(NativeInspectorRequestObserver(
            state: application, layout: layout, available: editorPanelsAvailable, onHandled: onInspectorProjectionHandled
        )
            .frame(width: 0, height: 0))
        .sheet(isPresented: $application.exportVisible) {
            NativeExportView(state: application, services: services ?? .shared, projectId: application.projectId ?? "")
        }
        .sheet(isPresented: $application.projectSettingsVisible) {
            NativeProjectSettingsView(state: application, projectId: application.projectId ?? "").id(application.projectId)
        }
        .sheet(isPresented: $application.libraryVisible) {
            NativeLibrarySheet(state: application, services: services ?? .shared)
        }
        .frame(minWidth: 960, minHeight: 600)
        .background(NativeWelcomeWindow(isWelcome: welcomeAvailable, state: application, controller: windowPresentation)
            .frame(width: 0, height: 0))
        .background(NativeSidebarTitlebar(layout: layout, available: editorPanelsAvailable, expanded: layout.sidebarVisible)
            .frame(width: 0, height: 0))
        .transaction(value: editorPanelsAvailable) { transaction in
            // Route restoration lays out both columns once; user panel toggles retain their normal transaction.
            transaction.disablesAnimations = true
            transaction.animation = nil
        }
        .task { appearance.startObserving() }
        .onDisappear { appearance.stopObserving() }
    }

    /// Production retains the original binding; integration receipts observe writes with the same transaction.
    private func inspectorVisibilityBinding(_ original: Binding<Bool>) -> Binding<Bool> {
        guard editorPanelsAvailable else { return .constant(false) }
        guard let onInspectorVisibilitySet else { return original }
        return Binding(
            get: { original.wrappedValue },
            set: { visible, transaction in
                original.transaction(transaction).wrappedValue = visible
                onInspectorVisibilitySet(visible)
            }
        )
    }

    /// Project panels belong to an active editor; the isolated canvas fixture retains panel lifecycle coverage.
    private var editorPanelsAvailable: Bool {
        demoMode || (application.route == "editor" && application.projectId != nil)
    }

    /// Initial loading uses the same welcome geometry; a failed canvas keeps the retained writer visible instead
    /// so the in-window retry overlay stays reachable. Isolated editor fixtures keep their existing contract.
    static func welcomeAvailable(route: String, canvasUnavailable: Bool, demoMode: Bool) -> Bool {
        !demoMode && !canvasUnavailable && ["loading", "home"].contains(route)
    }

    /// The shell reads the observed application state into the pure presentation rule above.
    private var welcomeAvailable: Bool {
        Self.welcomeAvailable(
            route: application.route, canvasUnavailable: application.canvasUnavailable, demoMode: demoMode
        )
    }

}

/// Request observation stays in a leaf view so editor projections do not invalidate the entire shell composition.
private struct NativeInspectorRequestObserver: View {
    /// The application remains the ordered snapshot owner.
    let state: NativeApplicationState
    /// Explicit requests preserve the user's existing native visibility preference.
    let layout: ShellLayoutState
    /// Nonediting routes retain their original guard against replaying properties.
    let available: Bool
    /// Receipt delivery happens after the real effect rather than after envelope acceptance.
    let onHandled: (@MainActor (HostJSON) -> Void)?

    /// A noninteractive retained observer keeps ordinary graph updates out of the root's dependencies.
    var body: some View {
        Color.clear.allowsHitTesting(false)
            .onChange(of: state.projection) { previous, current in
                revealRequestedNodeInspector(previous: previous, current: current)
                onHandled?(current)
            }
    }

    /// Only new edit requests between valid snapshots of one project reveal the inspector; restoration never replays targets.
    private func revealRequestedNodeInspector(previous: HostJSON, current: HostJSON) {
        guard available,
              previous["app"]?["route"]?.string == "editor", current["app"]?["route"]?.string == "editor",
              let project = current["app"]?["project"]?["id"]?.string,
              previous["app"]?["project"]?["id"]?.string == project,
              let editor = current["editor"], let previousEditor = previous["editor"],
              editor["projectId"]?.string == project, previousEditor["projectId"]?.string == project,
              let target = editor["editingNodeId"]?.string, !target.isEmpty,
              editor["selected"]?["id"]?.string == target else { return }
        let request = editor["nodeSettingsRequest"]?.number ?? 0
        let previousRequest = previousEditor["nodeSettingsRequest"]?.number ?? 0
        let newRequest = request.isFinite && request.rounded(.down) == request
            && previousRequest >= 0 && request > previousRequest
        let changedTarget = previousEditor["editingNodeId"]?.string != target
        if newRequest || changedTarget { layout.inspectorVisible = true }
    }

}
