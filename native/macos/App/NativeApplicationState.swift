import Foundation
import Observation

/// Native read-only projection owner; editable canvas state always stays in React.
@MainActor
@Observable
final class NativeApplicationState {
    /// Only validated, monotonically ordered snapshots are exposed to native presentation.
    private(set) var projection: HostJSON = .object([:])
    /// Domain values share the validated owner while observation stays local to their consumers.
    private var appProjection: HostJSON = .null
    /// Graph chrome changes do not invalidate unrelated navigation or model settings.
    private var editorProjection: HostJSON = .null
    /// AI consumers observe their own projection and current project identity.
    private var aiProjection: HostJSON = .null
    /// Image-job updates are independent from graph selection and history.
    private var imageProjection: HostJSON = .null
    /// Provider settings remain a read-only projection rather than an editable native document.
    private var settingsProjection: HostJSON = .null
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
    /// Futures are registered before fire-and-forget delivery, so quit cannot pass an empty Web save queue prematurely.
    @ObservationIgnored private var nativeIntents: [UUID: Task<HostJSON, Error>] = [:]

    /// App projection describes navigation and project metadata, never a writable document.
    var app: HostJSON { appProjection }
    /// Editor projection is visible only when it targets the currently open project.
    var editor: HostJSON {
        let value = editorProjection
        return value["projectId"]?.string == projectId ? value : .null
    }
    /// AI projection is bound to the current project and carries no provider credentials.
    var ai: HostJSON {
        let value = aiProjection
        return value["projectId"]?.string == projectId ? value : .null
    }
    /// Image jobs/models are read-only, and never survive a change of project identity.
    var image: HostJSON {
        let value = imageProjection
        return value["projectId"]?.string == projectId ? value : .null
    }
    /// Settings projection omits encrypted and plaintext credentials.
    var settings: HostJSON { settingsProjection }
    /// Outline rows re-render only when the outline itself changes, not on selection-only updates (issue #544).
    private(set) var editorOutline = HostJSON.null
    /// Episode focus follows its own slice so selection commits leave the outline header quiet.
    private(set) var focusedEpisode = HostJSON.null
    /// Row highlight observes the selected identity without re-mapping outline groups.
    private(set) var selectedNodeID: String?
    /// History toolbar buttons observe flags instead of the whole editor domain.
    private(set) var canUndo = false
    private(set) var canRedo = false
    /// The zoom readout changes only with the projected viewport scale.
    private(set) var canvasZoom = 1.0
    /// Identity changes revalidate retained feature projections without subscribing to unrelated app fields.
    private(set) var projectId: String?
    /// Window titles update only when the actual projected project name changes.
    private(set) var projectName = "PlotWeave"
    /// Navigation geometry does not subscribe to editor selection, history or background-job updates.
    private(set) var route = "loading"
    /// A failed canvas keeps the retained editor window interactive; welcome geometry must not mask its retry overlay.
    private(set) var canvasUnavailable = false

    /// Starts one page generation before observing its projection stream.
    func beginSession(_ sessionId: String) {
        guard sessionId != activeSession else { return }
        activeSession = sessionId
        nativeIntents.values.forEach { $0.cancel() }
        nativeIntents.removeAll()
        lastSequence = 0
        replaceProjection(.object([:]))
        error = nil
        pending = 0
        busy = false
    }

    /// Connects the current coordinator without restarting the same page on its ready handshake.
    func connect(_ coordinator: WebCanvasCoordinator) {
        self.coordinator = coordinator
        beginSession(coordinator.sessionId)
        let session = coordinator.sessionId
        coordinator.hasPendingNativeIntents = { [weak self] in
            self?.activeSession == session && self?.nativeIntents.isEmpty == false
        }
        coordinator.drainNativeIntents = { [weak self] in
            guard let self else { throw HostFailure(code: "PW_PAGE_UNAVAILABLE", message: "原生编辑会话不可用") }
            try await self.drainNativeIntents(session: session)
        }
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
        replaceProjection(decoded)
        // A valid projection proves the canvas is live again; the retry overlay can leave the failure presentation.
        if canvasUnavailable {
            canvasUnavailable = false
            error = nil
        }
        lastSequence = sequence
    }

    /// Publish complete validated or reset values synchronously; Equatable observation skips unchanged domains.
    private func replaceProjection(_ value: HostJSON) {
        appProjection = value["app"] ?? .null
        projectId = appProjection["project"]?["id"]?.string
        projectName = appProjection["project"]?["name"]?.string ?? "PlotWeave"
        route = appProjection["route"]?.string ?? "loading"
        editorProjection = value["editor"] ?? .null
        publishEditorChrome()
        aiProjection = value["ai"] ?? .null
        imageProjection = value["image"] ?? .null
        settingsProjection = value["settings"] ?? .null
        projection = value
    }

    /// Editor chrome slices derive from the same validated domain; equal values stay silent (issue #544).
    private func publishEditorChrome() {
        let editor = editorProjection["projectId"]?.string == projectId ? editorProjection : .null
        editorOutline = editor["outline"] ?? .null
        focusedEpisode = editor["focusedEpisode"] ?? .null
        selectedNodeID = editor["selected"]?["id"]?.string
        canUndo = editor["canUndo"]?.bool == true
        canRedo = editor["canRedo"]?.bool == true
        canvasZoom = editor["zoom"]?.number ?? 1
    }

    /// A failed page cannot retain active edit controls or present an empty replacement document.
    /// The failure flag suppresses welcome geometry and keeps the retained writer available for the retry overlay.
    func invalidate(_ message: String) {
        activeSession = nil
        nativeIntents.values.forEach { $0.cancel() }
        nativeIntents.removeAll()
        coordinator = nil
        canvasUnavailable = true
        replaceProjection(.object([:]))
        pending = 0
        busy = false
        error = message
    }

    /// Registers one explicit action synchronously; an optional presentation acknowledgment follows its validated completion.
    func send(_ command: String, args: [String: HostJSON] = [:], onCompletion: (@MainActor (Result<HostJSON, Error>) -> Void)? = nil) {
        let session = activeSession
        let blocksUI = command.hasPrefix("app.") || ["settings.close", "settings.retry"].contains(command)
        error = nil
        if blocksUI { pending += 1; busy = true }
        let intent = enqueueNativeIntent(command, args: args)
        // Completion adapter for the future owned by nativeIntents, not a second command.
        // beginSession/invalidate cancel that future; session checks below reject late results.
        // Keep the adapter alive to settle the presentation acknowledgment, including failure.
        Task { @MainActor [weak self] in
            guard let self else { return }
            defer {
                if blocksUI && self.activeSession == session {
                    self.pending -= 1
                    self.busy = self.pending > 0
                }
            }
            do {
                let value = try await intent.value
                guard self.activeSession == session else {
                    onCompletion?(.failure(HostFailure(code: "PW_STALE_SESSION", message: "页面会话已更改，本次结果未知。")))
                    return
                }
                onCompletion?(.success(value))
            } catch {
                if self.activeSession == session { self.error = error.localizedDescription }
                onCompletion?(.failure(error))
            }
        }
    }

    /// Awaitable action seam serves native preview/import UI while all document mutations stay with their Web owner.
    func request(_ command: String, args: [String: HostJSON] = [:]) async throws -> HostJSON {
        try await enqueueNativeIntent(command, args: args).value
    }

    /// Both native action entry points register immediately and retain only their current page's pending completions.
    private func enqueueNativeIntent(_ command: String, args: [String: HostJSON]) -> Task<HostJSON, Error> {
        let id = UUID()
        let session = activeSession
        let task = Task<HostJSON, Error> { @MainActor [weak self] in
            guard let self else { throw HostFailure(code: "PW_PAGE_UNAVAILABLE", message: "原生编辑会话不可用") }
            defer { self.nativeIntents.removeValue(forKey: id) }
            try Task.checkCancellation()
            guard self.activeSession == session else {
                throw HostFailure(code: "PW_STALE_SESSION", message: "页面会话已更改，本次结果未知。")
            }
            return try await self.performRequest(command, args: args)
        }
        nativeIntents[id] = task
        return task
    }

    /// Quit delivery waits to a native fixed point; failures cancel this attempt and no failed future is automatically replayed.
    private func drainNativeIntents(session: String) async throws {
        repeat {
            try Task.checkCancellation()
            guard activeSession == session else { throw HostFailure(code: "PW_STALE_SESSION", message: "退出对应的编辑会话已失效") }
            let tasks = Array(nativeIntents.values)
            for task in tasks { _ = try await task.value }
        } while !nativeIntents.isEmpty
        try Task.checkCancellation()
        guard activeSession == session else { throw HostFailure(code: "PW_STALE_SESSION", message: "退出对应的编辑会话已失效") }
    }

    /// The Web action remains the sole mutation owner after current-page and project checks.
    private func performRequest(_ command: String, args: [String: HostJSON]) async throws -> HostJSON {
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
            "protocolVersion": 1, "sessionId": session, "requestId": try coordinator.nextNativeIntentId(),
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
