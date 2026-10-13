import Foundation

/// Native library's schema and normalization policy, shared by every read and write entry.
struct NativeLibraryIndex {
    /// Each operation rereads these maps from the current anchored control file.
    var assets: [String: HostJSON] = [:]
    var groups: [String: HostJSON] = [:]
    var warnings: [String] = []
    /// Corrupt JSON produces a useful partial view but cannot prove a deletion committed.
    var damaged = false
    /// Repair and legacy identities are committed before becoming stable presentation identities.
    var changed = false

    /// Wire shape remains compatible with the existing library store and diagnostics consumers.
    var value: HostJSON { .object(["assets": .object(["byId": .object(assets)]), "groups": .object(["byId": .object(groups)])]) }

    /// Missing file means first launch; existing corrupt bytes are kept as explicit recovery evidence.
    init(bytes: Data?, allowReissue: Bool = true) {
        guard let bytes else { return }
        let (raw, damaged) = NativeLibrarySalvage.parse(bytes)
        self.damaged = damaged
        if damaged { warnings.append("图库索引部分数据损坏；完整条目仍可使用，写入前将保存损坏原件备份。") }
        let reissue = allowReissue && !damaged
        let groupResult = Self.keyify(raw["groups"], allowReissue: reissue, warnings: &warnings)
        for (id, entry) in groupResult.entries {
            if let normalized = try? Self.group(entry, legacy: groupResult.legacy) { groups[id] = normalized }
            else { warnings.append("已隔离非法组 \(id)") }
        }
        let assetResult = Self.keyify(raw["assets"], allowReissue: reissue, warnings: &warnings)
        for (id, value) in assetResult.entries {
            var entry = value.object ?? [:]
            if let oldGroup = entry["groupId"]?.string, let mapped = groupResult.aliases[oldGroup] { entry["groupId"] = .string(mapped) }
            if let normalized = try? Self.asset(.object(entry), legacy: assetResult.legacy, strict: false) {
                assets[id] = normalized
                if normalized != value { warnings.append("条目 \(id) 的字段已规范化") }
            } else { warnings.append("已隔离非法索引条目 \(id)") }
        }
        for (id, value) in assets {
            if let groupId = value["groupId"]?.string, groups[groupId]?["kind"] != value["kind"] {
                var entry = value.object ?? [:]
                entry.removeValue(forKey: "groupId")
                assets[id] = .object(entry)
                warnings.append("资产 \(id) 的编组缺失或分类不一致，已解除编组")
            }
        }
        changed = groupResult.legacy || assetResult.legacy || !warnings.isEmpty
    }

    /// Library/group identities are filename-safe ASCII, while project asset identities remain opaque.
    static func validID(_ id: String) -> Bool {
        !id.isEmpty && id.utf8.count <= 64 && id.utf8.allSatisfy { (48...57).contains($0) || (65...90).contains($0) || (97...122).contains($0) || $0 == 45 || $0 == 95 }
    }

    /// Film-art categories and views use the existing wire enums, including legacy prop migration only on arrays.
    static let kinds = ["character", "location", "wardrobe", "colorlight", "reference", "other"]
    static let views = ["front", "side", "back", "three_quarter", "top", "expression", "turnout", "other"]

    /// Full group validation rejects malformed inputs rather than silently resetting unrelated metadata.
    static func group(_ value: HostJSON, legacy: Bool = false) throws -> HostJSON {
        guard let id = value["id"]?.string, validID(id), let rawName = value["name"]?.string,
              let rawKind = value["kind"]?.string else { throw invalid("编组字段无效") }
        let name = try checkedName(rawName)
        let kind = legacy && rawKind == "prop" ? "wardrobe" : rawKind
        guard kinds.contains(kind) else { throw invalid("未知编组分类") }
        return .object(["id": .string(id), "name": .string(name), "kind": .string(kind)])
    }

    /// Full AssetRef and organization validation owns all library write boundaries.
    static func asset(_ value: HostJSON, legacy: Bool = false, strict: Bool = true) throws -> HostJSON {
        guard let id = value["id"]?.string, validID(id), let rel = value["relPath"]?.string,
              NativeAssetContract.validPath(rel), let rawMime = value["mime"]?.string,
              let rawName = value["name"]?.string, let rawKind = value["kind"]?.string else { throw invalid("资产字段无效") }
        let mime = rawMime.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard NativeAssetContract.validMIME(mime) else { throw invalid("资产 MIME 无效") }
        let source = value["source"]?.string ?? (legacy && value["source"] == nil ? "upload" : "")
        guard source == "upload" || source == "generated" else { throw invalid("资产来源无效") }
        let timestamp = try timestamp(value["createdAt"], legacy: legacy)
        let kind = legacy && rawKind == "prop" ? "wardrobe" : rawKind
        guard kinds.contains(kind) else { throw invalid("未知资产分类") }
        var result: [String: HostJSON] = [
            "id": .string(id), "name": .string(try checkedName(rawName)), "kind": .string(kind),
            "relPath": .string(rel), "mime": .string(mime), "source": .string(source),
            "createdAt": .string(timestamp), "tags": .array(try tags(value["tags"], strict: strict).map(HostJSON.string))
        ]
        if let view = value["view"] {
            if let name = view.string, views.contains(name) { result["view"] = view }
            else if strict { throw invalid("资产视角无效") }
        }
        if let group = value["groupId"] {
            if let name = group.string, validID(name) { result["groupId"] = group }
            else if strict { throw invalid("资产编组无效") }
        }
        return .object(result)
    }

    /// Updates only declared metadata and validates the complete merged entry before an index write.
    mutating func update(id: String, patch: HostJSON) throws -> HostJSON {
        guard Self.validID(id), var current = assets[id]?.object, let fields = patch.object else { throw Self.invalid("资产或修改对象无效") }
        let allowed: Set<String> = ["name", "kind", "view", "tags", "groupId"]
        guard Set(fields.keys).isSubset(of: allowed) else { throw Self.invalid("包含不可编辑的资产字段") }
        for (key, value) in fields {
            if (key == "view" && value == .null) || (key == "groupId" && (value == .null || value.string?.trimmingCharacters(in: .whitespacesAndNewlines) == "")) {
                current.removeValue(forKey: key)
            } else { current[key] = value }
        }
        let normalized = try Self.asset(.object(current))
        if let groupId = normalized["groupId"]?.string {
            guard let group = groups[groupId], group["kind"] == normalized["kind"] else { throw Self.invalid("编组不存在或与资产分类不一致") }
        }
        assets[id] = normalized
        return normalized
    }

    /// Group kind changes cannot silently orphan the existing members' classifications.
    mutating func upsert(_ value: HostJSON) throws -> HostJSON {
        let normalized = try Self.group(value)
        guard let id = normalized["id"]?.string else { throw Self.invalid("编组身份无效") }
        guard !assets.values.contains(where: { $0["groupId"]?.string == id && $0["kind"] != normalized["kind"] }) else { throw Self.invalid("编组分类与成员资产冲突") }
        groups[id] = normalized
        return normalized
    }

    /// Removing the group and every member reference occurs in one index snapshot.
    mutating func removeGroup(id: String) throws {
        guard Self.validID(id), groups.removeValue(forKey: id) != nil else { throw Self.invalid("编组不存在") }
        for (assetID, value) in assets where value["groupId"]?.string == id {
            var entry = value.object ?? [:]
            entry.removeValue(forKey: "groupId")
            assets[assetID] = .object(entry)
        }
    }

    /// Names are counted in Unicode scalar values, matching Rust chars() and frontend code-point validation.
    private static func checkedName(_ name: String) throws -> String {
        let text = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, text.unicodeScalars.count <= 128 else { throw invalid("名称须为 1–128 个字符") }
        return text
    }

    /// Strict patches reject invalid tags wholesale; reads safely isolate invalid optional tags.
    private static func tags(_ value: HostJSON?, strict: Bool) throws -> [String] {
        guard let values = value?.arrayValue else {
            if strict { throw invalid("标签须为数组") }
            return []
        }
        var normalized: [String] = []
        for raw in values {
            let text = raw.string?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            let valid = !text.isEmpty && text.unicodeScalars.count <= 64 && !normalized.contains(text) && normalized.count < 16
            if !valid { if strict { throw invalid("标签无效、重复或超过 16 项") }; continue }
            normalized.append(text)
        }
        return normalized
    }

    /// Legacy arrays alone may use epoch milliseconds; all persisted normalized values use canonical UTC.
    private static func timestamp(_ value: HostJSON?, legacy: Bool) throws -> String {
        if let text = value?.string, let normalized = NativeAssetContract.normalizedTimestamp(text) { return normalized }
        if legacy, let number = value?.number, number >= 0, number.rounded() == number, number <= 9_007_199_254_740_991 {
            let result = NativeAssetContract.timestamp(Date(timeIntervalSince1970: number / 1000))
            if NativeAssetContract.normalizedTimestamp(result) != nil { return result }
        }
        throw invalid("资产时间戳无效")
    }

    /// Library diagnostics preserve a stable machine code without embedding arbitrary filesystem paths.
    static func invalid(_ message: String) -> HostFailure { HostFailure(code: "PW_LIBRARY_INVALID", message: message) }
}

/// Key migration preserves authoritative Record identities and tracks only unambiguous old group spellings.
private extension NativeLibraryIndex {
    /// Legacy shape is explicit so target records cannot acquire missing source or timestamp defaults.
    struct KeyedEntries {
        var entries: [String: HostJSON] = [:]
        var aliases: [String: String] = [:]
        let legacy: Bool
    }

    /// Reissues duplicates/invalid keys only when the result can be committed, retaining reserved authoritative keys.
    static func keyify(_ value: HostJSON?, allowReissue: Bool, warnings: inout [String]) -> KeyedEntries {
        let legacy = value?.arrayValue != nil
        let entries: [(String?, HostJSON)] = legacy
            ? (value?.arrayValue ?? []).map { (nil, $0) }
            : (value?["byId"]?.object ?? [:]).sorted { $0.key < $1.key }.map { ($0.key, $0.value) }
        var result = KeyedEntries(legacy: legacy)
        if !legacy, value?["byId"]?.object == nil { warnings.append("库索引桶缺失或异型，已隔离") }
        let reserved = Set(entries.compactMap { $0.0 }.filter(validID))
        var spellings: [String: [String]] = [:]
        for (key, entry) in entries {
            guard var object = entry.object else { warnings.append("已隔离非对象库成员"); continue }
            let embedded = object["id"]?.string
            let chosen: String
            if let key, validID(key), result.entries[key] == nil { chosen = key }
            else if let embedded, validID(embedded), result.entries[embedded] == nil, !reserved.contains(embedded) { chosen = embedded }
            else {
                guard allowReissue else { warnings.append("只读视图已隔离需要重发身份的库成员"); continue }
                chosen = "la_" + UUID().uuidString.replacingOccurrences(of: "-", with: "_").lowercased()
            }
            if embedded != chosen || key.map({ $0 != chosen }) == true { warnings.append("库成员身份已规范化") }
            let spelling = key.flatMap { validID($0) ? nil : $0 } ?? embedded.flatMap { $0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? $0 : nil }
            if let spelling { spellings[spelling, default: []].append(chosen) }
            object["id"] = .string(chosen)
            result.entries[chosen] = .object(object)
        }
        result.aliases = spellings.compactMapValues { $0.count == 1 ? $0.first : nil }
        return result
    }
}
