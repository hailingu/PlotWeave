import SwiftUI

/// Project settings edit the existing character, location and document entities through native forms.
struct NativeProjectSettingsView: View {
    let state: NativeApplicationState
    let projectId: String
    @Environment(\.dismiss) private var dismiss
    @State private var kind = "character"
    @State private var selectedId: String?
    @State private var confirmDelete = false
    @State private var deletion: NativeEntityIdentity?
    private var bucket: String { kind == "character" ? "characters" : kind == "location" ? "locations" : "documents" }
    private var items: [HostJSON] { state.editor["settings"]?[bucket]?.array ?? [] }
    private var selected: HostJSON? { items.first { $0["id"]?.string == selectedId } }

    var body: some View {
        NavigationSplitView {
            VStack {
                Picker("类别", selection: $kind) { Text("角色").tag("character"); Text("地点").tag("location"); Text("文档").tag("document") }
                    .pickerStyle(.segmented).padding()
                List(selection: $selectedId) {
                    ForEach(rows, id: \.id) { row in
                        entityRow(id: row.id, entity: row.value)
                    }
                }
                Button("新增", systemImage: "plus") { send("editor.entityCreate") }.padding()
            }
        } detail: {
            if let selected, let id = selected["id"]?.string {
                NativeEntityForm(state: state, projectId: projectId, kind: kind, id: id, entity: selected).id(kind + id)
                    .toolbar { Button("删除", systemImage: "trash", role: .destructive) { deletion = NativeEntityIdentity(kind: kind, id: id); confirmDelete = true } }
            } else { ContentUnavailableView("选择设定条目", systemImage: "person.text.rectangle", description: Text("可新增角色、地点和长篇设定文档。")) }
        }
        .frame(minWidth: 800, minHeight: 550)
        .navigationTitle("项目设定集")
        .toolbar { Button("完成") { dismiss() }.keyboardShortcut(.defaultAction) }
        .safeAreaInset(edge: .bottom) { if let error = state.error { Text(error).foregroundStyle(.red).padding() } }
        .disabled(state.busy || state.projectId != projectId)
        .onChange(of: kind) { _, _ in selectedId = nil }
        .confirmationDialog("删除设定条目？节点将保留可撤销的失效引用。", isPresented: $confirmDelete) {
            if let deletion { Button("删除", role: .destructive) {
                state.sendEditor("editor.entityDelete", args: ["projectId": .string(projectId), "kind": .string(deletion.kind), "id": .string(deletion.id)])
            } }
        }
    }

    /// Read-only row identities survive renamed or reordered projections; selection never uses display offsets.
    private var rows: [(id: String, value: HostJSON)] {
        items.compactMap { entity in
            guard let id = entity["id"]?.string else { return nil }
            return (id, entity)
        }
    }

    /// The whole row opens its existing detail form, with a visible and accessible editing affordance.
    private func entityRow(id: String, entity: HostJSON) -> some View {
        let label = entity[kind == "document" ? "title" : "name"]?.string ?? "未命名"
        return Button { selectedId = id } label: {
            HStack {
                Text(label)
                Spacer()
                Image(systemName: "pencil").foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .tag(id)
        .accessibilityLabel("编辑「\(label)」")
        .help("编辑名称和内容")
    }

    /// The displayed bucket determines creation/deletion; identity is always captured with the project.
    private func send(_ command: String, id: String? = nil) {
        var args: [String: HostJSON] = ["projectId": .string(projectId), "kind": .string(kind)]
        if let id { args["id"] = .string(id) }
        state.sendEditor(command, args: args)
    }
}

/// Entity fields retain local typing only; committed content lives in the shared document owner.
private struct NativeEntityForm: View {
    let state: NativeApplicationState
    let projectId: String
    let kind: String
    let id: String
    let entity: HostJSON

    var body: some View {
        Form {
            Section("内容") {
                if kind == "document" {
                    text("标题", "title"); text("正文", "body")
                } else {
                    text("名称", "name")
                    if kind == "character" { text("小传", "bio") } else { text("备注", "note") }
                }
            }
            if kind == "document" { relations }
        }.formStyle(.grouped)
    }

    /// Ordinary entity patches go through the same validated settings history as dev.
    private func text(_ label: String, _ key: String) -> some View {
        NativeTextField(label: label, value: entity[key]?.string ?? "") { value in
            state.sendEditor("editor.entityUpdate", args: ["projectId": .string(projectId), "kind": .string(kind), "id": .string(id), "patch": .object([key: .string(value)])])
        }
    }

    /// Each relation toggles a stable entity against the current document instead of replacing a stale array.
    private var relations: some View {
        Section("关联条目") {
            ForEach(["character", "location"], id: \.self) { relationKind in
                let bucket = relationKind == "character" ? "characters" : "locations"
                ForEach(Array((state.editor["settings"]?[bucket]?.array ?? []).enumerated()), id: \.offset) { _, entry in
                    if let relatedId = entry["id"]?.string {
                        Toggle(entry["name"]?.string ?? "未命名", isOn: Binding(get: {
                            (entity["relatedIds"]?.array ?? []).contains { $0["kind"]?.string == relationKind && $0["id"]?.string == relatedId }
                        }, set: { _ in
                            state.sendEditor("editor.toggleDocumentRelation", args: ["projectId": .string(projectId), "id": .string(id), "kind": .string(relationKind), "entityId": .string(relatedId)])
                        }))
                    }
                }
            }
        }
    }
}

/// Delete confirmation binds the original bucket and entity, independently of subsequent selection changes.
private struct NativeEntityIdentity {
    let kind: String
    let id: String
}
