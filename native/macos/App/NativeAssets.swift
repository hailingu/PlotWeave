import Foundation

/// Native asset orchestration composes the library and the single project actor without duplicating storage rules.
/// invoke remains async for cross-actor library/project work and background descriptor reads.
actor NativeAssets {
    /// Single wire-name registry; exhaustive dispatch makes a missing command handler a compile error.
    enum Command: String, CaseIterable, Sendable {
        case importProjectAssetFromLibrary = "import_project_asset_from_library"
        case validateProjectAsset = "validate_project_asset"
        case registerProjectAssetAlias = "register_project_asset_alias"
        case getAssetMediaUrl = "get_asset_media_url"
    }

    let library: NativeLibrary
    let projects: NativeProjectStore

    /// Both shared domain owners receive the same host-injected independent root.
    init(library: NativeLibrary, projects: NativeProjectStore) { self.library = library; self.projects = projects }

    /// Existing business entry points retain their command names and camelCase arguments.
    func invoke(command: String, args: [String: HostJSON]) async throws -> HostJSON {
        guard let command = Command(rawValue: command) else { throw HostFailure(code: "PW_HOST_COMMAND_UNAVAILABLE", message: "未知项目素材命令") }
        switch command {
        case .importProjectAssetFromLibrary:
            let project = try args.requiredString("id", domain: .asset)
            try NativeProjectEnvelope.validateID(project)
            let (entry, file) = try await library.source(id: args.requiredString("libraryAssetId", domain: .asset))
            let bytes = try await Task.detached { try file.read(maxBytes: NativeLibrary.maximumBytes) }.value
            try Task.checkCancellation()
            guard let mime = entry["mime"]?.string, let path = entry["relPath"]?.string else { throw NativeLibraryIndex.invalid("源素材字段无效") }
            return try await projects.importMedia(id: project, bytes: bytes, mime: mime, source: "upload",
                extension: NativeAssetContract.fileExtension(name: path, mime: mime))
        case .validateProjectAsset:
            guard let asset = args["asset"] else { throw NativeLibraryIndex.invalid("缺少资产对象") }
            return try await projects.validateAsset(id: args.requiredString("id", domain: .asset), asset: asset)
        case .registerProjectAssetAlias:
            try await projects.registerAlias(id: args.requiredString("id", domain: .asset), blankKey: args.requiredString("blankKey", domain: .asset), freshId: args.requiredString("freshId", domain: .asset))
            return .null
        case .getAssetMediaUrl:
            guard let scope = args["scope"] else { throw NativeLibraryIndex.invalid("缺少媒体作用域") }
            let address = try NativeMediaAddress(scope: scope, assetId: args.requiredString("assetId", domain: .asset))
            _ = try await open(address)
            return .string(address.url)
        }
    }

    /// Every protocol delivery resolves current disk/pending/alias authority and returns one separately owned descriptor.
    func open(url: URL) async throws -> (NativeMediaFile, Int) {
        let address = try NativeMediaAddress(url: url)
        return (try await open(address), address.maximumBytes)
    }

    /// Resource and early-URL checks share the same authoritative open path and size boundary.
    private func open(_ address: NativeMediaAddress) async throws -> NativeMediaFile {
        let file: NativeMediaFile
        switch address {
        case .library(let id): file = try await library.openMedia(id: id)
        case .project(let project, let id): file = try await projects.openMedia(id: project, assetId: id)
        }
        guard file.size >= 0, file.size <= address.maximumBytes else { throw NativeDirectory.refused("媒体超过读取上限") }
        return file
    }

}
