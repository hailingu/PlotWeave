import AppKit
import Foundation
import UniformTypeIdentifiers
import OSLog

/// Native non-document services; all editor mutations and write ordering stay in the Web session.
@MainActor
final class NativeHostServices {
    /// Native destination selection is test-injectable; production always presents the actual NSSavePanel.
    typealias SaveDestination = @MainActor (String) async throws -> URL?
    /// Native export byte delivery is test-injectable; production always awaits the same detached atomic write.
    typealias SaveWrite = @MainActor (Data, URL) async throws -> Void
    private let pasteboard: NSPasteboard
    private let saveDestination: SaveDestination
    private let saveWrite: SaveWrite
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
    /// App-level quit eligibility also covers direct native library writes, not only cross-bridge intents (issue #529).
    let libraryQuitWork = NativeLibraryQuitWork()
    /// Direct native system deliveries (export save/copy) join the same quit fixed point (issue #804).
    let systemQuitWork = NativeSystemQuitWork()
    /// Only the currently connected page may revoke the shared listener's pending quit decision.
    private weak var quitPage: WebCanvasCoordinator?

    /// Injectable construction gives real tests isolated storage without opening any directory.
    init(
        dataRoot: URL?,
        quit: HostQuitController? = nil,
        pasteboard: NSPasteboard? = nil,
        saveDestination: SaveDestination? = nil,
        saveWrite: SaveWrite? = nil
    ) {
        self.dataRoot = dataRoot
        self.quit = quit ?? .shared
        self.pasteboard = pasteboard ?? .general
        self.saveDestination = saveDestination ?? Self.chooseSaveDestination
        self.saveWrite = saveWrite ?? Self.writeExportAtomically
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
        quitPage = coordinator
        quit.sendEvent = { [weak coordinator, libraryQuitWork, systemQuitWork] name, payload in
            guard let coordinator else { throw HostFailure(code: "PW_PAGE_UNAVAILABLE", message: "画布页面不可用") }
            if name == "app-quit-requested" {
                try await coordinator.drainNativeIntents?()
                try await libraryQuitWork.drain()
                try await systemQuitWork.drain()
            }
            try Task.checkCancellation()
            try await coordinator.dispatchEvent(name, payload: payload)
        }
        if let library {
            // This connection owns a one-shot actor assignment, not a library I/O operation.
            // The library holds one replaceable sink with a weak page; coordinator/router
            // invalidation rejects later delivery, without retaining a departed Web view.
            Task { [weak coordinator] in
                await library.connectDiagnostics { [weak coordinator] payload in
                    do { try await coordinator?.dispatchEvent("library-diagnostics", payload: payload) }
                    catch { NativeLog.library.error("PlotWeave library event delivery failed: \(error.localizedDescription, privacy: .private)") }
                }
            }
        }
    }

    /// A failed or removed current page cannot leave AppKit waiting; late failures from replaced pages are inert.
    /// A canvas failure preserves a pending user intent for the visible degraded close/quit confirmation;
    /// ordinary teardown cancels and resets the listener as before.
    func invalidateQuitListener(for coordinator: WebCanvasCoordinator, canvasFailed: Bool = false) {
        guard quitPage === coordinator else { return }
        if canvasFailed {
            quit.canvasFailed()
        } else {
            quit.cancel()
            quit.resetListener()
        }
        quit.sendEvent = nil
        quitPage = nil
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
            if NativeProjectStore.Command(rawValue: request.command) != nil {
                guard let projectStore else { throw unavailableRoot() }
                return try await projectStore.invoke(command: request.command, args: arguments)
            }
            if NativeLibrary.Command(rawValue: request.command) != nil {
                return try await libraryService().invoke(command: request.command, args: arguments)
            }
            if NativeAssets.Command(rawValue: request.command) != nil {
                return try await assetsService().invoke(command: request.command, args: arguments)
            }
            if NativePreferences.Command(rawValue: request.command) != nil {
                guard let preferences else { throw unavailableRoot() }
                return try await preferences.invoke(command: request.command, args: arguments)
            }
            if NativeModels.Command(rawValue: request.command) != nil {
                guard let models else { throw unavailableRoot() }
                return try await models.invoke(command: request.command, args: arguments)
            }
            throw HostFailure.commandUnavailable(request.command)
        }
    }

    /// Swift's additive failure signal settles AppKit; default app_exit keeps its existing successful-flush meaning.
    private func finishQuit(_ args: [String: HostJSON]?) throws -> HostJSON {
        switch args?["cancel"] {
        case nil, .bool(false):
            guard quitPage?.hasPendingNativeIntents?() != true else {
                throw HostFailure(code: "PW_NATIVE_INTENTS_PENDING", message: "原生编辑尚未完成，已阻止退出；请等待后重试。")
            }
            guard !libraryQuitWork.hasPendingBatches else {
                throw HostFailure(code: "PW_NATIVE_LIBRARY_PENDING", message: "原生素材库写入尚未完成，已阻止退出；请等待后重试。")
            }
            guard !systemQuitWork.hasPendingDeliveries else {
                throw HostFailure(code: "PW_NATIVE_SYSTEM_PENDING", message: "原生导出交付尚未完成，已阻止退出；请等待后重试。")
            }
            try quit.approve()
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

    /// Tests drain the long-lived model/project work before removing isolated fixture data.
    /// Library/assets have no retained worker or descriptor to close: per-request files and
    /// locks belong to their operations, and diagnostic delivery retains only a weak page.
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
        do { try await saveWrite(Data(text.utf8), url) }
        catch { throw HostFailure(code: "PW_SAVE_FAILED", message: "导出文件写入失败：\(error.localizedDescription)") }
        return .object(["cancelled": .bool(false)])
    }

    /// Production keeps file I/O off the UI actor; the write gate stays injectable for deterministic quit timing (issue #804).
    private static func writeExportAtomically(_ bytes: Data, to url: URL) async throws {
        try await Task.detached { try bytes.write(to: url, options: .atomic) }.value
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

}
