import SwiftUI

/// Asset edits retain a local form draft until the library actor confirms a validated durable update.
struct NativeLibraryAssetForm: View {
    let asset: HostJSON
    let groups: [LibrarySelection]
    let busy: Bool
    let error: String?
    let save: (HostJSON) -> Void
    @State private var name: String
    @State private var kind: String
    @State private var view: String
    @State private var tags: String
    @State private var groupId: String
    @Environment(\.dismiss) private var dismiss

    /// Form initialization captures a stable asset snapshot without becoming a second library store.
    init(asset: HostJSON, groups: [LibrarySelection], busy: Bool, error: String? = nil, save: @escaping (HostJSON) -> Void) {
        self.asset = asset; self.groups = groups; self.busy = busy; self.error = error; self.save = save
        _name = State(initialValue: asset["name"]?.string ?? "")
        _kind = State(initialValue: asset["kind"]?.string ?? "other")
        _view = State(initialValue: asset["view"]?.string ?? "")
        _tags = State(initialValue: (asset["tags"]?.array ?? []).compactMap(\.string).joined(separator: "，"))
        _groupId = State(initialValue: asset["groupId"]?.string ?? "")
    }

    /// Declared metadata fields map exactly to update_library_asset; paths, MIME, source and identity are read-only.
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("编辑素材").font(.title2.bold())
            Form {
                TextField("名称", text: $name)
                Picker("分类", selection: $kind) { ForEach(NativeLibraryLabels.kinds, id: \.0) { Text($0.1).tag($0.0) } }
                Picker("视角", selection: $view) {
                    Text("未指定").tag("")
                    ForEach(NativeLibraryLabels.views, id: \.0) { Text($0.1).tag($0.0) }
                }
                TextField("标签（逗号分隔）", text: $tags)
                Picker("编组", selection: $groupId) {
                    Text("不编组").tag("")
                    ForEach(groups.filter { $0.value["kind"]?.string == kind || $0.id == groupId }) { Text($0.name).tag($0.id) }
                }
                LabeledContent("类型", value: asset["mime"]?.string ?? "")
                LabeledContent("来源", value: asset["source"]?.string == "generated" ? "模型生成" : "上传")
            }.disabled(busy)
            if let error { Text(error).foregroundStyle(.red).font(.caption).textSelection(.enabled) }
            HStack {
                Spacer()
                Button("取消") { dismiss() }.keyboardShortcut(.cancelAction).disabled(busy)
                Button("保存") { save(patch) }.keyboardShortcut(.defaultAction).disabled(busy || name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }.padding(24).frame(width: 460)
    }

    /// Optional values use null to remove fields; tag constraints are enforced by the shared service.
    private var patch: HostJSON {
        let values = tags.components(separatedBy: CharacterSet(charactersIn: ",，\n"))
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
        return .object(["name": .string(name), "kind": .string(kind), "view": view.isEmpty ? .null : .string(view),
            "tags": .array(values.map(HostJSON.string)), "groupId": groupId.isEmpty ? .null : .string(groupId)])
    }
}

/// Group creation and editing submit one complete group; kind conflicts remain visible and never change member assets.
struct NativeLibraryGroupForm: View {
    let busy: Bool
    let error: String?
    let save: (HostJSON) -> Void
    private let id: String
    @State private var name: String
    @State private var kind: String
    @Environment(\.dismiss) private var dismiss

    /// Fresh IDs are safe logical keys and remain fixed across failed submission retries.
    init(group: HostJSON?, busy: Bool, error: String? = nil, save: @escaping (HostJSON) -> Void) {
        self.busy = busy; self.error = error; self.save = save
        id = group?["id"]?.string ?? "lg_" + UUID().uuidString.replacingOccurrences(of: "-", with: "_").lowercased()
        _name = State(initialValue: group?["name"]?.string ?? "")
        _kind = State(initialValue: group?["kind"]?.string ?? "character")
    }

    /// The native form changes only the declared group metadata and explicitly confirms persistence.
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("素材编组").font(.title2.bold())
            Form {
                TextField("名称", text: $name)
                Picker("分类", selection: $kind) { ForEach(NativeLibraryLabels.kinds, id: \.0) { Text($0.1).tag($0.0) } }
            }.disabled(busy)
            if let error { Text(error).foregroundStyle(.red).font(.caption).textSelection(.enabled) }
            HStack {
                Spacer()
                Button("取消") { dismiss() }.keyboardShortcut(.cancelAction).disabled(busy)
                Button("保存") { save(.object(["id": .string(id), "name": .string(name), "kind": .string(kind)])) }
                    .keyboardShortcut(.defaultAction).disabled(busy || name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }.padding(24).frame(width: 420)
    }
}
