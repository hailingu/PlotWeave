import SwiftUI

/// Native AI conversation controls present the existing single-owner session and validated command previews.
struct NativeAiView: View {
    let state: NativeApplicationState
    let projectId: String
    @State private var draft = ""
    @State private var confirmClear = false
    private var ai: HostJSON { state.ai }
    private var busy: Bool { ai["busy"]?.bool == true }
    private var ready: Bool { ai["ready"]?.bool == true }

    var body: some View {
        VStack(spacing: 12) {
            header
            if let error = state.error ?? ai["error"]?.string ?? ai["saveError"]?.string {
                Text(error).foregroundStyle(.red).textSelection(.enabled)
            }
            if state.editor["aiSessionLoadFailed"]?.bool == true {
                Label("聊天记录读取失败，发送和执行已停用。请检查磁盘后重新打开项目。", systemImage: "exclamationmark.triangle")
                    .font(.caption).foregroundStyle(.red)
                if let message = state.editor["aiSessionError"]?.string { Text(message).font(.caption).foregroundStyle(.red) }
            } else if !ready {
                Label("请在设置中配置模型和 API key", systemImage: "info.circle")
                    .font(.caption).foregroundStyle(.secondary)
            }
            timeline
            composer
        }
        .padding(14)
        .confirmationDialog("清空当前 AI 会话？", isPresented: $confirmClear) {
            Button("清空会话", role: .destructive) { send("ai.clear", args: ["confirmed": .bool(true)]) }
        } message: { Text("未确认的改动预览也会清除，此操作无法撤销。") }
    }

    /// The conversation header exposes session actions; application preferences remain in the standard menu.
    private var header: some View {
        HStack {
            Text("AI 编剧").font(.headline)
            Spacer()
            Button("新会话", systemImage: "plus.bubble") { confirmClear = true }
                .disabled(busy || (ai["thread"]?.array.isEmpty ?? true))
        }
    }

    /// Model availability derives from configured-key booleans; no encrypted or plaintext keys reach this view.
    private var modelPicker: some View {
        Picker("模型", selection: Binding(get: { ai["model"]?.string ?? "" }, set: {
            send("ai.selectModel", args: ["model": .string($0)])
        })) {
            ForEach(Array((ai["models"]?.array ?? []).enumerated()), id: \.offset) { _, option in
                Text(option["label"]?.string ?? "").tag(option["value"]?.string ?? "")
                    .disabled(option["available"]?.bool != true)
            }
        }.disabled(busy)
    }

    /// Stable entry IDs keep scroll, preview actions and saved conversation identity aligned.
    private var timeline: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 16) {
                    ForEach(Array((ai["thread"]?.array ?? []).enumerated()), id: \.offset) { _, entry in
                        if let id = entry["id"]?.number {
                            NativeAiEntryView(state: state, projectId: projectId, entry: entry, busy: busy).id(id)
                        }
                    }
                    Color.clear.frame(height: 1).id("latest")
                }.frame(maxWidth: .infinity, alignment: .leading)
            }
            .onChange(of: ai["thread"]?.array.count) { _, _ in proxy.scrollTo("latest", anchor: .bottom) }
        }
    }

    /// Draft text precedes the bottom model/context controls; send and long-request cancellation retain their original owner.
    private var composer: some View {
        VStack(alignment: .leading, spacing: 8) {
            TextEditor(text: $draft).frame(minHeight: 60, maxHeight: 120)
                .scrollContentBackground(.hidden).padding(6)
                .background(.background, in: .rect(cornerRadius: 6)).disabled(!ready || busy)
            modelPicker
            HStack {
                Toggle("了解当前画布", isOn: Binding(get: { ai["knowsCanvas"]?.bool != false }, set: {
                    send("ai.context", args: ["enabled": .bool($0)])
                })).font(.caption)
                Spacer()
                if busy {
                    Button("取消请求", systemImage: "stop.circle") { send("ai.cancel") }
                } else {
                    Button("发送", systemImage: "paperplane") {
                        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
                        guard !text.isEmpty else { return }
                        draft = ""
                        send("ai.send", args: ["text": .string(text)])
                    }
                    .keyboardShortcut(.return, modifiers: .command)
                    .disabled(!ready || draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
        }
    }

    /// Captured project identity accompanies every AI operation, including delayed confirmation callbacks.
    private func send(_ command: String, args: [String: HostJSON] = [:]) {
        var owned = args
        owned["projectId"] = .string(projectId)
        state.send(command, args: owned)
    }
}

/// IM bubbles distinguish speakers while keeping validated previews outside message-only styling.
private struct NativeAiEntryView: View {
    let state: NativeApplicationState
    let projectId: String
    let entry: HostJSON
    let busy: Bool
    /// Speaker alignment is read from the shared thread, never a second conversation state.
    private var isUser: Bool { entry["role"]?.string == "user" }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let text = entry["text"]?.string, !text.isEmpty {
                if entry["kind"]?.string == "note" {
                    Text(verbatim: text).font(.caption).foregroundStyle(.secondary)
                        .multilineTextAlignment(.center).textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.horizontal, 12).frame(maxWidth: .infinity)
                        .accessibilityLabel("回执：\(text)")
                } else {
                    bubble(text)
                }
            }
            if let card = entry["card"], card["status"]?.string != "dismissed" {
                NativeAiPreview(state: state, projectId: projectId, entryId: entry["id"]?.number ?? 0, card: card, busy: busy)
            }
        }.frame(maxWidth: .infinity, alignment: .leading)
    }

    /// Only assistant prose interprets Markdown; user input and execution receipts remain literal text.
    @ViewBuilder private func messageBody(_ text: String) -> some View {
        if isUser {
            Text(verbatim: text).accessibilityLabel("你：\(text)")
        } else {
            NativeMarkdownText(text).accessibilityElement(children: .contain).accessibilityLabel("AI 回复")
        }
    }

    /// Short messages hug their contents; long messages wrap without truncation and preserve selection.
    private func bubble(_ text: String) -> some View {
        HStack(alignment: .top, spacing: 0) {
            if isUser { Spacer(minLength: 28) }
            messageBody(text).multilineTextAlignment(.leading).textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
                .foregroundStyle(isUser ? Color.white : Color.primary)
                .padding(.horizontal, 12).padding(.vertical, 9)
                .background(isUser ? Color.blue : Color.primary.opacity(0.10), in: .rect(cornerRadius: 14))
                .overlay {
                    RoundedRectangle(cornerRadius: 14)
                        .strokeBorder(isUser ? Color.clear : Color.primary.opacity(0.18), lineWidth: 1)
                        .allowsHitTesting(false)
                }
            if !isUser { Spacer(minLength: 28) }
        }.frame(maxWidth: .infinity, alignment: isUser ? .trailing : .leading)
    }
}

/// Destructive batches require an arm step before execution; one native preview maps to one validated graph batch.
private struct NativeAiPreview: View {
    let state: NativeApplicationState
    let projectId: String
    let entryId: Double
    let card: HostJSON
    let busy: Bool
    private var armed: Bool { state.ai["armedEntryId"]?.number == entryId }
    private var validation: HostJSON { card["v"] ?? .null }

    var body: some View {
        GroupBox("改动预览") {
            VStack(alignment: .leading, spacing: 8) {
                ForEach(Array((validation["items"]?.array ?? []).enumerated()), id: \.offset) { _, item in
                    Label(item["label"]?.string ?? "", systemImage: item["danger"]?.bool == true ? "trash" : "pencil")
                }
                ForEach(Array((validation["issues"]?.array ?? []).enumerated()), id: \.offset) { _, issue in
                    Text(issue["message"]?.string ?? "校验失败").foregroundStyle(.red)
                }
                if let error = card["executionError"]?.string { Text(error).foregroundStyle(.red) }
                if card["uncommitted"]?.bool == true {
                    Text("等待画布保存，尚未确认落盘").foregroundStyle(.secondary)
                } else if card["status"]?.string == "executed" {
                    Text(card["historical"]?.bool == true ? "历史改动" : "已执行 · 可整批撤销").foregroundStyle(.secondary)
                } else if card["status"]?.string == "pending" {
                    actions
                }
            }.frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    /// Reject cards cannot execute; deletion confirmation is also checked again by the live action owner.
    private var actions: some View {
        HStack {
            Button("忽略") { send("ai.dismiss") }
            Spacer()
            if validation["hasDeletes"]?.bool == true && !armed {
                Button("确认删除改动…", role: .destructive) { send("ai.arm") }
            } else {
                Button(armed ? "确认执行" : "执行改动") { send("ai.execute") }
                    .disabled(validation["ok"]?.bool != true)
            }
        }.disabled(busy)
    }

    /// Preview identity resolves against the current thread at dispatch time.
    private func send(_ command: String) {
        state.send(command, args: ["projectId": .string(projectId), "entryId": .number(entryId)])
    }
}
