import Darwin
import Foundation
import OSLog

/// Crash maintenance reuses the established atomic-write name protocol and never interprets temp bytes as data.
extension NativeDirectory {
    /// Callers own their project actor or library lock; only aged ordinary temps for approved final targets are removed.
    @discardableResult
    func sweepOldTemporaryFiles(target: @Sendable (String) -> Bool) -> Int {
        let names: [String]
        do { names = try entries() }
        catch { NativeLog.storage.warning("PlotWeave temporary cleanup scan failed: \(error.localizedDescription, privacy: .private)"); return 0 }
        let now = Date().timeIntervalSince1970
        var removed = 0
        for name in names where Self.ownedTemporaryName(name, target: target) {
            do {
                guard let original = try metadata(name), Self.isRegular(original) else { continue }
                let modified = Double(original.st_mtimespec.tv_sec) + Double(original.st_mtimespec.tv_nsec) / 1_000_000_000
                guard modified.isFinite, now - modified >= 86_400,
                      let current = try metadata(name), Self.isRegular(current), Self.sameIdentity(original, current) else { continue }
                guard name.withCString({ unlinkat(descriptor, $0, 0) }) == 0 else { throw Self.ioError("移除过期原子写临时项失败") }
                removed += 1
            } catch { NativeLog.storage.warning("PlotWeave temporary cleanup entry refused: \(error.localizedDescription, privacy: .private)") }
        }
        if removed > 0 {
            do { try sync() }
            catch { NativeLog.storage.error("PlotWeave temporary cleanup sync failed: \(error.localizedDescription, privacy: .private)") }
        }
        return removed
    }

    /// A target whitelist and two lowercase hexadecimal ID parts exclude ordinary foreign .tmp files.
    private static func ownedTemporaryName(_ name: String, target: (String) -> Bool) -> Bool {
        guard name.hasPrefix("."), name.hasSuffix(".tmp") else { return false }
        let body = name.dropFirst().dropLast(4)
        guard let split = body.lastIndex(of: "."), target(String(body[..<split])) else { return false }
        let id = body[body.index(after: split)...]
        guard id.hasPrefix("p-"), id.utf8.count <= 64 else { return false }
        let parts = id.dropFirst(2).split(separator: "-", omittingEmptySubsequences: false)
        return parts.count == 2 && parts.allSatisfy { part in
            !part.isEmpty && part.utf8.allSatisfy { (48...57).contains($0) || (97...102).contains($0) }
        }
    }
}
