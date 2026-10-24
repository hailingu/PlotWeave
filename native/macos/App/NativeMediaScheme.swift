import Foundation
import WebKit

/// WebKit media delivery owns background chunks, cancellation and its concurrency permit until the final callback.
@MainActor
final class NativeMediaScheme: NSObject, WKURLSchemeHandler {
    /// Delivery granularity (issue #718): WKURLSchemeTask callbacks are main-thread only,
    /// so the delivery loop's actor hops — not the background preads — pace a large load.
    /// One chunk per hop at 4 MiB keeps a 256 MiB project video at 64 main-thread
    /// deliveries (64 KiB granularity needed 4096), while transient read buffers stay
    /// bounded by the read gate (≤ 4 concurrent × 4 MiB).
    static let deliveryChunkBytes = 4 * 1024 * 1024

    /// The adapter accepts domain-owned descriptors instead of arbitrary host file paths.
    typealias Loader = @Sendable (URL) async throws -> (NativeMediaFile, Int)
    private let loader: Loader
    private let gate: NativeMediaReadGate
    private var deliveries: [ObjectIdentifier: (UUID, Task<Void, Never>)] = [:]

    /// Production resolves through the single native asset owner.
    init(assets: NativeAssets) {
        loader = { try await assets.open(url: $0) }
        gate = .shared
    }

    /// Tests inject the same descriptor boundary and an isolated concurrency budget.
    init(loader: @escaping Loader, gate: NativeMediaReadGate = .shared) { self.loader = loader; self.gate = gate }

    /// Request tasks remain explicitly owned in the delivery table and retain this owner through cleanup.
    func webView(_ webView: WKWebView, start urlSchemeTask: any WKURLSchemeTask) {
        let id = ObjectIdentifier(urlSchemeTask)
        deliveries.removeValue(forKey: id)?.1.cancel()
        let generation = UUID()
        let work = Task { @MainActor [self] in await deliver(urlSchemeTask, id: id, generation: generation) }
        deliveries[id] = (generation, work)
    }

    /// WebKit stop revokes callbacks immediately; late background completions only release owned resources.
    func webView(_ webView: WKWebView, stop urlSchemeTask: any WKURLSchemeTask) {
        deliveries.removeValue(forKey: ObjectIdentifier(urlSchemeTask))?.1.cancel()
    }

    /// Host teardown drains the same requests rather than leaving background deliveries attached to an obsolete page.
    func cancelAll() {
        let owned = deliveries.values.map(\.1)
        deliveries.removeAll()
        for task in owned { task.cancel() }
    }

    /// A permit survives response/chunks/finish and is returned even when storage or reading throws.
    private func deliver(_ task: any WKURLSchemeTask, id: ObjectIdentifier, generation: UUID) async {
        let permit: UUID
        do { permit = try await gate.acquire() }
        catch { retire(id, generation: generation); return }
        var responseStarted = false
        do {
            try Task.checkCancellation()
            guard let url = task.request.url else { throw HostFailure(code: "PW_MEDIA_INVALID", message: "媒体请求无效") }
            let (file, maximum) = try await loader(url)
            try checkCurrent(id, generation: generation)
            guard file.size >= 0, file.size <= maximum else { throw NativeDirectory.refused("媒体超过读取上限") }
            try sendResponse(task, url: url, status: 200, mime: mediaContentType(file.mime), length: file.size)
            responseStarted = true
            var offset: Int64 = 0
            while offset < file.size {
                let chunk = try await read(file, offset: offset)
                try checkCurrent(id, generation: generation)
                task.didReceive(chunk)
                offset += Int64(chunk.count)
            }
            try checkCurrent(id, generation: generation)
            task.didFinish()
        } catch {
            if isCurrent(id, generation: generation), !Task.isCancelled {
                if responseStarted { task.didFailWithError(HostFailure(code: "PW_MEDIA_READ", message: "媒体不可用")) }
                else { unavailable(task) }
            }
        }
        await gate.release(permit)
        retire(id, generation: generation)
    }

    /// Background pread is bounded to one delivery chunk; cancellation propagates to its explicit child task.
    /// The chunk bound is read on the main actor before detaching — a detached closure cannot touch
    /// main-actor-isolated statics.
    private func read(_ file: NativeMediaFile, offset: Int64) async throws -> Data {
        let chunkBytes = Self.deliveryChunkBytes
        let work = Task.detached { try file.readChunk(offset: offset, maximum: chunkBytes) }
        return try await withTaskCancellationHandler { try await work.value } onCancel: { work.cancel() }
    }

    /// Narrow only the response declaration; stored MIME and bytes retain their existing contract.
    /// SVG remains a legitimate image, while response CSP independently denies document scripting.
    private func mediaContentType(_ mime: String) -> String {
        guard NativeAssetContract.mime(mime), ["image/", "audio/", "video/"].contains(where: { mime.hasPrefix($0) }) else {
            return "application/octet-stream"
        }
        return mime
    }

    /// A response is sent only for a current request; Content-Length refers to the selected immutable descriptor.
    private func sendResponse(_ task: any WKURLSchemeTask, url: URL, status: Int, mime: String, length: Int64) throws {
        guard let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": mime, "Content-Length": String(length), "Cache-Control": "no-store",
                           "Content-Security-Policy": "sandbox; script-src 'none'", "X-Content-Type-Options": "nosniff"]) else {
            throw HostFailure(code: "PW_MEDIA_RESPONSE", message: "媒体响应不可用")
        }
        task.didReceive(response)
    }

    /// Public failures never disclose private paths, service messages or raw request content.
    private func unavailable(_ task: any WKURLSchemeTask) {
        guard let url = task.request.url else { task.didFailWithError(HostFailure(code: "PW_MEDIA_INVALID", message: "媒体不可用")); return }
        let body = Data("媒体不可用".utf8)
        do {
            try sendResponse(task, url: url, status: 404, mime: "text/plain; charset=utf-8", length: Int64(body.count))
            task.didReceive(body)
            task.didFinish()
        } catch { task.didFailWithError(HostFailure(code: "PW_MEDIA_RESPONSE", message: "媒体不可用")) }
    }

    /// Both cancellation and generation replacement revoke subsequent callbacks before they reach WebKit.
    private func checkCurrent(_ id: ObjectIdentifier, generation: UUID) throws {
        try Task.checkCancellation()
        guard isCurrent(id, generation: generation) else { throw CancellationError() }
    }

    /// Identity includes one start generation, so a reused task object cannot receive a late previous delivery.
    private func isCurrent(_ id: ObjectIdentifier, generation: UUID) -> Bool { deliveries[id]?.0 == generation }

    /// Completion removes only the matching generation's table entry.
    private func retire(_ id: ObjectIdentifier, generation: UUID) {
        if isCurrent(id, generation: generation) { deliveries.removeValue(forKey: id) }
    }
}
