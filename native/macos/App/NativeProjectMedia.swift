import Foundation

/// Media changes share the project actor's save/delete barrier and keep pending refs separate from the document.
extension NativeProjectStore {
    /// Imports bytes only after project/control validation and checks cancellation again at atomic commit.
    func importMedia(id: String, bytes: Data, mime: String, source: String, extension fileExtension: String, isCancelled: @Sendable () -> Bool = { false }) throws -> HostJSON {
        try checkMediaCancellation(isCancelled)
        let normalizedMIME = mime.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard NativeAssetContract.mime(normalizedMIME), source == "upload" || source == "generated",
              !fileExtension.isEmpty, fileExtension.utf8.count <= 8,
              fileExtension.utf8.allSatisfy({ (48...57).contains($0) || (65...90).contains($0) || (97...122).contains($0) }) else {
            throw NativeProjectEnvelope.invalid("媒体 MIME、来源或扩展名无效")
        }
        _ = try loadProject(id: id)
        let directory = try projectDirectory(id: id, create: true).directory("assets", create: true)
        let assetId = "a_" + UUID().uuidString.replacingOccurrences(of: "-", with: "_").lowercased()
        let name = assetId + "." + fileExtension.lowercased()
        try directory.writeNew(bytes, name: name, beforeCommit: { try Self.requireActiveMedia(isCancelled) })
        let asset = HostJSON.object([
            "id": .string(assetId), "relPath": .string("assets/" + name), "mime": .string(normalizedMIME),
            "source": .string(source), "createdAt": .string(NativeAssetContract.timestamp())
        ])
        pendingMedia[id, default: [:]][assetId] = asset
        return asset
    }

    /// Revalidates a single normalized ref against its actual ordinary file before a set_asset mutation.
    func validateAsset(id: String, asset: HostJSON) throws -> HostJSON {
        guard let assetId = asset["id"]?.string, !assetId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              let path = asset["relPath"]?.string, NativeAssetContract.activeRelPath(path),
              let rawMIME = asset["mime"]?.string, let source = asset["source"]?.string,
              source == "upload" || source == "generated",
              let time = asset["createdAt"]?.string, NativeAssetContract.canonicalUTC(time) else {
            throw NativeProjectEnvelope.invalid("资产 id、路径、来源或 UTC 时间无效")
        }
        let mime = rawMIME.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard NativeAssetContract.mime(mime) else { throw NativeProjectEnvelope.invalid("资产 MIME 无效") }
        _ = try projectDirectory(id: id).media(path, mime: mime)
        return .object(["id": .string(assetId), "relPath": .string(path), "mime": .string(mime), "source": .string(source), "createdAt": .string(time)])
    }

    /// Blank-key repair aliases map opaque identities to the current disk key without caching a path.
    func registerAlias(id: String, blankKey: String, freshId: String) throws {
        try NativeProjectEnvelope.validateID(id)
        guard blankKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              !freshId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw NativeProjectEnvelope.invalid("资产别名必须从空白键映射到非空白身份")
        }
        _ = try loadProject(id: id)
        if let old = mediaAliases[id]?[freshId], old != blankKey {
            throw HostFailure(code: "PW_ASSET_ALIAS_CONFLICT", message: "资产别名已经属于另一条目")
        }
        mediaAliases[id, default: [:]][freshId] = blankKey
    }

    /// Each media delivery owns a verified file; persisted entries win, then pending imports, then live aliases.
    func openMedia(id: String, assetId: String) throws -> NativeMediaFile {
        guard !assetId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw NativeProjectEnvelope.invalid("资产身份不能为空白")
        }
        let document: HostJSON
        do { document = try loadProject(id: id) }
        catch {
            pendingMedia.removeValue(forKey: id)
            mediaAliases.removeValue(forKey: id)
            throw error
        }
        let entries = document["assets"]?["byId"]?.object ?? [:]
        let asset: HostJSON
        if let stored = entries[assetId] {
            pendingMedia[id]?.removeValue(forKey: assetId)
            asset = stored
        } else if let pending = pendingMedia[id]?[assetId] { asset = pending }
        else if let blankKey = mediaAliases[id]?[assetId], let stored = entries[blankKey] { asset = stored }
        else { throw HostFailure(code: "PW_ASSET_NOT_FOUND", message: "资产不存在") }
        guard let path = asset["relPath"]?.string, NativeAssetContract.activeRelPath(path) else {
            throw NativeProjectEnvelope.invalid("资产路径非法")
        }
        let rawMIME = asset["mime"]?.string ?? ""
        let mime = NativeAssetContract.mime(rawMIME) ? rawMIME : "application/octet-stream"
        return try projectDirectory(id: id).media(path, mime: mime)
    }

    /// The actor entry check precedes even directory creation after an image job waited for another mutation.
    private func checkMediaCancellation(_ isCancelled: @Sendable () -> Bool) throws { try Self.requireActiveMedia(isCancelled) }

    /// Cancellation participates in the atomic writer's final commit check without accessing actor-isolated state.
    private nonisolated static func requireActiveMedia(_ isCancelled: @Sendable () -> Bool) throws {
        if isCancelled() { throw HostFailure(code: "PW_CANCELLED", message: "已取消，未写入生成素材") }
    }
}
