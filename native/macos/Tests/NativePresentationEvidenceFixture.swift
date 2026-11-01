import AppKit
import Testing

/// Public view-cache rendering captures only a test-owned view, with no desktop or external-window automation.
@MainActor
enum NativePresentationEvidenceFixture {
    /// The cache records actual drawn pixels after layout; callers can measure glyph ink or inspect the PNG.
    static func bitmap(of view: NSView) throws -> NSBitmapImageRep {
        view.layoutSubtreeIfNeeded()
        let bitmap = try #require(view.bitmapImageRepForCachingDisplay(in: view.bounds))
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
