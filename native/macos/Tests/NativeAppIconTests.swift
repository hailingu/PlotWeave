import AppKit
import Foundation
import Testing

/// Checks the shipped app's icon declaration and decoded resource, catching missing packaging or broken filenames.
@MainActor
struct NativeAppIconTests {
    /// macOS resolves CFBundleIconFile from the main resources directory; a valid high-resolution icon must ship there.
    /// Contract: Apple InfoPlist Key Reference, Core Foundation Keys, CFBundleIconFile.
    @Test func bundledApplicationIconCanBeDecoded() throws {
        let filename = try #require(Bundle.main.object(forInfoDictionaryKey: "CFBundleIconFile") as? String)
        #expect(!filename.isEmpty)
        let resource = try #require(Bundle.main.url(forResource: filename, withExtension: nil))
        let image = try #require(NSImage(contentsOf: resource))
        #expect(image.isValid)
        #expect(image.representations.contains { $0.pixelsWide >= 512 && $0.pixelsHigh >= 512 })
    }
}
