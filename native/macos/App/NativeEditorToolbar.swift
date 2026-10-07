import SwiftUI

/// Standard native toolbar dispatches editor intents through the existing undo/save owner.
struct NativeEditorToolbar: ToolbarContent {
    let state: NativeApplicationState
    let layout: ShellLayoutState

    var body: some ToolbarContent {
        if state.route == "editor" {
            ToolbarItemGroup(placement: .navigation) {
                NativeProjectLibraryButton(state: state)
            }
            ToolbarItemGroup(placement: .primaryAction) {
                NativeEditorActions(state: state, layout: layout)
                if state.projectId != nil {
                    Button("检查器", systemImage: "sidebar.trailing") { layout.toggleInspector() }
                }
            }
        }
    }
}

/// Toolbar and menu navigation share one destination, readiness guard and existing save-coordinated action.
struct NativeProjectLibraryButton: View {
    /// The application remains the sole owner of route, pending navigation and failures.
    let state: NativeApplicationState

    var body: some View {
        Button("返回项目片库", systemImage: "house") { state.send("app.home") }
            .help("返回项目片库")
            .disabled(state.route != "editor" || state.busy)
    }
}

/// Creation, history and project tools remain native; graph arrangement is owned by the canvas toolbar.
private struct NativeEditorActions: View {
    let state: NativeApplicationState
    let layout: ShellLayoutState
    private let types = [("节奏卡", "beat"), ("场景", "scene"), ("对白", "dialogue"), ("分支", "branch"), ("分镜", "shot"), ("图片", "image")]

    var body: some View {
        Group {
            Button("撤销", systemImage: "arrow.uturn.backward") { state.sendEditor("editor.undo") }
                .disabled(state.editor["canUndo"]?.bool != true || state.busy)
            Button("重做", systemImage: "arrow.uturn.forward") { state.sendEditor("editor.redo") }
                .disabled(state.editor["canRedo"]?.bool != true || state.busy)
            Menu("添加节点", systemImage: "plus") {
                ForEach(types, id: \.1) { label, type in
                    Button(label) { state.sendEditor("editor.create", args: ["nodeType": .string(type)]) }
                }
            }
            Button("设定集", systemImage: "person.2") { state.projectSettingsVisible = true }
            Button("素材库", systemImage: "photo.on.rectangle") { state.libraryVisible = true }
            Button("AI", systemImage: "sparkles") { layout.inspectorVisible = true; state.sendEditor("editor.ai") }
            Button("导出", systemImage: "square.and.arrow.up") { state.exportVisible = true }
        }
        .disabled(state.busy)
    }
}
