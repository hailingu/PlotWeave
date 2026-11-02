import AppKit
import Testing

/// Public view-cache rendering captures only a test-owned view, with no desktop or external-window automation.
@MainActor
enum NativePresentationEvidenceFixture {
    /// The cache records drawn pixels at native or explicitly requested raster scale, without changing the display.
    static func bitmap(of view: NSView, scale: CGFloat? = nil) throws -> NSBitmapImageRep {
        view.layoutSubtreeIfNeeded()
        let bitmap: NSBitmapImageRep
        if let scale {
            try #require(scale > 0)
            bitmap = try #require(NSBitmapImageRep(bitmapDataPlanes: nil,
                pixelsWide: Int(ceil(view.bounds.width * scale)), pixelsHigh: Int(ceil(view.bounds.height * scale)),
                bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0))
            bitmap.size = view.bounds.size
        } else {
            bitmap = try #require(view.bitmapImageRepForCachingDisplay(in: view.bounds))
        }
        view.cacheDisplay(in: view.bounds, to: bitmap)
        return bitmap
    }

    /// Disposable output and the test attachment contain the same bytes, independent of xcresult cleanup on success.
    static func record(_ view: NSView, name: String) throws {
        let png = try #require(try bitmap(of: view).representation(using: .png, properties: [:]))
        try record(png, named: name + ".png")
    }

    /// AX trees and PNGs retain the same per-process ownership and survive successful xcresult disposal.
    static func record(_ data: Data, named name: String) throws {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("build/ui-evidence/" + String(ProcessInfo.processInfo.processIdentifier))
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let file = root.appendingPathComponent(name)
        try data.write(to: file)
        Attachment.record(data, named: name)
        print("[native-ui-evidence] " + file.path)
    }
}
