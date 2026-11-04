import Foundation
import Testing
@testable import PlotWeaveNative

/// Issue #730 scaling baseline for the two native list paths whose cost grows with stored data:
/// `NativeProjectStore.listProjects` fully decodes every `projects/*.json`, and every `NativeLibrary`
/// operation rebuilds its directory descriptor chain from the root and re-verifies each asset's media.
/// Regression mode runs only the fixture-invariant checks at smoke scale; the N×V and asset-count
/// measurements are opt-in (`sh scripts/test-native.sh list-scaling`) and print `PW-LIST-SCALING`
/// evidence lines. Recorded numbers are decision evidence, not CI thresholds.
@Suite(.serialized)
struct NativeListScalingBaselineTests {
    /// The project generator must yield exactly N healthy rows in the real sort order; a fixture the store
    /// would repair or reject would otherwise be measured as list cost (the invariant PR #814 asserts in Rust).
    @Test func projectFixtureListsEveryGeneratedProjectAsHealthySortedRows() async throws {
        let fixture = try ScalingFixture()
        defer { fixture.remove() }
        let written = try fixture.writeProjects(count: 8, fileKiB: 16)
        #expect(written.totalBytes >= 8 * 16 * 1024)
        let store = NativeProjectStore(root: fixture.root)
        let rows = try await store.invoke(command: "list_projects", args: [:]).array
        try Self.requireHealthyRows(rows, count: 8, scenesPerProject: written.nodesPerProject)
    }

    /// The library generator must be canonical: the first list returns every asset with no warnings and
    /// leaves `library.json` byte-identical, so measurements never include a normalization rewrite.
    @Test func libraryFixtureListsEveryAssetWithoutRewritingTheIndex() async throws {
        let fixture = try ScalingFixture()
        defer { fixture.remove() }
        _ = try fixture.writeLibrary(assets: 12)
        let index = fixture.root.appendingPathComponent("library/library.json")
        let before = try Data(contentsOf: index)
        let library = NativeLibrary(root: fixture.root)
        let listing = try await library.invoke(command: "list_library_assets", args: [:])
        try Self.requireHealthyListing(listing, assets: 12)
        #expect(try Data(contentsOf: index) == before)
    }

    /// Every rebuild opens fresh descriptors onto the same two real directories — the per-operation
    /// cost `NativeLibrary.execute` pays before taking the library lock.
    @Test func descriptorChainRebuildOpensFreshHandlesOntoTheSameDirectories() throws {
        let fixture = try ScalingFixture()
        defer { fixture.remove() }
        _ = try fixture.writeLibrary(assets: 0)
        let first = try Self.rebuildLibraryChain(root: fixture.root)
        let second = try Self.rebuildLibraryChain(root: fixture.root)
        #expect(first.descriptor != second.descriptor)
        #expect(try first.metadata("library.json") != nil)
        #expect(try second.metadata("assets") != nil)
    }

    /// N×V grid shared with the Rust baseline (issue #731) so both list implementations compare point by point.
    @Test(.enabled(if: NativeStressTestProfile.enabled, "按需运行：sh scripts/test-native.sh list-scaling"), arguments: ProjectGridPoint.grid)
    func listProjectsDurationScalesWithStoredBytes(point: ProjectGridPoint) async throws {
        let fixture = try ScalingFixture()
        defer { fixture.remove() }
        let written = try fixture.writeProjects(count: point.projects, fileKiB: point.fileKiB)
        let store = NativeProjectStore(root: fixture.root)
        let warm = try await Self.timed { try await store.invoke(command: "list_projects", args: [:]).array }
        try Self.requireHealthyRows(warm.value, count: point.projects, scenesPerProject: written.nodesPerProject)
        var samples: [Double] = []
        for _ in 0..<3 {
            samples.append(try await Self.timed { _ = try await store.invoke(command: "list_projects", args: [:]) }.milliseconds)
        }
        let summary = Summary(samples)
        let totalMiB = Double(written.totalBytes) / 1_048_576
        print("PW-LIST-SCALING store projects=\(point.projects) fileKiB=\(point.fileKiB) nodesPerProject=\(written.nodesPerProject) "
            + "totalMiB=\(evidence(totalMiB)) warmMs=\(evidence(warm.milliseconds)) \(summary) "
            + "MiBPerSecond=\(evidence(totalMiB * 1000 / summary.median))")
    }

    /// Asset-count sweep across the practical range under the 1 MiB index ceiling; each list rebuilds the
    /// chain, scans both directories, parses the index and reopens every asset's media file.
    @Test(.enabled(if: NativeStressTestProfile.enabled, "按需运行：sh scripts/test-native.sh list-scaling"), arguments: [0, 100, 400, 1600, 3200])
    func listLibraryAssetsDurationScalesWithAssetCount(assets: Int) async throws {
        let fixture = try ScalingFixture()
        defer { fixture.remove() }
        let indexBytes = try fixture.writeLibrary(assets: assets)
        let library = NativeLibrary(root: fixture.root)
        let warm = try await Self.timed { try await library.invoke(command: "list_library_assets", args: [:]) }
        try Self.requireHealthyListing(warm.value, assets: assets)
        var samples: [Double] = []
        for _ in 0..<3 {
            samples.append(try await Self.timed { _ = try await library.invoke(command: "list_library_assets", args: [:]) }.milliseconds)
        }
        let summary = Summary(samples)
        let perAsset = assets == 0 ? "n/a" : evidence(summary.median * 1000 / Double(assets))
        print("PW-LIST-SCALING library assets=\(assets) indexKiB=\(evidence(Double(indexBytes) / 1024)) "
            + "warmMs=\(evidence(warm.milliseconds)) \(summary) microsPerAsset=\(perAsset)")
    }

    /// Isolates the descriptor chain rebuild from everything else a library operation does.
    @Test(.enabled(if: NativeStressTestProfile.enabled, "按需运行：sh scripts/test-native.sh list-scaling"))
    func descriptorChainRebuildCostPerOperation() async throws {
        let fixture = try ScalingFixture()
        defer { fixture.remove() }
        _ = try fixture.writeLibrary(assets: 0)
        let iterations = 2_000
        var samples: [Double] = []
        for _ in 0..<3 {
            samples.append(try await Self.timed {
                for _ in 0..<iterations { _ = try Self.rebuildLibraryChain(root: fixture.root) }
            }.milliseconds)
        }
        let summary = Summary(samples)
        print("PW-LIST-SCALING descriptor-chain iterations=\(iterations) \(summary) "
            + "microsPerRebuild=\(evidence(summary.median * 1000 / Double(iterations)))")
    }

    /// Attributes the per-item cost behind the list curves: reopening one asset's media versus validating its
    /// index entry (library), and parsing one `updated_at` stamp as the store's sort comparator does.
    @Test(.enabled(if: NativeStressTestProfile.enabled, "按需运行：sh scripts/test-native.sh list-scaling"))
    func perItemUnitCostsAttributeListTime() async throws {
        let fixture = try ScalingFixture()
        defer { fixture.remove() }
        _ = try fixture.writeLibrary(assets: 1)
        let directory = try Self.rebuildLibraryChain(root: fixture.root)
        let entry = try #require(try JSONDecoder().decode(HostJSON.self, from: Data(contentsOf: fixture.root.appendingPathComponent("library/library.json")))["assets"]?["byId"]?["la_scale_00000"])
        let stamp = "2026-10-04T00:00:00.000Z"
        let iterations = 1_000
        func micros(_ milliseconds: Double) -> String { evidence(milliseconds * 1000 / Double(iterations)) }
        let media = try await Self.timed { for _ in 0..<iterations { _ = try directory.media("assets/la_scale_00000.png", mime: "image/png") } }
        let normalized = try await Self.timed { for _ in 0..<iterations { _ = NativeAssetContract.normalizedTimestamp(stamp) } }
        let validated = try await Self.timed { for _ in 0..<iterations { _ = try NativeLibraryIndex.asset(entry, strict: false) } }
        let parsed = try await Self.timed { for _ in 0..<iterations { _ = NativeProjectEnvelope.parseTime(stamp) } }
        print("PW-LIST-SCALING unit-cost iterations=\(iterations) mediaOpenMicros=\(micros(media.milliseconds)) "
            + "normalizedTimestampMicros=\(micros(normalized.milliseconds)) assetEntryValidationMicros=\(micros(validated.milliseconds)) "
            + "parseTimeMicros=\(micros(parsed.milliseconds))")
    }

    /// Healthy rows carry no diagnostic and the generator's derived counts (a scene chain has one ending),
    /// and arrive newest-first with distinct stamps — the sort the home list really performs.
    private static func requireHealthyRows(_ rows: [HostJSON], count: Int, scenesPerProject: Int) throws {
        try #require(rows.count == count)
        for row in rows {
            #expect(row["diagnostic"] == nil)
            #expect(row["name"]?.string == ProjectTemplate.name)
            #expect(row["scene_count"] == .number(Double(scenesPerProject)))
            #expect(row["ending_count"] == .number(1))
        }
        let stamps = rows.map { $0["updated_at"]?.string ?? "" }
        #expect(stamps == stamps.sorted(by: >))
        #expect(Set(stamps).count == count)
    }

    /// A healthy listing exposes every generated asset and reports neither warnings nor pending cleanup.
    private static func requireHealthyListing(_ listing: HostJSON, assets: Int) throws {
        let byId = try #require(listing["assets"]?["byId"]?.object)
        #expect(byId.count == assets)
        #expect(listing["warnings"]?.array.isEmpty == true)
        #expect(listing["cleanupPending"]?.array.isEmpty == true)
    }

    /// The exact two-level chain `NativeLibrary.execute` rebuilds for every operation before taking the lock.
    private static func rebuildLibraryChain(root: URL) throws -> NativeDirectory {
        let directory = try NativeDirectory(root: root).directory("library", create: true)
        _ = try directory.directory("assets", create: true)
        return directory
    }

    /// Monotonic wall-clock timing; the value is returned so the warm-up pass doubles as the correctness check.
    private static func timed<T>(_ operation: () async throws -> T) async throws -> (value: T, milliseconds: Double) {
        let clock = ContinuousClock()
        let start = clock.now
        let value = try await operation()
        let elapsed = clock.now - start
        return (value, Double(elapsed.components.seconds) * 1000 + Double(elapsed.components.attoseconds) / 1e15)
    }
}

/// One N×V grid point: `projects` files of at least `fileKiB` KiB each.
struct ProjectGridPoint: Sendable, CustomTestStringConvertible {
    let projects: Int
    let fileKiB: Int
    var testDescription: String { "\(projects)×\(fileKiB)KiB" }

    /// The Rust `list_scaling_baseline` grid minus its 800 MiB point, which adds nothing about the slope.
    static let grid: [ProjectGridPoint] = [
        ProjectGridPoint(projects: 50, fileKiB: 64), ProjectGridPoint(projects: 100, fileKiB: 64),
        ProjectGridPoint(projects: 200, fileKiB: 64), ProjectGridPoint(projects: 50, fileKiB: 512),
        ProjectGridPoint(projects: 100, fileKiB: 512), ProjectGridPoint(projects: 200, fileKiB: 512),
        ProjectGridPoint(projects: 100, fileKiB: 2048),
    ]
}

/// Two-decimal formatting shared by every evidence field.
private func evidence(_ value: Double) -> String { String(format: "%.2f", value) }

/// Three-sample statistics: the median is the headline number (PR #814 methodology); min/max show spread.
private struct Summary: CustomStringConvertible {
    let sorted: [Double]
    init(_ samples: [Double]) { sorted = samples.sorted() }
    var median: Double { sorted[sorted.count / 2] }
    var description: String {
        "minMs=\(evidence(sorted.first ?? 0)) medianMs=\(evidence(median)) maxMs=\(evidence(sorted.last ?? 0))"
    }
}

/// Byte and shape facts about a generated project set, used for evidence and invariant checks.
private struct WrittenProjects {
    let totalBytes: Int
    let nodesPerProject: Int
}

/// Fixture generation failures are reported as their own error, never as a store diagnostic.
private struct FixtureFailure: Error {
    let detail: String
}

/// Disposable data root with generators for canonical project and library fixtures at a requested scale.
private struct ScalingFixture {
    let root: URL

    /// Creates an empty root; the stores anchor `projects/` and `library/` themselves.
    init() throws {
        root = FileManager.default.temporaryDirectory.appendingPathComponent("pw-native-list-scaling-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    }

    /// Removes the fixture tree after awaited operations have settled.
    func remove() { try? FileManager.default.removeItem(at: root) }

    /// Writes `count` valid v1 documents of at least `fileKiB` KiB each, with distinct ids and `updatedAt`
    /// stamps so listing exercises the real decode and sort paths; reports what was actually written.
    func writeProjects(count: Int, fileKiB: Int) throws -> WrittenProjects {
        let projects = root.appendingPathComponent("projects")
        try FileManager.default.createDirectory(at: projects, withIntermediateDirectories: true)
        let template = try ProjectTemplate(minimumBytes: fileKiB * 1024)
        var total = 0
        for index in 0..<count {
            let id = String(format: "p-scale-%04d", index)
            let stamp = NativeAssetContract.timestamp(Date(timeIntervalSince1970: 1_760_000_000 + Double(index)))
            let body = template.text
                .replacingOccurrences(of: ProjectTemplate.idPlaceholder, with: id)
                .replacingOccurrences(of: ProjectTemplate.updatedPlaceholder, with: stamp)
            let bytes = Data(body.utf8)
            try bytes.write(to: projects.appendingPathComponent(id + ".json"))
            total += bytes.count
        }
        return WrittenProjects(totalBytes: total, nodesPerProject: template.nodes)
    }

    /// Writes a canonical `library.json` with `count` assets plus one tiny media file per asset and returns
    /// the index size; canonical entries keep the first list from rewriting the index.
    func writeLibrary(assets count: Int) throws -> Int {
        let library = root.appendingPathComponent("library")
        let assets = library.appendingPathComponent("assets")
        try FileManager.default.createDirectory(at: assets, withIntermediateDirectories: true)
        let media = Data([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
        var entries: [String: HostJSON] = [:]
        for index in 0..<count {
            let id = String(format: "la_scale_%05d", index)
            try media.write(to: assets.appendingPathComponent(id + ".png"))
            entries[id] = .object([
                "id": .string(id), "name": .string("基线素材 \(index)"), "kind": .string("reference"),
                "relPath": .string("assets/" + id + ".png"), "mime": .string("image/png"), "source": .string("upload"),
                "createdAt": .string("2026-10-04T00:00:00.000Z"), "tags": .array([])
            ])
        }
        let index = try JSONEncoder().encode(HostJSON.object([
            "assets": .object(["byId": .object(entries)]), "groups": .object(["byId": .object([:])])
        ]))
        try index.write(to: library.appendingPathComponent("library.json"))
        return index.count
    }
}

/// One encoded v1 envelope whose scene chain is sized to at least `minimumBytes`; id and `updatedAt`
/// placeholders are substituted per project so every file is a distinct, sortable document.
private struct ProjectTemplate {
    static let idPlaceholder = "__PW_PROJECT_ID__"
    static let updatedPlaceholder = "__PW_UPDATED_AT__"
    static let name = "伸缩基线项目"
    let text: String
    let nodes: Int

    /// Node count derives from one encoded node, so the whole document is encoded exactly once per grid point.
    init(minimumBytes: Int) throws {
        let script = String(repeating: "她推开门，雨声灌进来，屋里没有人回答。", count: 20)
        let perNode = try JSONEncoder().encode(Self.scene(0, script: script)).count + 1
        let count = max(1, (minimumBytes + perNode - 1) / perNode)
        var scenes: [HostJSON] = []
        var edges: [HostJSON] = []
        for index in 0..<count {
            scenes.append(Self.scene(index, script: script))
            if index > 0 {
                edges.append(.object(["id": .string("e-\(index)"), "source": .string("scene-\(index - 1)"), "target": .string("scene-\(index)")]))
            }
        }
        let document: HostJSON = .object([
            "schemaVersion": .number(1),
            "project": .object([
                "id": .string(Self.idPlaceholder), "name": .string(Self.name),
                "createdAt": .string("2026-10-04T00:00:00.000Z"), "updatedAt": .string(Self.updatedPlaceholder)
            ]),
            "graph": .object([
                "nodes": .array(scenes), "edges": .array(edges),
                "viewport": .object(["x": .number(0), "y": .number(0), "zoom": .number(1)])
            ]),
            "settings": .object(["characters": .object([:]), "locations": .object([:]), "props": .object([:]), "documents": .object([:])]),
            "episodeTitles": .object([:]), "assets": .object(["byId": .object([:])])
        ])
        guard let encoded = String(data: try JSONEncoder().encode(document), encoding: .utf8) else {
            throw FixtureFailure(detail: "项目夹具不是 UTF-8 文本")
        }
        text = encoded
        nodes = count
    }

    /// Scene node with a ~1.1 KiB script: an array of structured nodes approximates real canvas parsing cost.
    private static func scene(_ index: Int, script: String) -> HostJSON {
        .object([
            "id": .string("scene-\(index)"), "type": .string("scene"),
            "position": .object(["x": .number(Double(index % 8) * 320), "y": .number(Double(index / 8) * 200)]),
            "data": .object(["title": .string("第 \(index + 1) 场"), "script": .string(script), "episode": .number(Double(index / 10 + 1))])
        ])
    }
}
