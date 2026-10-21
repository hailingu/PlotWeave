import Foundation
import Observation
import SwiftUI

/// Project-entry presentation prepares at most one real field tree per project node kind, never one per graph node.
@MainActor
@Observable
final class NativeEditorPreparation {
    /// Waiting and failed states keep input shielded; current layout receipts release the project.
    private enum Phase: Equatable { case waiting, ready, failed }
    private var phase = Phase.ready
    private var started = false
    private var readyKinds: Set<String> = []
    /// App navigation can precede the matching editor snapshot.
    private(set) var hasSnapshot = false
    /// Project, page and retry changes invalidate all prior layout callbacks.
    private(set) var generation = UUID()
    /// This is presentation identity only; the Web session remains the document owner.
    private(set) var projectID: String?
    /// One read-only representative per existing kind bounds preparation to the six supported node kinds.
    private(set) var seeds: [HostJSON] = []
    /// The loading shield attaches and lays out first; each subsequent layout receipt activates at most one new field tree.
    private(set) var activatedKinds: Set<String> = []

    /// Native overlays and controls observe only this small presentation owner.
    var pending: Bool { projectID != nil && phase != .ready }
    /// A timed-out layout remains recoverable without reopening or replaying the project operation.
    var error: String? { phase == .failed ? "项目属性准备超时，请重试。" : nil }

    /// Ordinary snapshots refresh read-only representatives without restarting a completed preparation.
    func receive(projectID: String?, editor: HostJSON) {
        if self.projectID != projectID {
            reset()
            self.projectID = projectID
            phase = projectID == nil ? .ready : .waiting
        }
        guard let projectID, editor["projectId"]?.string == projectID else { return }
        hasSnapshot = true
        guard let projected = editor["inspectorSeeds"]?.arrayValue else {
            seeds = [] // Older projections have no preparation contract.
            if phase == .waiting { phase = .ready }
            return
        }
        var seen: Set<String> = []
        seeds = ([editor["selected"]].compactMap { $0 } + projected).filter { value in
            guard value["id"]?.string != nil, value["data"]?.object != nil,
                  let kind = value["type"]?.string else { return false }
            return seen.insert(kind).inserted
        }
        if phase == .waiting, seeds.isEmpty || started { advance() }
    }

    /// A page reset invalidates receipts even if the new page opens the same project identity.
    func reset() {
        generation = UUID()
        projectID = nil
        seeds = []
        activatedKinds = []
        readyKinds = []
        started = false
        hasSnapshot = false
        phase = .ready
    }

    /// A window update of the loading shield precedes any expensive field-tree construction.
    func start(_ generation: UUID) {
        guard generation == self.generation, hasSnapshot, phase == .waiting else { return }
        started = true
        advance()
    }

    /// Only an activated tree's actual window/layout receipt advances the bounded preparation queue.
    func fieldReady(_ generation: UUID, kind: String) {
        guard generation == self.generation, phase == .waiting, activatedKinds.contains(kind) else { return }
        readyKinds.insert(kind)
        advance()
    }

    /// Hidden and AI panes explicitly need no node fields; failure still requires an explicit retry.
    func complete(_ generation: UUID) {
        guard generation == self.generation, hasSnapshot, phase == .waiting else { return }
        phase = .ready
    }

    /// A bounded UI-owned timeout cannot fail a later project or undo completed preparation.
    func fail(_ generation: UUID) {
        guard generation == self.generation, phase == .waiting else { return }
        phase = .failed
    }

    /// Retry repeats only local preparation and retains the authoritative project/save owner.
    func retry() {
        guard phase == .failed else { return }
        generation = UUID()
        activatedKinds = []
        readyKinds = []
        started = false
        phase = hasSnapshot && seeds.isEmpty ? .ready : .waiting
    }

    /// Keep prior trees mounted while the next kind prepares, yielding through AppKit instead of guessed delays.
    private func advance() {
        let kinds = seeds.compactMap { $0["type"]?.string }
        let required = Set(kinds)
        readyKinds.formIntersection(required)
        activatedKinds.formIntersection(required)
        if required.isSubset(of: readyKinds) { phase = .ready; return }
        guard activatedKinds.subtracting(readyKinds).isEmpty,
              let next = kinds.first(where: { !readyKinds.contains($0) }) else { return }
        activatedKinds.insert(next)
    }
}

/// The real project stays mounted underneath a loading shield until its necessary native fields have laid out.
struct NativeEditorPreparationOverlay: View {
    let state: NativeApplicationState
    /// A collapsed inspector may never mount its content; the shield owns this no-field completion path.
    var inspectorVisible = true

    var body: some View {
        if state.route == "editor", state.editorPreparation.pending {
            VStack(spacing: 12) {
                if let error = state.editorPreparation.error {
                    Text(error)
                    Button("重试准备") { state.editorPreparation.retry() }
                } else {
                    ProgressView()
                    Text("正在准备项目…")
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Color(nsColor: .windowBackgroundColor))
            .background { startReceipt }
            .onAppear { completeWithoutFields() }
            .onChange(of: state.editor) { _, _ in completeWithoutFields() }
            .onChange(of: inspectorVisible) { _, _ in completeWithoutFields() }
            .task(id: state.editorPreparation.generation) { await waitForPreparation() }
        }
    }

    /// Attach and lay out the loading shield before constructing fields; the matching snapshot may arrive after navigation.
    @ViewBuilder private var startReceipt: some View {
        if state.editorPreparation.hasSnapshot, state.editorPreparation.error == nil {
            let generation = state.editorPreparation.generation
            NativeLayoutReceipt { state.editorPreparation.start(generation) }.id(generation)
        }
    }

    /// SwiftUI owns cancellation when navigation, retry or successful layout replaces this shield.
    private func waitForPreparation() async {
        completeWithoutFields()
        guard state.editorPreparation.pending else { return }
        let generation = state.editorPreparation.generation
        do { try await Task.sleep(for: .seconds(15)) }
        catch { return } // Removing this view cancels its only wait; no business operation is retried.
        guard !Task.isCancelled else { return }
        state.editorPreparation.fail(generation)
    }

    /// No mounted inspector is required when the user's current pane needs no node fields.
    private func completeWithoutFields() {
        if !inspectorVisible || state.editor["aiOpen"]?.bool == true {
            state.editorPreparation.complete(state.editorPreparation.generation)
        }
    }

}
