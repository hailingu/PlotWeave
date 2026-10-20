import Foundation

/// Swift-owned persistence actor serializes project mutations, media commits and deletion at one boundary.
/// invoke stays synchronous for actor-serialized filesystem transactions; external callers still await the actor hop.
actor NativeProjectStore {
    /// Single wire-name registry; exhaustive dispatch makes a missing command handler a compile error.
    enum Command: String, CaseIterable, Sendable {
        case listProjects = "list_projects"
        case createProject = "create_project"
        case loadProject = "load_project"
        case saveProject = "save_project"
        case deleteProject = "delete_project"
        case loadAiSession = "load_ai_session"
        case saveAiSession = "save_ai_session"
        case verifyProjectAssets = "verify_project_assets"
        case copyProjectAssets = "copy_project_assets"
    }

    /// The independent host-selected root never comes from a Web request.
    let root: URL
    /// A cached capability keeps later operations anchored if the ambient projects path is renamed.
    private var projects: NativeDirectory?
    /// A disposed fixture or app service cannot silently reopen its previous directory.
    private var closed = false
    /// Imported bytes are addressable before the Web's next debounced document save.
    var pendingMedia: [String: [String: HostJSON]] = [:]
    /// Repair aliases store only identity mappings; authoritative paths always come from the current document.
    var mediaAliases: [String: [String: String]] = [:]

    /// Shared project control-file byte ceiling (issue #592), aligned with the Rust store's 64 MiB.
    static let controlFileMaxBytes = 64 * 1024 * 1024
    /// Distinct oversize code: listing keeps a diagnostic card instead of hiding the entry.
    static let controlFileOversizeCode = "PW_STORAGE_LIMIT"

    /// Construction does no filesystem I/O, keeping App-hosted fixture startup independent of user data.
    init(root: URL) { self.root = root }

    /// Existing nine project IPC operations retain their wire values while execution moves into native Swift.
    func invoke(command: String, args: [String: HostJSON]) throws -> HostJSON {
        do {
            guard let command = Command(rawValue: command) else { throw HostFailure.commandUnavailable(command) }
            switch command {
            case .listProjects: return try listProjects()
            case .createProject: return try createProject(name: args.requiredString("name", domain: .project))
            case .loadProject: return try loadProject(id: args.requiredString("id", domain: .project))
            case .saveProject:
                guard let doc = args["doc"] else { throw invalid("缺少 doc 字段") }
                let existing: Bool
                switch args["expectExisting"] {
                case nil: existing = false
                case .bool(let flag): existing = flag
                default: throw invalid("expectExisting 必须是布尔值")
                }
                return try saveProject(id: args.requiredString("id", domain: .project), doc: doc, expectExisting: existing)
            case .deleteProject: try deleteProject(id: args.requiredString("id", domain: .project)); return .null
            case .loadAiSession: return try loadAiSession(id: args.requiredString("id", domain: .project))
            case .saveAiSession:
                guard let session = args["session"] else { throw invalid("缺少 session 字段") }
                try saveAiSession(id: args.requiredString("id", domain: .project), session: session); return .null
            case .verifyProjectAssets:
                guard let assets = args["assets"] else { throw invalid("缺少 assets 字段") }
                return try verifyAssets(id: args.requiredString("id", domain: .project), assets: assets)
            case .copyProjectAssets: try copyAssets(from: args.requiredString("fromId", domain: .project), to: args.requiredString("toId", domain: .project)); return .null
            }
        } catch let failure as HostFailure { throw failure }
        catch { throw HostFailure(code: "PW_STORAGE_ERROR", message: "原生存储操作失败：\(error.localizedDescription)") }
    }

    /// Stops future operations; outstanding media descriptors retain their own lifetime independently.
    func close() {
        closed = true
        projects = nil
        pendingMedia.removeAll()
        mediaAliases.removeAll()
    }

    /// Assets and model services submit a synchronous file transaction to this same actor as deletion.
    func withProject<T: Sendable>(id: String, body: @Sendable (NativeDirectory, HostJSON) throws -> T) throws -> T {
        let document = try loadProject(id: id)
        let directory = try projectDirectory(id: id, create: true)
        return try body(directory, document)
    }

    /// Lazily anchors the projects root on the background actor, including its durable first creation.
    func projectsDirectory() throws -> NativeDirectory {
        guard !closed else { throw HostFailure(code: "PW_CORE_CLOSED", message: "原生存储已关闭") }
        if let projects { return projects }
        let parent = try NativeDirectory(root: root)
        let directory = try parent.directory("projects", create: true)
        projects = directory
        return directory
    }

    /// All project-local directories go through the validated, anchored projects capability.
    func projectDirectory(id: String, create: Bool = false) throws -> NativeDirectory {
        try NativeProjectEnvelope.validateID(id)
        return try projectsDirectory().directory(id, create: create)
    }

    /// Reads a project control file under the shared ceiling; a static oversize file is rejected
    /// from metadata before materialization, and the streaming read enforces the same budget if it grows.
    private func readControlFile(_ directory: NativeDirectory, _ name: String) throws -> Data {
        if let metadata = try directory.metadata(name), metadata.st_size > off_t(Self.controlFileMaxBytes) {
            throw HostFailure(
                code: Self.controlFileOversizeCode,
                message: "控制文件 \(name) 超过 \(NativeDirectory.byteBudget(Self.controlFileMaxBytes)) 读取上限"
            )
        }
        return try directory.read(name, maxBytes: Self.controlFileMaxBytes, oversizeCode: Self.controlFileOversizeCode)
    }

    /// Write-side closure of the read ceiling: a document the loader would reject is never persisted.
    static func ensureControlFileSize(_ byteCount: Int, context: String) throws {
        guard byteCount <= controlFileMaxBytes else {
            throw HostFailure(
                code: controlFileOversizeCode,
                message: "\(context) 超过 \(NativeDirectory.byteBudget(controlFileMaxBytes)) 上限，拒绝保存"
            )
        }
    }

    /// Broken rows keep one diagnostic card per unreadable project; oversized files are locatable, not hidden.
    private static func brokenMeta(id: String, reason: String) -> HostJSON {
        .object([
            "id": .string(id), "name": .string(""), "updated_at": .string(""),
            "scene_count": .number(0), "ending_count": .number(0),
            "diagnostic": .string(reason)
        ])
    }

    /// Dirty records are isolated into their own diagnostic card; symlinks and disappeared entries stay invisible.
    private func listProjects() throws -> HostJSON {
        let directory = try projectsDirectory()
        directory.sweepOldTemporaryFiles { target in
            target.hasSuffix(".json") && (try? NativeProjectEnvelope.validateID(String(target.dropLast(5)))) != nil
        }
        var metas: [HostJSON] = []
        for name in try directory.entries() where name.hasSuffix(".json") {
            let id = String(name.dropLast(5))
            guard (try? NativeProjectEnvelope.validateID(id)) != nil else { continue }
            do {
                guard let kind = try directory.metadata(name), NativeDirectory.isRegular(kind) else { continue }
                let document = try decodeProject(readControlFile(directory, name), id: id)
                metas.append(NativeProjectEnvelope.metadata(document, id: id))
            } catch let failure as HostFailure where failure.code == "PW_STORAGE_REFUSED" { continue }
            catch let failure as HostFailure where failure.code == Self.controlFileOversizeCode {
                metas.append(Self.brokenMeta(id: id, reason: "项目文件不可读：\(failure.message)"))
            } catch let failure as HostFailure {
                metas.append(Self.brokenMeta(id: id, reason: "项目文件损坏或不可读：\(failure.message)"))
            } catch {
                metas.append(Self.brokenMeta(id: id, reason: "项目文件损坏或不可读：\(error.localizedDescription)"))
            }
        }
        metas.sort {
            let a = NativeProjectEnvelope.parseTime($0["updated_at"]?.string ?? "") ?? .distantPast
            let b = NativeProjectEnvelope.parseTime($1["updated_at"]?.string ?? "") ?? .distantPast
            return a == b ? ($0["id"]?.string ?? "") < ($1["id"]?.string ?? "") : a > b
        }
        return .array(metas)
    }

    /// Native UUID generation plus vacant-target validation prevents cross-process new-project collisions.
    private func createProject(name: String) throws -> HostJSON {
        let name = try NativeProjectEnvelope.sanitizeName(name)
        let directory = try projectsDirectory()
        let id = "p-" + UUID().uuidString.lowercased()
        let document = NativeProjectEnvelope.empty(id: id, name: name)
        try directory.writeNew(JSONEncoder().encode(document), name: id + ".json")
        return NativeProjectEnvelope.metadata(document, id: id)
    }

    /// Only confirmed absence receives the stable missing-project prefix used by the existing UI decoder.
    func loadProject(id: String) throws -> HostJSON {
        try NativeProjectEnvelope.validateID(id)
        let directory = try projectsDirectory()
        guard try directory.metadata(id + ".json") != nil else {
            throw HostFailure(code: "project_not_found", message: "[project_not_found] 项目不存在：\(id)")
        }
        return try decodeProject(readControlFile(directory, id + ".json"), id: id)
    }

    /// The existence check and atomic write share this actor with delete, so guarded late saves cannot resurrect it.
    private func saveProject(id: String, doc: HostJSON, expectExisting: Bool) throws -> HostJSON {
        try NativeProjectEnvelope.validateID(id)
        let directory = try projectsDirectory()
        if expectExisting, try directory.metadata(id + ".json") == nil {
            throw HostFailure(code: "PW_PROJECT_NOT_FOUND", message: "项目不存在，拒绝写入副本：\(id)")
        }
        let document = try NativeProjectEnvelope.prepareSave(doc, id: id)
        let encoded = try JSONEncoder().encode(document)
        try Self.ensureControlFileSize(encoded.count, context: "项目文件 \(id)")
        try verifySaveAssets(id: id, assets: document["assets"] ?? .null)
        try directory.write(encoded, name: id + ".json")
        try verifySaveAssets(id: id, assets: document["assets"] ?? .null)
        if let entries = document["assets"]?["byId"]?.object {
            for key in entries.keys { pendingMedia[id]?.removeValue(forKey: key) }
        }
        return NativeProjectEnvelope.metadata(document, id: id)
    }

    /// Media/AI tree removal precedes the control file, keeping a failed deletion discoverable and retryable.
    private func deleteProject(id: String) throws {
        try NativeProjectEnvelope.validateID(id)
        let directory = try projectsDirectory()
        try directory.removeTree(id)
        try directory.removeTree(id + ".json")
        pendingMedia.removeValue(forKey: id)
        mediaAliases.removeValue(forKey: id)
    }

    /// Missing session files are legitimate empty history; corrupt bytes are reported without rewriting the original.
    private func loadAiSession(id: String) throws -> HostJSON {
        try NativeProjectEnvelope.validateID(id)
        let projects = try projectsDirectory()
        guard try projects.metadata(id) != nil else { return sessionCopy(nil, corrupt: false) }
        let directory = try projects.directory(id)
        guard try directory.metadata("ai-session.json") != nil else { return sessionCopy(nil, corrupt: false) }
        let data = try readControlFile(directory, "ai-session.json")
        guard let session = try? JSONDecoder().decode(HostJSON.self, from: data), validSession(session) else {
            return sessionCopy(nil, corrupt: true)
        }
        return sessionCopy(session, corrupt: false)
    }

    /// AI writes require an existing ordinary project record under the same deletion barrier.
    private func saveAiSession(id: String, session: HostJSON) throws {
        try NativeProjectEnvelope.validateID(id)
        guard validSession(session) else { throw invalid("AI 会话版本或 entries 形状无效") }
        let projects = try projectsDirectory()
        guard try projects.metadata(id + ".json") != nil else {
            throw HostFailure(code: "PW_PROJECT_NOT_FOUND", message: "项目不存在，拒绝保存 AI 会话")
        }
        _ = try readControlFile(projects, id + ".json")
        let directory = try projects.directory(id, create: true)
        let encoded = try JSONEncoder().encode(session)
        try Self.ensureControlFileSize(encoded.count, context: "AI 会话 \(id)")
        try directory.write(encoded, name: "ai-session.json")
    }

    /// Verification reports reserved quarantine references without opening them, plus unsafe or missing active files.
    private func verifyAssets(id: String, assets: HostJSON) throws -> HostJSON {
        try NativeProjectEnvelope.validateID(id)
        let fields = assets["byId"]?.object ?? [:]
        let bad = fields.keys.sorted().filter { key in
            guard let path = fields[key]?["relPath"]?.string, NativeAssetContract.lexicalRelPath(path) else { return false }
            guard NativeAssetContract.activeRelPath(path) else { return true }
            return (try? projectDirectory(id: id).media(path, mime: fields[key]?["mime"]?.string ?? "application/octet-stream")) == nil
        }
        return .array(bad.map(HostJSON.string))
    }

    /// A document may reference only verified real files, both before and after its atomic persistence.
    private func verifySaveAssets(id: String, assets: HostJSON) throws {
        for (key, value) in assets["byId"]?.object ?? [:] {
            guard let path = value["relPath"]?.string, let mime = value["mime"]?.string else { throw invalid("资产 \(key) 缺失路径或 MIME") }
            _ = try projectDirectory(id: id).media(path, mime: mime)
        }
    }

    /// Copy validates the destination record even for an empty source, and rolls back every partial media tree.
    private func copyAssets(from source: String, to destination: String) throws {
        try NativeProjectEnvelope.validateID(source)
        try NativeProjectEnvelope.validateID(destination)
        let projects = try projectsDirectory()
        guard source != destination, try projects.metadata(destination) == nil else {
            throw NativeDirectory.refused("目标资产目录已存在或与源相同，拒绝复制")
        }
        guard try projects.metadata(destination + ".json") != nil else {
            throw HostFailure(code: "PW_PROJECT_NOT_FOUND", message: "目标项目已被删除，拒绝复制")
        }
        _ = try readControlFile(projects, destination + ".json")
        guard try projects.metadata(source) != nil else { return }
        let sourceDirectory = try projects.directory(source)
        guard try sourceDirectory.metadata("assets") != nil else { return }
        let assets = try sourceDirectory.directory("assets")
        do { try assets.copyContents(to: projects.directory(destination, create: true).directory("assets", create: true)) }
        catch {
            do { try projects.removeTree(destination) }
            catch { throw HostFailure(code: "PW_COPY_ROLLBACK_FAILED", message: "资产复制失败且清理未完成：\(error.localizedDescription)") }
            throw error
        }
    }

    /// Storage parses no application prose; malformed wire bytes remain untouched and produce a structured failure.
    private func decodeProject(_ data: Data, id: String) throws -> HostJSON {
        do { return try NativeProjectEnvelope.parse(JSONDecoder().decode(HostJSON.self, from: data), id: id) }
        catch { throw HostFailure(code: "PW_PROJECT_CORRUPT", message: "项目文件损坏：\(error.localizedDescription)") }
    }

    /// Session schema validation stays narrow; existing application entry payloads are preserved verbatim.
    private func validSession(_ value: HostJSON) -> Bool { value.object != nil && value["schemaVersion"] == .number(1) && value["entries"]?.arrayValue != nil }
    /// The AI read wire distinguishes missing, malformed and valid sessions explicitly.
    private func sessionCopy(_ session: HostJSON?, corrupt: Bool) -> HostJSON { .object(["session": session ?? .null, "corrupt": .bool(corrupt)]) }
    /// Shared invalid-input code is separate from persisted missing/corrupt record diagnostics.
    private func invalid(_ message: String) -> HostFailure { NativeProjectEnvelope.invalid(message) }
}
