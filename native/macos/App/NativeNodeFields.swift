import SwiftUI

/// Complete node inputs use native controls while React remains the document and history owner.
struct NativeNodeFields: View {
    let target: NativeNodeTarget
    let type: String
    let data: HostJSON

    var body: some View {
        NativeInspectorSection(title: "基本信息") {
            ForEach(textFields, id: \.1) { label, key in
                NativeTextField(label: label, value: data[key]?.string ?? "") { target.patch([key: .string($0)]) }
            }
            if type == "shot" {
                NativeNumberField(label: "镜号", value: data["shotNo"]?.number) { target.patch(["shotNo": .number($0)]) }
            }
            if type == "scene" {
                HStack(alignment: .top, spacing: 12) {
                    NativeNumberField(label: "场次", value: data["sceneNo"]?.number) { target.patch(["sceneNo": .number($0)]) }
                    episodeField
                }
            } else if ["beat", "dialogue", "branch"].contains(type) {
                episodeField
            }
        }
        if type == "scene" { sceneFields }
        if type == "dialogue" || type == "branch" || type == "shot" {
            NativeNodeLists(target: target, type: type, data: data)
        }
        if type == "image" { NativeImageFields(target: target, data: data) }
    }

    /// Text field names match dev's declared node model; generated outputs stay read-only.
    private var textFields: [(String, String)] {
        switch type {
        case "scene": [("名称", "name"), ("梗概", "synopsis")]
        case "beat": [("名称", "name"), ("基调", "tone")]
        case "dialogue": [("名称", "name")]
        case "branch": [("问句", "prompt")]
        case "shot": [("景别", "size"), ("画面描述", "picture"), ("镜头提示词", "prompt")]
        case "image": [("提示词", "prompt")]
        default: []
        }
    }

    /// Optional episode numbers share the unchanged typed clear and safe-integer paths.
    private var episodeField: some View {
        NativeNumberField(label: "集号", value: data["episodeNo"]?.number, onClear: { target.clear("episodeNo") }) { target.patch(["episodeNo": .number($0)]) }
    }

    /// Scene context and cast are separate content groups, preserving stable and broken reference identities.
    @ViewBuilder
    private var sceneFields: some View {
        NativeInspectorSection(title: "时间与地点") {
            HStack(alignment: .top, spacing: 12) {
                NativeTextField(label: "时间", value: data["time"]?.string ?? "") { target.patch(["time": .string($0)]) }
                NativeTextField(label: "天气", value: data["weather"]?.string ?? "") { target.patch(["weather": .string($0)]) }
            }
            NativeInspectorToggle(label: "内景", isOn: Binding(get: { data["interior"]?.bool ?? false }, set: { target.patch(["interior": .bool($0)]) }))
            locationField
        }
        NativeInspectorSection(title: "出场角色") {
            if characters.isEmpty && cast.isEmpty { Text("暂无角色").foregroundStyle(.secondary) }
            ForEach(Array(characters.enumerated()), id: \.offset) { _, character in
                let id = character["id"]?.string ?? ""
                NativeInspectorToggle(label: character["name"]?.string ?? "未命名角色", isOn: Binding(get: { cast.contains(id) }, set: { _ in target.send("editor.toggleCharacter", ["characterId": .string(id)]) }))
            }
            ForEach(cast.filter { id in !characters.contains(where: { $0["id"]?.string == id }) }, id: \.self) { Text("失效角色引用 · " + $0).foregroundStyle(.secondary) }
        }
    }

    /// The native location selector retains an explicit empty choice and a visible missing-entity choice.
    private var locationField: some View {
        NativeInspectorField(label: "地点") {
            Picker("地点", selection: Binding(get: { data["locationId"]?.string ?? "" }, set: {
                if $0.isEmpty { target.clear("locationId") } else { target.patch(["locationId": .string($0)]) }
            })) {
                Text("未指定").tag("")
                if let selected = data["locationId"]?.string, !locations.contains(where: { $0["id"]?.string == selected }) { Text("失效引用 · " + selected).tag(selected) }
                ForEach(Array(locations.enumerated()), id: \.offset) { _, location in
                    Text(location["name"]?.string ?? "未命名").tag(location["id"]?.string ?? "")
                }
            }
        }
    }
    private var locations: [HostJSON] { target.state.editorSettings["locations"]?.array ?? [] }
    private var characters: [HostJSON] { target.state.editorSettings["characters"]?.array ?? [] }
    private var cast: [String] { (data["characterIds"]?.array ?? []).compactMap(\.string) }
}

/// Image input, current job status and actions remain separate from generated output ownership.
private struct NativeImageFields: View {
    let target: NativeNodeTarget
    let data: HostJSON
    private var image: HostJSON { target.state.image }
    private var job: HostJSON { image["jobs"]?[target.id] ?? .null }

    var body: some View {
        NativeInspectorSection(title: "图片生成") {
            NativeInspectorField(label: "模型") {
                Picker("模型", selection: Binding(get: { data["model"]?.string ?? "" }, set: { target.patch(["model": .string($0)]) })) {
                    Text("跟随默认模型").tag("")
                    ForEach(Array((image["models"]?.array ?? []).enumerated()), id: \.offset) { _, model in
                        Text(model["label"]?.string ?? "").tag(model["value"]?.string ?? "")
                    }
                }
            }
            NativeInspectorField(label: "尺寸") {
                Picker("尺寸", selection: Binding(get: { data["size"]?.string ?? "1024x1536" }, set: { target.patch(["size": .string($0)]) })) {
                    Text("1024 × 1024 · 方图").tag("1024x1024")
                    Text("1024 × 1536 · 竖图").tag("1024x1536")
                    Text("1536 × 1024 · 横图").tag("1536x1024")
                }
            }
            if job["status"]?.string == "running" {
                ProgressView("正在生成")
                Button("取消生成", systemImage: "stop.circle") { target.send("image.cancel") }
            } else {
                Button("生成图片", systemImage: "sparkles") { target.send("image.start") }
            }
            if let message = job["message"]?.string { Text(message).foregroundStyle(.red) }
            if let asset = data["outputs"]?["primary"]?["assetId"]?.string { Text("当前产物 · " + asset).font(.caption).textSelection(.enabled) }
            Text("修改生成输入后，在途结果会被丢弃，保留新的编辑内容。").font(.caption).foregroundStyle(.secondary)
        }
    }
}
