import Darwin
import Foundation

/// Stable filesystem identity is persisted as UInt64, preserving precision outside the Web JSON boundary.
struct NativeFileIdentity: Codable, Sendable, Equatable {
    let dev: UInt64
    let ino: UInt64

    /// Identity comes from the already-open regular file, never an ambient path after validation.
    init(_ metadata: stat) {
        dev = UInt64(truncatingIfNeeded: metadata.st_dev)
        ino = UInt64(metadata.st_ino)
    }
}

/// Owned immutable media handle; directory renames cannot change the bytes selected for one delivery.
final class NativeMediaFile: Sendable {
    /// Callers read using pread so independent reads never share a mutable offset.
    let descriptor: Int32
    let mime: String
    let size: Int64
    let identity: NativeFileIdentity

    /// Takes ownership of a verified descriptor and rejects non-regular media before any byte read.
    init(descriptor: Int32, mime: String) throws {
        var metadata = stat()
        guard fstat(descriptor, &metadata) == 0, NativeDirectory.isRegular(metadata) else {
            Darwin.close(descriptor)
            throw NativeDirectory.refused("媒体不是普通文件")
        }
        self.descriptor = descriptor
        self.mime = mime
        size = metadata.st_size
        identity = NativeFileIdentity(metadata)
    }

    /// ARC owns the descriptor until the final delivery stops referring to it.
    deinit { Darwin.close(descriptor) }

    /// Reads with a byte cap and explicit cancellation, without exposing a filesystem path to WebKit.
    func read(maxBytes: Int) throws -> Data {
        guard size >= 0, size <= maxBytes else { throw NativeDirectory.refused("媒体超过读取上限") }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 65_536)
        while true {
            try Task.checkCancellation()
            let wanted = min(buffer.count, maxBytes - data.count + 1)
            let count = buffer.withUnsafeMutableBytes { pread(descriptor, $0.baseAddress, wanted, off_t(data.count)) }
            if count < 0, errno == EINTR { continue }
            guard count >= 0 else { throw NativeDirectory.ioError("读取媒体失败") }
            if count == 0 { return data }
            guard data.count <= maxBytes - count else { throw NativeDirectory.refused("媒体超过读取上限") }
            data.append(contentsOf: buffer.prefix(count))
        }
    }
}

/// Library-relative filesystem operations extend the same trusted capability used by project storage.
extension NativeDirectory {
    /// Traverses every assets-relative component with no-follow, retaining the final parent capability.
    func mediaParent(_ relative: String) throws -> (NativeDirectory, String) {
        guard NativeAssetContract.activeRelPath(relative) else { throw Self.refused("媒体相对路径非法") }
        let components = relative.split(separator: "/").map(String.init)
        var directory = self
        for component in components.dropLast() { directory = try directory.directory(component) }
        guard let leaf = components.last else { throw Self.refused("媒体路径缺少文件名") }
        return (directory, leaf)
    }

    /// Actual media is opened after resolving its current authoritative index entry.
    func media(_ relative: String, mime: String) throws -> NativeMediaFile {
        let (parent, name) = try mediaParent(relative)
        return try NativeMediaFile(descriptor: parent.openFile(name), mime: mime)
    }

    /// Moves only into a vacant destination through the two bound parent handles and synchronizes both.
    func move(_ name: String, to destination: NativeDirectory, name target: String) throws {
        guard try metadata(name) != nil, try destination.metadata(target) == nil else { throw Self.refused("移动源缺失或目标已占用") }
        let moved = name.withCString { source in target.withCString { renameatx_np(descriptor, source, destination.descriptor, $0, UInt32(RENAME_EXCL)) } }
        guard moved == 0 else { throw Self.ioError("隔离或恢复媒体失败") }
        try sync()
        try destination.sync()
    }

    /// All native library instances coordinate with dev's existing persistent lock-file convention.
    func withLibraryLock<T>(_ operation: () throws -> T) throws -> T {
        let name = ".library-op.lock"
        let prior = try metadata(name)
        let file = name.withCString { openat(descriptor, $0, O_RDWR | O_CREAT | O_NOFOLLOW | O_CLOEXEC, mode_t(S_IRUSR | S_IWUSR)) }
        guard file >= 0 else { throw Self.ioError("打开素材库操作锁失败") }
        defer { Darwin.close(file) }
        var current = stat()
        guard fstat(file, &current) == 0, Self.isRegular(current), prior.map({ Self.sameIdentity($0, current) }) ?? true else { throw Self.refused("素材库锁条目非法") }
        while flock(file, LOCK_EX) != 0 { if errno != EINTR { throw Self.ioError("锁定素材库失败") } }
        defer { flock(file, LOCK_UN) }
        return try operation()
    }
}

/// Streaming reads use the same owned descriptor as bounded whole-file imports.
extension NativeMediaFile {
    /// Reads at most one bounded chunk and treats early EOF as a failed delivery rather than successful truncation.
    func readChunk(offset: Int64, maximum: Int) throws -> Data {
        guard offset >= 0, offset < size, maximum > 0 else { throw NativeDirectory.refused("媒体读取范围无效") }
        let wanted = min(maximum, Int(size - offset))
        var bytes = [UInt8](repeating: 0, count: wanted)
        while true {
            try Task.checkCancellation()
            let count = bytes.withUnsafeMutableBytes { pread(descriptor, $0.baseAddress, wanted, off_t(offset)) }
            if count < 0, errno == EINTR { continue }
            guard count > 0 else { throw NativeDirectory.ioError("媒体读取失败或已截断") }
            return Data(bytes.prefix(count))
        }
    }
}
