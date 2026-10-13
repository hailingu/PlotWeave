import CryptoKit
import Darwin
import Foundation

/// One locked library operation owns its normalized index, raw evidence and completed recovery diagnostics.
struct NativeLibraryOperation {
    let directory: NativeDirectory
    var index: NativeLibraryIndex
    var journal: NativeLibraryJournal
    let original: Data?
    var migrationSuspended = false

    /// Migration capacity is checked before recovery so a suspended partial view cannot confirm a deletion.
    init(directory: NativeDirectory, recovered: (NativeLibraryOperation) -> Void = { _ in }) throws {
        self.directory = directory
        original = try directory.metadata("library.json") == nil ? nil : directory.read("library.json", maxBytes: 1_048_576)
        journal = NativeLibraryJournal(directory: directory)
        index = NativeLibraryIndex(bytes: original, allowReissue: !journal.readOnly)
        if journal.hasPendingImport, index.changed {
            migrationSuspended = true
            index = NativeLibraryIndex(bytes: original, allowReissue: false)
            index.warnings.append("未完成导入的索引尚需修复，写入已暂停。")
        }
        if index.changed, !index.damaged, !journal.readOnly, !migrationSuspended, try encodedIndex().count > 1_048_576 {
            migrationSuspended = true
            index = NativeLibraryIndex(bytes: original, allowReissue: false)
            index.warnings.append("索引迁移结果超过大小上限，写入已暂停。")
        }
        try journal.recover(directory: directory, index: index, complete: !migrationSuspended)
        recovered(self)
        filterMedia()
        if index.changed, !index.damaged, !journal.readOnly, !migrationSuspended, !journal.hasPendingImport {
            try directory.write(encodedIndex(), name: "library.json")
        }
    }

    /// Diagnostics describe a complete observation and never pretend a failed recovery produced an empty library.
    func diagnostics(revision: UInt64) -> [String: HostJSON] {
        ["warnings": .array((index.warnings + journal.warnings).map(HostJSON.string)),
         "cleanupPending": .array(journal.cleanupPending), "diagnosticsRevision": .string(String(revision))]
    }

    /// Every ordinary command response carries the same diagnostic revision and cleanup snapshot.
    func response(_ value: HostJSON, revision: UInt64) -> HostJSON {
        var fields = value.object ?? [:]
        fields.merge(diagnostics(revision: revision)) { _, new in new }
        return .object(fields)
    }

    /// Listing marks conflicted members visibly; they remain unavailable to media and project-import callers.
    var listing: HostJSON {
        var assets = index.assets
        for id in journal.conflicted {
            if var fields = assets[id]?.object { fields["conflicted"] = .bool(true); assets[id] = .object(fields) }
        }
        return .object(["assets": .object(["byId": .object(assets)]), "groups": .object(["byId": .object(index.groups)])])
    }

    /// Read-only recovery and oversized migrations refuse every write entry before media materialization.
    func requireWritable() throws {
        guard !journal.readOnly, !migrationSuspended, !journal.hasPendingImport else { throw NativeDirectory.refused("素材库写入暂停，请先备份并修复索引或恢复日志") }
    }

    /// Validates the complete next index and preserves raw corruption before any new media reaches disk.
    func prepareWrite() throws -> Data {
        try requireWritable()
        for (id, value) in index.assets {
            guard value["id"]?.string == id else { throw NativeLibraryIndex.invalid("资产身份不一致") }
            _ = try NativeLibraryIndex.asset(value)
        }
        for value in index.groups.values { _ = try NativeLibraryIndex.group(value) }
        let bytes = try encodedIndex()
        guard bytes.count <= 1_048_576 else { throw NativeDirectory.refused("素材索引超过 1 MiB 上限") }
        if index.damaged, let original { try preserveEvidence(original) }
        return bytes
    }

    /// Index persistence uses the same prepared bytes that were checked before media writes.
    func write() throws { try directory.write(prepareWrite(), name: "library.json") }

    /// Resolves only a current validated member and opens one immutable descriptor for the caller's delivery.
    func media(id: String) throws -> NativeMediaFile {
        guard !journal.conflicted.contains(id), let asset = index.assets[id],
              let path = asset["relPath"]?.string, let mime = asset["mime"]?.string else { throw NativeLibraryIndex.invalid("媒体不可用") }
        return try directory.media(path, mime: mime)
    }

    /// Physically missing or untrusted entries are isolated independently; conflict evidence is retained.
    private mutating func filterMedia() {
        for (id, value) in index.assets where !journal.conflicted.contains(id) {
            do {
                guard let path = value["relPath"]?.string, let mime = value["mime"]?.string else { throw NativeLibraryIndex.invalid("媒体字段无效") }
                _ = try directory.media(path, mime: mime)
            } catch {
                index.assets.removeValue(forKey: id)
                index.warnings.append("素材 \(id) 的媒体缺失或不可用，已隔离")
                index.changed = true
            }
        }
    }

    /// Sorted JSON is deterministic evidence; schema semantics are validated separately from formatting.
    private func encodedIndex() throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        return try encoder.encode(index.value)
    }

    /// A content-addressed backup cannot overwrite conflicting evidence, and success includes file and directory sync.
    private func preserveEvidence(_ bytes: Data) throws {
        let digest = SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
        let name = "library-corrupt-" + digest + ".bak"
        if try directory.metadata(name) != nil {
            guard try directory.read(name, maxBytes: 1_048_576) == bytes else { throw NativeDirectory.refused("索引损坏备份已占用且内容不一致") }
            let file = try directory.openFile(name)
            defer { Darwin.close(file) }
            guard fsync(file) == 0 else { throw NativeDirectory.ioError("同步损坏原件备份失败") }
            try directory.sync()
        } else { try directory.writeNew(bytes, name: name) }
    }
}
