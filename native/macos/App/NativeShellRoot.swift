import SwiftUI

/// Native navigation, toolbar, inspector and business views surround one persistent Web canvas session.
struct NativeShellRoot: View {
    let demoMode: Bool
    let services: NativeHostServices?
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
        services: NativeHostServices? = nil,
        application: NativeApplicationState = NativeApplicationState(),
        windowPresentation: NativeWelcomeWindowController = NativeWelcomeWindowController()
    ) {
        self.demoMode = demoMode
        self.services = services
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
                appearance: appearance, demoMode: demoMode,
                application: application, services: services
            )
        }
        .toolbar { NativeEditorToolbar(state: application, layout: layout) }
        .inspector(isPresented: editorPanelsAvailable ? $layout.inspectorVisible : .constant(false)) {
            NativeInspectorView(state: application)
                .inspectorColumnWidth(min: 300, ideal: 360, max: 640)
                .toolbar { NativeInspectorToolbar(state: application, layout: layout) }
        }
        .navigationTitle(application.projectName)
        .background(NativeInspectorRequestObserver(state: application, layout: layout, available: editorPanelsAvailable)
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

    /// Project panels belong to an active editor; the isolated canvas fixture retains panel lifecycle coverage.
    private var editorPanelsAvailable: Bool {
        demoMode || (application.route == "editor" && application.projectId != nil)
    }

    /// Initial loading uses the same welcome geometry; isolated editor fixtures keep their existing window contract.
    private var welcomeAvailable: Bool { !demoMode && ["loading", "home"].contains(application.route) }

}

/// Request observation stays in a leaf view so editor projections do not invalidate the entire shell composition.
private struct NativeInspectorRequestObserver: View {
    /// The application remains the ordered snapshot owner.
    let state: NativeApplicationState
    /// Explicit requests preserve the user's existing native visibility preference.
    let layout: ShellLayoutState
    /// Nonediting routes retain their original guard against replaying properties.
    let available: Bool

    /// A noninteractive retained observer keeps ordinary graph updates out of the root's dependencies.
    var body: some View {
        Color.clear.allowsHitTesting(false)
            .onChange(of: state.projection) { previous, current in
                revealRequestedNodeInspector(previous: previous, current: current)
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
