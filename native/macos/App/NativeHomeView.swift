import AppKit
import SwiftUI

/// Project metadata for native navigation; this projection never owns a writable document.
struct NativeProjectProjection: Identifiable, Equatable {
    /// Persisted identity binds every action to its original project.
    let id: String
    /// Display metadata and dirty-data diagnostics come from the existing project list.
    let name: String
    let updatedAt: String?
    let error: String?

    /// Rejects malformed identities instead of inventing a target for native mutations.
    init?(_ value: HostJSON) {
        guard let id = value["id"]?.string, !id.isEmpty, let name = value["name"]?.string else { return nil }
        self.id = id
        self.name = name
        updatedAt = value["updatedAt"]?.string
        error = value["error"]?.string
    }

    /// Canonical saved timestamps include milliseconds; legacy whole-second metadata remains displayable.
    var updatedDate: Date? {
        guard error == nil, let updatedAt else { return nil }
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = formatter.date(from: updatedAt) { return date }
        formatter.formatOptions = [.withInternetDateTime]
        return formatter.date(from: updatedAt)
    }
}

/// The displayed failure owns its recovery identity; native controls cannot reconstruct failed mutation arguments.
struct NativeHomeRecovery {
    /// A changed or cleared owner invalidates earlier button clicks in the Web coordinator.
    let id: String
    /// Non-idempotent partial or unknown commits remain visible without a retry control.
    let canRetry: Bool
    /// Names the actual recovery action rather than promising an unrelated list refresh.
    let label: String

    /// Unknown recovery kinds are not actionable, even if a malformed projection advertises retry.
    init?(_ value: HostJSON?) {
        guard let id = value?["id"]?.string, !id.isEmpty,
              let canRetry = value?["canRetry"]?.bool else { return nil }
        switch value?["action"]?.string {
        case "load": label = "重新加载"
        case "open": label = "重试打开"
        case "create": label = "重试创建"
        case "rename": label = "重试重命名"
        case "duplicate": label = "重试复制"
        case "delete": label = "重试删除"
        default: return nil
        }
        self.id = id
        self.canRetry = canRetry
    }
}

/// Read-only homepage policy preserves the full ordered library and disables writes during unfinished loads.
struct NativeHomeProjection {
    /// The ordered list is supplied by the application owner, including unreadable projects.
    let projects: [NativeProjectProjection]
    /// Missing readiness is treated as loading, rather than a successful empty library.
    let loading: Bool
    /// List or action failures stay visible without replacing the original list.
    let error: String?
    /// The Web failure owner alone decides which explicit recovery remains safe.
    let recovery: NativeHomeRecovery?

    /// Reads only expected wire fields and retains server ordering.
    init(_ value: HostJSON) {
        projects = value["projects"]?.array.compactMap(NativeProjectProjection.init) ?? []
        loading = value["loading"]?.bool ?? true
        error = value["error"]?.string
        recovery = NativeHomeRecovery(value["recovery"])
    }

    /// Conflicting navigation and project mutations wait for the current application action.
    func canMutate(busy: Bool) -> Bool { !loading && !busy }

    /// A sheet's captured target must still exist in the current list before submitting.
    func contains(id: String) -> Bool { projects.contains { $0.id == id } }
}

/// A native welcome page keeps project selection local and navigation with the existing application owner.
struct NativeHomeView: View {
    /// The application state receives every mutation, retaining the authoritative save coordination.
    @Bindable var state: NativeApplicationState
    /// Presentation-only state never changes persisted project metadata by itself.
    @State private var renameTarget: NativeProjectProjection?
    @State private var deleteTarget: NativeProjectProjection?
    /// Selection is an ephemeral persisted ID, never a list offset or a writable project copy.
    @State private var selectedId: String?
    /// Only the first completed load may choose a default; later refreshes cannot retarget a removed selection.
    @State private var selectionInitialized = false

    /// Recomputes readiness from the latest projection, including actions completing while a sheet is open.
    private var home: NativeHomeProjection { NativeHomeProjection(state.app) }

    /// All project controls share the same loading and in-flight action boundary.
    private var enabled: Bool { home.canMutate(busy: state.busy) }

    var body: some View {
        VStack(spacing: 16) {
            branding
            actions
            if let error = state.error ?? home.error {
                failure(error)
            }
            library
        }
        .frame(width: 360)
        .padding(.top, 64).padding(.bottom, 60)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(nsColor: .windowBackgroundColor))
        .overlay(alignment: .topLeading) {
            NativeWelcomeCloseButton(enabled: !state.busy)
                .frame(width: NativeWelcomeMetrics.closeDiameter, height: NativeWelcomeMetrics.closeDiameter)
                .padding(20)
        }
        .onChange(of: home.projects, initial: true) { _, _ in synchronizeSelection() }
        .onChange(of: home.loading) { _, _ in synchronizeSelection() }
        .sheet(item: $renameTarget) { project in
            NativeProjectRenameForm(project: project, disabled: !enabled) { renameTarget = nil } submit: { name in
                guard enabled, home.contains(id: project.id) else { renameTarget = nil; return }
                state.send("app.rename", args: ["id": .string(project.id), "name": .string(name)])
                renameTarget = nil
            }
        }
        .confirmationDialog("删除项目？", isPresented: deletePresented, presenting: deleteTarget) { project in
            Button("删除“\(project.name)”", role: .destructive) {
                if enabled, home.contains(id: project.id) { state.send("app.delete", args: ["id": .string(project.id)]) }
                deleteTarget = nil
            }.disabled(!enabled || !home.contains(id: project.id))
            Button("取消", role: .cancel) { deleteTarget = nil }
        } message: { _ in
            Text("项目画布、AI 会话和项目资产将被删除，此操作无法撤销。")
        }
    }

    /// Binds confirmation visibility to its captured target without retaining an independent mutation flag.
    private var deletePresented: Binding<Bool> {
        Binding(get: { deleteTarget != nil }, set: { if !$0 { deleteTarget = nil } })
    }

    /// Branding reuses the system application icon and actual bundle version instead of a reference-app asset.
    private var branding: some View {
        VStack(spacing: 4) {
            Image(nsImage: NSApplication.shared.applicationIconImage)
                .resizable().scaledToFit().frame(width: 120, height: 120)
                .clipShape(RoundedRectangle(cornerRadius: 24))
                .accessibilityHidden(true)
            VStack(spacing: 4) {
                Text("PlotWeave").font(.title2.bold())
                if let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String {
                    Text("版本 \(version)").font(.body).foregroundStyle(.secondary)
                }
            }
        }
    }

    /// Rounded system controls expose only the app's existing open and create capabilities.
    private var actions: some View {
        HStack(spacing: 16) {
            Button("打开项目") { if let selectedId { open(selectedId) } }
                .disabled(!enabled || selectedId == nil || !home.contains(id: selectedId ?? ""))
                .help("打开选中的短剧；也可双击项目或按回车")
            NativeProjectCreationButton(state: state)
                .help("新建短剧（⌘N）")
        }.buttonStyle(NativeWelcomeActionStyle())
    }

    /// Loading and empty states occupy the same rounded recent-project surface as a populated library.
    private var library: some View {
        Group {
            if home.loading {
                ProgressView("正在加载项目…").frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if home.projects.isEmpty {
                emptyList
            } else {
                projectList
            }
        }
        .frame(minHeight: 180, maxHeight: 278)
        .background(.quinary, in: RoundedRectangle(cornerRadius: 16))
        .clipShape(RoundedRectangle(cornerRadius: 16))
    }

    /// The visible owner determines recovery; transport diagnostics offer only an explicit list refresh.
    private func failure(_ message: String) -> some View {
        HStack {
            Label(message, systemImage: "exclamationmark.triangle").foregroundStyle(.red)
                .lineLimit(3).help(message).textSelection(.enabled)
            Spacer()
            if state.error != nil {
                Button("刷新列表") { state.send("app.retry", args: ["recoveryId": .null]) }.disabled(state.busy)
            } else if let recovery = home.recovery, recovery.canRetry {
                Button(recovery.label) { state.send("app.retry", args: ["recoveryId": .string(recovery.id)]) }
                    .disabled(state.busy)
            }
        }
    }

    /// Only a loaded, empty library presents the creation prompt.
    private var emptyList: some View {
        ContentUnavailableView(
            "还没有短剧项目",
            systemImage: "rectangle.stack", description: Text("新建短剧，开始创作。")
        ).frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    /// Every action carries an immutable project ID; a dirty placeholder can still be opened for its diagnostic.
    private var projectList: some View {
        List(selection: $selectedId) {
            ForEach(home.projects) { project in
                HStack(spacing: 12) {
                    NativeProjectRow(project: project, selected: selectedId == project.id)
                    projectMenu(project)
                }
                .background(NativeWelcomeSelectionPresentation().frame(width: 0, height: 0))
                .padding(12)
                .foregroundStyle(selectedId == project.id ? Color(nsColor: .alternateSelectedControlTextColor) : .primary)
                .background {
                    if selectedId == project.id {
                        RoundedRectangle(cornerRadius: 8).fill(Color(nsColor: .selectedContentBackgroundColor))
                    }
                }
                .tag(project.id).listRowSeparator(.hidden)
                .listRowInsets(EdgeInsets())
            }
        }
        .listStyle(.plain).scrollContentBackground(.hidden).disabled(!enabled)
        .padding(.vertical, 8)
        .accessibilityLabel("项目片库")
        .contextMenu(forSelectionType: String.self) { ids in
            if let id = ids.first {
                Button("打开项目") { open(id) }.disabled(!enabled || !home.contains(id: id))
            }
        } primaryAction: { ids in
            if let id = ids.first { open(id) }
        }
    }

    /// Menu confirmations retain their original immutable target independently of the selected row.
    private func projectMenu(_ project: NativeProjectProjection) -> some View {
        Menu {
            Button("重命名") { renameTarget = project }
            Button("复制") { state.send("app.duplicate", args: ["id": .string(project.id)]) }
            Divider()
            Button("删除", role: .destructive) { deleteTarget = project }
        } label: { Image(systemName: "ellipsis") }
            .menuStyle(.borderlessButton).menuIndicator(.hidden)
            .accessibilityLabel("项目操作").frame(width: 28).disabled(!enabled)
    }

    /// The first completed library selects its first project; later removal clears rather than retargets selection.
    private func synchronizeSelection() {
        guard !home.loading else { return }
        if !selectionInitialized {
            selectedId = home.projects.first?.id
            selectionInitialized = true
        } else if let selectedId, !home.contains(id: selectedId) {
            self.selectedId = nil
        }
    }

    /// Button, double-click and Return share one live readiness and identity boundary before opening.
    private func open(_ id: String) {
        guard enabled, home.contains(id: id) else { return }
        state.send("app.open", args: ["id": .string(id)])
    }
}

/// Homepage and menu creation share one title, readiness boundary and save-coordinated application action.
struct NativeProjectCreationButton: View {
    /// Read projections and pending intent state remain owned by the existing application coordinator.
    let state: NativeApplicationState

    var body: some View {
        Button("新建短剧", systemImage: "plus") { state.send("app.create") }
            .disabled(!NativeHomeProjection(state.app).canMutate(busy: state.busy))
    }
}

/// Metadata presentation avoids claiming valid timestamps or counts for unreadable project placeholders.
private struct NativeProjectRow: View {
    /// Captured metadata is read-only; the selected system foreground remains legible under the blue highlight.
    let project: NativeProjectProjection
    /// Selection changes presentation without introducing a row-local navigation owner.
    let selected: Bool

    var body: some View {
        HStack(spacing: 12) {
            Image(nsImage: NSApplication.shared.applicationIconImage)
                .resizable().scaledToFit().frame(width: 24, height: 24)
                .clipShape(RoundedRectangle(cornerRadius: 5)).accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 4) {
                Text(project.name).font(.headline)
                if let error = project.error {
                    Label(error, systemImage: "exclamationmark.triangle").font(.caption)
                        .foregroundStyle(selected ? AnyShapeStyle(.primary) : AnyShapeStyle(.orange))
                } else if let date = project.updatedDate {
                    Text(date, style: .relative).font(.caption)
                        .foregroundStyle(selected ? AnyShapeStyle(.primary) : AnyShapeStyle(.secondary))
                }
            }
        }.frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle())
    }
}

/// Welcome actions match the reference's point dimensions while retaining real SwiftUI button semantics.
private struct NativeWelcomeActionStyle: ButtonStyle {
    /// Disabled presentation follows the controls' shared loading and in-flight boundary.
    @Environment(\.isEnabled) private var enabled

    /// Explicit capsule geometry avoids the varying intrinsic padding of toolbar/menu controls.
    func makeBody(configuration: Configuration) -> some View {
        configuration.label.font(.body)
            .frame(width: NativeWelcomeMetrics.actionSize.width, height: NativeWelcomeMetrics.actionSize.height)
            .background(.quaternary, in: Capsule())
            .brightness(configuration.isPressed ? -0.06 : 0)
            .opacity(enabled ? 1 : 0.5)
            .contentShape(Capsule())
    }
}

/// The welcome row draws its own persistent blue highlight while the native list retains selection and keyboard behavior.
private struct NativeWelcomeSelectionPresentation: NSViewRepresentable {
    /// Each row anchor styles only its enclosing native table, without global appearance changes.
    func makeNSView(context: Context) -> NativeWelcomeSelectionAnchor { NativeWelcomeSelectionAnchor() }

    /// SwiftUI row updates keep its system selection platter from showing outside the custom rounded highlight.
    func updateNSView(_ view: NativeWelcomeSelectionAnchor, context: Context) { view.updateHighlight() }
}

/// A zero-sized presentation anchor leaves hit testing and accessibility with the actual list row.
private final class NativeWelcomeSelectionAnchor: NSView {
    /// Styling waits for the real native table hierarchy rather than relying on private SwiftUI view types.
    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        updateHighlight()
    }

    /// Native selection state stays intact; only its additional background drawing is disabled.
    func updateHighlight() {
        var ancestor = superview
        while let view = ancestor {
            if let table = view as? NSTableView { table.selectionHighlightStyle = .none; return }
            ancestor = view.superview
        }
    }
}

/// Rename owns only a local text draft; cancellation cannot submit a project mutation.
private struct NativeProjectRenameForm: View {
    /// The ID remains captured while validation uses the current homepage before dispatch.
    let project: NativeProjectProjection
    let disabled: Bool
    let cancel: () -> Void
    let submit: (String) -> Void
    @State private var name: String

    /// Seeds the native draft once, without writing through an editable document copy.
    init(project: NativeProjectProjection, disabled: Bool, cancel: @escaping () -> Void, submit: @escaping (String) -> Void) {
        self.project = project
        self.disabled = disabled
        self.cancel = cancel
        self.submit = submit
        _name = State(initialValue: project.name)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("重命名短剧").font(.headline)
            TextField("剧名", text: $name).textFieldStyle(.roundedBorder).onSubmit(save)
            HStack {
                Spacer()
                Button("取消", action: cancel).keyboardShortcut(.cancelAction)
                Button("保存", action: save).keyboardShortcut(.defaultAction)
                    .disabled(disabled || name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }.padding(24).frame(width: 360)
    }

    /// Whitespace-only drafts never reach the authoritative rename owner.
    private func save() {
        let value = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !disabled, !value.isEmpty else { return }
        submit(value)
    }
}
