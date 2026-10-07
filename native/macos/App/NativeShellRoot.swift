import SwiftUI

/// Native navigation, toolbar, inspector and business views surround one persistent Web canvas session.
struct NativeShellRoot: View {
    let demoMode: Bool
    let services: NativeHostServices?
    @State private var layout: ShellLayoutState
    @State private var appearance: CanvasAppearanceState
    @State private var application: NativeApplicationState

    /// Injected services isolate integration fixtures from production and Tauri application data.
    init(
        layout: ShellLayoutState = ShellLayoutState(),
        appearance: CanvasAppearanceState = CanvasAppearanceState(),
        demoMode: Bool = false,
        services: NativeHostServices? = nil,
        application: NativeApplicationState = NativeApplicationState()
    ) {
        self.demoMode = demoMode
        self.services = services
        _layout = State(initialValue: layout)
        _appearance = State(initialValue: appearance)
        _application = State(initialValue: application)
    }

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
                .toolbar(removing: editorPanelsAvailable ? nil : .sidebarToggle)
        } detail: {
            WebCanvasSection(
                appearance: appearance, demoMode: demoMode,
                application: application, services: services
            )
        }
        .inspector(isPresented: editorPanelsAvailable ? $layout.inspectorVisible : .constant(false)) {
            NativeInspectorView(state: application)
                .inspectorColumnWidth(min: 300, ideal: 360, max: 640)
        }
        .navigationTitle(application.projectName)
        .onChange(of: application.projection) { previous, current in
            revealRequestedNodeInspector(previous: previous, current: current)
        }
        .toolbar { NativeEditorToolbar(state: application, layout: layout) }
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
        .task { appearance.startObserving() }
        .onDisappear { appearance.stopObserving() }
    }

    /// Only new edit requests between valid snapshots of one project reveal the inspector; route and page restoration do not replay targets.
    private func revealRequestedNodeInspector(previous: HostJSON, current: HostJSON) {
        guard editorPanelsAvailable,
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

    /// Project panels belong to an active editor; the isolated canvas fixture retains panel lifecycle coverage.
    private var editorPanelsAvailable: Bool {
        demoMode || (application.route == "editor" && application.projectId != nil)
    }

}
