import SwiftUI

/// Native outline is a read projection; rename/focus/reorder actions always return to the canvas's single graph owner.
struct NativeOutlineView: View {
    let state: NativeApplicationState
    @State private var projectId: String?

    /// The first displayed project is immutable for this view lifetime; the shell keys the view by project identity.
    init(state: NativeApplicationState) { self.state = state; _projectId = State(initialValue: state.projectId) }

    /// Episode groups and live row labels come directly from the current ordered outline projection.
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("故事大纲").font(.headline)
                Spacer()
                if state.focusedEpisode != .null {
                    Button("取消聚焦") { episode("editor.episodeFocus", number: .null) }.font(.caption)
                }
            }.padding(.horizontal, 12)
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 14) {
                    ForEach(groups, id: \.identity) { group in
                        NativeOutlineGroup(state: state, projectId: projectId, group: group.value, drop: performDrop)
                    }
                }.padding(12)
            }
            if let error = state.error { Text(error).font(.caption).foregroundStyle(.red).padding(.horizontal, 12) }
        }
        .disabled(state.busy || state.projectId != projectId)
        .frame(minWidth: 240, idealWidth: 300)
        .overlay {
            if state.projectId != projectId { ContentUnavailableView("项目已切换", systemImage: "doc", description: Text("请打开当前项目的大纲。")) }
        }
    }

    /// Changed project identity removes the old projection from drop validation immediately.
    private var groups: [NativeOutlineGroupProjection] {
        guard state.projectId == projectId else { return [] }
        return state.editorOutline.array.map(NativeOutlineGroupProjection.init)
    }

    /// Current identities are reread at the actual drop event, including changes after the row was rendered.
    private func performDrop(_ payload: String, _ target: HostJSON) -> Bool {
        guard !state.busy, let projectId, state.projectId == projectId else { return false }
        let ids = Set(groups.flatMap { $0.value["rows"]?.array ?? [] }.compactMap { $0["id"]?.string })
        guard let args = NativeOutlineContract.moveArguments(payload: payload, projectId: projectId, ids: ids, target: target) else { return false }
        state.sendEditor("editor.outlineMove", args: args)
        return true
    }

    /// Focus targets retain the nullable wire contract and the captured document identity.
    private func episode(_ command: String, number: HostJSON) {
        guard let projectId else { return }
        state.sendEditor(command, args: ["projectId": .string(projectId), "episode": number])
    }
}

/// A group header owns native title editing and explicit focus, without creating a native episode model.
private struct NativeOutlineGroup: View {
    let state: NativeApplicationState
    let projectId: String?
    let group: HostJSON
    let drop: (String, HostJSON) -> Bool
    @State private var targeted = false
    private var number: HostJSON { group["episode"] ?? .null }
    private var rows: [HostJSON] { group["rows"]?.array ?? [] }

    /// Unassigned rows have no episode title, while numbered groups retain their existing title field.
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(number.number.map { "第 \(String(format: "%.0f", $0)) 集" } ?? "未分集").font(.subheadline.bold())
                if number != .null { Button("聚焦") { send("editor.episodeFocus") }.font(.caption) }
            }
            if number != .null {
                NativeTextField(label: "集名称", value: group["title"]?.string ?? "") { send("editor.episodeRename", title: $0) }
            }
            ForEach(rows.compactMap(NativeOutlineRowProjection.init), id: \.identity) { row in
                NativeOutlineRow(state: state, projectId: projectId, row: row.value, isSelected: state.selectedNodeID == row.identity, drop: drop)
            }
            Text("拖到此处放在组末尾").font(.caption).foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, minHeight: 24, alignment: .leading)
                .background(targeted ? Color.accentColor.opacity(0.15) : .clear)
                .dropDestination(for: String.self) { items, _ in
                    guard items.count == 1, let payload = items.first else { return false }
                    return drop(payload, .object(["kind": .string("groupEnd"), "episode": number]))
                } isTargeted: { targeted = $0 }
        }
    }

    /// Title and focus actions capture the current rendered episode and project before dispatch.
    private func send(_ command: String, title: String? = nil) {
        guard let projectId else { return }
        var args: [String: HostJSON] = ["projectId": .string(projectId), "episode": number]
        if let title { args["title"] = .string(title) }
        state.sendEditor(command, args: args)
    }
}

/// One native drag/drop row exposes before/after targets while the canvas resolves sequence and attachment semantics.
private struct NativeOutlineRow: View {
    let state: NativeApplicationState
    let projectId: String?
    let row: HostJSON
    /// The group owns the selected-identity read, so one selection change re-evaluates only the affected rows.
    let isSelected: Bool
    let drop: (String, HostJSON) -> Bool
    @State private var targeted = false
    private var id: String { row["id"]?.string ?? "" }
    private var payload: String { projectId.flatMap { NativeOutlineContract.payload(projectId: $0, id: id) } ?? "" }

    /// Drop geometry selects before/after; node selection is a separate native click action.
    var body: some View {
        Button {
            guard let projectId else { return }
            state.sendEditor("editor.select", args: ["projectId": .string(projectId), "id": .string(id)])
        } label: {
            VStack(alignment: .leading, spacing: 2) {
                Text(row["label"]?.string ?? "未命名节点").lineLimit(2)
                if let beat = row["beat"] {
                    Text(beat["pending"]?.bool == true ? "待兑现" : beat["label"]?.string ?? "已兑现").font(.caption2).foregroundStyle(.secondary)
                }
            }
            .padding(.leading, CGFloat(min(3, max(0, row["level"]?.number ?? 0))) * 10)
            .frame(maxWidth: .infinity, minHeight: 34, alignment: .leading)
        }
        .buttonStyle(.plain)
        .padding(.horizontal, 5)
        .background(targeted ? Color.accentColor.opacity(0.2) : isSelected ? Color.accentColor.opacity(0.1) : .clear,
            in: .rect(cornerRadius: 5))
        .draggable(payload)
        .dropDestination(for: String.self) { items, point in
            guard items.count == 1, let item = items.first else { return false }
            return drop(item, .object(["kind": .string("row"), "anchorId": .string(id), "position": .string(point.y < 17 ? "before" : "after")]))
        } isTargeted: { targeted = $0 }
    }
}

/// Episode identity, including the unassigned group, survives row reordering and protects focused title drafts.
private struct NativeOutlineGroupProjection {
    let identity: String
    let value: HostJSON
    init(_ value: HostJSON) {
        self.value = value
        identity = value["episode"]?.number.map { "episode:" + String($0) } ?? "unassigned"
    }
}

/// Stable node identity keeps drag highlighting bound to the same row after outline reorder.
private struct NativeOutlineRowProjection {
    let identity: String
    let value: HostJSON
    init?(_ value: HostJSON) {
        guard let id = value["id"]?.string else { return nil }
        identity = id; self.value = value
    }
}
