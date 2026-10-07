import Foundation
import Observation

/// Native read-only projection owner; editable canvas state always stays in React.
@MainActor
@Observable
final class NativeApplicationState {
    /// Only validated, monotonically ordered snapshots are exposed to native presentation.
    private(set) var projection: HostJSON = .object([:])
    /// A command failure remains visible until the next explicit action or page generation.
    private(set) var error: String?
    /// Native actions may await Web-owned saves; presentation disables conflicting controls.
    private(set) var busy = false
    /// Native sheets are presentation state only and do not own editable document copies.
    var projectSettingsVisible = false
    var exportVisible = false
    var libraryVisible = false
    @ObservationIgnored private var activeSession: String?
    @ObservationIgnored private var lastSequence = 0.0
    @ObservationIgnored private weak var coordinator: WebCanvasCoordinator?
    @ObservationIgnored private var pending = 0

    /// App projection describes navigation and project metadata, never a writable document.
    var app: HostJSON { projection["app"] ?? .null }
    /// Editor projection is visible only when it targets the currently open project.
    var editor: HostJSON {
        let value = projection["editor"] ?? .null
        return value["projectId"]?.string == projectId ? value : .null
    }
    /// AI projection is bound to the current project and carries no provider credentials.
    var ai: HostJSON {
        let value = projection["ai"] ?? .null
        return value["projectId"]?.string == projectId ? value : .null
    }
    /// Image jobs/models are read-only, and never survive a change of project identity.
    var image: HostJSON {
        let value = projection["image"] ?? .null
        return value["projectId"]?.string == projectId ? value : .null
    }
    /// Settings projection omits encrypted and plaintext credentials.
    var settings: HostJSON { projection["settings"] ?? .null }
    var projectId: String? { app["project"]?["id"]?.string }
    var projectName: String { app["project"]?["name"]?.string ?? "PlotWeave" }
    var route: String { app["route"]?.string ?? "loading" }

    /// Starts one page generation before observing its projection stream.
    func beginSession(_ sessionId: String) {
        guard sessionId != activeSession else { return }
        activeSession = sessionId
        lastSequence = 0
        projection = .object([:])
        error = nil
        pending = 0
        busy = false
    }

    /// Connects the current coordinator without restarting the same page on its ready handshake.
    func connect(_ coordinator: WebCanvasCoordinator) {
        self.coordinator = coordinator
        beginSession(coordinator.sessionId)
    }

    /// Consumes a validated projection envelope; stale or out-of-order events have no effect.
    func receiveProjection(_ body: [String: Any]) throws {
        guard body["protocolVersion"] as? Int == 1,
              body["sessionId"] as? String == activeSession,
              let sequenceValue = body["sequence"] as? NSNumber,
              sequenceValue.doubleValue.isFinite, sequenceValue.doubleValue > lastSequence,
              let value = body["projection"] as? [String: Any] else { return }
        let sequence = sequenceValue.doubleValue
        let decoded = try HostJSON(webValue: value)
        if let app = decoded["app"], !["home", "editor", "settings"].contains(app["route"]?.string ?? "") {
            throw HostFailure(code: "PW_INVALID_PROJECTION", message: "原生界面收到无效的导航状态")
        }
        projection = decoded
        lastSequence = sequence
    }

    /// A failed page cannot retain active edit controls or present an empty replacement document.
    func invalidate(_ message: String) {
        activeSession = nil
        coordinator = nil
        projection = .object([:])
        pending = 0
        busy = false
        error = message
    }

    /// Sends one explicit action; failures remain visible and side effects are never automatically retried.
    func send(_ command: String, args: [String: HostJSON] = [:]) {
        let session = activeSession
        let blocksUI = command.hasPrefix("app.") || ["settings.close", "settings.retry"].contains(command)
        error = nil
        if blocksUI { pending += 1; busy = true }
        Task { @MainActor [weak self] in
            guard let self else { return }
            defer {
                if blocksUI && self.activeSession == session {
                    self.pending -= 1
                    self.busy = self.pending > 0
                }
            }
            do { _ = try await self.request(command, args: args) }
            catch { if self.activeSession == session { self.error = error.localizedDescription } }
        }
    }

    /// Awaitable action seam serves native preview/import UI while all document mutations stay with their Web owner.
    func request(_ command: String, args: [String: HostJSON] = [:]) async throws -> HostJSON {
        guard let coordinator, let session = activeSession else {
            throw HostFailure(code: "PW_PAGE_UNAVAILABLE", message: "画布尚未就绪，请稍后重试。")
        }
        if let target = args["projectId"]?.string, target != projectId {
            throw HostFailure(code: "PW_STALE_PROJECT", message: "操作所属项目已关闭，请重新打开。")
        }
        if route == "settings", command.hasPrefix("app."), command != "app.settings" {
            _ = try await dispatch("settings.close", args: [:], coordinator: coordinator, session: session)
        }
        return try await dispatch(command, args: args, coordinator: coordinator, session: session)
    }

    /// Validates the final reply and page generation after the asynchronous Web operation completes.
    private func dispatch(_ command: String, args: [String: HostJSON], coordinator: WebCanvasCoordinator, session: String) async throws -> HostJSON {
        guard activeSession == session else { throw HostFailure(code: "PW_STALE_SESSION", message: "页面会话已更改，本次结果未知。") }
        let request: [String: Any] = [
            "protocolVersion": 1, "sessionId": session, "requestId": UUID().uuidString,
            "command": command, "args": HostJSON.object(args).webValue
        ]
        let reply = try HostJSON(webValue: await coordinator.sendNativeIntent(request: request))
        guard activeSession == session else { throw HostFailure(code: "PW_STALE_SESSION", message: "页面会话已更改，本次结果未知。") }
        if let failure = reply["error"] {
            throw HostFailure(code: failure["code"]?.string ?? "PW_INTENT_FAILED", message: failure["message"]?.string ?? "操作失败，请重试。")
        }
        guard let result = reply["ok"] else { throw HostFailure(code: "PW_INVALID_REPLY", message: "原生操作未返回有效回执。") }
        return result
    }

    /// Binds editor operations to the current project, including delayed native form submissions.
    func sendEditor(_ command: String, args: [String: HostJSON] = [:]) {
        guard let projectId else { error = "没有打开的项目。"; return }
        if let target = args["projectId"]?.string, target != projectId {
            error = "表单所属项目已关闭，请重新选择。"
            return
        }
        var owned = args
        owned["projectId"] = .string(projectId)
        send(command, args: owned)
    }
}
