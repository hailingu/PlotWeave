import SwiftUI

/// Project metadata for native navigation; this projection never owns a writable document.
struct NativeProjectProjection: Identifiable, Equatable {
    /// Persisted identity binds every action to its original project.
    let id: String
    /// Display metadata and dirty-data diagnostics come from the existing project list.
    let name: String
    let updatedAt: String?
    let error: String?

    /// Rejects malformed identities instead of inventing a target for native mutations.
    init?(_ value: HostJSON) {
        guard let id = value["id"]?.string, !id.isEmpty, let name = value["name"]?.string else { return nil }
        self.id = id
        self.name = name
        updatedAt = value["updatedAt"]?.string
        error = value["error"]?.string
    }
}

/// Read-only homepage policy: search preserves identities and unfinished loads never enable writes.
struct NativeHomeProjection {
    /// The ordered list is supplied by the application owner, including unreadable projects.
    let projects: [NativeProjectProjection]
    /// Missing readiness is treated as loading, rather than a successful empty library.
    let loading: Bool
    /// List or action failures stay visible without replacing the original list.
    let error: String?

    /// Reads only expected wire fields and retains server ordering.
    init(_ value: HostJSON) {
        projects = value["projects"]?.array.compactMap(NativeProjectProjection.init) ?? []
        loading = value["loading"]?.bool ?? true
        error = value["error"]?.string
    }

    /// Matches the dev homepage's trimmed, case-insensitive title search.
    func filtered(by query: String) -> [NativeProjectProjection] {
        let term = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return term.isEmpty ? projects : projects.filter { $0.name.lowercased().contains(term) }
    }

    /// Conflicting navigation and project mutations wait for the current application action.
    func canMutate(busy: Bool) -> Bool { !loading && !busy }

    /// A sheet's captured target must still exist in the current list before submitting.
    func contains(id: String) -> Bool { projects.contains { $0.id == id } }
}

/// Native homepage with actual project navigation; only search and confirmation drafts live locally.
struct NativeHomeView: View {
    /// The application state receives every mutation, retaining the authoritative save coordination.
    @Bindable var state: NativeApplicationState
    /// Presentation-only state never changes persisted project metadata by itself.
    @State private var query = ""
    @State private var renameTarget: NativeProjectProjection?
    @State private var deleteTarget: NativeProjectProjection?

    /// Recomputes readiness from the latest projection, including actions completing while a sheet is open.
    private var home: NativeHomeProjection { NativeHomeProjection(state.app) }

    /// All project controls share the same loading and in-flight action boundary.
    private var enabled: Bool { home.canMutate(busy: state.busy) }

    var body: some View {
        VStack(spacing: 16) {
            header
            TextField("搜索剧名", text: $query)
                .textFieldStyle(.roundedBorder)
                .accessibilityLabel("搜索项目")
            if let error = state.error ?? home.error {
                failure(error)
            }
            if home.loading {
                ProgressView("正在加载项目…").frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if home.filtered(by: query).isEmpty {
                emptyList
            } else {
                projectList
            }
        }
        .padding(24)
        .sheet(item: $renameTarget) { project in
            NativeProjectRenameForm(project: project, disabled: !enabled) { renameTarget = nil } submit: { name in
                guard enabled, home.contains(id: project.id) else { renameTarget = nil; return }
                state.send("app.rename", args: ["id": .string(project.id), "name": .string(name)])
                renameTarget = nil
            }
        }
        .confirmationDialog("删除项目？", isPresented: deletePresented, presenting: deleteTarget) { project in
            Button("删除“\(project.name)”", role: .destructive) {
                if enabled, home.contains(id: project.id) { state.send("app.delete", args: ["id": .string(project.id)]) }
                deleteTarget = nil
            }.disabled(!enabled || !home.contains(id: project.id))
            Button("取消", role: .cancel) { deleteTarget = nil }
        } message: { _ in
            Text("项目画布、AI 会话和项目资产将被删除，此操作无法撤销。")
        }
    }

    /// Binds confirmation visibility to its captured target without retaining an independent mutation flag.
    private var deletePresented: Binding<Bool> {
        Binding(get: { deleteTarget != nil }, set: { if !$0 { deleteTarget = nil } })
    }

    /// The project-library header offers project creation while app settings stay in the standard app menu.
    private var header: some View {
        HStack {
            VStack(alignment: .leading, spacing: 4) {
                Text("项目片库").font(.largeTitle.bold())
                Text("选择一部短剧继续创作").foregroundStyle(.secondary)
            }
            Spacer()
            Button("新建短剧", systemImage: "plus") { state.send("app.create") }.disabled(!enabled)
        }
    }

    /// List failures stay observable and a retry is an explicit application action.
    private func failure(_ message: String) -> some View {
        HStack {
            Label(message, systemImage: "exclamationmark.triangle").foregroundStyle(.red).textSelection(.enabled)
            Spacer()
            Button("重试") { state.send("app.retry") }.disabled(state.busy)
        }
    }

    /// Empty search results never imply persisted projects were removed.
    private var emptyList: some View {
        ContentUnavailableView(
            query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "还没有短剧项目" : "没有匹配的项目",
            systemImage: "rectangle.stack", description: Text("新建短剧，或调整搜索词。")
        ).frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    /// Every action carries an immutable project ID; a dirty placeholder can still be opened for its diagnostic.
    private var projectList: some View {
        List(home.filtered(by: query)) { project in
            HStack(spacing: 12) {
                Button { state.send("app.open", args: ["id": .string(project.id)]) } label: {
                    NativeProjectRow(project: project)
                }.buttonStyle(.plain).disabled(!enabled)
                Spacer()
                Menu {
                    Button("重命名") { renameTarget = project }
                    Button("复制") { state.send("app.duplicate", args: ["id": .string(project.id)]) }
                    Divider()
                    Button("删除", role: .destructive) { deleteTarget = project }
                } label: { Image(systemName: "ellipsis") }
                    .menuStyle(.borderlessButton).frame(width: 28).disabled(!enabled)
            }.padding(.vertical, 8)
        }.listStyle(.inset)
    }
}

/// Metadata presentation avoids claiming valid timestamps or counts for unreadable project placeholders.
private struct NativeProjectRow: View {
    /// Captured metadata is read-only and its ID stays with the action button.
    let project: NativeProjectProjection

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: project.error == nil ? "film.stack" : "exclamationmark.triangle")
                .font(.title2).foregroundStyle(project.error == nil ? Color.accentColor : .orange)
            VStack(alignment: .leading, spacing: 4) {
                Text(project.name).font(.headline)
                if let error = project.error {
                    Text(error).font(.caption).foregroundStyle(.orange)
                } else if let timestamp = project.updatedAt,
                          let date = ISO8601DateFormatter().date(from: timestamp) {
                    Text(date, style: .relative).font(.caption).foregroundStyle(.secondary)
                }
            }
        }.frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle())
    }
}

/// Rename owns only a local text draft; cancellation cannot submit a project mutation.
private struct NativeProjectRenameForm: View {
    /// The ID remains captured while validation uses the current homepage before dispatch.
    let project: NativeProjectProjection
    let disabled: Bool
    let cancel: () -> Void
    let submit: (String) -> Void
    @State private var name: String

    /// Seeds the native draft once, without writing through an editable document copy.
    init(project: NativeProjectProjection, disabled: Bool, cancel: @escaping () -> Void, submit: @escaping (String) -> Void) {
        self.project = project
        self.disabled = disabled
        self.cancel = cancel
        self.submit = submit
        _name = State(initialValue: project.name)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("重命名短剧").font(.headline)
            TextField("剧名", text: $name).textFieldStyle(.roundedBorder).onSubmit(save)
            HStack {
                Spacer()
                Button("取消", action: cancel).keyboardShortcut(.cancelAction)
                Button("保存", action: save).keyboardShortcut(.defaultAction)
                    .disabled(disabled || name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }.padding(24).frame(width: 360)
    }

    /// Whitespace-only drafts never reach the authoritative rename owner.
    private func save() {
        let value = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !disabled, !value.isEmpty else { return }
        submit(value)
    }
}
