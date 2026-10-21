import SwiftUI

/// One flexible inspector fills the system-managed column for AI and node fields using the shared edit/history owner.
struct NativeInspectorView: View {
    let state: NativeApplicationState
    /// macOS evaluates `.inspector` content eagerly, so a hidden pane must not build or
    /// observe the per-selection node field tree (issue #544); the AI pane stays mounted
    /// regardless because its native draft state must survive visibility toggles.
    var visible: Bool = true
    /// The node whose field tree may stay mounted while the pane is hidden: collapsing alone
    /// must not discard incomplete numeric drafts, while a selection change while hidden still
    /// tears the tree down without building a replacement (PR #578 review).
    @State private var mountedNodeID: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // The shared error banner stays outside the AI-versus-content branch: document
            // autosave failures (`editor.saveError`) must remain visible in every pane.
            if visible,
                let error = state.error ?? state.editor["saveError"]?.string ?? state.app["error"]?.string {
                Label(error, systemImage: "exclamationmark.triangle")
                    .foregroundStyle(.red).padding()
            }
            if state.editor["aiOpen"]?.bool == true {
                // The AI pane stays mounted while hidden so its native draft state survives
                // visibility toggles exactly as before (its tree never depends on selection).
                NativeAiView(state: state, projectId: state.projectId ?? "").id(state.projectId)
            } else {
                // Fixed panel bounds isolate cached kinds from each other's intrinsic-size measurement.
                GeometryReader { geometry in
                    ZStack(alignment: .topLeading) {
                        ForEach(inspectorNodes, id: \.type) { node in
                            inspectorFields(node).frame(width: geometry.size.width, height: geometry.size.height)
                        }
                        if !hasSelection && visible { emptySelection.frame(maxWidth: .infinity, maxHeight: .infinity) }
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .onAppear { if visible { mountedNodeID = state.selectedNodeID }; completeWithoutFields() }
        .onChange(of: state.editor) { _, _ in completeWithoutFields() }
        .onChange(of: state.selectedNodeID) { _, current in
            mountedNodeID = visible ? current : nil
        }
        .onChange(of: visible) { _, current in
            if current { mountedNodeID = state.selectedNodeID }
            completeWithoutFields()
        }
    }

    /// Immutable presentation descriptors retain one target-bound form per kind, with no writable document mirror.
    private struct InspectorNode { let id: String; let type: String; let data: HostJSON }

    /// Hidden panes keep only the unchanged selected form; visible loading activates one necessary kind at a time.
    private var inspectorNodes: [InspectorNode] {
        var candidates = [state.editor["selected"]].compactMap { $0 }
        if visible { candidates += state.editorPreparation.seeds }
        var kinds: Set<String> = []
        return candidates.compactMap { value in
            guard let id = value["id"]?.string, let type = value["type"]?.string, let data = value["data"],
                  visible || id == mountedNodeID, kinds.insert(type).inserted,
                  !state.editorPreparation.pending || state.editorPreparation.activatedKinds.contains(type) else { return nil }
            return InspectorNode(id: id, type: type, data: data)
        }.sorted { $0.type < $1.type }
    }

    /// Changing selection rebinds a prepared form and resets drafts by target instead of rebuilding its controls.
    private func inspectorFields(_ node: InspectorNode) -> some View {
        let active = state.selectedNodeID == node.id
        return NativeNodeInspector(state: state, projectId: state.projectId ?? "", id: node.id, type: node.type, data: node.data, active: active)
            .id(state.projectId)
            .environment(\.nativeFieldIdentity, NativeNodeFieldIdentity(projectID: state.projectId ?? "", nodeID: active ? node.id : ""))
            .opacity(active ? 1 : 0)
            .allowsHitTesting(active)
            .accessibilityHidden(!active)
            .disabled(!active)
            .background { preparationReceipt(kind: node.type) }
    }
    /// Prepared fields remain disabled and visually covered until a real selection arrives.
    private var hasSelection: Bool { state.selectedNodeID != nil }
    /// The empty-selection presentation overlays the already laid-out seed instead of removing it.
    private var emptySelection: some View {
        ContentUnavailableView("没有选择节点", systemImage: "cursorarrow", description: Text("在画布或大纲中选择节点，查看和编辑属性。"))
    }
    /// Each mounted kind reports real window layout before loading can activate its successor.
    @ViewBuilder private func preparationReceipt(kind: String) -> some View {
        if visible, state.editorPreparation.pending, state.editorPreparation.error == nil {
            let generation = state.editorPreparation.generation
            NativeLayoutReceipt { state.editorPreparation.fieldReady(generation, kind: kind) }.id(generation)
        }
    }
    /// Hidden and AI panes do not build replacement node fields merely to satisfy a loading receipt.
    private func completeWithoutFields() {
        if !visible || state.editor["aiOpen"]?.bool == true {
            state.editorPreparation.complete(state.editorPreparation.generation)
        }
    }

}

/// Per-selection draft fields retain normal text editing and submit only to the current node identity.
private struct NativeNodeInspector: View {
    let state: NativeApplicationState
    let projectId: String
    let id: String
    let type: String
    let data: HostJSON
    /// A cached inactive kind cannot retain focus, drafts or an open destructive confirmation.
    let active: Bool
    @State private var confirmDelete = false
    /// A retained form must never retarget an already presented destructive confirmation on selection changes.
    @State private var deleteTarget: NativeNodeTarget?

    var body: some View {
        VStack(spacing: 0) {
            NativeInspectorHeader(type: type, data: data)
            Divider()
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    NativeNodeFields(target: NativeNodeTarget(state: state, projectId: projectId, id: id), type: type, data: data)
                }
                .padding(16)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            actions
        }
        .font(.system(size: 13))
        .textFieldStyle(.roundedBorder)
        .toggleStyle(.switch)
        .environment(\.nativeInspectorFields, true)
        .disabled(state.busy || state.editorPreparation.pending)
        .confirmationDialog("删除这个节点及其连线？", isPresented: $confirmDelete) {
            if let target = deleteTarget {
                Button("删除节点", role: .destructive) { target.send("editor.delete") }
            }
        }
        .onChange(of: id) { _, _ in confirmDelete = false; deleteTarget = nil }
        .onChange(of: active) { _, current in if !current { confirmDelete = false; deleteTarget = nil } }
    }

    /// Fixed footer actions stay reachable while long node fields and stable list rows scroll independently.
    private var actions: some View {
        VStack(spacing: 0) {
            Divider()
            HStack(spacing: 10) {
                Button { state.sendEditor("editor.duplicate", args: ["projectId": .string(projectId), "id": .string(id)]) } label: {
                    Label("复制节点", systemImage: "square.on.square").frame(maxWidth: .infinity)
                }
                Button(role: .destructive) {
                    deleteTarget = NativeNodeTarget(state: state, projectId: projectId, id: id)
                    confirmDelete = true
                } label: {
                    Label("删除节点", systemImage: "trash").frame(maxWidth: .infinity)
                }
            }
            .buttonStyle(.bordered).controlSize(.regular)
            .padding(16)
        }
    }
}
