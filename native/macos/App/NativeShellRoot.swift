import SwiftUI

/// Root composition of the native shell: standard navigation sidebar,
/// unified toolbar, and trailing inspector around the canvas area.
///
/// Chrome uses standard macOS 26 containers, which supply Liquid Glass for
/// navigation and operation areas while the canvas stays an opaque content
/// surface (`docs/swiftui-react-flow-migration-plan.md` §2.2). The detail
/// column hosts ``WebCanvasSection``: a WKWebView rendering the in-memory
/// demo canvas built from the shared frontend sources.
struct NativeShellRoot: View {
    @State private var layout = ShellLayoutState()

    var body: some View {
        @Bindable var layout = layout
        NavigationSplitView {
            ShellSidebarView()
        } detail: {
            WebCanvasSection()
        }
        .inspector(isPresented: $layout.inspectorVisible) {
            ShellInspectorView()
        }
        .navigationTitle("PlotWeave")
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button("检查器", systemImage: "sidebar.trailing") {
                    layout.toggleInspector()
                }
                .help("显示或隐藏属性检查器（占位）")
            }
        }
        .frame(minWidth: 960, minHeight: 600)
    }
}

/// Placeholder navigation sidebar; rows carry no function until P3 connects
/// real single-project navigation.
private struct ShellSidebarView: View {
    var body: some View {
        List {
            Section("导航（占位）") {
                Label("首页", systemImage: "house")
                Label("剧本", systemImage: "text.book.closed")
                Label("角色", systemImage: "person.2")
                Label("场景", systemImage: "photo.on.rectangle.angled")
                Label("设定", systemImage: "slider.horizontal.3")
            }
        }
        .safeAreaInset(edge: .bottom) {
            Text("功能在 P3 接通")
                .font(.footnote)
                .foregroundStyle(.tertiary)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 6)
        }
    }
}

/// Placeholder trailing inspector; attribute editing arrives in P3.
private struct ShellInspectorView: View {
    var body: some View {
        List {
            Section("属性（占位）") {
                LabeledContent("名称", value: "—")
                LabeledContent("位置", value: "—")
                LabeledContent("状态", value: "—")
            }
        }
        .safeAreaInset(edge: .bottom) {
            Text("属性编辑在 P3 接通")
                .font(.footnote)
                .foregroundStyle(.tertiary)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 6)
        }
    }
}
