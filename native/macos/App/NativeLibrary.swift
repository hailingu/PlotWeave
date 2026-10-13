import Foundation

/// Pure Swift library service serializes business operations and retains the existing cross-process flock boundary.
actor NativeLibrary {
    /// Only the host selects this trusted app-data root.
    let root: URL
    private var revision: UInt64 = 0
    private var eventSink: (@Sendable (HostJSON) async -> Void)?
    private let importCheckpoint: @Sendable (ImportCheckpoint) throws -> Void
    static let maximumBytes = 20 * 1024 * 1024

    /// Deterministic storage probes distinguish a committed media file from an index rename before directory sync.
    enum ImportCheckpoint: Sendable { case mediaCommitted, indexRenamed }

    /// Construction defers filesystem I/O; disposable tests may inject storage probes, while production uses no-op checkpoints.
    init(root: URL, importCheckpoint: @escaping @Sendable (ImportCheckpoint) throws -> Void = { _ in }) {
        self.root = root
        self.importCheckpoint = importCheckpoint
    }

    /// Event delivery happens after the library lock is released; consumers order snapshots by revision.
    func connectDiagnostics(_ sink: @escaping @Sendable (HostJSON) async -> Void) { eventSink = sink }

    /// Existing IPC names route through one native domain implementation also used by SwiftUI forms.
    func invoke(_ command: String, args: [String: HostJSON]) async throws -> HostJSON {
        switch command {
        case "list_library_assets": return try await execute { state, number in state.response(state.listing, revision: number) }
        case "import_library_asset":
            return try await importAsset(name: string(args, "name"), mime: string(args, "mime"), kind: string(args, "kind"), bytes: byteData(args["bytes"]))
        case "update_library_asset":
            let id = try identity(args)
            guard let patch = args["patch"] else { throw NativeLibraryIndex.invalid("缺少修改对象") }
            return try await execute { state, number in
                try state.requireWritable()
                let asset = try state.index.update(id: id, patch: patch)
                try state.write()
                return state.response(asset, revision: number)
            }
        case "delete_library_asset": return try await deleteAsset(id: identity(args))
        case "upsert_library_group":
            guard let group = args["group"] else { throw NativeLibraryIndex.invalid("缺少编组对象") }
            let validated = try NativeLibraryIndex.group(group)
            return try await execute { state, number in
                try state.requireWritable()
                let group = try state.index.upsert(validated)
                try state.write()
                return state.response(group, revision: number)
            }
        case "delete_library_group":
            let id = try identity(args)
            return try await execute { state, number in
                try state.requireWritable()
                try state.index.removeGroup(id: id)
                try state.write()
                return state.response(.object(["id": .string(id)]), revision: number)
            }
        default: throw HostFailure(code: "PW_HOST_COMMAND_UNAVAILABLE", message: "未知素材库命令")
        }
    }

    /// Native file panels import bytes directly without serializing them as Web JSON arrays.
    func importAsset(name: String, mime: String, kind: String, bytes: Data) async throws -> HostJSON {
        let normalizedMIME = mime.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !bytes.isEmpty, bytes.count <= Self.maximumBytes else { throw NativeLibraryIndex.invalid("文件须为非空且不超过 20 MiB") }
        var entry: [String: HostJSON] = ["id": .string("placeholder"), "name": .string(name), "mime": .string(normalizedMIME),
            "kind": .string(kind), "relPath": .string("assets/placeholder"), "source": .string("upload"),
            "createdAt": .string(NativeAssetContract.timestamp()), "tags": .array([])]
        _ = try NativeLibraryIndex.asset(.object(entry))
        let checkpoint = importCheckpoint
        return try await execute { state, number in
            try state.requireWritable()
            var id: String
            repeat { id = "la_" + UUID().uuidString.replacingOccurrences(of: "-", with: "_").lowercased() } while state.index.assets[id] != nil
            let fileName = id + "." + NativeAssetContract.fileExtension(name: name, mime: normalizedMIME)
            entry["id"] = .string(id)
            entry["relPath"] = .string("assets/" + fileName)
            let asset = try NativeLibraryIndex.asset(.object(entry))
            state.index.assets[id] = asset
            let prepared = try state.prepareWrite()
            let directory = state.directory
            let assetID = id
            let relative = "assets/" + fileName
            try directory.directory("assets").writeNew(bytes, name: fileName, recordIdentity: { identity in
                try NativeLibraryJournal.beginImport(assetID: assetID, relative: relative, identity: identity, directory: directory)
            })
            try checkpoint(.mediaCommitted)
            try directory.write(prepared, name: "library.json", afterCommit: { try checkpoint(.indexRenamed) })
            state.journal = NativeLibraryJournal(directory: directory)
            try state.journal.recover(directory: directory, index: NativeLibraryIndex(bytes: prepared))
            return state.response(asset, revision: number)
        }
    }

    /// Media opens reread the authoritative index and publish completed recovery even if the target is unavailable.
    func openMedia(id: String) async throws -> NativeMediaFile {
        guard NativeLibraryIndex.validID(id) else { throw NativeLibraryIndex.invalid("素材身份无效") }
        return try await execute(publishSuccess: true) { state, _ in try state.media(id: id) }
    }

    /// Metadata and its owned descriptor are selected in the same library operation for project copy.
    func source(id: String) async throws -> (HostJSON, NativeMediaFile) {
        guard NativeLibraryIndex.validID(id) else { throw NativeLibraryIndex.invalid("素材身份无效") }
        return try await execute(publishSuccess: true) { state, _ in
            let file = try state.media(id: id)
            guard let asset = state.index.assets[id] else { throw NativeLibraryIndex.invalid("素材不存在") }
            return (asset, file)
        }
    }

    /// Shared files are never quarantined for deleting one logical reference; other deletes commit through a journal.
    private func deleteAsset(id: String) async throws -> HostJSON {
        try await execute(deleteHeadroom: true) { state, number in
            try state.requireWritable()
            _ = try state.media(id: id)
            guard let asset = state.index.assets[id], let path = asset["relPath"]?.string else { throw NativeLibraryIndex.invalid("素材不存在") }
            let shared = state.index.assets.contains { otherID, value in otherID != id && value["relPath"]?.string == path }
            state.index.assets.removeValue(forKey: id)
            let prepared = try state.prepareWrite()
            if shared { try state.directory.write(prepared, name: "library.json") }
            else {
                let entry = try state.journal.quarantine(assetID: id, relative: path, directory: state.directory)
                try state.directory.write(prepared, name: "library.json")
                try state.journal.committed(entry, directory: state.directory)
            }
            return state.response(.object(["id": .string(id)]), revision: number)
        }
    }

    /// One operation allocates its sequence under flock and records only completed recovery observations.
    private func execute<T: Sendable>(publishSuccess: Bool = false, deleteHeadroom: Bool = false, _ body: (inout NativeLibraryOperation, UInt64) throws -> T) async throws -> T {
        let directory = try NativeDirectory(root: root).directory("library", create: true)
        _ = try directory.directory("assets", create: true)
        var observed: HostJSON?
        let result: Result<T, Error> = Result {
            try directory.withLibraryLock {
                if deleteHeadroom { try NativeLibraryJournal(directory: directory).requireDeleteHeadroom() }
                sweepTemporaryFiles(directory)
                guard revision < UInt64.max else { throw NativeDirectory.refused("素材库诊断序号已耗尽") }
                revision += 1
                var state = try NativeLibraryOperation(directory: directory) { recovered in
                    observed = .object(recovered.diagnostics(revision: revision))
                }
                let value = try body(&state, revision)
                if publishSuccess { observed = .object(state.diagnostics(revision: revision)) }
                return value
            }
        }
        if let observed, let eventSink, publishSuccess || result.isFailure { await eventSink(observed) }
        return try result.get()
    }

    /// Crash cleanup accepts only the library's established control and media final-name domains.
    private func sweepTemporaryFiles(_ directory: NativeDirectory) {
        directory.sweepOldTemporaryFiles { name in
            if ["library.json", "asset-delete-journal.json", "asset-delete-archive.json"].contains(name) { return true }
            guard name.hasPrefix("library-corrupt-"), name.hasSuffix(".bak") else { return false }
            let digest = name.dropFirst("library-corrupt-".count).dropLast(4)
            return digest.utf8.count == 64 && digest.utf8.allSatisfy { (48...57).contains($0) || (97...102).contains($0) }
        }
        do {
            let assets = try directory.directory("assets")
            assets.sweepOldTemporaryFiles { name in
                guard let split = name.lastIndex(of: ".") else { return false }
                let stem = String(name[..<split])
                let suffix = name[name.index(after: split)...]
                return NativeLibraryIndex.validID(stem) && !suffix.isEmpty && suffix.utf8.count <= 8
                    && suffix.utf8.allSatisfy { (48...57).contains($0) || (97...122).contains($0) }
            }
        } catch { NSLog("PlotWeave library temporary cleanup refused: %@", error.localizedDescription) }
    }

    /// Identity validation precedes filesystem recovery for malformed requests.
    private func identity(_ args: [String: HostJSON]) throws -> String {
        let id = try string(args, "id")
        guard NativeLibraryIndex.validID(id) else { throw NativeLibraryIndex.invalid("素材身份无效") }
        return id
    }

    /// Required strings are never coerced from JSON numbers or null values.
    private func string(_ args: [String: HostJSON], _ key: String) throws -> String {
        guard let value = args[key]?.string else { throw NativeLibraryIndex.invalid("缺少必填字段") }
        return value
    }

    /// Existing Web imports must carry bounded integral bytes; native forms use Data directly.
    private func byteData(_ value: HostJSON?) throws -> Data {
        guard let values = value?.arrayValue, values.count <= Self.maximumBytes else { throw NativeLibraryIndex.invalid("文件数据超过上限或不是数组") }
        var bytes = Data(capacity: values.count)
        for value in values {
            guard let number = value.number, number >= 0, number <= 255, number.rounded() == number else { throw NativeLibraryIndex.invalid("文件数据包含非字节") }
            bytes.append(UInt8(number))
        }
        return bytes
    }
}

/// Failure inspection does not erase the domain error captured for subsequent propagation.
private extension Result {
    var isFailure: Bool { if case .failure = self { return true }; return false }
}
