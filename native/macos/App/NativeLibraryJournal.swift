import Darwin
import Foundation

/// Identity-bound import and delete recovery preserves media whenever the index or filesystem evidence is ambiguous.
struct NativeLibraryJournal {
    /// Journal and aggregate cleanup metrics are always persisted as one atomic object.
    var entries: [Entry] = []
    var retainedCleanupCount: UInt64 = 0
    var trashBytes: UInt64?
    var warnings: [String] = []
    var readOnly = false
    var conflicted = Set<String>()
    var evidence: [HostJSON] = []
    private var needsWrite = false

    /// Compatible journal entry; paths never reach I/O until this whole shape passes validation.
    struct Entry: Codable, Sendable {
        let id: String
        let assetId: String
        let relPath: String
        let identity: NativeFileIdentity
        let trashName: String
        var indexUncertain: Bool?
        /// Import intent uses the same identity-bound recovery ledger before the media's final placement.
        var importPending: Bool? = nil

        /// Validates both paths independently; the quarantine name must be one fixed-directory leaf.
        var valid: Bool {
            let prefix = "assets/.trash/"
            guard !id.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                  !assetId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                  NativeAssetContract.activeRelPath(relPath), trashName.hasPrefix(prefix) else { return false }
            let leaf = String(trashName.dropFirst(prefix.count))
            return !leaf.isEmpty && leaf != "." && leaf != ".." && !leaf.contains("/") && !leaf.contains("\0")
        }
    }

    /// Disk representation retains exact UInt64 identities; advisory totals cannot make valid transactions read-only.
    private struct Snapshot: Codable {
        var entries: [Entry]
        var retainedCleanupCount: UInt64
        var trashBytes: UInt64?
        var repairedTotals = false

        /// Encoding omits repair bookkeeping and keeps dev's committed journal field names.
        enum CodingKeys: String, CodingKey { case entries, retainedCleanupCount, trashBytes }

        /// Default initializer is used for durable writes after recovery has checked all entries.
        init(entries: [Entry], retainedCleanupCount: UInt64, trashBytes: UInt64?) {
            self.entries = entries
            self.retainedCleanupCount = retainedCleanupCount
            self.trashBytes = trashBytes
        }

        /// Bad aggregate metrics are advisory; bad entries remain a strict decoding failure.
        init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            entries = try container.decode([Entry].self, forKey: .entries)
            let count = (try? container.decode(UInt64.self, forKey: .retainedCleanupCount)).flatMap { $0 <= UInt32.max ? $0 : nil }
            retainedCleanupCount = count ?? 0
            trashBytes = count == nil ? nil : try? container.decode(UInt64.self, forKey: .trashBytes)
            repairedTotals = count == nil || (container.contains(.trashBytes) && trashBytes == nil)
        }
    }

    /// Current pending diagnostics stay bounded as committed retained entries fold into one routine summary.
    var cleanupPending: [HostJSON] {
        guard retainedCleanupCount > 0 else { return evidence }
        var summary: [String: HostJSON] = [
            "kind": .string("routine"), "message": .string("隔离区保留 \(retainedCleanupCount) 项媒体（\(trashBytes.map { String($0) + " 字节" } ?? "大小未知")），等待人工核对后清理"),
            "count": .number(Double(retainedCleanupCount))
        ]
        if let trashBytes { summary["bytes"] = .number(Double(trashBytes)) }
        return evidence + [.object(summary)]
    }

    /// Missing journal is healthy; malformed, oversized or untrusted journals suspend writes without guessing paths.
    init(directory: NativeDirectory) {
        do {
            guard try directory.metadata("asset-delete-journal.json") != nil else {
                try readLegacyTotals(directory)
                return
            }
            let data = try directory.read("asset-delete-journal.json", maxBytes: 1_048_576)
            if let legacy = try? JSONDecoder().decode([Entry].self, from: data) {
                entries = legacy
                try readLegacyTotals(directory)
                needsWrite = true
            } else {
                let value = try JSONDecoder().decode(Snapshot.self, from: data)
                entries = value.entries
                retainedCleanupCount = value.retainedCleanupCount
                trashBytes = value.trashBytes
                needsWrite = value.repairedTotals
                if value.repairedTotals { warnings.append("清理统计字段异常，已按保守值继续累计") }
            }
            guard entries.allSatisfy(\.valid), Set(entries.map(\.id)).count == entries.count else { throw NativeLibraryIndex.invalid("删除日志条目形状或身份重复") }
        } catch {
            entries = []
            readOnly = true
            warnings.append("删除日志异常，素材库写入已暂停；请先备份并修复日志。")
        }
    }

    /// Recovery runs before each read/write/open and records conflicts without treating a partial index as deletion proof.
    mutating func recover(directory: NativeDirectory, index: NativeLibraryIndex, complete: Bool = true) throws {
        guard !readOnly else { return }
        let original = entries
        var remaining: [Entry] = []
        for var entry in original {
            if entry.importPending != true, index.damaged || !complete, index.assets[entry.assetId] == nil {
                entry.indexUncertain = true
                remaining.append(entry)
                conflict(entry, "索引仍损坏，删除状态无法确认")
                continue
            }
            entry.indexUncertain = nil
            do {
                let keep = entry.importPending == true
                    ? try recoverImport(entry, directory: directory, index: index, complete: complete)
                    : try recoverEntry(entry, directory: directory, index: index)
                if keep { remaining.append(entry) }
            } catch {
                remaining.append(entry)
                conflict(entry, "媒体恢复失败，请核对隔离区与原文件")
            }
        }
        entries = remaining
        let entriesChanged = try encodedEntries(original) != encodedEntries(remaining)
        if needsWrite || entriesChanged {
            try write(directory)
            needsWrite = false
        }
        if retainedCleanupCount > 0, try directory.directory("assets").metadata(".trash") == nil {
            retainedCleanupCount = 0
            trashBytes = nil
            try write(directory)
        }
    }

    /// An unresolved import blocks further writes, so failed recovery cannot accumulate more unindexed media.
    var hasPendingImport: Bool { entries.contains { $0.importPending == true } }

    /// Persists an import's actual temporary-file identity before any finalized media becomes visible.
    static func beginImport(assetID: String, relative: String, identity: NativeFileIdentity, directory: NativeDirectory) throws {
        var journal = NativeLibraryJournal(directory: directory)
        guard !journal.hasPendingImport else { throw NativeDirectory.refused("未完成导入须先恢复，素材库写入已暂停") }
        let trash = try directory.directory("assets").directory(".trash", create: true)
        var metadata = stat()
        guard fstat(trash.descriptor, &metadata) == 0, UInt64(truncatingIfNeeded: metadata.st_dev) == identity.dev else {
            throw NativeDirectory.refused("隔离区不在媒体文件系统内")
        }
        let token = UUID().uuidString.lowercased()
        let entry = Entry(id: token, assetId: assetID, relPath: relative, identity: identity, trashName: "assets/.trash/" + token, importPending: true)
        try journal.requireDeleteHeadroom(adding: entry)
        journal.entries.append(entry)
        try journal.write(directory)
    }

    /// Only a complete unchanged index and every opened active identity can prove an import unreferenced.
    private mutating func recoverImport(_ entry: Entry, directory: NativeDirectory, index: NativeLibraryIndex, complete: Bool) throws -> Bool {
        guard complete, !index.damaged, !index.changed else {
            conflict(entry, "索引不完整，导入提交状态无法确认；写入已暂停")
            return true
        }
        var referenced = false
        for asset in index.assets.values {
            guard let path = asset["relPath"]?.string, let mime = asset["mime"]?.string else { throw NativeLibraryIndex.invalid("活动媒体字段无效") }
            let file = try directory.media(path, mime: mime)
            if file.identity == entry.identity { referenced = true }
        }
        try synchronizeImportDecision(directory, relative: entry.relPath)
        if referenced { return try retainReferencedImport(entry, directory: directory) }
        guard index.assets[entry.assetId] == nil else {
            conflict(entry, "导入身份被其它媒体占用，已保留证据")
            return true
        }
        if let current = try identity(directory: directory, relative: entry.relPath), current != entry.identity {
            conflict(entry, "导入媒体身份改变，已保留证据")
            return true
        }
        return try recoverEntry(entry, directory: directory, index: index)
    }

    /// A still-active identity keeps its live reference; any verified extra quarantine name remains visible in cleanup totals.
    private mutating func retainReferencedImport(_ entry: Entry, directory: NativeDirectory) throws -> Bool {
        let assets = try directory.directory("assets")
        guard try assets.metadata(".trash") != nil else { return false }
        let trash = try assets.directory(".trash")
        let leaf = trashLeaf(entry)
        guard try trash.metadata(leaf) != nil else { return false }
        let file = try NativeMediaFile(descriptor: trash.openFile(leaf), mime: "application/octet-stream")
        guard file.identity == entry.identity else { throw NativeDirectory.refused("导入隔离媒体身份改变，已保留证据") }
        retain(file)
        return false
    }

    /// A visible index after a failed directory barrier must become durable before recovery retires its evidence.
    private func synchronizeImportDecision(_ directory: NativeDirectory, relative: String) throws {
        if try directory.metadata("library.json") != nil {
            let file = try directory.openFile("library.json")
            defer { Darwin.close(file) }
            guard fsync(file) == 0 else { throw NativeDirectory.ioError("同步导入权威索引失败") }
        }
        try directory.sync()
        let (parent, leaf) = try directory.mediaParent(relative)
        if try parent.metadata(leaf) != nil {
            let file = try parent.openFile(leaf)
            defer { Darwin.close(file) }
            guard fsync(file) == 0 else { throw NativeDirectory.ioError("同步导入媒体失败") }
        }
        try parent.sync()
        if try parent.metadata(".trash") != nil { try parent.directory(".trash").sync() }
    }

    /// A delete records identity before moving media; no ordinary unlink can remove the quarantined file.
    mutating func quarantine(assetID: String, relative: String, directory: NativeDirectory) throws -> Entry {
        let file = try directory.media(relative, mime: "application/octet-stream")
        let assets = try directory.directory("assets")
        let trash = try assets.directory(".trash", create: true)
        var trashMetadata = stat()
        guard fstat(trash.descriptor, &trashMetadata) == 0, UInt64(truncatingIfNeeded: trashMetadata.st_dev) == file.identity.dev else { throw NativeDirectory.refused("隔离区不在媒体文件系统内") }
        let token = UUID().uuidString.lowercased()
        let entry = Entry(id: token, assetId: assetID, relPath: relative, identity: file.identity, trashName: "assets/.trash/" + token)
        try requireDeleteHeadroom(adding: entry)
        entries.append(entry)
        try write(directory)
        let (source, leaf) = try directory.mediaParent(relative)
        try source.move(leaf, to: trash, name: token)
        let quarantined = try NativeMediaFile(descriptor: trash.openFile(token), mime: file.mime)
        guard quarantined.identity == file.identity else { throw NativeDirectory.refused("隔离媒体身份冲突，未修改索引") }
        return entry
    }

    /// Index commit retires the verified transaction and aggregates retention in the same durable journal write.
    mutating func committed(_ entry: Entry, directory: NativeDirectory) throws {
        let trash = try directory.directory("assets").directory(".trash")
        let file = try NativeMediaFile(descriptor: trash.openFile(trashLeaf(entry)), mime: "application/octet-stream")
        guard file.identity == entry.identity else { throw NativeDirectory.refused("隔离文件身份改变，保留删除证据") }
        retain(file)
        entries.removeAll { $0.id == entry.id }
        try write(directory)
    }

    /// Exact identities are inspected using fresh bound descriptors; missing and replaced entries remain distinct.
    private func identity(directory: NativeDirectory, relative: String) throws -> NativeFileIdentity? {
        let (parent, name) = try directory.mediaParent(relative)
        guard let metadata = try parent.metadata(name) else { return nil }
        guard NativeDirectory.isRegular(metadata) else { throw NativeDirectory.refused("媒体条目类型改变") }
        return try NativeMediaFile(descriptor: parent.openFile(name), mime: "application/octet-stream").identity
    }

    /// Recovery respects shared references and restores an uncommitted original only into a vacant name.
    private mutating func recoverEntry(_ entry: Entry, directory: NativeDirectory, index: NativeLibraryIndex) throws -> Bool {
        let (originalParent, originalName) = try directory.mediaParent(entry.relPath)
        let assets = try directory.directory("assets")
        let trash = try assets.metadata(".trash") == nil ? nil : assets.directory(".trash")
        let leaf = trashLeaf(entry)
        let quarantined = try trash.flatMap { try $0.metadata(leaf) == nil ? nil : NativeMediaFile(descriptor: $0.openFile(leaf), mime: "application/octet-stream") }
        let current = try identity(directory: directory, relative: entry.relPath)
        let samePosition = index.assets.contains { id, value in id != entry.assetId && value["relPath"]?.string == entry.relPath }
        let shared = samePosition && current == entry.identity
        if shared {
            if let quarantined {
                guard quarantined.identity == entry.identity else { conflict(entry, "共享媒体的隔离项身份异常"); return true }
                retain(quarantined)
            }
            return false
        }
        if index.assets[entry.assetId] != nil {
            if let quarantined, let trash {
                guard quarantined.identity == entry.identity, current == nil else { conflict(entry, "原位置占用或隔离媒体身份不一致"); return true }
                try trash.move(leaf, to: originalParent, name: originalName)
                return false
            }
            if current == entry.identity { return false }
            conflict(entry, "索引仍引用但原媒体缺失或被替换")
            return true
        }
        if let quarantined {
            guard quarantined.identity == entry.identity else { conflict(entry, "已删除媒体的隔离项身份异常"); return true }
            retain(quarantined)
            return false
        }
        if current == entry.identity {
            let target = try assets.directory(".trash", create: true)
            try originalParent.move(originalName, to: target, name: leaf)
            let moved = try NativeMediaFile(descriptor: target.openFile(leaf), mime: "application/octet-stream")
            guard moved.identity == entry.identity else { conflict(entry, "重新隔离时媒体身份改变"); return true }
            retain(moved)
        }
        return false
    }

    /// Folded cleanup metrics saturate rather than overflowing or losing the retained evidence count.
    private mutating func retain(_ file: NativeMediaFile) {
        retainedCleanupCount = min(UInt64(UInt32.max), retainedCleanupCount + 1)
        if let bytes = trashBytes {
            let (sum, overflow) = bytes.addingReportingOverflow(UInt64(max(0, file.size)))
            trashBytes = overflow ? nil : sum
        } else if retainedCleanupCount == 1 { trashBytes = UInt64(max(0, file.size)) }
        needsWrite = true
    }

    /// Conflicted assets cannot be used as a read/import source, and cleanup guidance remains evidence-only.
    private mutating func conflict(_ entry: Entry, _ message: String) {
        conflicted.insert(entry.assetId)
        warnings.append(message)
        evidence.append(.object(["kind": .string("evidence"), "message": .string(message)]))
    }

    /// The leaf is never exposed outside the native filesystem layer.
    private func trashLeaf(_ entry: Entry) -> String { String(entry.trashName.dropFirst("assets/.trash/".count)) }

    /// Delete checks the complete compact snapshot before recovery and before appending any new transaction.
    func requireDeleteHeadroom(adding entry: Entry? = nil) throws {
        guard !readOnly else { throw NativeDirectory.refused("删除日志异常，素材库删除已暂停") }
        var projected = entries
        if let entry { projected.append(entry) }
        guard try encodedSnapshot(projected).count <= 524_288 else {
            throw NativeDirectory.refused("删除日志接近上限，请人工核对隔离区和删除日志后重试")
        }
    }

    /// One serialization path enforces the same one-MiB budget used by journal reads.
    mutating func write(_ directory: NativeDirectory) throws {
        let data = try encodedSnapshot(entries)
        guard data.count <= 1_048_576 else { throw NativeLibraryIndex.invalid("删除日志超过大小上限") }
        try directory.write(data, name: "asset-delete-journal.json")
    }

    /// Serialization and delete projection use the same compact object so advisory totals consume headroom too.
    private func encodedSnapshot(_ entries: [Entry]) throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = .withoutEscapingSlashes
        return try encoder.encode(Snapshot(entries: entries, retainedCleanupCount: retainedCleanupCount, trashBytes: trashBytes))
    }

    /// Compares semantic journal state rather than optional field ordering in disk JSON.
    private func encodedEntries(_ entries: [Entry]) throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = .sortedKeys
        return try encoder.encode(entries)
    }

    /// Old aggregate files are consumed only before object-journal migration and are never rewritten.
    private mutating func readLegacyTotals(_ directory: NativeDirectory) throws {
        guard try directory.metadata("asset-delete-archive.json") != nil else { return }
        do {
            let raw = try JSONDecoder().decode(HostJSON.self, from: directory.read("asset-delete-archive.json", maxBytes: 128))
            needsWrite = true
            guard let count = raw["retainedCleanupCount"]?.number, count >= 0, count.rounded() == count, count <= Double(UInt32.max) else {
                retainedCleanupCount = 0
                trashBytes = nil
                warnings.append("旧清理归档计数无效，按 0 和未知字节量累计")
                return
            }
            retainedCleanupCount = UInt64(count)
            if let bytes = raw["trashBytes"]?.number, bytes >= 0, bytes.rounded() == bytes, bytes < Double(UInt64.max) { trashBytes = UInt64(bytes) }
        } catch { warnings.append("旧清理归档无法读取，已保留原文件") }
    }
}
