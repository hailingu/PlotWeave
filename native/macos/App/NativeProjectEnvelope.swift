import Foundation

/// Project envelope parsing and strict save boundaries mirror the persisted v1 contract; the retired v0 flat family is rejected (#519).
enum NativeProjectEnvelope {
    /// Newly created projects include every v1 bucket and need no normalization repair on first load.
    static func empty(id: String, name: String) -> HostJSON {
        let stamp = now()
        return .object([
            "schemaVersion": .number(1), "project": .object([
                "id": .string(id), "name": .string(name), "createdAt": .string(stamp), "updatedAt": .string(stamp)
            ]), "graph": .object([
                "nodes": .array([]), "edges": .array([]),
                "viewport": .object(["x": .number(0), "y": .number(0), "zoom": .number(1)])
            ]), "settings": .object([
                "characters": .object([:]), "locations": .object([:]), "props": .object([:]), "documents": .object([:])
            ]), "episodeTitles": .object([:]), "assets": .object(["byId": .object([:])])
        ])
    }

    /// Shape classification preserves future-version claims; the retired v0 flat family is rejected outright (#519).
    static func parse(_ value: HostJSON, id: String) throws -> HostJSON {
        guard let fields = value.object else { throw invalid("无法判别文档信封（已保留原文件）") }
        let modern = ["project", "graph", "assets"].filter { fields[$0] != nil }.count
        let legacy = ["name", "updated_at", "nodes", "edges"].filter { fields[$0] != nil }.count
        if let version = fields["schemaVersion"]?.number {
            guard version >= 1, version <= Double(UInt32.max), version.rounded() == version else {
                throw invalid(version == 0
                    ? "schemaVersion 0（旧扁平格式）已不再受支持，拒绝加载并保留原文件"
                    : "schemaVersion 是非法数值或超出可表示范围（已保留原文件）")
            }
            guard legacy == 0 else { throw invalid("文档信封自相矛盾：schemaVersion ≥ 1 携带旧扁平特征键") }
            return modernEnvelope(fields, version: version, versionless: false)
        }
        if let text = fields["schemaVersion"]?.string,
           text.range(of: "^-?(0|[1-9][0-9]*)$", options: .regularExpression) != nil {
            throw invalid("schemaVersion 是规范整数字符串而非数值版本号（已保留原文件）")
        }
        if modern > 0, legacy == 0 { return modernEnvelope(fields, version: 1, versionless: true) }
        if legacy >= 2, fields["nodes"] != nil || fields["edges"] != nil {
            throw invalid("旧扁平（无有效版本号）文档已不再受支持，拒绝加载并保留原文件")
        }
        throw invalid("无法判别文档信封：v1 与旧扁平特征键混合或均不足（已保留原文件）")
    }

    /// Saving rejects absent or malformed buckets as a whole; only trusted identity/name/timestamp are rewritten.
    static func prepareSave(_ value: HostJSON, id: String) throws -> HostJSON {
        guard var fields = value.object, fields["schemaVersion"] == .number(1),
              var project = fields["project"]?.object else { throw invalid("doc 不是受支持的完整项目信封") }
        for key in ["graph", "settings", "episodeTitles", "assets"] {
            guard fields[key] != nil else { throw invalid("doc 缺少 \(key)，拒绝保存") }
        }
        guard let rawName = project["name"]?.string else { throw invalid("项目名必须是字符串") }
        let name = try sanitizeName(rawName)
        if let description = project["description"], description.string == nil { throw invalid("project.description 非字符串，拒绝保存") }
        guard let created = project["createdAt"]?.string, parseTime(created) != nil,
              let updated = project["updatedAt"]?.string, parseTime(updated) != nil else {
            throw invalid("项目时间戳不是可解析的 ISO 8601 时间戳")
        }
        try validateGraph(fields["graph"])
        try validateSettings(fields["settings"])
        try validateTitles(fields["episodeTitles"])
        try validateAssets(fields["assets"])
        project["id"] = .string(id)
        project["name"] = .string(name)
        project["updatedAt"] = .string(now())
        fields["project"] = .object(project)
        fields.removeValue(forKey: "versionless")
        return .object(fields)
    }

    /// Home metadata is derived from the graph; attachment edges do not turn leaf scenes into non-endings.
    static func metadata(_ document: HostJSON, id: String) -> HostJSON {
        let nodes = document["graph"]?["nodes"]?.array ?? []
        let edges = document["graph"]?["edges"]?.array ?? []
        let scenes = Set(nodes.filter { $0["type"]?.string == "scene" }.compactMap { $0["id"]?.string })
        let outgoing = Set(edges.filter {
            $0["data"]?["kind"]?.string != "attach" && $0["sourceHandle"]?.string != "shots" && $0["className"]?.string != "pw-edge-attach"
        }.compactMap { $0["source"]?.string })
        let rawName = document["project"]?["name"]?.string ?? ""
        let name = (try? sanitizeName(rawName)) ?? "未命名项目"
        return .object([
            "id": .string(id), "name": .string(name), "updated_at": document["project"]?["updatedAt"] ?? .string(""),
            "scene_count": .number(Double(scenes.count)), "ending_count": .number(Double(scenes.subtracting(outgoing).count))
        ])
    }

    /// IDs are filenames, unlike opaque media IDs; their lexical check always precedes any path construction.
    static func validateID(_ id: String) throws {
        guard !id.isEmpty, id.utf8.count <= 64, id.utf8.allSatisfy({
            (48...57).contains($0) || (65...90).contains($0) || (97...122).contains($0) || $0 == 45 || $0 == 95
        }) else { throw invalid("非法项目 id：\(id)") }
    }

    /// Unicode scalar count matches the existing Rust name contract rather than grapheme count.
    static func sanitizeName(_ raw: String) throws -> String {
        let name = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty else { throw invalid("项目名不能为空") }
        guard name.unicodeScalars.count <= 64 else { throw invalid("项目名过长（≤ 64 字符）") }
        return name
    }

    /// Canonical millisecond UTC stamps are generated by the native persistence owner.
    static func now() -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        formatter.dateFormat = "yyyy-MM-dd'T'HH:mm:ss.SSS'Z'"
        return formatter.string(from: Date())
    }

    /// ISO timestamps with timezone offsets/fractions sort by their actual instant.
    static func parseTime(_ text: String) -> Date? {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let value = formatter.date(from: text) { return value }
        formatter.formatOptions = [.withInternetDateTime]
        return formatter.date(from: text)
    }

    /// Read-side extraction retains malformed/missing fields for the frontend's explicit repair and warning.
    private static func modernEnvelope(_ fields: [String: HostJSON], version: Double, versionless: Bool) -> HostJSON {
        let raw = fields["project"]?.object ?? [:]
        var project: [String: HostJSON] = [:]
        for key in ["id", "name", "createdAt", "updatedAt"] { project[key] = .string(raw[key]?.string ?? "") }
        if let description = raw["description"] { project["description"] = description }
        var value: [String: HostJSON] = ["schemaVersion": .number(version), "project": .object(project)]
        for key in ["graph", "settings", "episodeTitles", "assets"] { value[key] = fields[key] ?? .null }
        if versionless { value["versionless"] = .bool(true) }
        return .object(value)
    }

    /// Graph save validation preserves unknown node fields while refusing a lossy container or viewport.
    private static func validateGraph(_ graph: HostJSON?) throws {
        guard let fields = graph?.object, fields["nodes"]?.arrayValue != nil, fields["edges"]?.arrayValue != nil else {
            throw invalid("graph 必须是包含 nodes/edges 数组的普通对象")
        }
        if let viewport = fields["viewport"] {
            guard let value = viewport.object, value["x"]?.number != nil, value["y"]?.number != nil,
                  let zoom = value["zoom"]?.number, zoom > 0 else { throw invalid("graph.viewport 必须含有限 x/y 与正 zoom") }
        }
        if let revision = fields["aiRevision"] {
            guard let number = revision.number, number >= 0, number <= 9_007_199_254_740_991,
                  number.rounded() == number else { throw invalid("graph.aiRevision 必须是非负安全整数") }
        }
    }

    /// All entity buckets must be present to prevent silent erasure on the next normalization.
    private static func validateSettings(_ settings: HostJSON?) throws {
        guard let fields = settings?.object else { throw invalid("settings 必须是普通对象") }
        for key in ["characters", "locations", "props", "documents"] {
            guard fields[key]?.object != nil else { throw invalid("settings.\(key) 缺失或非普通对象，拒绝保存") }
        }
    }

    /// Episode titles use canonical positive safe-integer keys and already-trimmed nonempty text.
    private static func validateTitles(_ titles: HostJSON?) throws {
        guard let fields = titles?.object else { throw invalid("episodeTitles 必须是普通对象") }
        for (key, value) in fields {
            guard let number = Double(key), number > 0, number <= 9_007_199_254_740_991,
                  key.first != "0", key.utf8.allSatisfy({ (48...57).contains($0) }),
                  let text = value.string, !text.isEmpty, text.trimmingCharacters(in: .whitespacesAndNewlines) == text else {
                throw invalid("episodeTitles 键或标题非规范形式")
            }
        }
    }

    /// Full asset refs remain opaque identities but require valid native paths and canonical metadata.
    private static func validateAssets(_ assets: HostJSON?) throws {
        guard let fields = assets?["byId"]?.object else { throw invalid("assets.byId 必须是普通对象") }
        for (key, value) in fields {
            guard let id = value["id"]?.string, !id.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                  id == key, let path = value["relPath"]?.string, NativeAssetContract.activeRelPath(path),
                  let mime = value["mime"]?.string, NativeAssetContract.mime(mime),
                  let source = value["source"]?.string, source == "upload" || source == "generated",
                  let stamp = value["createdAt"]?.string, NativeAssetContract.canonicalUTC(stamp) else {
                throw invalid("资产 \(key) 的身份、路径或元信息无效")
            }
        }
    }

    /// Stable boundary diagnostic distinguishes invalid input from filesystem trust failures.
    static func invalid(_ message: String) -> HostFailure { HostFailure(code: "PW_INVALID_REQUEST", message: message) }
}
