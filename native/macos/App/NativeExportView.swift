import SwiftUI

/// Native export preview consumes the live session generator and delivers files through AppKit system services.
struct NativeExportView: View {
    let state: NativeApplicationState
    let services: NativeHostServices
    let projectId: String
    @Environment(\.dismiss) private var dismiss
    @State private var format = "md"
    /// The outline appendix stays opt-in like the Web ExportDialog (docs/ui-design.md §5, issue #598).
    @State private var outline = false
    @State private var ticket = NativeExportTicket()
    private var preview: HostJSON { ticket.available(for: key) ?? .null }
    @State private var error: String?
    @State private var receipt: String?
    @State private var delivering = false

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                Text("导出剧本").font(.title2.bold())
                Spacer()
                Button("完成") { dismiss() }.keyboardShortcut(.cancelAction)
            }
            HStack {
                Picker("格式", selection: $format) { Text("Markdown").tag("md"); Text("JSON").tag("json") }
                    .pickerStyle(.segmented).frame(width: 240)
                if format == "md" { Toggle("创作大纲（节奏与分支）", isOn: $outline) }
            }
            .disabled(delivering)
            Text(preview["scope"]?.string ?? "正在生成预览…").font(.caption).foregroundStyle(.secondary)
            ScrollView { Text(preview["text"]?.string ?? "").font(.body.monospaced()).textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading).padding(12) }
                .background(.background, in: .rect(cornerRadius: 8))
            if let error { Text(error).foregroundStyle(.red).textSelection(.enabled) }
            if let receipt { Text(receipt).foregroundStyle(.secondary) }
            HStack {
                Spacer()
                Button("复制全文") { deliver("system.copyText") }
                Button("保存文件…") { deliver("system.saveText") }.buttonStyle(.borderedProminent)
            }.disabled(delivering || preview["text"]?.string == nil)
        }
        .padding(22).frame(minWidth: 700, minHeight: 560)
        .task(id: key) { await loadPreview() }
    }

    /// Changes in actual document content invalidate previews; continuous drag frames never cross this projection.
    private var key: String {
        "\(projectId)|\(format)|\(outline)|\(state.editor["contentRevision"]?.number ?? 0)"
    }

    /// Loading rejects stale targets and never freezes an old document over current edits.
    private func loadPreview() async {
        let requestedKey = key
        ticket.begin(requestedKey)
        error = nil
        receipt = nil
        do {
            let value = try await state.request("editor.exportPreview", args: [
                "projectId": .string(projectId), "format": .string(format), "outline": .bool(outline)
            ])
            guard !Task.isCancelled, requestedKey == key else { return }
            ticket.complete(requestedKey, value: value)
        } catch {
            if !Task.isCancelled { self.error = error.localizedDescription }
        }
    }

    /// Cancellation is a visible result; neither clipboard nor file errors receive a success receipt.
    private func deliver(_ command: String) {
        guard let text = preview["text"]?.string, let name = preview["fileName"]?.string else { return }
        delivering = true
        error = nil
        receipt = nil
        // The user's immutable delivery request owns this adapter through the system service's
        // actual panel decision and awaited atomic write. It may complete after preview dismissal;
        // dismissal is not an I/O cancellation or a success receipt, and no editor write is owned here.
        Task { @MainActor in
            defer { delivering = false }
            do {
                let result = try await services.perform(HostRequest(protocolVersion: 1, sessionId: "native-system", requestId: UUID().uuidString,
                    command: command, args: ["text": .string(text), "fileName": .string(name)]))
                receipt = result["cancelled"]?.bool == true ? "已取消保存" : command == "system.copyText" ? "已复制全文" : "文件已保存"
            } catch { self.error = error.localizedDescription }
        }
    }
}
