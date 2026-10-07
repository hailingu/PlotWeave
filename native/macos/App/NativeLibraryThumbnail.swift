import AppKit
import SwiftUI

/// Native thumbnails read through the same opaque library authority with SwiftUI-owned visibility and retry tasks.
struct NativeLibraryThumbnail: View {
    let asset: HostJSON
    let library: NativeLibrary
    @State private var image: NSImage?
    @State private var error: String?
    @State private var generation = UUID()

    /// Non-image resources retain a meaningful native icon; image failures keep an explicit retry affordance.
    var body: some View {
        Group {
            if let image { Image(nsImage: image).resizable().scaledToFit() }
            else if let error { Button { generation = UUID() } label: { Image(systemName: "arrow.clockwise").help(error) } }
            else { Image(systemName: asset["mime"]?.string?.hasPrefix("image/") == true ? "photo" : "doc.richtext").foregroundStyle(.secondary) }
        }
        .frame(width: 72, height: 64)
        .task(id: generation) { await load() }
    }

    /// Cancellation releases the global permit and prevents an offscreen row from receiving late data.
    private func load() async {
        guard image == nil, asset["mime"]?.string?.hasPrefix("image/") == true, let id = asset["id"]?.string else { return }
        let permit: UUID
        do { permit = try await NativeMediaReadGate.shared.acquire() }
        catch { return }
        do {
            let file = try await library.openMedia(id: id)
            let work = Task.detached { try file.read(maxBytes: NativeLibrary.maximumBytes) }
            let bytes = try await withTaskCancellationHandler { try await work.value } onCancel: { work.cancel() }
            try Task.checkCancellation()
            guard let loaded = NSImage(data: bytes) else { throw HostFailure(code: "PW_MEDIA_PREVIEW", message: "缩略图无法读取，请重试") }
            image = loaded
            error = nil
        } catch { if !Task.isCancelled { self.error = error.localizedDescription } }
        await NativeMediaReadGate.shared.release(permit)
    }
}
