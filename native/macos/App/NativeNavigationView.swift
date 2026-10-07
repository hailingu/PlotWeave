import SwiftUI

/// The editor sidebar dedicates its available height to the current project's story outline.
struct NativeNavigationView: View {
    /// Read-only project and outline projections retain the existing Web editing owner.
    let state: NativeApplicationState
    /// Fixture navigation stays disabled and identifies its non-persistent data.
    let demoMode: Bool

    /// Only the story outline occupies the production sidebar; the isolated fixture retains its data notice.
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if state.route == "editor", state.projectId != nil {
                projectNavigation
            } else {
                Spacer(minLength: 0)
            }
            if demoMode { footer }
        }
        .frame(minWidth: 240, idealWidth: 280, maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .disabled(demoMode || state.route == "loading" || state.busy)
    }

    /// The keyed story outline starts the sidebar; project identity remains in the window title.
    private var projectNavigation: some View {
        NativeOutlineView(state: state).id(state.projectId)
            .padding(.top, 16)
            .frame(maxHeight: .infinity, alignment: .top)
    }

    /// The isolated fixture keeps its data warning separate from production project content.
    private var footer: some View {
        VStack(alignment: .leading, spacing: 8) {
            Divider()
            Text("内存演示数据 · 不落盘")
                .font(.caption)
                .foregroundStyle(.secondary)
                .padding(.horizontal, 10)
        }
        .padding(.horizontal, 12)
        .padding(.bottom, 16)
    }
}
