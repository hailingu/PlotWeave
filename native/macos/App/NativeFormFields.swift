import SwiftUI

/// Parses editable node/episode numbers without silently replacing invalid drafts.
nonisolated enum NativeIntegerDraft {
    /// A draft commits only when it represents a JavaScript safe positive integer.
    static func parse(_ text: String) -> Double? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, let value = Double(trimmed), value.isFinite,
              value >= 1, value <= 9_007_199_254_740_991, value.rounded(.towardZero) == value else { return nil }
        return value
    }
}

/// Native text drafts submit while editing so application quit never depends on a later focus change.
struct NativeTextField: View {
    let label: String
    let value: String
    let onSubmit: (String) -> Void
    @State private var draft = ""
    @FocusState private var focused: Bool
    @Environment(\.nativeInspectorFields) private var inspectorFields

    var body: some View {
        if inspectorFields { NativeInspectorField(label: label) { input } }
        else { input }
    }

    /// The presentation wrapper shares the existing draft, focus and incremental commit behavior.
    private var input: some View {
        TextField(label, text: $draft, axis: .vertical)
            .accessibilityLabel(label)
            .focused($focused)
            .onChange(of: draft) { _, updated in if focused && updated != value { onSubmit(updated) } }
            .onAppear { draft = value }
            .onChange(of: value) { _, updated in if !focused { draft = updated } }
    }
}

/// Numeric fields retain incomplete/invalid drafts and expose an explicit optional clear action.
struct NativeNumberField: View {
    let label: String
    let value: Double?
    var onClear: (() -> Void)? = nil
    let onSubmit: (Double) -> Void
    @State private var draft = ""
    @FocusState private var focused: Bool
    @Environment(\.nativeInspectorFields) private var inspectorFields

    var body: some View {
        if inspectorFields { NativeInspectorField(label: label) { input } }
        else { input }
    }

    /// Numeric drafts and explicit clearing remain native controls with one validation path.
    private var input: some View {
        HStack {
            TextField(label, text: $draft).focused($focused)
                .accessibilityLabel(label)
                .onAppear { refresh() }
                .onChange(of: value) { _, _ in if !focused { refresh() } }
                .onChange(of: draft) { _, text in
                    if focused, let number = NativeIntegerDraft.parse(text), number != value { onSubmit(number) }
                }
            if let onClear {
                Button("清除", systemImage: "xmark.circle") { draft = ""; onClear() }.labelStyle(.iconOnly)
            }
        }
    }

    /// Display values originate from validated projections; clearing is a separate domain action.
    private func refresh() { draft = value.map { String(format: "%.0f", $0) } ?? "" }
}

/// A captured project/node identity accompanies every field action until the form is replaced.
@MainActor
struct NativeNodeTarget {
    let state: NativeApplicationState
    let projectId: String
    let id: String

    /// Patches only changed fields; the Web controller owns validation and history.
    func patch(_ fields: [String: HostJSON]) { send("editor.patchNode", ["patch": .object(fields)]) }
    /// Optional fields use the explicit typed clear path rather than invalid JSON null values.
    func clear(_ field: String) { send("editor.clearNodeField", ["field": .string(field)]) }
    /// Granular list editing lets the owner derive arrays from its current document.
    func list(_ command: String, field: String, itemId: String? = nil, patch: [String: HostJSON] = [:]) {
        var args: [String: HostJSON] = ["field": .string(field), "patch": .object(patch)]
        if let itemId { args["itemId"] = .string(itemId) }
        send(command, args)
    }
    /// Immutable identities prevent late confirmation from targeting a newly selected node.
    func send(_ command: String, _ fields: [String: HostJSON] = [:]) {
        var args = fields
        args["id"] = .string(id)
        args["projectId"] = .string(projectId)
        state.sendEditor(command, args: args)
    }
}
