import Foundation
import Testing
@testable import PlotWeaveNative

/// Real service entry points verify routing authority without opening user data or calling providers.
@MainActor
struct NativeCommandRoutingTests {
    /// Wire-name anchors are the existing protocol commands, independent from the typed registry.
    @Test func knownWireCommandsRequireConfiguredRootBeforeArguments() async throws {
        let services = NativeHostServices(dataRoot: nil, quit: HostQuitController())
        for command in ["list_projects", "list_library_assets", "get_asset_media_url", "load_prefs", "llm_image_cancel"] {
            let error = try await failure { try await services.perform(request(command)) }
            #expect(error.code == "PW_CORE_UNAVAILABLE")
        }
    }

    /// Every registered command is routable, uniquely owned and checked before any unavailable-root I/O.
    @Test func allRegisteredCommandsReachTheirRootBoundary() async throws {
        let commands = NativeProjectStore.Command.allCases.map(\.rawValue)
            + NativeLibrary.Command.allCases.map(\.rawValue)
            + NativeAssets.Command.allCases.map(\.rawValue)
            + NativePreferences.Command.allCases.map(\.rawValue)
            + NativeModels.Command.allCases.map(\.rawValue)
        #expect(Set(commands).count == commands.count)
        let services = NativeHostServices(dataRoot: nil, quit: HostQuitController())
        for command in commands {
            let error = try await failure { try await services.perform(request(command)) }
            #expect(error.code == "PW_CORE_UNAVAILABLE")
        }
    }

    /// Unknown dispatch never opens storage; the model's closed-state error still precedes command parsing.
    @Test func unknownCommandsAndClosedModelsPreserveFailureBoundaries() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("pw-command-registry-" + UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let projects = NativeProjectStore(root: root)
        let library = NativeLibrary(root: root)
        let assets = NativeAssets(library: library, projects: projects)
        let preferences = NativePreferences(root: root, machineMaterial: { "registry-fixture-material" })
        let models = NativeModels(preferences: preferences, projects: projects)
        let unknown = "fixture_unknown_command"
        let services = NativeHostServices(dataRoot: nil, quit: HostQuitController())
        let routed = try await failure { try await services.perform(request(unknown)) }
        #expect(routed.code == "PW_HOST_COMMAND_UNAVAILABLE")
        let operations: [CommandCall] = [
            { try await projects.invoke(command: unknown, args: [:]) },
            { try await library.invoke(command: unknown, args: [:]) },
            { try await assets.invoke(command: unknown, args: [:]) },
            { try await preferences.invoke(command: unknown, args: [:]) },
            { try await models.invoke(command: unknown, args: [:]) },
        ]
        for (index, operation) in operations.enumerated() {
            let error = try await failure(operation)
            #expect(error.code == "PW_HOST_COMMAND_UNAVAILABLE")
            if index == 0 { #expect(error.reply == routed.reply) }
        }
        await models.close()
        let closed = try await failure { try await models.invoke(command: unknown, args: [:]) }
        #expect(closed.code == "PW_CORE_CLOSED")
        #expect(!FileManager.default.fileExists(atPath: root.path))
    }

    /// Test calls stay on their fixture's main actor while crossing real domain actors.
    private typealias CommandCall = @MainActor () async throws -> HostJSON

    /// A successful or differently typed response must fail the test, not satisfy an error-code assertion.
    private func failure(_ operation: CommandCall) async throws -> HostFailure {
        do { _ = try await operation() }
        catch let error as HostFailure { return error }
        catch { throw error }
        Issue.record("Expected a structured host failure")
        throw CocoaError(.coderInvalidValue)
    }

    /// The request envelope is real; only the supplied command and absent business arguments vary.
    private func request(_ command: String) -> HostRequest {
        HostRequest(protocolVersion: 1, sessionId: "registry-fixture", requestId: UUID().uuidString, command: command, args: [:])
    }
}
