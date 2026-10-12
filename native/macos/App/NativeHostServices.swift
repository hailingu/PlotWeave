import AppKit
import Foundation
import UniformTypeIdentifiers

/// Native non-document services; all editor mutations and write ordering stay in the Web session.
@MainActor
final class NativeHostServices {
    /// Native destination selection is test-injectable; production always presents the actual NSSavePanel.
    typealias SaveDestination = @MainActor (String) async throws -> URL?
    private let pasteboard: NSPasteboard
    private let saveDestination: SaveDestination
    /// Production root is separate from Tauri's com.plotweave.app data and opens only on the first request.
    static let shared = NativeHostServices(dataRoot: developmentRoot())
    /// Host-injected app-data root; no Web payload can select a filesystem root.
    let dataRoot: URL?
    /// Every domain shares the same host-selected root and project deletion barrier; construction does no I/O.
    let projectStore: NativeProjectStore?
    private let library: NativeLibrary?
    private let assets: NativeAssets?
    private let preferences: NativePreferences?
    private let models: NativeModels?
    /// Shared application quit controller or an isolated test lifecycle.
    let quit: HostQuitController

    /// Injectable construction gives real tests isolated storage without opening any directory.
    init(dataRoot: URL?, quit: HostQuitController? = nil, pasteboard: NSPasteboard? = nil, saveDestination: SaveDestination? = nil) {
        self.dataRoot = dataRoot
        self.quit = quit ?? .shared
        self.pasteboard = pasteboard ?? .general
        self.saveDestination = saveDestination ?? Self.chooseSaveDestination
        if let dataRoot {
            let projects = NativeProjectStore(root: dataRoot)
            let library = NativeLibrary(root: dataRoot)
            projectStore = projects
            self.library = library
            assets = NativeAssets(library: library, projects: projects)
            let preferences = NativePreferences(root: dataRoot)
            self.preferences = preferences
            models = NativeModels(preferences: preferences, projects: projects)
        } else {
            projectStore = nil
            library = nil
            assets = nil
            preferences = nil
            models = nil
        }
    }

    /// Connects event delivery to the current page and resets the listener-ready startup barrier.
    func connect(_ coordinator: WebCanvasCoordinator) {
        quit.resetListener()
        quit.sendEvent = { [weak coordinator] name, payload in
            guard let coordinator else { throw HostFailure(code: "PW_PAGE_UNAVAILABLE", message: "画布页面不可用") }
            try await coordinator.dispatchEvent(name, payload: payload)
        }
        if let library {
            Task { [weak coordinator] in
                await library.connectDiagnostics { [weak coordinator] payload in
                    do { try await coordinator?.dispatchEvent("library-diagnostics", payload: payload) }
                    catch { NSLog("PlotWeave library event delivery failed: %@", error.localizedDescription) }
                }
            }
        }
    }

    /// Dispatches the declared Swift project, library, media, settings, model and system capabilities.
    func perform(_ request: HostRequest) async throws -> HostJSON {
        switch request.command {
        case "acknowledge_quit_listener": quit.acknowledgeListener(); return .null
        case "app_exit": return try finishQuit(request.args)
        case "system.copyText": return try copyText(request.args)
        case "system.saveText": return try await saveText(request.args)
        default:
            let arguments = request.args ?? [:]
            if Self.storeCommands.contains(request.command) {
                guard let projectStore else { throw unavailableRoot() }
                return try await projectStore.invoke(command: request.command, args: arguments)
            }
            if Self.libraryCommands.contains(request.command) {
                return try await libraryService().invoke(request.command, args: arguments)
            }
            if Self.assetCommands.contains(request.command) {
                return try await assetsService().invoke(request.command, args: arguments)
            }
            if Self.preferenceCommands.contains(request.command) {
                guard let preferences else { throw unavailableRoot() }
                return try await preferences.invoke(command: request.command, args: arguments)
            }
            if Self.modelCommands.contains(request.command) {
                guard let models else { throw unavailableRoot() }
                return try await models.invoke(command: request.command, args: arguments)
            }
            throw HostFailure(code: "PW_HOST_COMMAND_UNAVAILABLE", message: "宿主命令尚未接通：\(request.command)")
        }
    }

    /// Swift's additive failure signal settles AppKit; default app_exit keeps its existing successful-flush meaning.
    private func finishQuit(_ args: [String: HostJSON]?) throws -> HostJSON {
        switch args?["cancel"] {
        case nil, .bool(false): try quit.approve()
        case .bool(true): quit.cancel()
        default: throw HostFailure(code: "PW_INVALID_REQUEST", message: "退出 cancel 必须为布尔值")
        }
        return .null
    }

    /// Native SwiftUI and Web adapters use one library actor, retaining shared locks and diagnostics.
    func libraryService() async throws -> NativeLibrary {
        guard let library else { throw unavailableRoot() }
        return library
    }

    /// Cross-domain asset operations always reuse the project's serialized mutation owner.
    func assetsService() async throws -> NativeAssets {
        guard let assets else { throw unavailableRoot() }
        return assets
    }

    /// WebKit's synchronous configuration installs a handler without triggering storage or network I/O.
    func makeMediaScheme() -> NativeMediaScheme? { assets.map { NativeMediaScheme(assets: $0) } }

    /// Tests drain and close their project owner before removing isolated fixture data.
    func close() async {
        await models?.close()
        await projectStore?.close()
    }

    /// A missing root is explicit; tests never fall back to a user's live application-support directory.
    private func unavailableRoot() -> HostFailure {
        HostFailure(code: "PW_CORE_UNAVAILABLE", message: "原生独立数据目录不可用")
    }

    /// Copies exact export text through the native pasteboard and makes write failures observable.
    private func copyText(_ args: [String: HostJSON]?) throws -> HostJSON {
        guard let text = args?["text"]?.string else { throw invalidSystemArguments() }
        pasteboard.clearContents()
        guard pasteboard.setString(text, forType: .string) else {
            throw HostFailure(code: "PW_COPY_FAILED", message: "复制失败，请重试或手动复制")
        }
        return .null
    }

    /// User cancellation is a result; write errors stay errors and file I/O does not block the UI actor.
    private func saveText(_ args: [String: HostJSON]?) async throws -> HostJSON {
        guard let text = args?["text"]?.string, let name = args?["fileName"]?.string,
              !name.isEmpty, URL(fileURLWithPath: name).lastPathComponent == name else {
            throw invalidSystemArguments()
        }
        guard let url = try await saveDestination(name) else { return .object(["cancelled": .bool(true)]) }
        do { try await Task.detached { try Data(text.utf8).write(to: url, options: .atomic) }.value }
        catch { throw HostFailure(code: "PW_SAVE_FAILED", message: "导出文件写入失败：\(error.localizedDescription)") }
        return .object(["cancelled": .bool(false)])
    }

    /// Production selection waits for the user's sheet decision without inventing an automatic timeout or retry.
    private static func chooseSaveDestination(_ name: String) async throws -> URL? {
        let panel = NSSavePanel()
        panel.nameFieldStringValue = name
        panel.allowedContentTypes = name.hasSuffix(".json") ? [.json] : [.plainText]
        let response = await withCheckedContinuation { continuation in
            panel.begin { continuation.resume(returning: $0) }
        }
        return response == .OK ? panel.url : nil
    }

    /// Stable validation error for the two declared system text capabilities.
    private func invalidSystemArguments() -> HostFailure {
        HostFailure(code: "PW_INVALID_REQUEST", message: "系统文本请求参数无效")
    }

    /// Development identity is derived from the app bundle, never from Tauri or a machine-specific absolute path.
    private static func developmentRoot() -> URL? {
        guard !Bundle.allBundles.contains(where: { $0.bundleURL.pathExtension == "xctest" }),
              let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first,
              let identity = Bundle.main.bundleIdentifier else { return nil }
        return support.appendingPathComponent(identity + ".development", isDirectory: true)
    }

    /// Project IPC remains unchanged even though its implementation is now Swift-owned.
    private static let storeCommands: Set<String> = [
        "list_projects", "create_project", "load_project", "save_project", "delete_project",
        "load_ai_session", "save_ai_session", "verify_project_assets", "copy_project_assets"
    ]
    /// Library commands share their service with native SwiftUI instead of creating a second store.
    private static let libraryCommands: Set<String> = [
        "list_library_assets", "import_library_asset", "update_library_asset", "delete_library_asset",
        "upsert_library_group", "delete_library_group"
    ]
    /// Asset URLs are opaque identities resolved by the native media owner.
    private static let assetCommands: Set<String> = [
        "import_project_asset_from_library", "validate_project_asset", "register_project_asset_alias", "get_asset_media_url"
    ]
    /// Provider secrets are encrypted by native preferences and never emitted in native projections.
    private static let preferenceCommands: Set<String> = ["load_prefs", "save_prefs", "set_provider_key"]
    /// Each generation/cancel command uses the same asynchronous native model owner.
    private static let modelCommands: Set<String> = ["llm_chat", "llm_image_generate", "llm_image_cancel"]
}
