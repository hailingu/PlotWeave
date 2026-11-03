import Darwin
import Foundation

/// Host-owned authority for exactly one newly copied library asset; paths never come from discard callers.
struct NativeProjectImportReceipt: Sendable {
    /// Durable quarantine evidence remains readable after process exit; byte space is intentionally retained.
    struct Record: Codable, Sendable {
        let assetId: String
        let relPath: String
        let identity: NativeFileIdentity
    }
    let directory: NativeDirectory
    let name: String
    let file: NativeMediaFile
    let record: Record
    let token = "import-" + UUID().uuidString

    /// Capture an open no-follow file and its trusted parent before returning the import to WebKit.
    init(directory: NativeDirectory, name: String, asset: HostJSON) throws {
        guard let id = asset["id"]?.string, let path = asset["relPath"]?.string else {
            throw NativeProjectEnvelope.invalid("导入凭据缺少身份")
        }
        self.directory = directory
        self.name = name
        file = try NativeMediaFile(descriptor: directory.openFile(name), mime: "application/octet-stream")
        record = Record(assetId: id, relPath: path, identity: file.identity)
    }

    /// Journal precedes exclusive relocation; destination durability precedes removing the active name.
    func quarantine() throws {
        let trash = try directory.directory(".trash", create: true)
        let slot = try trash.directory(token, create: true)
        if try slot.metadata("media") != nil {
            let held = try NativeMediaFile(descriptor: slot.openFile("media"), mime: file.mime)
            guard held.identity == record.identity, try directory.metadata(name) == nil else {
                throw NativeDirectory.refused("导入隔离目标已占用或原位置改变，保留现场")
            }
            try slot.sync()
            try directory.sync()
            return
        }
        let current = try NativeMediaFile(descriptor: directory.openFile(name), mime: file.mime)
        guard current.identity == record.identity else { throw NativeDirectory.refused("导入副本身份变化，保留现场") }
        try slot.write(try JSONEncoder().encode(record), name: "receipt.json")
        guard try slot.metadata("media") == nil else { throw NativeDirectory.refused("导入隔离目标已占用，保留现场") }
        let moved = name.withCString { source in
            "media".withCString { renameatx_np(directory.descriptor, source, slot.descriptor, $0, UInt32(RENAME_EXCL)) }
        }
        guard moved == 0 else { throw NativeDirectory.ioError("隔离未绑定导入失败") }
        try slot.sync()
        try directory.sync()
        let held = try NativeMediaFile(descriptor: slot.openFile("media"), mime: file.mime)
        guard held.identity == record.identity else { throw NativeDirectory.refused("隔离后身份不符，已保留凭据") }
    }
}

extension NativeProjectStore {
    /// Reject accepted or unknown media; only this actor's fresh import receipt grants quarantine authority.
    func discardImport(id: String, assetId: String) throws {
        let document = try loadProject(id: id)
        guard let receipt = importReceipts[id]?[assetId] else {
            throw NativeDirectory.refused("导入凭据不存在或已被项目接受")
        }
        for (key, entry) in document["assets"]?["byId"]?.object ?? [:] {
            guard key != assetId, entry["relPath"]?.string != receipt.record.relPath else {
                throw NativeDirectory.refused("项目仍引用导入媒体，拒绝隔离")
            }
            if let path = entry["relPath"]?.string, NativeAssetContract.activeRelPath(path) {
                let referenced = try projectDirectory(id: id).media(path, mime: "application/octet-stream")
                guard referenced.identity != receipt.record.identity else { throw NativeDirectory.refused("项目仍引用导入媒体身份") }
            }
        }
        try receipt.quarantine()
        importReceipts[id]?.removeValue(forKey: assetId)
        pendingMedia[id]?.removeValue(forKey: assetId)
    }
}
