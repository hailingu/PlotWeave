import AppKit
import SwiftUI

/// Native material library owns filters and confirmed forms while the canvas retains project-document mutations.
struct NativeLibraryView: View {
    @Bindable var state: NativeApplicationState
    @State private var model: NativeLibraryModel
    private let projectID: String?
    @State private var category = "all"
    @State private var query = ""
    @State private var editing: LibrarySelection?
    @State private var deleting: LibrarySelection?
    @State private var groupForm = false
    @State private var groupEditing: HostJSON?
    @State private var groupDeleting: LibrarySelection?
    @State private var importError: String?
    @State private var importing = false
    @State private var importTask: Task<Void, Never>?
    @Environment(\.dismiss) private var dismiss

    /// Project identity is captured at sheet creation so delayed actions cannot target a subsequently opened document.
    init(state: NativeApplicationState, library: NativeLibrary) {
        self.state = state
        projectID = state.projectId
        _model = State(initialValue: NativeLibraryModel(library: library))
    }

    /// Loading, errors and cleanup evidence remain visible without inventing an empty successful state.
    var body: some View {
        VStack(spacing: 12) {
            controls
            diagnostics
            if model.loading { ProgressView("正在读取素材库…").frame(maxWidth: .infinity, maxHeight: .infinity) }
            else { assetList }
            footer
        }
        .padding(20).frame(minWidth: 720, minHeight: 520)
        .task { model.refresh() }
        .onDisappear { model.close(); importTask?.cancel() }
        .sheet(item: $editing) { selected in
            NativeLibraryAssetForm(asset: selected.value, groups: groups, busy: model.busy, error: model.error) { patch in
                model.mutate("update_library_asset", args: ["id": .string(selected.id), "patch": patch]) { success in if success { editing = nil } }
            }
        }
        .sheet(isPresented: $groupForm) {
            NativeLibraryGroupForm(group: groupEditing, busy: model.busy, error: model.error) { group in
                model.mutate("upsert_library_group", args: ["group": group]) { success in if success { groupForm = false } }
            }
        }
        .confirmationDialog("删除素材？", isPresented: assetDeleteVisible, presenting: deleting) { selected in
            Button("删除「\(selected.name)」", role: .destructive) {
                model.mutate("delete_library_asset", args: ["id": .string(selected.id)])
                deleting = nil
            }
        } message: { _ in Text("将从素材库移除。已经复制到项目的素材仍保留。") }
        .confirmationDialog("删除编组？", isPresented: groupDeleteVisible, presenting: groupDeleting) { selected in
            Button("删除「\(selected.name)」", role: .destructive) {
                model.mutate("delete_library_group", args: ["id": .string(selected.id)])
                groupDeleting = nil
            }
        } message: { _ in Text("素材仍保留，将解除此编组的所有成员。") }
    }

    /// Six stable categories share one search over current names and tags.
    private var controls: some View {
        HStack {
            Text("素材库").font(.title2.bold())
            Picker("分类", selection: $category) {
                Text("全部").tag("all")
                ForEach(NativeLibraryLabels.kinds, id: \.0) { Text($0.1).tag($0.0) }
            }.frame(width: 180)
            TextField("搜索名称或标签", text: $query).textFieldStyle(.roundedBorder)
            Menu("导入素材") {
                ForEach(NativeLibraryLabels.kinds, id: \.0) { kind in Button(kind.1) { model.pickFiles(kind: kind.0) } }
            }.disabled(!model.writable)
            groupMenu
        }
    }

    /// Groups can be created, renamed, reclassified and removed through the same actor validation as Web clients.
    private var groupMenu: some View {
        Menu("编组") {
            Button("新建编组") { groupEditing = nil; groupForm = true }
            ForEach(groups, id: \.id) { group in
                Menu(group.name) {
                    Button("编辑") { groupEditing = group.value; groupForm = true }
                    Button("删除", role: .destructive) { groupDeleting = group }
                }
            }
        }.disabled(!model.writable)
    }

    /// Service diagnostics retain both general warnings and identity-bound cleanup guidance.
    private var diagnostics: some View {
        VStack(alignment: .leading, spacing: 4) {
            if let error = model.error ?? importError { Text(error).foregroundStyle(.red).textSelection(.enabled) }
            ForEach(Array((model.value["warnings"]?.array ?? []).enumerated()), id: \.offset) { Text($0.element.string ?? "").foregroundStyle(.orange) }
            ForEach(Array((model.value["cleanupPending"]?.array ?? []).enumerated()), id: \.offset) { Text($0.element["message"]?.string ?? "待核对的清理记录").foregroundStyle(.secondary) }
        }.font(.caption).frame(maxWidth: .infinity, alignment: .leading)
    }

    /// Rows capture logical identity only, and conflicted media cannot be attached to the canvas.
    private var assetList: some View {
        List {
            ForEach(items, id: \.id) { selected in
                HStack(spacing: 12) {
                    NativeLibraryThumbnail(asset: selected.value, library: model.library)
                    VStack(alignment: .leading, spacing: 4) {
                        Text(selected.name).font(.headline)
                        Text((selected.value["tags"]?.array ?? []).compactMap(\.string).joined(separator: " · ")).foregroundStyle(.secondary)
                        if selected.value["conflicted"]?.bool == true { Text("删除事务冲突，暂不可用").foregroundStyle(.orange) }
                    }
                    Spacer()
                    Button("添加到分镜") { attach(selected) }.disabled(!canAttach || selected.value["conflicted"]?.bool == true)
                    Button("编辑") { editing = selected }.disabled(model.busy)
                    Button(role: .destructive) { deleting = selected } label: { Image(systemName: "trash") }.disabled(model.busy)
                }.padding(.vertical, 4)
            }
        }.overlay { if items.isEmpty { ContentUnavailableView("没有匹配的素材", systemImage: "photo.on.rectangle") } }
    }

    /// Refresh is explicit after errors; close waits until confirmed operations settle.
    private var footer: some View {
        HStack {
            Button("刷新") { model.refresh() }.disabled(model.busy)
            if model.busy || importing { ProgressView().controlSize(.small) }
            Spacer()
            Text("选择分镜后可将素材复制到当前项目").font(.caption).foregroundStyle(.secondary)
            Button("完成") { dismiss() }.keyboardShortcut(.defaultAction).disabled(model.busy || importing)
        }
    }

    /// The target node and project are captured before awaiting the canvas owner's import/history operation.
    private func attach(_ asset: LibrarySelection) {
        guard canAttach, let projectID, let target = state.editor["selected"]?["id"]?.string else { return }
        importing = true
        importError = nil
        importTask = Task { @MainActor in
            defer { importing = false; importTask = nil }
            do {
                _ = try await state.request("editor.importLibraryAsset", args: ["projectId": .string(projectID), "assetId": .string(asset.id), "targetNodeId": .string(target)])
            } catch { if !Task.isCancelled { importError = error.localizedDescription } }
        }
    }

    /// Selection must still be a shot in the same captured project before any document mutation starts.
    private var canAttach: Bool { model.writable && !importing && state.projectId == projectID && state.editor["selected"]?["type"]?.string == "shot" }
    private var items: [LibrarySelection] { NativeLibraryPresentation(model.value, kind: category == "all" ? nil : category, query: query).items.compactMap(LibrarySelection.init) }
    private var groups: [LibrarySelection] { (model.value["groups"]?["byId"]?.object ?? [:]).sorted { $0.key < $1.key }.compactMap { LibrarySelection($0.value) } }
    private var assetDeleteVisible: Binding<Bool> { Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }) }
    private var groupDeleteVisible: Binding<Bool> { Binding(get: { groupDeleting != nil }, set: { if !$0 { groupDeleting = nil } }) }
}

/// Form targets retain immutable identity rather than list offsets or a mutable selected-row binding.
struct LibrarySelection: Identifiable {
    let id: String
    let name: String
    let value: HostJSON
    init?(_ value: HostJSON) {
        guard let id = value["id"]?.string, let name = value["name"]?.string else { return nil }
        self.id = id; self.name = name; self.value = value
    }
}
