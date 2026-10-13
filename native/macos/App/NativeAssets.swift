import Foundation

/// Native asset orchestration composes the library and the single project actor without duplicating storage rules.
actor NativeAssets {
    let library: NativeLibrary
    let projects: NativeProjectStore

    /// Both shared domain owners receive the same host-injected independent root.
    init(library: NativeLibrary, projects: NativeProjectStore) { self.library = library; self.projects = projects }

    /// Existing business entry points retain their command names and camelCase arguments.
    func invoke(_ command: String, args: [String: HostJSON]) async throws -> HostJSON {
        switch command {
        case "import_project_asset_from_library":
            let project = try string(args, "id")
            try NativeProjectEnvelope.validateID(project)
            let (entry, file) = try await library.source(id: string(args, "libraryAssetId"))
            let bytes = try await Task.detached { try file.read(maxBytes: NativeLibrary.maximumBytes) }.value
            try Task.checkCancellation()
            guard let mime = entry["mime"]?.string, let path = entry["relPath"]?.string else { throw NativeLibraryIndex.invalid("源素材字段无效") }
            return try await projects.importMedia(id: project, bytes: bytes, mime: mime, source: "upload",
                extension: NativeAssetContract.fileExtension(name: path, mime: mime))
        case "validate_project_asset":
            guard let asset = args["asset"] else { throw NativeLibraryIndex.invalid("缺少资产对象") }
            return try await projects.validateAsset(id: string(args, "id"), asset: asset)
        case "register_project_asset_alias":
            try await projects.registerAlias(id: string(args, "id"), blankKey: string(args, "blankKey"), freshId: string(args, "freshId"))
            return .null
        case "get_asset_media_url":
            guard let scope = args["scope"] else { throw NativeLibraryIndex.invalid("缺少媒体作用域") }
            let address = try NativeMediaAddress(scope: scope, assetId: string(args, "assetId"))
            _ = try await open(address)
            return .string(address.url)
        default: throw HostFailure(code: "PW_HOST_COMMAND_UNAVAILABLE", message: "未知项目素材命令")
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

    /// No missing or mistyped scalar acquires an implicit default at the host trust boundary.
    private func string(_ args: [String: HostJSON], _ key: String) throws -> String {
        guard let value = args[key]?.string else { throw NativeLibraryIndex.invalid("素材请求缺少必填字段") }
        return value
    }
}
