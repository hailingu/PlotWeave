import Darwin
import Foundation

/// Owned directory capability: every descendant operation is descriptor-relative and refuses symlinks.
final class NativeDirectory: Sendable {
    /// Immutable descriptor is retained with the capability; callers never close borrowed descriptors.
    let descriptor: Int32

    /// Creates a host-selected root, then anchors its real directory before any untrusted child lookup.
    init(root: URL) throws {
        descriptor = try Self.openRoot(root.standardizedFileURL.resolvingSymlinksInPath())
    }

    /// Takes ownership of an already-bound child descriptor.
    private init(descriptor: Int32) { self.descriptor = descriptor }

    /// ARC keeps the descriptor alive through all outstanding directory operations.
    deinit { Darwin.close(descriptor) }

    /// No-follow classification preserves missing as a separate state from access or I/O failure.
    func metadata(_ name: String) throws -> stat? {
        try Self.validateComponent(name)
        var metadata = stat()
        let result = name.withCString { fstatat(descriptor, $0, &metadata, AT_SYMLINK_NOFOLLOW) }
        if result == 0 { return metadata }
        if errno == ENOENT { return nil }
        throw Self.ioError("读取条目元数据失败")
    }

    /// Opens or durably creates a bound real child directory, never a link or another file kind.
    func directory(_ name: String, create: Bool = false) throws -> NativeDirectory {
        try Self.validateComponent(name)
        if create, try metadata(name) == nil {
            let made = name.withCString { mkdirat(descriptor, $0, mode_t(S_IRWXU)) }
            guard made == 0 || errno == EEXIST else { throw Self.ioError("创建子目录失败") }
            if made == 0 {
                do { try sync() }
                catch {
                    _ = name.withCString { unlinkat(descriptor, $0, AT_REMOVEDIR) }
                    throw error
                }
            }
        }
        guard let classified = try metadata(name), Self.isDirectory(classified) else {
            throw Self.refused("目录缺失、不是实际目录或为符号链接")
        }
        let opened = name.withCString { openat(descriptor, $0, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC) }
        guard opened >= 0 else { throw Self.ioError("打开子目录失败") }
        do {
            try Self.verifyIdentity(opened, classified: classified)
            return NativeDirectory(descriptor: opened)
        } catch { Darwin.close(opened); throw error }
    }

    /// Enumerates the bound directory without reopening its ambient path after a replacement.
    func entries() throws -> [String] {
        let duplicate = openat(descriptor, ".", O_RDONLY | O_DIRECTORY | O_CLOEXEC)
        guard duplicate >= 0 else { throw Self.ioError("复制目录句柄失败") }
        guard let stream = fdopendir(duplicate) else {
            Darwin.close(duplicate)
            throw Self.ioError("扫描目录失败")
        }
        defer { closedir(stream) }
        var names: [String] = []
        while true {
            errno = 0
            guard let entry = readdir(stream) else {
                guard errno == 0 else { throw Self.ioError("遍历目录失败") }
                return names
            }
            let name = withUnsafePointer(to: entry.pointee.d_name) {
                $0.withMemoryRebound(to: CChar.self, capacity: Int(entry.pointee.d_namlen) + 1) { String(cString: $0) }
            }
            if name != ".", name != ".." { names.append(name) }
        }
    }

    /// Opens a regular file with no-follow and identity binding; the caller owns the returned descriptor.
    func openFile(_ name: String) throws -> Int32 {
        guard let classified = try metadata(name), Self.isRegular(classified) else {
            throw Self.refused("文件缺失、不是普通文件或为符号链接")
        }
        let opened = name.withCString { openat(descriptor, $0, O_RDONLY | O_NOFOLLOW | O_CLOEXEC) }
        guard opened >= 0 else { throw Self.ioError("打开文件失败") }
        do { try Self.verifyIdentity(opened, classified: classified); return opened }
        catch { Darwin.close(opened); throw error }
    }

    /// Reads the verified file with an optional byte budget used by media and settings callers.
    func read(_ name: String, maxBytes: Int? = nil) throws -> Data {
        let file = try openFile(name)
        defer { Darwin.close(file) }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 65_536)
        while true {
            let count = buffer.withUnsafeMutableBytes { Darwin.read(file, $0.baseAddress, $0.count) }
            if count < 0 {
                if errno == EINTR { continue }
                throw Self.ioError("读取文件失败")
            }
            if count == 0 { return data }
            if let maxBytes, data.count > maxBytes - count { throw Self.refused("文件超过读取上限") }
            data.append(contentsOf: buffer.prefix(count))
        }
    }

    /// Atomic persistence synchronizes contents before rename and its parent before success; probes bracket rename and directory sync.
    func write(_ data: Data, name: String, beforeCommit: @Sendable () throws -> Void = {}, afterCommit: @Sendable () throws -> Void = {}) throws {
        try atomicWrite(data, name: name, replace: true, beforeCommit: { _ in try beforeCommit() }, afterCommit: afterCommit)
    }

    /// Evidence backups require an unoccupied final name, never overwriting another stored original.
    func writeNew(_ data: Data, name: String, beforeCommit: @Sendable () throws -> Void = {}) throws {
        try atomicWrite(data, name: name, replace: false, beforeCommit: { _ in try beforeCommit() })
    }

    /// Import recovery records the flushed temporary file's real identity durably before its exclusive final rename.
    func writeNew(_ data: Data, name: String, recordIdentity: @Sendable (NativeFileIdentity) throws -> Void) throws {
        try atomicWrite(data, name: name, replace: false) { file in
            var metadata = stat()
            guard fstat(file, &metadata) == 0, Self.isRegular(metadata) else { throw Self.refused("导入临时媒体身份不可用") }
            try recordIdentity(NativeFileIdentity(metadata))
        }
    }

    /// Shared durable write primitive keeps regular writes and exclusive backups identical except for replacement.
    private func atomicWrite(_ data: Data, name: String, replace: Bool, beforeCommit: @Sendable (Int32) throws -> Void, afterCommit: @Sendable () throws -> Void = {}) throws {
        try Self.validateComponent(name)
        if let existing = try metadata(name), !replace || !Self.isRegular(existing) {
            throw Self.refused("写入目标已占用、不是普通文件或为符号链接")
        }
        let random = UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased()
        let stamp = String(UInt64(Date().timeIntervalSince1970 * 1000), radix: 16)
        let temporary = "." + name + ".p-" + random + "-" + stamp + ".tmp"
        let file = temporary.withCString {
            openat(descriptor, $0, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, mode_t(S_IRUSR | S_IWUSR))
        }
        guard file >= 0 else { throw Self.ioError("创建原子写临时文件失败") }
        defer {
            Darwin.close(file)
            _ = temporary.withCString { unlinkat(descriptor, $0, 0) }
        }
        try Self.writeAll(data, descriptor: file)
        guard NativeAtomicWriteFaults.syscall(.temporaryFileSync, { fsync(file) }) == 0 else { throw Self.ioError("同步文件内容失败") }
        if let existing = try metadata(name), !Self.isRegular(existing) {
            throw Self.refused("写入目标在提交前成为非普通文件")
        }
        try beforeCommit(file)
        let renamed = NativeAtomicWriteFaults.syscall(.rename) {
            temporary.withCString { from in
                name.withCString { to in
                    replace ? renameat(descriptor, from, descriptor, to)
                        : renameatx_np(descriptor, from, descriptor, to, UInt32(RENAME_EXCL))
                }
            }
        }
        guard renamed == 0 else { throw Self.ioError("提交原子写失败") }
        try afterCommit()
        try syncBarrier()
    }

    /// Removes only the classified entry; directories are traversed through bound no-follow handles.
    func removeTree(_ name: String) throws {
        guard let classified = try metadata(name) else { return }
        if Self.isDirectory(classified) {
            let child = try directory(name)
            for item in try child.entries() { try child.removeTree(item) }
            guard let current = try metadata(name), Self.sameIdentity(current, classified) else {
                throw Self.refused("待删目录在删除期间被替换")
            }
            guard name.withCString({ unlinkat(descriptor, $0, AT_REMOVEDIR) }) == 0 else {
                throw Self.ioError("移除子目录失败")
            }
        } else if name.withCString({ unlinkat(descriptor, $0, 0) }) != 0 {
            throw Self.ioError("移除文件条目失败")
        }
        try sync()
    }

    /// Copies regular files and real subdirectories only; callers own rollback of the new destination.
    func copyContents(to destination: NativeDirectory) throws {
        for name in try entries() {
            guard let kind = try metadata(name) else { throw Self.refused("源条目在复制时消失") }
            if Self.isDirectory(kind) {
                try directory(name).copyContents(to: destination.directory(name, create: true))
            } else if Self.isRegular(kind) {
                guard try destination.metadata(name) == nil else { throw Self.refused("副本目标条目已存在") }
                try destination.write(read(name), name: name)
            } else { throw Self.refused("源资产树含符号链接或非普通文件") }
        }
        try destination.sync()
    }

    /// Directory entry durability is part of the success contract, including newly created children.
    func sync() throws {
        guard fsync(descriptor) == 0 else { throw Self.ioError("同步目录条目失败") }
    }

    /// The post-rename durability barrier shares sync()'s syscall but is injectable as its own protocol stage.
    private func syncBarrier() throws {
        guard NativeAtomicWriteFaults.syscall(.directorySync, { fsync(descriptor) }) == 0 else { throw Self.ioError("同步目录条目失败") }
    }

    /// File classification stays separate from following or opening its target.
    static func isRegular(_ value: stat) -> Bool { value.st_mode & S_IFMT == S_IFREG }
    /// A link to a directory never counts as a real directory.
    static func isDirectory(_ value: stat) -> Bool { value.st_mode & S_IFMT == S_IFDIR }
    /// Bound identity prevents replacing a classified project with another project's entity.
    static func sameIdentity(_ a: stat, _ b: stat) -> Bool { a.st_dev == b.st_dev && a.st_ino == b.st_ino }

    /// Stable native I/O diagnostic retains the system reason without disclosing business payloads.
    static func ioError(_ context: String) -> HostFailure {
        HostFailure(code: "PW_STORAGE_ERROR", message: context + "：" + String(cString: strerror(errno)))
    }

    /// Trust failures are distinct from missing project records and never trigger fallback writes.
    static func refused(_ message: String) -> HostFailure { HostFailure(code: "PW_STORAGE_REFUSED", message: message) }

    /// Every path component is supplied independently; no caller can smuggle a relative traversal.
    private static func validateComponent(_ value: String) throws {
        guard !value.isEmpty, value != ".", value != "..", !value.contains("/"), !value.contains("\0") else {
            throw refused("非法路径组件")
        }
    }

    /// Creates every missing root level through its parent capability and synchronizes the new entry first.
    private static func openRoot(_ root: URL) throws -> Int32 {
        let opened = root.path.withCString { Darwin.open($0, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC) }
        if opened >= 0 { return opened }
        guard errno == ENOENT, root.path != "/" else { throw ioError("打开数据根目录失败") }
        let parent = try NativeDirectory(root: root.deletingLastPathComponent())
        let child = try parent.directory(root.lastPathComponent, create: true)
        let owned = fcntl(child.descriptor, F_DUPFD_CLOEXEC, 0)
        guard owned >= 0 else { throw ioError("保留数据根句柄失败") }
        return owned
    }

    /// Reads identity from the opened descriptor before any content is consumed.
    private static func verifyIdentity(_ descriptor: Int32, classified: stat) throws {
        var opened = stat()
        guard fstat(descriptor, &opened) == 0 else { throw ioError("读取文件句柄元数据失败") }
        guard sameIdentity(opened, classified) else { throw refused("条目在归类后被替换") }
    }

    /// Handles partial writes and EINTR without returning a truncated success.
    private static func writeAll(_ data: Data, descriptor: Int32) throws {
        try data.withUnsafeBytes { bytes in
            guard let base = bytes.baseAddress else { return }
            var written = 0
            while written < bytes.count {
                let count = Darwin.write(descriptor, base.advanced(by: written), bytes.count - written)
                if count < 0, errno == EINTR { continue }
                guard count > 0 else { throw ioError("写入文件内容失败") }
                written += count
            }
        }
    }
}
