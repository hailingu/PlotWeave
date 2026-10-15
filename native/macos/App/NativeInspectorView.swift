import SwiftUI

/// One flexible inspector fills the system-managed column for AI and node fields using the shared edit/history owner.
struct NativeInspectorView: View {
    let state: NativeApplicationState
    /// macOS evaluates `.inspector` content eagerly, so a hidden pane must not build or
    /// observe the per-selection node field tree (issue #544); the AI pane stays mounted
    /// regardless because its native draft state must survive visibility toggles.
    var visible: Bool = true

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if state.editor["aiOpen"]?.bool == true {
                // The AI pane stays mounted while hidden so its native draft state survives
                // visibility toggles exactly as before (its tree never depends on selection).
                NativeAiView(state: state, projectId: state.projectId ?? "").id(state.projectId)
            } else if visible {
                if let error = state.error ?? state.editor["saveError"]?.string ?? state.app["error"]?.string {
                    Label(error, systemImage: "exclamationmark.triangle")
                        .foregroundStyle(.red).padding()
                }
                if let id = state.editor["selected"]?["id"]?.string,
                   let type = state.editor["selected"]?["type"]?.string,
                   let data = state.editor["selected"]?["data"] {
                    NativeNodeInspector(state: state, projectId: state.projectId ?? "", id: id, type: type, data: data).id((state.projectId ?? "") + id)
                } else {
                    ContentUnavailableView("没有选择节点", systemImage: "cursorarrow", description: Text("在画布或大纲中选择节点，查看和编辑属性。"))
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
}

/// Per-selection draft fields retain normal text editing and submit only to the current node identity.
private struct NativeNodeInspector: View {
    let state: NativeApplicationState
    let projectId: String
    let id: String
    let type: String
    let data: HostJSON
    @State private var confirmDelete = false

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
        .disabled(state.busy)
        .confirmationDialog("删除这个节点及其连线？", isPresented: $confirmDelete) {
            Button("删除节点", role: .destructive) { state.sendEditor("editor.delete", args: ["projectId": .string(projectId), "id": .string(id)]) }
        }
    }

    /// Fixed footer actions stay reachable while long node fields and stable list rows scroll independently.
    private var actions: some View {
        VStack(spacing: 0) {
            Divider()
            HStack(spacing: 10) {
                Button { state.sendEditor("editor.duplicate", args: ["projectId": .string(projectId), "id": .string(id)]) } label: {
                    Label("复制节点", systemImage: "square.on.square").frame(maxWidth: .infinity)
                }
                Button(role: .destructive) { confirmDelete = true } label: {
                    Label("删除节点", systemImage: "trash").frame(maxWidth: .infinity)
                }
            }
            .buttonStyle(.bordered).controlSize(.regular)
            .padding(16)
        }
    }
}
