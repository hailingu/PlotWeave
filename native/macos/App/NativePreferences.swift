import CryptoKit
import Darwin
import Foundation
import OSLog

/// Opaque settings and cipher migration share one actor, preventing stale read-modify-write replacements.
/// invoke stays synchronous for actor-serialized preference I/O; no additional suspension point is introduced.
actor NativePreferences {
    /// Single wire-name registry; exhaustive dispatch makes a missing command handler a compile error.
    enum Command: String, CaseIterable, Sendable {
        case loadPrefs = "load_prefs"
        case savePrefs = "save_prefs"
        case setProviderKey = "set_provider_key"
    }

    /// The trusted root comes only from the native host, never a Web payload.
    let root: URL
    /// Synthetic material is injected by tests; production preserves the frozen machine binding.
    private let machineMaterial: @Sendable () throws -> String
    /// The capability opens lazily and stays bound for this service's lifetime.
    private var directory: NativeDirectory?
    /// Only successful discovery is cached, allowing a failed probe to recover later.
    private var material: String?
    /// Settings use the existing one-MiB load and save boundary.
    private static let maximum = 1_048_576
    /// Both ordinary writes and migrations address the same fixed control-file leaf.
    private static let file = "settings.json"

    /// Construction is I/O-free; the first persistence command opens its injected root.
    init(root: URL, machineMaterial: @escaping @Sendable () throws -> String = NativeSeal.probeMachineMaterial) {
        self.root = root
        self.machineMaterial = machineMaterial
    }

    /// Existing IPC returns a business value, leaving the router as the sole envelope owner.
    func invoke(command: String, args: [String: HostJSON]) throws -> HostJSON {
        guard let command = Command(rawValue: command) else { throw HostFailure(code: "PW_HOST_COMMAND_UNAVAILABLE", message: "未支持的设置命令") }
        switch command {
        case .loadPrefs: return try load()
        case .savePrefs:
            guard let value = args["prefs"] else { throw invalid() }
            try save(value)
            return .null
        case .setProviderKey:
            guard let provider = args["providerId"]?.string, let raw = args["key"]?.string else { throw invalid() }
            try NativeSeal.validateProvider(provider)
            let key = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !key.isEmpty else { throw HostFailure(code: "PW_KEY_ERROR", message: "API key 不能为空") }
            return .string(try NativeSeal.seal(provider: provider, plaintext: key, material: machine()))
        }
    }

    /// Bind the endpoint and cipher from one actor-serialized snapshot before opening any secret.
    func providerCredential(_ provider: String, baseURL: String, suffix: String) throws -> NativeProviderCredential {
        try NativeSeal.validateProvider(provider)
        let value = try load()
        let entries = value["providers"]?.arrayValue?.filter { $0["id"]?.string == provider } ?? []
        guard entries.count == 1, let entry = entries.first, let configured = entry["baseUrl"]?.string else {
            throw NativeNetworkPolicy.refused("缺少唯一有效的 provider 服务配置，请重新保存设置")
        }
        let url = try NativeProviderBinding.endpoint(configured: configured, requested: baseURL, suffix: suffix)
        guard let envelope = entry["keyEnc"]?.string else {
            throw HostFailure(code: "PW_KEY_MISSING", message: "未配置 API key，请在设置页填写")
        }
        let secret = try NativeSeal.open(provider: provider, envelope: envelope, material: machine())
        if envelope.hasPrefix("pw1:") {
            do { try migrate(provider: provider, opened: envelope, secret: secret) }
            catch { NativeLog.preferences.warning("PlotWeave PW_KEY_MIGRATION_FAILED: legacy settings envelope remains unchanged") }
        }
        return NativeProviderCredential(url: url, key: secret)
    }

    /// Only true absence receives defaults; all unreadable, invalid, oversized or nonregular entries reject.
    private func load() throws -> HostJSON {
        let root = try capability()
        guard try root.metadata(Self.file) != nil else { return .object([:]) }
        let bytes = try root.read(Self.file, maxBytes: Self.maximum)
        do {
            let value = try HostJSON.decode(bytes)
            guard value.object != nil else { throw invalid() }
            return value
        }
        catch { throw HostFailure(code: "PW_PREFS_CORRUPT", message: "设置文件损坏，请先备份原文件后恢复设置") }
    }

    /// Serialization and its cap precede disk mutation; original damage evidence must be durable before replacement.
    private func save(_ value: HostJSON) throws {
        let bytes = try encode(value)
        let root = try capability()
        try backupDamaged(root)
        try root.write(bytes, name: Self.file)
    }

    /// Re-reading under the same actor protects newer provider edits and unknown fields during legacy migration.
    private func migrate(provider: String, opened: String, secret: String) throws {
        let latest = try load()
        guard var fields = latest.object, var providers = fields["providers"]?.arrayValue,
              let index = providers.firstIndex(where: { $0["id"]?.string == provider }),
              var entry = providers[index].object, entry["keyEnc"]?.string == opened else { return }
        entry["keyEnc"] = .string(try NativeSeal.seal(provider: provider, plaintext: secret, material: machine()))
        providers[index] = .object(entry)
        fields["providers"] = .array(providers)
        try capability().write(encode(.object(fields)), name: Self.file)
    }

    /// A valid JSON object is healthy; all other bounded original bytes get a content-addressed private backup.
    private func backupDamaged(_ root: NativeDirectory) throws {
        guard try root.metadata(Self.file) != nil else { return }
        let bytes = try root.read(Self.file, maxBytes: Self.maximum)
        if let decoded = try? HostJSON.decode(bytes), decoded.object != nil { return }
        let digest = SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
        let name = "settings-corrupt-" + digest + ".bak"
        if try root.metadata(name) == nil { try root.writeNew(bytes, name: name); return }
        guard try root.read(name, maxBytes: Self.maximum) == bytes else {
            throw HostFailure(code: "PW_PREFS_BACKUP_FAILED", message: "损坏设置的已有备份不匹配，已保留原文件")
        }
        let file = try root.openFile(name)
        defer { Darwin.close(file) }
        guard fchmod(file, mode_t(S_IRUSR | S_IWUSR)) == 0, fsync(file) == 0 else {
            throw NativeDirectory.ioError("同步私有设置备份失败")
        }
    }

    /// Pretty JSON remains opaque and is rejected before any original settings can change.
    private func encode(_ value: HostJSON) throws -> Data {
        guard value.object != nil else { throw HostFailure(code: "PW_PREFS_INVALID", message: "设置内容必须是 JSON 对象") }
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        let bytes: Data
        do { bytes = try encoder.encode(value) }
        catch { throw HostFailure(code: "PW_PREFS_INVALID", message: "设置内容不能序列化为 JSON") }
        guard bytes.count <= Self.maximum else { throw HostFailure(code: "PW_PREFS_TOO_LARGE", message: "设置内容过大（超过 1 MiB 上限）") }
        return bytes
    }

    /// Lazy open keeps app-hosted construction isolated from all real data roots.
    private func capability() throws -> NativeDirectory {
        if let directory { return directory }
        let opened = try NativeDirectory(root: root)
        directory = opened
        return opened
    }

    /// Failure is never cached and no alternative machine material is substituted.
    private func machine() throws -> String {
        if let material { return material }
        let discovered = try machineMaterial()
        guard !discovered.isEmpty else { throw HostFailure(code: "PW_MACHINE_UNAVAILABLE", message: "本机标识不可用") }
        material = discovered
        return discovered
    }

    /// Invalid arguments remain independent from storage failures and contain no request data.
    private func invalid() -> HostFailure { HostFailure(code: "PW_INVALID_REQUEST", message: "设置请求参数无效") }
}
