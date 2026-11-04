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

/// A reused control resets drafts by document target even when two nodes project identical values.
struct NativeNodeFieldIdentity: Equatable {
    /// A reopened project never inherits the previous document's input draft.
    let projectID: String
    /// Empty identity marks a prepared inactive form; real selection rebinds to its immutable node ID.
    let nodeID: String
}

extension EnvironmentValues {
    /// Ordinary forms keep their lifecycle; inspector controls additionally follow their captured node target.
    @Entry var nativeFieldIdentity: NativeNodeFieldIdentity? = nil
}

/// Local input text belongs to one target; reading a new target immediately falls back to its projected value.
private struct NativeFieldDraft {
    private var identity: NativeNodeFieldIdentity?
    private var text = ""

    /// A new identity never displays the previous node's incomplete draft during the view update.
    func value(for identity: NativeNodeFieldIdentity?, fallback: String) -> String {
        self.identity == identity ? text : fallback
    }

    /// Only the native control owns transient text; authoritative document data stays in React.
    mutating func replace(_ text: String, identity: NativeNodeFieldIdentity?) {
        self.identity = identity
        self.text = text
    }
}

/// Native text drafts submit while editing so application quit never depends on a later focus change.
struct NativeTextField: View {
    let label: String
    let value: String
    let onSubmit: (String) -> Void
    @State private var draft = NativeFieldDraft()
    @FocusState private var focused: Bool
    @Environment(\.nativeInspectorFields) private var inspectorFields
    @Environment(\.nativeFieldIdentity) private var fieldIdentity

    var body: some View {
        if inspectorFields { NativeInspectorField(label: label) { input } }
        else { input }
    }

    /// The presentation wrapper shares the existing draft, focus and incremental commit behavior.
    private var input: some View {
        TextField(label, text: Binding(
            get: { draft.value(for: fieldIdentity, fallback: value) },
            set: { text in
                draft.replace(text, identity: fieldIdentity)
                if focused && text != value { onSubmit(text) }
            }
        ), axis: .vertical)
            .accessibilityLabel(label)
            .focused($focused)
            .onAppear { draft.replace(value, identity: fieldIdentity) }
            .onChange(of: value) { _, updated in if !focused { draft.replace(updated, identity: fieldIdentity) } }
            .onChange(of: fieldIdentity) { _, _ in
                focused = false
                draft.replace(value, identity: fieldIdentity)
            }
    }
}

/// Numeric fields retain incomplete/invalid drafts and expose an explicit optional clear action.
struct NativeNumberField: View {
    let label: String
    let value: Double?
    var onClear: (() -> Void)? = nil
    let onSubmit: (Double) -> Void
    @State private var draft = NativeFieldDraft()
    @FocusState private var focused: Bool
    @Environment(\.nativeInspectorFields) private var inspectorFields
    @Environment(\.nativeFieldIdentity) private var fieldIdentity

    var body: some View {
        if inspectorFields { NativeInspectorField(label: label) { input } }
        else { input }
    }

    /// Numeric drafts and explicit clearing remain native controls with one validation path.
    private var input: some View {
        HStack {
            TextField(label, text: Binding(
                get: { draft.value(for: fieldIdentity, fallback: displayValue) },
                set: { text in
                    draft.replace(text, identity: fieldIdentity)
                    if focused, let number = NativeIntegerDraft.parse(text), number != value { onSubmit(number) }
                }
            )).focused($focused)
                .accessibilityLabel(label)
                .onAppear { refresh() }
                .onChange(of: value) { _, _ in if !focused { refresh() } }
                .onChange(of: fieldIdentity) { _, _ in focused = false; refresh() }
            if let onClear, value != nil {
                Button("清除" + label, systemImage: "xmark.circle") {
                    // End the explicit edit so undo can refresh it; delayed projections still preserve focused typing.
                    focused = false
                    draft.replace("", identity: fieldIdentity)
                    onClear()
                }.labelStyle(.iconOnly)
                    .help("清除" + label)
            }
        }
    }

    /// Display values originate from validated projections; clearing is a separate domain action.
    private func refresh() { draft.replace(displayValue, identity: fieldIdentity) }

    /// Incomplete edits stay local while projected numbers retain the existing integer display format.
    private var displayValue: String { value.map { String(format: "%.0f", $0) } ?? "" }
}

/// Every rendered binding captures an immutable project/node target even when its native control is reused.
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
