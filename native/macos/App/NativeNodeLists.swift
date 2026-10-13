import SwiftUI

/// List editing sends stable row IDs; the document owner merges against current contents.
struct NativeNodeLists: View {
    let target: NativeNodeTarget
    let type: String
    let data: HostJSON
    private var field: String { type == "dialogue" ? "lines" : type == "branch" ? "options" : "refs" }
    private var title: String { type == "dialogue" ? "台词与动作" : type == "branch" ? "分支选项" : "分镜引用" }

    /// Stable row identities prevent a focused native text draft from moving to a different item after deletion.
    private var rows: [NativeNodeListRow] {
        (data[field]?.array ?? []).enumerated().compactMap { index, value in
            value["id"]?.string.map { NativeNodeListRow(id: $0, index: index, value: value) }
        }
    }

    var body: some View {
        NativeInspectorSection(title: title) {
            ForEach(rows, id: \.id) { row in
                let item = row.value
                let id = row.id
                let index = row.index
                VStack(alignment: .leading, spacing: 12) {
                    HStack {
                        Text("条目 \(index + 1)").font(.caption).foregroundStyle(.secondary)
                        Spacer()
                        Button("删除条目", systemImage: "minus.circle", role: .destructive) {
                            target.list("editor.deleteListItem", field: field, itemId: id)
                        }
                        .labelStyle(.iconOnly).buttonStyle(.borderless).help("删除条目 \(index + 1)")
                    }
                    if type == "dialogue" { NativeDialogueRow(target: target, id: id, item: item) }
                    else if type == "shot" { NativeShotRefRow(target: target, id: id, item: item) }
                    else {
                        NativeTextField(label: "选项 \(index + 1)", value: item["label"]?.string ?? "") {
                            target.list("editor.patchListItem", field: field, itemId: id, patch: ["label": .string($0)])
                        }
                    }
                }
                if id != rows.last?.id { Divider() }
            }
            Button("添加条目", systemImage: "plus") { target.list("editor.insertListItem", field: field) }
                .buttonStyle(.borderless)
        }
    }
}

/// Dialogue fields preserve action/line exclusion, optional speakers, and current entity IDs.
private struct NativeDialogueRow: View {
    let target: NativeNodeTarget
    let id: String
    let item: HostJSON
    private var characters: [HostJSON] { target.state.editor["settings"]?["characters"]?.array ?? [] }

    var body: some View {
        Group {
            NativeInspectorField(label: "行类型") {
                Picker("行类型", selection: textBinding("kind", fallback: "line")) {
                    Text("台词").tag("line")
                    Text("动作").tag("action")
                }
                .pickerStyle(.segmented)
            }
            if item["kind"]?.string != "action" {
                NativeInspectorField(label: "说话人") {
                    Picker("说话人", selection: Binding(get: { item["speaker"]?.string ?? "" }, set: { patch(["speaker": $0.isEmpty ? .null : .string($0)]) })) {
                        Text("未指定").tag("")
                        if let speaker = item["speaker"]?.string, !characters.contains(where: { $0["id"]?.string == speaker }) { Text("失效引用 · " + speaker).tag(speaker) }
                        ForEach(Array(characters.enumerated()), id: \.offset) { _, character in
                            Text(character["name"]?.string ?? "未命名").tag(character["id"]?.string ?? "")
                        }
                    }
                }
                NativeInspectorField(label: "位置") {
                    Picker("位置", selection: textBinding("side", fallback: "left")) {
                        Text("左侧").tag("left"); Text("右侧").tag("right")
                    }
                    .pickerStyle(.segmented)
                }
                NativeInspectorToggle(label: "画外音", isOn: Binding(get: { item["vo"]?.bool ?? false }, set: { patch(["vo": .bool($0)]) }))
            }
            NativeTextField(label: item["kind"]?.string == "action" ? "动作描述" : "台词内容", value: item["text"]?.string ?? "") { patch(["text": .string($0)]) }
        }
    }

    /// Patches contain only changed keys; backend kind transitions clear exclusive fields.
    private func patch(_ fields: [String: HostJSON]) { target.list("editor.patchListItem", field: "lines", itemId: id, patch: fields) }
    /// Picker bindings retain persisted strings until a real native choice is made.
    private func textBinding(_ key: String, fallback: String) -> Binding<String> {
        Binding(get: { item[key]?.string ?? fallback }, set: { patch([key: .string($0)]) })
    }
}

/// Shot references show bound assets and explicitly convert text editing into free labels.
private struct NativeShotRefRow: View {
    let target: NativeNodeTarget
    let id: String
    let item: HostJSON
    private var mime: String? {
        guard let asset = item["assetId"]?.string else { return nil }
        return target.state.editor["assets"]?["byId"]?[asset]?["mime"]?.string
    }

    var body: some View {
        Group {
            NativeInspectorField(label: "引用类型") {
                Picker("引用类型", selection: Binding(get: { item["kind"]?.string ?? "character" }, set: { patch(["kind": .string($0)]) })) {
                    Text("角色垫图").tag("character").disabled(mime.map { !$0.hasPrefix("image/") } ?? false)
                    Text("场景底图").tag("location").disabled(mime.map { !$0.hasPrefix("image/") } ?? false)
                    Text("音频").tag("audio").disabled(mime.map { !$0.hasPrefix("audio/") } ?? false)
                }
            }
            if let asset = item["assetId"]?.string {
                Text((mime == nil ? "失效资产 · " : "资产 · ") + asset).font(.caption).foregroundStyle(.secondary)
            }
            NativeTextField(label: "自由文案", value: item["label"]?.string ?? "") { patch(["label": .string($0)]) }
            Text("编辑文案会替换资产绑定").font(.caption).foregroundStyle(.secondary)
        }
    }

    /// The owning document validates MIME/kind consistency before applying any row change.
    private func patch(_ fields: [String: HostJSON]) { target.list("editor.patchListItem", field: "refs", itemId: id, patch: fields) }
}

/// Presentation identity follows the persisted item ID; indexes serve labels only.
private struct NativeNodeListRow {
    let id: String
    let index: Int
    let value: HostJSON
}
