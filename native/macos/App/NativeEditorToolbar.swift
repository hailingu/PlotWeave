import SwiftUI

/// Standard native toolbar dispatches editor intents through the existing undo/save owner.
struct NativeEditorToolbar: ToolbarContent {
    let state: NativeApplicationState
    let layout: ShellLayoutState

    /// History leads the project title; project actions belong to the inspector toolbar.
    var body: some ToolbarContent {
        if state.route == "editor" {
            ToolbarItemGroup(placement: .navigation) {
                Button("撤销", systemImage: "arrow.uturn.backward") { state.sendEditor("editor.undo") }
                    .disabled(!state.canUndo || state.busy)
                Button("重做", systemImage: "arrow.uturn.forward") { state.sendEditor("editor.redo") }
                    .disabled(!state.canRedo || state.busy)
            }
        }
    }
}

/// Creation and project tools occupy the two ends of the inspector's native toolbar.
struct NativeInspectorToolbar: ToolbarContent {
    /// Native intents still target the existing application and layout owners.
    let state: NativeApplicationState
    /// Inspector visibility is shared with the shell, never duplicated by toolbar presentation.
    let layout: ShellLayoutState

    /// Flexible native spacing follows the inspector width without a second layout preference.
    var body: some ToolbarContent {
        if state.route == "editor" {
            ToolbarItem(placement: .primaryAction) {
                NativeNodeCreationMenu(state: state)
            }
            ToolbarSpacer(.flexible, placement: .primaryAction)
            ToolbarItemGroup(placement: .primaryAction) {
                NativeEditorActions(state: state, layout: layout)
                if state.projectId != nil {
                    Button("检查器", systemImage: "sidebar.trailing") { layout.toggleInspector() }
                }
            }
        }
    }
}

/// Menu navigation retains its destination, readiness guard and existing save-coordinated action.
struct NativeProjectLibraryButton: View {
    /// The application remains the sole owner of route, pending navigation and failures.
    let state: NativeApplicationState

    var body: some View {
        Button("返回项目片库", systemImage: "house") { state.send("app.home") }
            .help("返回项目片库")
            .disabled(state.route != "editor" || state.busy)
    }
}

/// Project tools remain native; graph arrangement is owned by the canvas toolbar.
private struct NativeEditorActions: View {
    let state: NativeApplicationState
    let layout: ShellLayoutState

    var body: some View {
        Group {
            Button("设定集", systemImage: "person.2") { state.projectSettingsVisible = true }
            Button("素材库", systemImage: "photo.on.rectangle") { state.libraryVisible = true }
            Button("AI", systemImage: "sparkles") { layout.inspectorVisible = true; state.sendEditor("editor.ai") }
            Button("导出", systemImage: "square.and.arrow.up") { state.exportVisible = true }
        }
        .disabled(state.busy)
    }
}

/// The inspector toolbar dispatches the existing six creation commands to the Web editor.
private struct NativeNodeCreationMenu: View {
    /// The Web editor remains the node identity, history and save owner.
    let state: NativeApplicationState
    /// Existing labels and wire types remain one finite menu definition.
    private let types = [("节奏卡", "beat"), ("场景", "scene"), ("对白", "dialogue"), ("分支", "branch"), ("分镜", "shot"), ("图片", "image")]

    /// Selection delegates to the original native editor intent rather than creating local nodes.
    var body: some View {
        Menu("添加节点", systemImage: "plus") {
            ForEach(types, id: \.1) { label, type in
                Button(label) { state.sendEditor("editor.create", args: ["nodeType": .string(type)]) }
            }
        }
        .menuIndicator(.hidden)
        .disabled(state.busy)
    }
}
