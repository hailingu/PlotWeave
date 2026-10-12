import AppKit
import Darwin
import Foundation
import Observation
import UniformTypeIdentifiers

/// Native library presentation owns temporary UI tasks; the library actor owns all durable metadata and media rules.
@MainActor
@Observable
final class NativeLibraryModel {
    /// Native composition may supply selected URLs; the default remains the user's system file panel.
    typealias FileSelection = @MainActor () async throws -> [URL]
    private(set) var value: HostJSON = .null
    private(set) var loading = true
    private(set) var busy = false
    private(set) var error: String?
    let library: NativeLibrary
    @ObservationIgnored private var generation = UUID()
    @ObservationIgnored private var work: Task<Void, Never>?
    @ObservationIgnored private let selectFiles: FileSelection

    /// First-read failures cannot enable writes against an uninitialized presentation.
    var writable: Bool { !loading && !busy && value.object != nil }

    /// One shared library actor serves native views and host requests.
    init(library: NativeLibrary, selectFiles: FileSelection? = nil) {
        self.library = library
        self.selectFiles = selectFiles ?? Self.chooseFiles
    }

    /// Refresh keeps the last good list on failure and never clears it into a fake empty replacement.
    func refresh() {
        guard !busy else { return }
        run { [library] in try await library.invoke("list_library_assets", args: [:]) }
    }

    /// A confirmed mutation completes once, then reloads the authoritative list; failures keep form drafts open.
    func mutate(_ command: String, args: [String: HostJSON], completion: @escaping @MainActor (Bool) -> Void = { _ in }) {
        guard writable else { return }
        run(refreshOnFailure: true, completion: completion) { [library] in
            _ = try await library.invoke(command, args: args)
            return try await library.invoke("list_library_assets", args: [:])
        }
    }

    /// The user's native file selection is the only source of ambient file URLs, never a Web payload.
    func pickFiles(kind: String) {
        guard writable else { return }
        run(refreshOnFailure: true) { [library, selectFiles] in
            for url in try await selectFiles() {
                try Task.checkCancellation()
                let mime = UTType(filenameExtension: url.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
                let bytes = try await Self.selectedBytes(url, mime: mime)
                _ = try await library.importAsset(name: url.lastPathComponent, mime: mime, kind: kind, bytes: bytes)
            }
            return try await library.invoke("list_library_assets", args: [:])
        }
    }

    /// Sheet teardown invalidates late presentation updates and explicitly cancels its owned task.
    func close() { generation = UUID(); work?.cancel(); work = nil }

    /// Cancellation produces an empty selection while the model keeps owning the in-flight panel task.
    private static func chooseFiles() async -> [URL] {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = true
        panel.canChooseDirectories = false
        let response = await withCheckedContinuation { continuation in panel.begin { continuation.resume(returning: $0) } }
        return response == .OK ? panel.urls : []
    }

    /// A single task owner disables conflicting writes and settles only its own presentation generation.
    private func run(refreshOnFailure: Bool = false, completion: @escaping @MainActor (Bool) -> Void = { _ in }, _ operation: @escaping @MainActor () async throws -> HostJSON) {
        work?.cancel()
        let current = generation
        busy = true
        error = nil
        work = Task { @MainActor [weak self] in
            do {
                let result = try await operation()
                try Task.checkCancellation()
                guard let self, self.generation == current else { return }
                self.value = result
                self.loading = false
                self.busy = false
                self.work = nil
                completion(true)
            } catch {
                await self?.recover(error, refreshList: refreshOnFailure, generation: current, completion: completion)
            }
        }
    }

    /// A failed batch may already have committed files; reread the actor without clearing the last good snapshot on failure.
    private func recover(_ cause: Error, refreshList: Bool, generation current: UUID, completion: @escaping @MainActor (Bool) -> Void) async {
        guard generation == current, !Task.isCancelled else { return }
        var message = cause.localizedDescription
        var snapshot: HostJSON?
        if refreshList {
            do { snapshot = try await library.invoke("list_library_assets", args: [:]) }
            catch { message += "\n刷新素材列表失败：" + error.localizedDescription }
        }
        guard generation == current, !Task.isCancelled else { return }
        if let snapshot { value = snapshot }
        error = message
        loading = false
        busy = false
        work = nil
        completion(false)
    }

    /// Bounded reads run away from the main actor while security-scoped access remains owned through completion.
    private static func selectedBytes(_ url: URL, mime: String) async throws -> Data {
        let work = Task.detached {
            let accessing = url.startAccessingSecurityScopedResource()
            defer { if accessing { url.stopAccessingSecurityScopedResource() } }
            let file = url.path.withCString { open($0, O_RDONLY | O_NOFOLLOW | O_CLOEXEC) }
            guard file >= 0 else { throw NativeDirectory.ioError("打开所选素材失败") }
            let media = try NativeMediaFile(descriptor: file, mime: mime)
            return try media.read(maxBytes: NativeLibrary.maximumBytes)
        }
        return try await withTaskCancellationHandler { try await work.value } onCancel: { work.cancel() }
    }
}
