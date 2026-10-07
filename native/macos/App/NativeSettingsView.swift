import SwiftUI

/// Credential-free provider fields accepted by the native settings form.
struct NativeProviderProjection: Identifiable, Equatable {
    /// Provider identity cannot be edited by a form patch.
    let id: String
    let label: String
    let baseUrl: String
    let enabled: Bool
    let models: [String]
    /// This boolean deliberately carries neither plaintext nor the encrypted envelope.
    let keyConfigured: Bool

    /// Reads only the native projection contract; malformed provider entries remain unavailable.
    init?(_ value: HostJSON) {
        guard let id = value["id"]?.string, !id.isEmpty, let label = value["label"]?.string,
              let baseUrl = value["baseUrl"]?.string, let enabled = value["enabled"]?.bool else { return nil }
        self.id = id
        self.label = label
        self.baseUrl = baseUrl
        self.enabled = enabled
        models = value["models"]?.array.compactMap(\.string) ?? []
        keyConfigured = value["keyConfigured"]?.bool ?? false
    }

    /// The existing built-in catalog fixes labels for OpenAI-compatible and Ark providers.
    var isBuiltin: Bool { id == "openai" || id == "volcengine-ark" }
}

/// Settings readiness and model options are projected by the authoritative application owner.
struct NativeSettingsProjection {
    /// A failure or unfinished load never exposes editable fallback defaults.
    let phase: String
    let closing: Bool
    let error: String?
    let providers: [NativeProviderProjection]
    let modelOptions: [NativeModelOption]
    let defaultChat: String?
    let defaultImage: String?

    /// Typed reads retain current values without generating a new settings document.
    init(_ value: HostJSON) {
        phase = value["phase"]?.string ?? "loading"
        closing = value["closing"]?.bool ?? false
        error = value["error"]?.string
        providers = value["providers"]?.array.compactMap(NativeProviderProjection.init) ?? []
        modelOptions = value["modelOptions"]?.array.compactMap(NativeModelOption.init) ?? []
        defaultChat = value["defaultChat"]?.string
        defaultImage = value["defaultImage"]?.string
    }

    /// Conflicting form submissions wait for the current request or settings close to finish.
    func canMutate(busy: Bool) -> Bool { phase == "ready" && !closing && !busy }
}

/// An available default-model choice retains the existing providerId:modelId wire value.
struct NativeModelOption: Identifiable {
    let id: String
    let label: String

    /// Rejects malformed options instead of offering a synthetic model.
    init?(_ value: HostJSON) {
        guard let id = value["value"]?.string, let label = value["label"]?.string else { return nil }
        self.id = id
        self.label = label
    }
}

/// Local provider form drafts contain no persisted settings copy; plaintext exists only until submission.
struct NativeProviderDraft {
    var label: String
    var baseUrl: String
    var models: String
    var key = ""

    /// Seeds editable fields from a read-only provider snapshot.
    init(_ provider: NativeProviderProjection) {
        label = provider.label
        baseUrl = provider.baseUrl
        models = provider.models.joined(separator: "\n")
    }

    /// Matches dev's per-line trimming while emitting only the permitted models field.
    var modelsPatch: HostJSON {
        let items = models.components(separatedBy: .newlines)
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
        return .object(["models": .array(items.map(HostJSON.string))])
    }

    /// Consumes the secure draft before dispatch so failure replies cannot leave a plaintext cache in the form.
    mutating func takeKeyArguments(id: String) -> [String: HostJSON]? {
        let value = key.trimmingCharacters(in: .whitespacesAndNewlines)
        key = ""
        return value.isEmpty ? nil : ["id": .string(id), "key": .string(value)]
    }
}

/// System grouped settings keep readable field widths while preserving the authoritative settings owner.
struct NativeSettingsView: View {
    /// Form writes go through the application owner, never directly to a settings file.
    @Bindable var state: NativeApplicationState
    /// Derived readiness follows the current settings lifecycle rather than local form state.
    private var settings: NativeSettingsProjection { NativeSettingsProjection(state.settings) }

    /// One centered content column gives settings a stable scale across wide and narrow windows.
    var body: some View {
        VStack(spacing: 0) {
            header
            if let error = state.error ?? settings.error {
                Label(error, systemImage: "exclamationmark.triangle")
                    .foregroundStyle(.red).textSelection(.enabled)
                    .frame(maxWidth: 720, alignment: .leading)
                    .padding(.horizontal, 20).padding(.bottom, 8)
            }
            content
        }
        .frame(minWidth: 500, minHeight: 440)
        .background(Color(nsColor: .windowBackgroundColor))
    }

    /// Page identity and completion share the form's content width rather than opposite window edges.
    private var header: some View {
        HStack(spacing: 20) {
            VStack(alignment: .leading, spacing: 4) {
                Text("设置").font(.title2.weight(.semibold))
                Text("管理 AI 服务与默认模型").font(.subheadline).foregroundStyle(.secondary)
            }
            Spacer()
            Button(settings.closing ? "保存中…" : "完成") { state.send("settings.close") }
                .buttonStyle(.borderedProminent)
                .disabled(state.busy || settings.closing)
                .keyboardShortcut(.cancelAction)
        }
        .frame(maxWidth: 720)
        .padding(.horizontal, 20).padding(.top, 24).padding(.bottom, 12)
        .frame(maxWidth: .infinity)
    }

    /// The grouped Form supplies native rows and scrolling; unready settings never expose writable defaults.
    @ViewBuilder private var content: some View {
        if settings.phase == "ready" {
            Form {
                defaults
                ForEach(settings.providers) { provider in
                    NativeProviderSettingsForm(state: state, provider: provider,
                        disabled: !settings.canMutate(busy: state.busy))
                }
                Section {} footer: {
                    Text("远程服务使用 HTTPS；HTTP 仅支持本机回环地址。")
                }
            }
            .formStyle(.grouped)
            .controlSize(.regular)
            .frame(maxWidth: 760, maxHeight: .infinity)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        } else if settings.phase == "error" {
            ContentUnavailableView {
                Label("设置读取失败", systemImage: "exclamationmark.triangle")
            } description: {
                Text("原配置未被改动。修复文件或权限后重试读取。")
            } actions: {
                Button("重试") { state.send("settings.retry") }.disabled(state.busy)
            }
        } else {
            ProgressView("正在加载设置…").frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    /// Native model rows retain unavailable stored choices until the user explicitly changes them.
    private var defaults: some View {
        Section {
            modelPicker("AI 对话模型", value: settings.defaultChat, image: false)
            modelPicker("图像生成模型", value: settings.defaultImage, image: true)
        } header: {
            Text("默认模型")
        } footer: {
            Text("模型清单由各服务提供。图像模型需支持图像生成接口。")
        }
        .disabled(!settings.canMutate(busy: state.busy))
    }

    /// Emits both existing defaults according to the settings action contract; selection does not write locally.
    private func modelPicker(_ title: String, value: String?, image: Bool) -> some View {
        Picker(title, selection: Binding(get: { value ?? "" }, set: { selection in
            guard settings.canMutate(busy: state.busy) else { return }
            state.send("settings.setDefaults", args: [
                "defaultChat": image ? settings.defaultChat.map(HostJSON.string) ?? .null : selection.isEmpty ? .null : .string(selection),
                "defaultImage": image ? selection.isEmpty ? .null : .string(selection) : settings.defaultImage.map(HostJSON.string) ?? .null
            ])
        })) {
            Text("未选择").tag("")
            if let value, !settings.modelOptions.contains(where: { $0.id == value }) {
                Text("当前选择（不可用）：\(value)").tag(value)
            }
            ForEach(settings.modelOptions) { option in Text(option.label).tag(option.id) }
        }
        .pickerStyle(.menu)
    }
}

/// Each provider contributes grouped rows while retaining its stable, short-lived drafts and existing mutations.
private struct NativeProviderSettingsForm: View {
    /// The settings application owner remains the only mutation entry point.
    @Bindable var state: NativeApplicationState
    /// A credential-free snapshot supplies identity, enabled state and key configuration status.
    let provider: NativeProviderProjection
    /// Readiness gates every writable row without unloading the provider draft.
    let disabled: Bool
    /// Multiline caret text and an unsubmitted key remain local to this provider identity.
    @State private var draft: NativeProviderDraft

    /// Initial drafts are tied to a stable provider ID through ForEach ownership.
    init(state: NativeApplicationState, provider: NativeProviderProjection, disabled: Bool) {
        self.state = state
        self.provider = provider
        self.disabled = disabled
        _draft = State(initialValue: NativeProviderDraft(provider))
    }

    /// One service card groups compact connection rows, secure entry and the editable model catalog.
    var body: some View {
        Section {
            VStack(alignment: .leading, spacing: 20) {
                Text(provider.label).font(.title3.weight(.semibold))
                connectionRows
                keyField
                modelsField
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .multilineTextAlignment(.leading)
            .padding(.vertical, 8)
        }
        .disabled(disabled)
        .onChange(of: provider) { previous, next in
            if previous.label != next.label { draft.label = next.label }
            if previous.baseUrl != next.baseUrl { draft.baseUrl = next.baseUrl }
            if previous.models != next.models { draft.models = next.models.joined(separator: "\n") }
        }
        .onDisappear { draft.key = "" }
    }

    /// Connection controls keep standard label/value alignment inside a compact semantic text surface.
    private var connectionRows: some View {
        VStack(spacing: 0) {
            Toggle("启用服务", isOn: Binding(get: { provider.enabled }, set: { enabled in
                patch(.object(["enabled": .bool(enabled)]))
            })).toggleStyle(.switch).padding(12)
            if !provider.isBuiltin {
                Divider().padding(.horizontal, 12)
                LabeledContent("名称") {
                    TextField("服务名称", text: field(\.label, wire: "label"))
                        .labelsHidden().multilineTextAlignment(.trailing).frame(maxWidth: 420)
                }.padding(12)
            }
            Divider().padding(.horizontal, 12)
            LabeledContent("服务地址") {
                TextField("服务地址", text: field(\.baseUrl, wire: "baseUrl"))
                    .labelsHidden().multilineTextAlignment(.trailing).frame(maxWidth: 420)
            }.padding(12)
        }
        .background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 10))
    }

    /// A full-width secure field sits beneath its label; status never displays a stored credential.
    private var keyField: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("API 密钥").font(.headline)
            HStack(spacing: 8) {
                SecureField("API 密钥", text: $draft.key,
                    prompt: Text(provider.keyConfigured ? "输入新密钥以更新" : "输入您的 API 密钥"))
                    .labelsHidden().frame(maxWidth: .infinity)
                    .accessibilityLabel("API 密钥")
                    .textFieldStyle(.roundedBorder)
                    .onSubmit(submitKey)
                Button("保存", action: submitKey)
                    .disabled(draft.key.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                if provider.keyConfigured {
                    Button("清除") { state.send("settings.removeKey", args: ["id": .string(provider.id)]) }
                }
            }
            Text(provider.keyConfigured ? "已配置 · 密钥不会回显" : "未配置")
                .font(.caption).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// Model rows use the whole card width; disclosure retains the existing immediate multiline edits.
    private var modelsField: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("模型列表").font(.headline)
            modelRows
            DisclosureGroup("编辑模型列表") {
                VStack(alignment: .leading, spacing: 6) {
                    TextEditor(text: modelDraft)
                        .font(.body.monospaced())
                        .multilineTextAlignment(.leading)
                        .scrollContentBackground(.hidden)
                        .frame(height: 84).padding(6)
                        .background(Color(nsColor: .textBackgroundColor), in: RoundedRectangle(cornerRadius: 6))
                        .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(Color(nsColor: .separatorColor), lineWidth: 0.5))
                        .accessibilityLabel("模型列表，每行一个 ID")
                    Text("每行填写一个模型 ID，修改会自动保存。")
                        .font(.caption).foregroundStyle(.secondary)
                }
                .padding(.top, 6)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// Positional identities preserve repeated catalog values without deduplicating stored settings.
    private var modelRows: some View {
        VStack(spacing: 0) {
            if provider.models.isEmpty {
                Text("暂无模型，请展开下方编辑列表添加。")
                    .foregroundStyle(.secondary).frame(maxWidth: .infinity, alignment: .leading).padding(12)
            } else {
                ForEach(Array(provider.models.enumerated()), id: \.offset) { index, model in
                    if index > 0 { Divider().padding(.horizontal, 12) }
                    HStack(spacing: 12) {
                        Text(model).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
                        defaultMarkers(for: model)
                    }
                    .padding(.horizontal, 12).padding(.vertical, 10)
                }
            }
        }
        .background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 10))
    }

    /// Checkmarks denote only persisted default purposes; unavailable choices remain visible and unchanged.
    private func defaultMarkers(for model: String) -> some View {
        let settings = NativeSettingsProjection(state.settings)
        let wireValue = provider.id + ":" + model
        let available = settings.modelOptions.contains { $0.id == wireValue }
        return HStack(spacing: 8) {
            if settings.defaultChat == wireValue {
                Label(available ? "对话默认" : "对话默认（不可用）", systemImage: "checkmark")
            }
            if settings.defaultImage == wireValue {
                Label(available ? "图像默认" : "图像默认（不可用）", systemImage: "checkmark")
            }
        }
        .font(.caption).foregroundStyle(.secondary)
    }

    /// Ordinary native fields enter the existing debounced saver on edit, so Done cannot lose an unsubmitted draft.
    private func field(_ keyPath: WritableKeyPath<NativeProviderDraft, String>, wire: String) -> Binding<String> {
        Binding(get: { draft[keyPath: keyPath] }, set: { value in
            guard !disabled else { return }
            draft[keyPath: keyPath] = value
            patch(.object([wire: .string(value)]))
        })
    }

    /// Each model edit emits only its normalized list while the local multiline draft retains caret text.
    private var modelDraft: Binding<String> {
        Binding(get: { draft.models }, set: { value in
            guard !disabled else { return }
            draft.models = value
            patch(draft.modelsPatch)
        })
    }

    /// Guards a captured form against current request readiness before issuing one provider mutation.
    private func patch(_ fields: HostJSON) {
        guard !disabled else { return }
        state.send("settings.patchProvider", args: ["id": .string(provider.id), "patch": fields])
    }

    /// Plaintext is removed before sending and is never copied into ordinary draft patches.
    private func submitKey() {
        guard !disabled, let args = draft.takeKeyArguments(id: provider.id) else { return }
        state.send("settings.setKey", args: args)
    }
}
