import AppKit
import SwiftUI

/// Native AI conversation controls present the existing single-owner session and validated command previews.
struct NativeAiView: View {
    let state: NativeApplicationState
    let projectId: String
    @State private var draft = ""
    @State private var confirmClear = false
    /// This submission permits only the current in-flight send to consume an unchanged draft.
    @State private var pending: PendingSubmission?
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
            requestFeedback
            composer
        }
        .padding(14)
        .onDisappear { pending = nil }
        .confirmationDialog("清空当前 AI 会话？", isPresented: $confirmClear) {
            Button("清空会话", role: .destructive) { send("ai.clear", args: ["confirmed": .bool(true)]) }
        } message: { Text("未确认的改动预览也会清除，此操作无法撤销。") }
    }

    /// Stable feedback consumes the Web lifecycle projection; this view never infers provider progress.
    @ViewBuilder private var requestFeedback: some View {
        if let feedback = ai["feedback"], let title = feedback["title"]?.string {
            VStack(alignment: .leading, spacing: 4) {
                Text(title).font(.subheadline.weight(.semibold))
                if let detail = feedback["detail"]?.string {
                    Text(detail).font(.caption).foregroundStyle(.secondary)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(10)
            .background(.quaternary, in: .rect(cornerRadius: 8))
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("ai.requestStatus")
            .accessibilityLabel(title)
            .accessibilityValue(feedback["detail"]?.string ?? "")
        }
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
                .scrollContentBackground(.hidden)
                .safeAreaInset(edge: .top, spacing: 0) {
                    Color.clear.frame(height: 6).allowsHitTesting(false)
                }
                .padding(6)
                .background(.background, in: .rect(cornerRadius: 6)).disabled(!ready)
                .onKeyPress(.return, phases: .down) { submitFromKeyboard($0) }
                .onChange(of: ai["thread"]?.array.count) { _, _ in consumeAdmittedDraft() }
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
                        sendDraft()
                    }
                    .keyboardShortcut(.return, modifiers: .command)
                    .disabled(!ready || pending != nil || draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
        }
    }

    /// One in-flight submission owns its exact submitted snapshot; receipts and thread admission
    /// may consume only that snapshot, never text typed afterwards.
    private struct PendingSubmission: Equatable {
        let token = UUID()
        let text: String
        let snapshot: String
    }

    /// Plain Return submits like the send button; Shift+Return and other modifiers keep AppKit's
    /// newline editing, and an active input-method composition keeps Return for candidate
    /// confirmation instead of sending (issue #744).
    private func submitFromKeyboard(_ press: KeyPress) -> KeyPress.Result {
        guard press.modifiers.subtracting(.capsLock).isEmpty, !inputMethodComposing else { return .ignored }
        guard pending == nil, ready, !busy,
              !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return .ignored }
        sendDraft()
        return .handled
    }

    /// The composer can only receive this press while focused, so the composing input, if any,
    /// is the focused text input; its marked text marks Return as input-method-owned.
    private var inputMethodComposing: Bool {
        NSApp.windows.contains { ($0.firstResponder as? NSTextInputClient)?.hasMarkedText() == true }
    }

    /// Rejected sends retain their prompt; a successful Web acknowledgment consumes only the exact submitted snapshot.
    private func sendDraft() {
        let submitted = draft
        let text = submitted.trimmingCharacters(in: .whitespacesAndNewlines)
        guard pending == nil, ready, !busy, !text.isEmpty else { return }
        let submission = PendingSubmission(text: text, snapshot: submitted)
        pending = submission
        state.send("ai.send", args: ["projectId": .string(projectId), "text": .string(text)]) { result in
            guard pending == submission else { return }
            pending = nil
            if case .success = result, draft == submission.snapshot { draft = "" }
        }
    }

    /// The Web owner appends the user message at dispatch; that admission consumes the draft
    /// without waiting for the full model round, while the round receipt remains the rejection
    /// fallback and late receipts cannot touch later drafts (issue #744).
    private func consumeAdmittedDraft() {
        guard let submission = pending, threadAdmitsUserText(submission.text) else { return }
        pending = nil
        if draft == submission.snapshot { draft = "" }
    }

    /// Admission is observable as the live projection containing the submitted user entry itself.
    private func threadAdmitsUserText(_ text: String) -> Bool {
        (ai["thread"]?.array ?? []).contains {
            $0["role"]?.string == "user" && $0["text"]?.string == text
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
    /// Conflicts expose original/proposed ownership and require this preview's manual confirmation.
    private var conflicts: [HostJSON] { validation["episodeAssignment"]?["conflicts"]?.array ?? [] }

    var body: some View {
        GroupBox("改动预览") {
            VStack(alignment: .leading, spacing: 8) {
                ForEach(Array((validation["items"]?.array ?? []).enumerated()), id: \.offset) { _, item in
                    Label(item["label"]?.string ?? "", systemImage: item["danger"]?.bool == true ? "trash" : "pencil")
                }
                ForEach(Array((validation["issues"]?.array ?? []).enumerated()), id: \.offset) { _, issue in
                    Text(issue["message"]?.string ?? "校验失败").foregroundStyle(.red)
                }
                if card["status"]?.string == "pending" && !conflicts.isEmpty {
                    Text("分集冲突：尚未执行。请核对原/目标归属，确认本次冲突后执行，也可忽略取消。")
                        .foregroundStyle(.red)
                    ForEach(Array(conflicts.enumerated()), id: \.offset) { _, conflict in
                        Text(conflict.string ?? "分集冲突").foregroundStyle(.red)
                    }
                    if validation["hasDeletes"]?.bool == true { Text("本批同时包含删除；确认也将执行已列删除。") }
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
            if (!conflicts.isEmpty || validation["hasDeletes"]?.bool == true) && !armed {
                Button(conflicts.isEmpty ? "确认删除改动…" : "确认分集冲突…", role: .destructive) { send("ai.arm") }
            } else {
                Button(!conflicts.isEmpty ? "确认本次分集冲突并执行" : (armed ? "确认执行" : "执行改动")) { send("ai.execute") }
                    .disabled(validation["ok"]?.bool != true)
            }
        }.disabled(busy)
    }

    /// Preview identity resolves against the current thread at dispatch time.
    private func send(_ command: String) {
        state.send(command, args: ["projectId": .string(projectId), "entryId": .number(entryId)])
    }
}
