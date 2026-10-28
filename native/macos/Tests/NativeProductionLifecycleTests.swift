import AppKit
import Foundation
import ApplicationServices
import SwiftUI
import Testing
import WebKit
@testable import PlotWeaveNative

/// Production bundle, SwiftUI shell, Web canvas and native storage prove one document writer across real saves.
@MainActor
@Suite(.serialized, WebKitTestIsolation())
struct NativeProductionLifecycleTests {
    /// Real non-streaming WK requests publish readable native feedback; cancelled replies cannot replace a new round (#927).
    @Test func aiRequestFeedbackFollowsActualTurnLifecycle() async throws {
        let fixture = Fixture()
        defer { fixture.remove() }
        let (mounted, id, gate) = try await prepareAiStatus(fixture)
        let statusWindow = fixture.mountAi(state: mounted.state, projectId: id)
        let args: [String: HostJSON] = ["projectId": .string(id), "text": .string("不要修改画布，只讨论人物。")]
        let first = Task { try await mounted.state.request("ai.send", args: args) }
        defer { first.cancel() }
        try await wait { gate.replies.count == 1 && mounted.state.ai["feedback"]?["phase"]?.string == "waiting" }
        try await assertAiStatus(statusWindow, title: "正在等待 AI 回复…")
        _ = try await mounted.state.request("ai.cancel", args: ["projectId": .string(id)])
        try await wait { mounted.state.ai["feedback"]?["phase"]?.string == "cancelled" }
        try await assertAiStatus(statusWindow, title: "已停止本轮处理")
        let second = Task { try await mounted.state.request("ai.send", args: args) }
        defer { second.cancel() }
        try await wait { gate.replies.count == 2 && mounted.state.ai["busy"]?.bool == true }
        gate.finish(0, content: "旧轮迟到回复")
        _ = try await first.value
        #expect(mounted.state.ai["feedback"]?["phase"]?.string == "waiting")
        #expect(mounted.state.ai["thread"]?.array.contains { $0["text"]?.string == "旧轮迟到回复" } != true)
        // The native pane can remount without losing the still-current Web lifecycle.
        statusWindow.contentView = nil
        let remounted = fixture.mountAi(state: mounted.state, projectId: id)
        try await assertAiStatus(remounted, title: "正在等待 AI 回复…")
        gate.finish(1, content: "本轮文字回复")
        _ = try await second.value
        try await wait { mounted.state.ai["feedback"]?["phase"]?.string == "completed" }
        try await assertAiStatus(remounted, title: "本轮回答已结束")
        #expect(mounted.state.ai["busy"]?.bool == false)
        let failed = Task { try await mounted.state.request("ai.send", args: args) }
        defer { failed.cancel() }
        try await wait { gate.replies.count == 3 }
        gate.finish(2, error: true)
        _ = try await failed.value
        try await wait { mounted.state.ai["feedback"]?["phase"]?.string == "failed" }
        try await assertAiStatus(remounted, title: "请求失败")
        #expect(mounted.state.ai["error"]?.string?.contains("合成模型失败") == true)
        await fixture.services.close()
    }

    /// Only the external model response is gated; production React, IPC, projection and native controls remain real.
    private func prepareAiStatus(_ fixture: Fixture) async throws -> ((window: NSWindow, state: NativeApplicationState), String, AiReplyGate) {
        let prefs = NativePreferences(root: fixture.root, machineMaterial: { "fixture-machine" })
        let encrypted = try await prefs.invoke(command: "set_provider_key", args: ["providerId": .string("openai"), "key": .string("fixture-key")])
        _ = try await prefs.invoke(command: "save_prefs", args: ["prefs": .object([
            "providers": .array([.object(["id": .string("openai"), "label": .string("合成模型"), "baseUrl": .string("https://provider.example/v1"), "enabled": .bool(true), "models": .array([.string("fixture-model")]), "keyEnc": encrypted])]),
            "defaultChat": .string("openai:fixture-model")
        ])])
        let projects = try #require(fixture.services.projectStore)
        let created = try await projects.invoke(command: "create_project", args: ["name": .string("AI 状态回归")])
        let id = try #require(created["id"]?.string)
        let mounted = fixture.mount()
        try await wait { mounted.state.route == "home" && mounted.state.app["loading"] == .bool(false) }
        let web = try #require(findWebView(mounted.window.contentView))
        try await waitForHostReady(web)
        let coordinator = try #require(web.navigationDelegate as? WebCanvasCoordinator)
        let gate = AiReplyGate(coordinator: coordinator)
        let controller = web.configuration.userContentController
        controller.removeScriptMessageHandler(forName: "plotweaveHost", contentWorld: .page)
        controller.addScriptMessageHandler(gate, contentWorld: .page, name: "plotweaveHost")
        _ = try await mounted.state.request("app.open", args: ["id": .string(id)])
        try await wait { mounted.state.route == "editor" && mounted.state.ai["ready"]?.bool == true }
        return (mounted, id, gate)
    }

    /// The real native accessibility element must expose the same title as the request owner.
    private func assertAiStatus(_ window: NSWindow, title: String) async throws {
        let deadline = ContinuousClock.now.advanced(by: .seconds(5))
        while ContinuousClock.now < deadline {
            let elements = try await NativeCreationControlFixture.elements(in: window)
            if elements.contains(where: {
                NativeCreationControlFixture.string($0, kAXIdentifierAttribute) == "ai.requestStatus"
                    && NativeCreationControlFixture.string($0, kAXDescriptionAttribute) == title
            }) { return }
            try await Task.sleep(for: .milliseconds(30))
        }
        Issue.record("原生 AI 请求状态未呈现：\(title)")
    }

    /// Deterministic external-response seam holds replies on the same production WK RPC futures.
    @MainActor private final class AiReplyGate: NSObject, WKScriptMessageHandlerWithReply {
        let coordinator: WebCanvasCoordinator
        var replies: [@MainActor @Sendable (Any?, String?) -> Void] = []
        /// Non-model requests keep their original service and session validation.
        init(coordinator: WebCanvasCoordinator) { self.coordinator = coordinator }
        /// Holds model transport only; no public endpoint or user credential is accessed.
        func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage, replyHandler: @escaping @MainActor @Sendable (Any?, String?) -> Void) {
            if (message.body as? [String: Any])?["command"] as? String == "llm_chat" { replies.append(replyHandler) }
            else { coordinator.userContentController(controller, didReceive: message, replyHandler: replyHandler) }
        }
        /// Releases an owned pending transport request with a standard host envelope.
        func finish(_ index: Int, content: String = "", error: Bool = false) {
            replies[index](error ? ["error": ["code": "PW_FIXTURE_MODEL_FAILURE", "message": "合成模型失败"]]
                : ["ok": ["role": "assistant", "content": content]], nil)
        }
    }

    /// Real WKWebView timers retire repeated native-outline refusals without mutating the document (#930).
    @Test func outlineFeedbackExpiresAndDoesNotReturnAfterNavigation() async throws {
        let fixture = Fixture()
        defer { fixture.remove() }
        let projects = try #require(fixture.services.projectStore)
        let created = try await projects.invoke(command: "create_project", args: ["name": .string("操作反馈生命周期")])
        let id = try #require(created["id"]?.string)
        var doc = try #require(try await projects.invoke(command: "load_project", args: ["id": .string(id)]).object)
        // An explicit viewport prevents startup fitView from changing the document after baseline capture.
        var graph = try #require(outlineGraph().object)
        graph["viewport"] = .object(["x": .number(0), "y": .number(0), "zoom": .number(1)])
        doc["graph"] = .object(graph)
        _ = try await projects.invoke(command: "save_project", args: ["id": .string(id), "doc": .object(doc), "expectExisting": .bool(true)])
        let mounted = fixture.mount()
        try await wait { mounted.state.route == "home" && mounted.state.app["loading"] == .bool(false) }
        let web = try #require(findWebView(mounted.window.contentView))
        try await waitForHostReady(web)
        _ = try await mounted.state.request("app.open", args: ["id": .string(id)])
        try await wait { mounted.state.route == "editor" && mounted.state.editor["nodes"]?.arrayValue?.count == 5 }
        let before = try await numberingDocument(mounted.state, id: id)
        let args: [String: HostJSON] = ["projectId": .string(id), "id": .string("A"),
            "target": .object(["kind": .string("row"), "anchorId": .string("X"), "position": .string("after")])]
        _ = try await mounted.state.request("editor.outlineMove", args: args)
        try await waitForActionFeedback(web, present: true)
        try await Task.sleep(for: .seconds(3))
        _ = try await mounted.state.request("editor.outlineMove", args: args)
        try await Task.sleep(for: .milliseconds(5_100))
        let text = try await web.evaluateJavaScript("document.querySelector('.pw-error-banner[role=alert]')?.textContent ?? ''") as? String
        #expect(text?.contains("大纲拖拽未执行") == true)
        #expect(text?.contains("请先在画布上调整连线") == true)
        try await waitForActionFeedback(web, present: false)
        #expect(try await numberingDocument(mounted.state, id: id) == before)
        _ = try await mounted.state.request("editor.outlineMove", args: args)
        try await waitForActionFeedback(web, present: true)
        _ = try await mounted.state.request("app.home")
        try await wait { mounted.state.route == "home" }
        _ = try await mounted.state.request("app.open", args: ["id": .string(id)])
        try await wait { mounted.state.route == "editor" }
        try await waitForActionFeedback(web, present: false)
        let reopened = try await numberingDocument(mounted.state, id: id)
        var expected = try #require(before.object)
        var metadata = try #require(before["project"]?.object)
        // app.home flushes the document: export now uses the reloaded save timestamp.
        metadata["updatedAt"] = .string(try #require(reopened["project"]?["updatedAt"]?.string))
        expected["project"] = .object(metadata)
        #expect(reopened == .object(expected))
        #expect(mounted.state.error == nil)
        await fixture.services.close()
    }

    /// Observe rendered alerts with real browser scheduling, independently of native projections.
    private func waitForActionFeedback(_ web: WKWebView, present: Bool) async throws {
        let deadline = ContinuousClock.now.advanced(by: .seconds(12))
        while ContinuousClock.now < deadline {
            let visible = try await web.evaluateJavaScript("Array.from(document.querySelectorAll('[role=alert]')).some(node => node.textContent.includes('大纲拖拽未执行'))") as? Bool
            if visible == present { return }
            try await Task.sleep(for: .milliseconds(40))
        }
        Issue.record("大纲操作反馈未达到预期可见状态：\(present)")
    }

    /// Actual native clear buttons, React history and Swift disk reload share the optional numbering contract (#933).
    @Test func sceneNumberClearControlsPersistAndUndoIndependently() async throws {
        let fixture = Fixture()
        defer { fixture.remove() }
        let projects = try #require(fixture.services.projectStore)
        let created = try await projects.invoke(command: "create_project", args: ["name": .string("独立清除编号")])
        let id = try #require(created["id"]?.string)
        var doc = try #require(try await projects.invoke(command: "load_project", args: ["id": .string(id)]).object)
        doc["graph"] = outlineGraph()
        _ = try await projects.invoke(command: "save_project", args: ["id": .string(id), "doc": .object(doc), "expectExisting": .bool(true)])
        let mounted = fixture.mount()
        try await wait { mounted.state.route == "home" && mounted.state.app["loading"] == .bool(false) }
        try await waitForHostReady(try #require(findWebView(mounted.window.contentView)))
        _ = try await mounted.state.request("app.open", args: ["id": .string(id)])
        try await wait { mounted.state.route == "editor" }
        _ = try await mounted.state.request("editor.patchNode", args: ["projectId": .string(id), "id": .string("A"), "patch": .object(["sceneNo": .number(7), "episodeNo": .number(2)])])
        _ = try await mounted.state.request("editor.select", args: ["projectId": .string(id), "id": .string("A")])
        try await wait { mounted.state.selectedNodeID == "A" && mounted.state.editor["selected"]?["data"]?["sceneNo"] == .number(7) }
        let controls = mounted.window
        let before = try await numberingDocument(mounted.state, id: id)
        try await assertNumberField(controls, label: "场次", value: "7")
        try numberPreview(controls, name: "scene7-episode2")
        try await pressNumberButton(controls, named: "清除场次")
        try await waitForNumbering(mounted.state, scene: nil, episode: 2)
        try await assertNumberField(controls, label: "场次", value: "")
        try numberPreview(controls, name: "scene-cleared-episode2")
        #expect(numberingInvariant(try await numberingDocument(mounted.state, id: id)) == numberingInvariant(before))
        _ = try await mounted.state.request("editor.undo", args: ["projectId": .string(id)])
        try await waitForNumbering(mounted.state, scene: 7, episode: 2)
        try await assertNumberField(controls, label: "场次", value: "7")
        try await pressNumberButton(controls, named: "清除集号")
        try await waitForNumbering(mounted.state, scene: 7, episode: nil)
        _ = try await mounted.state.request("editor.undo", args: ["projectId": .string(id)])
        try await waitForNumbering(mounted.state, scene: 7, episode: 2)
        try await exerciseNumberHistory(controls, state: mounted.state, id: id)
        for selected in ["B", "A"] {
            _ = try await mounted.state.request("editor.select", args: ["projectId": .string(id), "id": .string(selected)])
            try await wait { mounted.state.selectedNodeID == selected }
        }
        try await assertNumberField(controls, label: "场次", value: "")
        #expect(!(try await NativeCreationControlFixture.elements(in: controls)).contains { NativeCreationControlFixture.string($0, "AXDescription") == "清除场次" })
        try await enterSceneNumber(controls, text: "8")
        try await waitForNumbering(mounted.state, scene: 8, episode: nil)
        try await pressNumberButton(controls, named: "清除场次")
        controls.makeFirstResponder(nil)
        try await waitForNumbering(mounted.state, scene: nil, episode: nil)
        try await waitForNumberDisk(projects, id: id)
        _ = try await mounted.state.request("app.home")
        try await wait { mounted.state.route == "home" }
        let saved = try await projects.invoke(command: "load_project", args: ["id": .string(id)])
        let savedA = try #require(saved["graph"]?["nodes"]?.arrayValue?.first { $0["id"] == .string("A") })
        #expect(savedA["data"]?["spec"]?.object?["sceneNo"] == nil)
        #expect(savedA["data"]?["meta"]?.object?["episodeNo"] == nil)
        #expect(numberingInvariant(saved) == numberingInvariant(before))
        _ = try await mounted.state.request("app.open", args: ["id": .string(id)])
        try await wait { mounted.state.route == "editor" }
        _ = try await mounted.state.request("editor.select", args: ["projectId": .string(id), "id": .string("A")])
        try await waitForNumbering(mounted.state, scene: nil, episode: nil)
        try await assertNumberField(controls, label: "场次", value: "")
        #expect(mounted.state.error == nil)
        await fixture.services.close()
    }

    /// Sequential clears have separate inverse keys and restore exact empty/value combinations.
    private func exerciseNumberHistory(_ controls: NSWindow, state: NativeApplicationState, id: String) async throws {
        try await pressNumberButton(controls, named: "清除场次")
        try await waitForNumbering(state, scene: nil, episode: 2)
        try await pressNumberButton(controls, named: "清除集号")
        try await waitForNumbering(state, scene: nil, episode: nil)
        _ = try await state.request("editor.undo", args: ["projectId": .string(id)])
        try await waitForNumbering(state, scene: nil, episode: 2)
        _ = try await state.request("editor.undo", args: ["projectId": .string(id)])
        try await waitForNumbering(state, scene: 7, episode: 2)
        _ = try await state.request("editor.redo", args: ["projectId": .string(id)])
        try await waitForNumbering(state, scene: nil, episode: 2)
        _ = try await state.request("editor.redo", args: ["projectId": .string(id)])
        try await waitForNumbering(state, scene: nil, episode: nil)
    }

    /// Read the actual production serializer, independently of native field projections.
    private func numberingDocument(_ state: NativeApplicationState, id: String) async throws -> HostJSON {
        let result = try await state.request("editor.exportPreview", args: ["projectId": .string(id), "format": .string("json")])
        return try HostJSON.decode(Data(try #require(result["text"]?.string).utf8))
    }

    /// Remove only A's two target fields so whole-graph equality catches changes to content, edges or other nodes.
    private func numberingInvariant(_ document: HostJSON) -> HostJSON {
        let nodes = (document["graph"]?["nodes"]?.arrayValue ?? []).map { node -> HostJSON in
            guard node["id"] == .string("A"), var object = node.object, var data = node["data"]?.object,
                  var spec = data["spec"]?.object, var meta = data["meta"]?.object else { return node }
            spec.removeValue(forKey: "sceneNo"); meta.removeValue(forKey: "episodeNo")
            data["spec"] = .object(spec); data["meta"] = .object(meta); object["data"] = .object(data)
            return .object(object)
        }
        return .object(["nodes": .array(nodes), "edges": document["graph"]?["edges"] ?? .null])
    }

    /// Await authoritative projections rather than timing a mocked callback or assuming the control action completed.
    private func waitForNumbering(_ state: NativeApplicationState, scene: Double?, episode: Double?, sourceLocation: SourceLocation = #_sourceLocation) async throws {
        try await wait(sourceLocation: sourceLocation) { state.selectedNodeID == "A" && state.editor["selected"]?["data"]?["sceneNo"]?.number == scene
            && state.editor["selected"]?["data"]?["episodeNo"]?.number == episode }
    }

    /// Public accessibility reads prove that the actual native input agrees with the document after focus/history changes.
    private func assertNumberField(_ controls: NSWindow, label: String, value: String) async throws {
        let field = try await NativeCreationControlFixture.element(in: controls, named: label, roles: ["AXTextField"])
        #expect(NativeCreationControlFixture.string(field, "AXValue") == value)
    }

    /// Public AX activation exercises the actual production inspector in the existing shell window.
    private func pressNumberButton(_ window: NSWindow, named name: String) async throws {
        let button = try await NativeCreationControlFixture.button(in: window, named: name)
        #expect(try NativeCreationControlFixture.isEnabled(button))
        try NativeCreationControlFixture.press(button)
    }

    /// Actual native editing follows AppKit's public text delegate and the field's exposed semantic label.
    private func enterSceneNumber(_ window: NSWindow, text: String) async throws {
        func fields(_ view: NSView?) -> [NSTextField] {
            guard let view else { return [] }
            return (view as? NSTextField).map { [$0] } ?? view.subviews.flatMap { fields($0) }
        }
        let field = try #require(fields(window.contentView).first {
            $0.isEditable && !$0.isHiddenOrHasHiddenAncestor && !$0.visibleRect.isEmpty && $0.accessibilityLabel() == "场次"
        })
        window.makeKeyAndOrderFront(nil)
        window.makeFirstResponder(field)
        field.stringValue = text
        field.delegate?.controlTextDidChange?(Notification(name: NSControl.textDidChangeNotification, object: field))
    }

    /// Synthetic project screenshots document the two numbered-field states without using private user data.
    private func numberPreview(_ window: NSWindow, name: String) throws {
        let view = try #require(window.contentView)
        let bitmap = try #require(view.bitmapImageRepForCachingDisplay(in: view.bounds))
        view.cacheDisplay(in: view.bounds, to: bitmap)
        let png = try #require(bitmap.representation(using: .png, properties: [:]))
        Attachment.record(png, named: name + ".png")
        let output = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("build/scene-number-previews", isDirectory: true)
        try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
        try png.write(to: output.appendingPathComponent(name + ".png"))
    }

    /// Save completion is observed on disk before navigating; a route projection alone is not a storage receipt.
    private func waitForNumberDisk(_ store: NativeProjectStore, id: String) async throws {
        let deadline = ContinuousClock.now.advanced(by: .seconds(8))
        while ContinuousClock.now < deadline {
            let document = try await store.invoke(command: "load_project", args: ["id": .string(id)])
            let node = document["graph"]?["nodes"]?.arrayValue?.first { $0["id"] == .string("A") }
            if node?["data"]?["spec"]?.object?["sceneNo"] == nil && node?["data"]?["meta"]?.object?["episodeNo"] == nil { return }
            try await Task.sleep(for: .milliseconds(40))
        }
        Issue.record("清除后的场次与集号未保存到磁盘")
    }

    /// Dynamic ports, deleted nodes and empty graphs survive permanent page disposal and actual same-view reload.
    @Test(arguments: [false, true])
    func pageDisposalAfterDynamicPortsReloadsSavedProject(retainNode: Bool) async throws {
        let fixture = Fixture()
        defer { fixture.remove() }
        let projects = try #require(fixture.services.projectStore)
        let metadata = try await projects.invoke(command: "create_project", args: ["name": .string("页面卸载回归")])
        let id = try #require(metadata["id"]?.string)
        let mounted = fixture.mount()
        try await wait { mounted.state.route == "home" && mounted.state.app["loading"] == .bool(false) }
        let webView = try #require(findWebView(mounted.window.contentView))
        try await waitForHostReady(webView)
        _ = try await mounted.state.request("app.open", args: ["id": .string(id)])
        try await wait { mounted.state.route == "editor" }
        try await exerciseDynamicPorts(mounted.state, webView: webView, projectId: id)
        if retainNode {
            _ = try await mounted.state.request("editor.create", args: ["projectId": .string(id), "nodeType": .string("branch")])
            try await wait { mounted.state.editor["nodes"]?.arrayValue?.count == 1 }
            try await waitForPortCount(webView, count: 3)
        }
        // The ordinary home transition flushes actual storage before the destructive navigation under test.
        _ = try await mounted.state.request("app.home")
        try await wait { mounted.state.route == "home" }
        _ = try await mounted.state.request("app.open", args: ["id": .string(id)])
        try await wait { mounted.state.route == "editor" }
        try await waitForPortCount(webView, count: retainNode ? 3 : 0)
        #expect(try await webView.evaluateJavaScript("document.getElementById('root').childElementCount > 0") as? Bool == true)
        _ = try await webView.evaluateJavaScript("window.dispatchEvent(new PageTransitionEvent('pagehide', {persisted:false})); null")
        #expect(try await webView.evaluateJavaScript("document.getElementById('root').childElementCount") as? Int == 0)
        try await waitForPortCount(webView, count: 0)
        let coordinator = try #require(webView.navigationDelegate as? WebCanvasCoordinator)
        let oldSession = coordinator.sessionId
        coordinator.loadCanvas(into: webView)
        try await wait { coordinator.sessionId != oldSession && !webView.isLoading }
        try await waitForHostReady(webView)
        try await wait { mounted.state.route == "home" && mounted.state.app["loading"] == .bool(false) }
        #expect(findWebView(mounted.window.contentView) === webView)
        _ = try await mounted.state.request("app.open", args: ["id": .string(id)])
        try await wait { mounted.state.route == "editor" && mounted.state.editor["nodes"]?.arrayValue?.count == (retainNode ? 1 : 0) }
        try await waitForPortCount(webView, count: retainNode ? 3 : 0)
        let saved = try await projects.invoke(command: "load_project", args: ["id": .string(id)])
        #expect(saved["graph"]?["nodes"]?.arrayValue?.count == (retainNode ? 1 : 0))
        await fixture.services.close()
    }

    /// Outline insertion replaces the real canvas seam and survives undo/redo, disk save and reopening (#879).
    @Test func outlineInsertionPersistsExactTopology() async throws {
        let fixture = Fixture()
        defer { fixture.remove() }
        let projects = try #require(fixture.services.projectStore)
        let created = try await projects.invoke(command: "create_project", args: ["name": .string("大纲接缝回归")])
        let id = try #require(created["id"]?.string)
        var doc = try #require(try await projects.invoke(command: "load_project", args: ["id": .string(id)]).object)
        doc["graph"] = outlineGraph()
        _ = try await projects.invoke(command: "save_project", args: ["id": .string(id), "doc": .object(doc), "expectExisting": .bool(true)])
        let mounted = fixture.mount()
        try await wait { mounted.state.route == "home" && mounted.state.app["loading"] == .bool(false) }
        let webView = try #require(findWebView(mounted.window.contentView))
        try await waitForHostReady(webView)
        _ = try await mounted.state.request("app.open", args: ["id": .string(id)])
        try await wait { mounted.state.route == "editor" && mounted.state.editor["nodes"]?.arrayValue?.count == 5 }
        _ = try await mounted.state.request("editor.outlineMove", args: [
            "projectId": .string(id), "id": .string("X"),
            "target": .object(["kind": .string("row"), "anchorId": .string("B"), "position": .string("after")])
        ])
        let inserted = ["A->B", "B->X", "C->D", "X->C"]
        #expect(try await outlinePairs(mounted.state, id: id) == inserted)
        #expect(try await webView.evaluateJavaScript("document.querySelectorAll('.react-flow__edge').length") as? Int == 4)
        _ = try await mounted.state.request("editor.undo", args: ["projectId": .string(id)])
        #expect(try await outlinePairs(mounted.state, id: id) == ["A->B", "B->C", "C->D"])
        _ = try await mounted.state.request("editor.redo", args: ["projectId": .string(id)])
        #expect(try await outlinePairs(mounted.state, id: id) == inserted)
        try await waitForOutlineDisk(projects, id: id, expected: inserted)
        _ = try await mounted.state.request("app.home")
        try await wait { mounted.state.route == "home" }
        let saved = try await projects.invoke(command: "load_project", args: ["id": .string(id)])
        #expect(edgePairs(saved) == inserted)
        _ = try await mounted.state.request("app.open", args: ["id": .string(id)])
        try await wait { mounted.state.route == "editor" }
        #expect(try await outlinePairs(mounted.state, id: id) == inserted)
        await fixture.services.close()
    }

    /// Route changes do not acknowledge the asynchronous save; observe the actual debounce completion on disk.
    private func waitForOutlineDisk(_ projects: NativeProjectStore, id: String, expected: [String]) async throws {
        let deadline = ContinuousClock.now.advanced(by: .seconds(12))
        while ContinuousClock.now < deadline {
            let saved = try await projects.invoke(command: "load_project", args: ["id": .string(id)])
            if edgePairs(saved) == expected { return }
            try await Task.sleep(for: .milliseconds(40))
        }
        Issue.record("大纲重排未将完整边集保存到真实项目文件")
    }

    /// Seed only valid current-schema scenes and sequence edges into the fixture's private storage.
    private func outlineGraph() -> HostJSON {
        let nodes: [HostJSON] = ["A", "B", "C", "D", "X"].enumerated().map { index, id in
            .object(["id": .string(id), "type": .string("scene"),
                     "layout": .object(["position": .object(["x": .number(Double(index * 200)), "y": .number(0)])]),
                     "ui": .object(["selected": .bool(false), "expanded": .bool(true)]),
                     "data": .object(["meta": .object(["label": .string(id), "episodeNo": .number(1)]),
                                      "spec": .object(["sceneNo": .number(Double(index + 1)), "interior": .bool(true),
                                                       "time": .string("夜"), "synopsis": .string("回归"), "characterIds": .array([])])])])
        }
        let edges: [HostJSON] = [("A", "B"), ("B", "C"), ("C", "D")].map { source, target in
            .object(["id": .string(source + target), "source": .string(source), "target": .string(target), "data": .object(["kind": .string("sequence")])])
        }
        return .object(["nodes": .array(nodes), "edges": .array(edges)])
    }

    /// Read the real production serializer after the native intent has completed its React update.
    private func outlinePairs(_ state: NativeApplicationState, id: String) async throws -> [String] {
        let result = try await state.request("editor.exportPreview", args: ["projectId": .string(id), "format": .string("json")])
        let text = try #require(result["text"]?.string)
        return edgePairs(try JSONDecoder().decode(HostJSON.self, from: Data(text.utf8)))
    }

    /// Exact complete edge sets detect a bypass even when every newly added edge is correct.
    private func edgePairs(_ document: HostJSON) -> [String] {
        (document["graph"]?["edges"]?.arrayValue ?? []).map {
            ($0["source"]?.string ?? "?") + "->" + ($0["target"]?.string ?? "?")
        }.sorted()
    }

    /// Native production intents change the real React Flow port DOM before deleting its owning branch.
    private func exerciseDynamicPorts(_ state: NativeApplicationState, webView: WKWebView, projectId: String) async throws {
        _ = try await state.request("editor.create", args: ["projectId": .string(projectId), "nodeType": .string("branch")])
        try await wait { state.editor["nodes"]?.arrayValue?.count == 1 }
        let node = try #require(state.editor["nodes"]?.arrayValue?.first?["id"]?.string)
        try await waitForPortCount(webView, count: 3)
        _ = try await state.request("editor.insertListItem", args: ["projectId": .string(projectId), "id": .string(node), "field": .string("options")])
        try await waitForPortCount(webView, count: 4)
        _ = try await state.request("editor.select", args: ["projectId": .string(projectId), "id": .string(node)])
        try await wait { state.editor["selected"]?["id"]?.string == node }
        let option = try #require(state.editor["selected"]?["data"]?["options"]?.arrayValue?.first?["id"]?.string)
        _ = try await state.request("editor.deleteListItem", args: ["projectId": .string(projectId), "id": .string(node), "field": .string("options"), "itemId": .string(option)])
        try await waitForPortCount(webView, count: 3)
        _ = try await state.request("editor.delete", args: ["projectId": .string(projectId), "id": .string(node)])
        try await wait { state.editor["nodes"]?.arrayValue?.isEmpty == true }
        try await waitForPortCount(webView, count: 0)
    }

    /// Observe actual public handle DOM; no React or native projection mock can satisfy this check.
    private func waitForPortCount(_ webView: WKWebView, count: Int) async throws {
        let deadline = ContinuousClock.now.advanced(by: .seconds(12))
        while ContinuousClock.now < deadline {
            if try await webView.evaluateJavaScript("document.querySelectorAll('.react-flow__handle').length") as? Int == count { return }
            try await Task.sleep(for: .milliseconds(30))
        }
        throw HostFailure(code: "PW_FIXTURE_PORT_TIMEOUT", message: "真实分支端口数量未达到预期 \(count)")
    }

    /// Real canvas editing survives debounce, the quit fixed point and a second page opening the saved project.
    @Test func nativeProjectEditFlushAndReloadUsesActualIndependentStorage() async throws {
        let fixture = Fixture()
        defer { fixture.remove() }
        let projects = try #require(fixture.services.projectStore)
        let metadata = try await projects.invoke(command: "create_project", args: ["name": .string("原生真实业务")])
        let id = try #require(metadata["id"]?.string)
        let first = fixture.mount()
        try await wait { first.state.route == "home" && first.state.app["loading"] == .bool(false) }
        let webView = try #require(findWebView(first.window.contentView))
        try await waitForHostReady(webView)
        let identity = ObjectIdentifier(webView)
        _ = try await first.state.request("app.open", args: ["id": .string(id)])
        try await wait { first.state.route == "editor" && first.state.editor["projectId"]?.string == id }
        _ = try await first.state.request("editor.create", args: ["projectId": .string(id), "nodeType": .string("scene")])
        try await wait { first.state.editor["nodes"]?.arrayValue?.count == 1 }
        let node = try #require(first.state.editor["nodes"]?.arrayValue?.first?["id"]?.string)
        let patch: [String: HostJSON] = ["projectId": .string(id), "id": .string(node), "patch": .object(["synopsis": .string("防抖保存稿")])]
        _ = try await first.state.request("editor.patchNode", args: patch)
        try await waitForDisk(projects, id: id, node: node, synopsis: "防抖保存稿")
        #expect(ObjectIdentifier(try #require(findWebView(first.window.contentView))) == identity)
        let latest: [String: HostJSON] = ["projectId": .string(id), "id": .string(node), "patch": .object(["synopsis": .string("退出固定点稿")])]
        _ = try await first.state.request("editor.patchNode", args: latest)
        let approvals = ApprovalLog()
        fixture.quit.onApproved = { intent in
            if intent == .close { approvals.count += 1; first.window.close(); first.window.contentView = nil }
        }
        fixture.quit.request(.close)
        try await wait { approvals.count == 1 }
        let saved = try await projects.invoke(command: "load_project", args: ["id": .string(id)])
        #expect(saved["graph"]?["nodes"]?.arrayValue?.first { $0["id"]?.string == node }?["data"]?["spec"]?["synopsis"]?.string == "退出固定点稿")
        #expect(fixture.quit.pendingIntent == nil)
        let reopened = fixture.mount()
        try await wait { reopened.state.route == "home" && reopened.state.app["loading"] == .bool(false) }
        try await waitForHostReady(try #require(findWebView(reopened.window.contentView)))
        _ = try await reopened.state.request("app.open", args: ["id": .string(id)])
        try await wait { reopened.state.route == "editor" && reopened.state.editor["nodes"]?.arrayValue?.count == 1 }
        let exported = try await reopened.state.request("editor.exportPreview", args: ["projectId": .string(id), "format": .string("json")])
        let document = try JSONDecoder().decode(HostJSON.self, from: Data(try #require(exported["text"]?.string).utf8))
        #expect(document["graph"]?["nodes"]?.arrayValue?.first { $0["id"]?.string == node }?["data"]?["spec"]?["synopsis"]?.string == "退出固定点稿")
        await fixture.services.close()
    }

    /// A real failed project write preserves the editable window and latest draft until an explicit quit retry saves it.
    @Test func failedQuitSaveCanRecoverWithoutDeferredAppKitTermination() async throws {
        let fixture = Fixture()
        defer { fixture.remove() }
        let projects = try #require(fixture.services.projectStore)
        let metadata = try await projects.invoke(command: "create_project", args: ["name": .string("退出恢复")])
        let id = try #require(metadata["id"]?.string)
        let mounted = fixture.mount()
        try await wait { mounted.state.route == "home" && mounted.state.app["loading"] == .bool(false) }
        try await waitForHostReady(try #require(findWebView(mounted.window.contentView)))
        _ = try await mounted.state.request("app.open", args: ["id": .string(id)])
        try await wait { mounted.state.route == "editor" }
        let file = fixture.root.appendingPathComponent("projects/" + id + ".json")
        let backup = fixture.root.appendingPathComponent("projects/" + id + ".saved")
        try FileManager.default.moveItem(at: file, to: backup)
        try FileManager.default.createDirectory(at: file, withIntermediateDirectories: false)
        _ = try await mounted.state.request("editor.create", args: ["projectId": .string(id), "nodeType": .string("scene")])
        try await wait { mounted.state.editor["nodes"]?.arrayValue?.count == 1 }
        let approvals = ApprovalLog()
        var replies: [Bool] = []
        let delegate = NativeApplicationDelegate(quit: fixture.quit, terminateApplication: {}, replyToTermination: { approved in
            replies.append(approved)
            if approved { approvals.count += 1 }
        })
        delegate.applicationDidFinishLaunching(Notification(name: NSApplication.didFinishLaunchingNotification))
        #expect(delegate.applicationShouldTerminate(NSApplication.shared) == .terminateLater)
        // The Web error projection can arrive before its separate cancellation RPC settles AppKit.
        try await wait {
            mounted.state.app["error"]?.string?.contains("已阻止退出") == true
                && fixture.quit.pendingIntent == nil && replies == [false]
        }
        #expect(approvals.count == 0)
        #expect(mounted.window.isVisible)
        #expect(fixture.quit.pendingIntent == nil)
        #expect(replies == [false])
        try FileManager.default.removeItem(at: file)
        try FileManager.default.moveItem(at: backup, to: file)
        #expect(delegate.applicationShouldTerminate(NSApplication.shared) == .terminateLater)
        try await wait { approvals.count == 1 }
        #expect(replies == [false, true])
        #expect(delegate.applicationShouldTerminate(NSApplication.shared) == .terminateNow)
        let saved = try await projects.invoke(command: "load_project", args: ["id": .string(id)])
        #expect(saved["graph"]?["nodes"]?.arrayValue?.count == 1)
        #expect(mounted.state.app["error"] == .null)
        #expect(fixture.quit.pendingIntent == nil)
        await fixture.services.close()
    }

    /// A quit cannot outrun an admitted native mutation, including its asynchronous fingerprint and failed reply.
    @Test(arguments: ["bridge", "fingerprint", "failure"])
    func immediateQuitWaitsForNativeMutation(mode: String) async throws {
        let fixture = Fixture()
        defer { fixture.remove() }
        let projects = try #require(fixture.services.projectStore)
        let metadata = try await projects.invoke(command: "create_project", args: ["name": .string("原生意图退出")])
        let id = try #require(metadata["id"]?.string)
        let mounted = fixture.mount()
        try await wait { mounted.state.route == "home" && mounted.state.app["loading"] == .bool(false) }
        let webView = try #require(findWebView(mounted.window.contentView))
        try await waitForHostReady(webView)
        _ = try await mounted.state.request("app.open", args: ["id": .string(id)])
        try await wait { mounted.state.route == "editor" && mounted.state.projectId == id }
        _ = try await mounted.state.request("editor.create", args: ["projectId": .string(id), "nodeType": .string("scene")])
        try await wait { mounted.state.editor["nodes"]?.arrayValue?.count == 1 }
        let node = try #require(mounted.state.editor["nodes"]?.arrayValue?.first?["id"]?.string)
        try await installIntentGate(webView, mode: mode)
        var replies: [Bool] = []
        let delegate = NativeApplicationDelegate(quit: fixture.quit, terminateApplication: {}, replyToTermination: { replies.append($0) })
        delegate.applicationDidFinishLaunching(Notification(name: NSApplication.didFinishLaunchingNotification))
        mounted.state.sendEditor("editor.patchNode", args: ["id": .string(node), "patch": .object(["synopsis": .string("最后原生字段")])])
        #expect(delegate.applicationShouldTerminate(NSApplication.shared) == .terminateLater)
        try await waitForIntentGate(webView)
        // Observe a blocked future long enough for the old, empty Web save barrier to settle its quit.
        try await Task.sleep(for: .seconds(1))
        #expect(replies.isEmpty, "原生意图尚未落定，系统退出不得提前批准")
        #expect(fixture.quit.pendingIntent == .terminate)
        _ = try await webView.evaluateJavaScript("window.__pwIntentGate.release(); null")
        try await wait { replies == (mode == "failure" ? [false] : [true]) }
        if mode == "failure" {
            try await wait { mounted.state.error?.contains("PW_FIXTURE_INTENT_FAILURE") == true }
            #expect(mounted.window.isVisible)
            #expect(delegate.applicationShouldTerminate(NSApplication.shared) == .terminateLater)
            try await wait { replies == [false, true] }
        } else {
            let doc = try await projects.invoke(command: "load_project", args: ["id": .string(id)])
            #expect(doc["graph"]?["nodes"]?.arrayValue?.first { $0["id"]?.string == node }?["data"]?["spec"]?["synopsis"]?.string == "最后原生字段")
        }
        #expect(fixture.quit.pendingIntent == nil)
        await fixture.services.close()
    }

    /// The real browser delays exactly one synthetic edit either before admission or inside SHA-256 admission.
    private func installIntentGate(_ webView: WKWebView, mode: String) async throws {
        _ = try await webView.callAsyncJavaScript("""
            const original = window.__pwNativeIntent;
            const digest = crypto.subtle.digest.bind(crypto.subtle);
            let release;
            const gate = new Promise(resolve => release = resolve);
            window.__pwIntentGate = {entered: false, release};
            if (mode === 'fingerprint') {
              crypto.subtle.digest = async (...args) => {
                window.__pwIntentGate.entered = true;
                await gate;
                crypto.subtle.digest = digest;
                return digest(...args);
              };
            } else {
              window.__pwNativeIntent = async request => {
                if (request.command === 'editor.patchNode') {
                  window.__pwIntentGate.entered = true;
                  await gate;
                  window.__pwNativeIntent = original;
                  if (mode === 'failure') return {error: {code: 'PW_FIXTURE_INTENT_FAILURE', message: 'PW_FIXTURE_INTENT_FAILURE'}};
                }
                return original(request);
              };
            }
            return null;
            """, arguments: ["mode": mode], in: nil, contentWorld: .page)
    }

    /// Web keyboard mutations are saved before quitting; final approval cannot accept another undo.
    @Test(arguments: [false, true])
    func webFinalApprovalSealsCleanAndDrainedDocuments(dirty: Bool) async throws {
        let fixture = Fixture()
        defer { fixture.remove() }
        let projects = try #require(fixture.services.projectStore)
        let metadata = try await projects.invoke(command: "create_project", args: ["name": .string("Web 最终退出")])
        let id = try #require(metadata["id"]?.string)
        let mounted = fixture.mount()
        try await wait { mounted.state.route == "home" && mounted.state.app["loading"] == .bool(false) }
        let webView = try #require(findWebView(mounted.window.contentView))
        try await waitForHostReady(webView)
        _ = try await mounted.state.request("app.open", args: ["id": .string(id)])
        try await wait { mounted.state.route == "editor" }
        _ = try await mounted.state.request("editor.create", args: ["projectId": .string(id), "nodeType": .string("scene")])
        try await wait { mounted.state.editor["nodes"]?.arrayValue?.count == 1 }
        let node = try #require(mounted.state.editor["nodes"]?.arrayValue?.first?["id"]?.string)
        _ = try await mounted.state.request("editor.select", args: ["projectId": .string(id), "id": .string(node)])
        _ = try await mounted.state.request("editor.patchNode", args: ["projectId": .string(id), "id": .string(node), "patch": .object(["synopsis": .string("Web 基线稿")])])
        try await waitForDisk(projects, id: id, node: node, synopsis: "Web 基线稿")
        if dirty {
            // This genuine document keyboard event uses Web's command history, not a native intent.
            _ = try await webView.evaluateJavaScript("document.body.dispatchEvent(new KeyboardEvent('keydown', {key:'Delete', bubbles:true, cancelable:true})); null")
            try await wait { mounted.state.editor["nodes"]?.arrayValue?.count == 0 }
        }
        let gate = try installExitGate(webView)
        var approvals = 0
        fixture.quit.onApproved = { _ in approvals += 1 }
        fixture.quit.request(.close)
        try await wait { gate.entered }
        #expect(approvals == 0)
        #expect(try await webView.evaluateJavaScript("document.getElementById('root').inert") as? Bool == true)
        #expect(try await webView.evaluateJavaScript("document.body.dispatchEvent(new KeyboardEvent('keydown', {key:'z', ctrlKey:true, bubbles:true, cancelable:true}))") as? Bool == false)
        #expect(mounted.state.editor["nodes"]?.arrayValue?.count == (dirty ? 0 : 1))
        gate.release?()
        try await wait { approvals == 1 }
        let saved = try await projects.invoke(command: "load_project", args: ["id": .string(id)])
        #expect(saved["graph"]?["nodes"]?.arrayValue?.count == (dirty ? 0 : 1))
        #expect(fixture.quit.pendingIntent == nil)
        await fixture.services.close()
    }

    /// Holds only the final Web→Swift exit RPC, after the real Web fixed point has finished.
    private func installExitGate(_ webView: WKWebView) throws -> ExitMessageGate {
        let coordinator = try #require(webView.navigationDelegate as? WebCanvasCoordinator)
        let gate = ExitMessageGate(coordinator: coordinator)
        let controller = webView.configuration.userContentController
        controller.removeScriptMessageHandler(forName: "plotweaveHost", contentWorld: .page)
        controller.addScriptMessageHandler(gate, contentWorld: .page, name: "plotweaveHost")
        return gate
    }

    /// Delegates actual trusted WK messages unchanged; only final approval waits at a deterministic gate.
    @MainActor private final class ExitMessageGate: NSObject, WKScriptMessageHandlerWithReply {
        let coordinator: WebCanvasCoordinator
        var entered = false
        var release: (() -> Void)?
        /// Retains the real page coordinator through the held reply.
        init(coordinator: WebCanvasCoordinator) { self.coordinator = coordinator }
        /// Pauses approval before service dispatch, then forwards the same message and completion.
        func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage, replyHandler: @escaping @MainActor @Sendable (Any?, String?) -> Void) {
            let body = message.body as? [String: Any]
            let args = body?["args"] as? [String: Any]
            let forward = { self.coordinator.userContentController(controller, didReceive: message, replyHandler: replyHandler) }
            if body?["command"] as? String == "app_exit", args?["cancel"] as? Bool != true {
                entered = true
                release = { self.release = nil; forward() }
            } else { forward() }
        }
    }

    /// Gate admission is observed in the actual production page, never inferred from a submitted call.
    private func waitForIntentGate(_ webView: WKWebView) async throws {
        let deadline = ContinuousClock.now.advanced(by: .seconds(8))
        while ContinuousClock.now < deadline {
            if try await webView.evaluateJavaScript("window.__pwIntentGate.entered") as? Bool == true { return }
            try await Task.sleep(for: .milliseconds(30))
        }
        throw HostFailure(code: "PW_FIXTURE_GATE_TIMEOUT", message: "原生意图未进入确定性闸门")
    }

    /// Bounded polling observes actual state transitions and reports a useful last-state failure.
    private func wait(sourceLocation: SourceLocation = #_sourceLocation, _ predicate: () -> Bool) async throws {
        let deadline = ContinuousClock.now.advanced(by: .seconds(12))
        while !predicate() && ContinuousClock.now < deadline { try await Task.sleep(for: .milliseconds(30)) }
        try #require(predicate(), "生产原生页面未在期限内完成业务状态转换", sourceLocation: sourceLocation)
    }

    /// Probes the real native ready guard without admitting a business intent.
    /// The version-rejection contract in src/platform/nativeShell.ts receiveIntent returns
    /// PW_INVALID_NATIVE_INTENT before handler lookup, replay caching or business execution.
    private func waitForHostReady(_ webView: WKWebView) async throws {
        let coordinator = try #require(webView.navigationDelegate as? WebCanvasCoordinator)
        let deadline = ContinuousClock.now.advanced(by: .seconds(12))
        while ContinuousClock.now < deadline {
            do {
                let response = try await coordinator.sendNativeIntent(request: [
                    "protocolVersion": 0, "sessionId": coordinator.sessionId,
                    "requestId": "readiness-probe", "command": "readiness.probe", "args": [:]
                ])
                let reply = try HostJSON(webValue: response)
                try #require(reply["error"]?["code"]?.string == "PW_INVALID_NATIVE_INTENT")
                return
            } catch let error as HostFailure where error.code == "PW_CANVAS_NOT_READY" {
                try await Task.sleep(for: .milliseconds(30))
            }
        }
        throw HostFailure(code: "PW_CANVAS_NOT_READY", message: "生产测试未在期限内观察到宿主就绪；" + readinessDiagnostics(webView))
    }

    /// Reports only fixture visibility and geometry when a real handshake times out.
    private func readinessDiagnostics(_ webView: WKWebView) -> String {
        guard let window = webView.window else { return "WKView 未附加窗口" }
        return "visible=\(window.isVisible), key=\(window.isKeyWindow), canKey=\(window.canBecomeKey), "
            + "active=\(NSApp.isActive), running=\(NSApp.isRunning), policy=\(NSApp.activationPolicy().rawValue), "
            + "occluded=\(!window.occlusionState.contains(.visible)), activeSpace=\(window.isOnActiveSpace), "
            + "frame=\(window.frame), screen=\(String(describing: window.screen?.frame)), layout=\(window.contentLayoutRect), "
            + "webFrame=\(webView.frame), webBounds=\(webView.bounds), visibleRect=\(webView.visibleRect), "
            + "hidden=\(webView.isHidden), alpha=\(webView.alphaValue)"
    }

    /// Actor reads verify persisted document bytes rather than a projection or mock save call.
    private func waitForDisk(_ projects: NativeProjectStore, id: String, node: String, synopsis: String) async throws {
        let deadline = ContinuousClock.now.advanced(by: .seconds(8))
        while ContinuousClock.now < deadline {
            let doc = try await projects.invoke(command: "load_project", args: ["id": .string(id)])
            if doc["graph"]?["nodes"]?.arrayValue?.first { $0["id"]?.string == node }?["data"]?["spec"]?["synopsis"]?.string == synopsis { return }
            try await Task.sleep(for: .milliseconds(40))
        }
        Issue.record("真实项目文件未保存原生编辑稿")
    }

    /// Finds the persistent canvas underneath the real SwiftUI composition without rebuilding it.
    private func findWebView(_ view: NSView?) -> WKWebView? {
        guard let view else { return nil }
        if let webView = view as? WKWebView { return webView }
        for child in view.subviews { if let result = findWebView(child) { return result } }
        return nil
    }

    /// A synchronous approval counter records the host's actual app_exit outcome.
    private final class ApprovalLog { var count = 0 }

    /// Every service/window belongs to this unique temporary root; default app-support paths are never selected.
    @MainActor private final class Fixture {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("pw-native-production-" + UUID().uuidString)
        let quit = HostQuitController()
        let services: NativeHostServices
        private var windows: [NSWindow] = []

        /// Actor construction remains lazy until the fixture's explicit project request.
        init() { services = NativeHostServices(dataRoot: root, quit: quit) }

        /// Presents one actual native shell so WebKit can run the production frame-driven handshake.
        func mount() -> (window: NSWindow, state: NativeApplicationState) {
            let state = NativeApplicationState()
            let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1100, height: 750), styleMask: [.titled], backing: .buffered, defer: false)
            window.isReleasedWhenClosed = false
            // Keep this disposable integration window visible above the foreground test client.
            window.level = .floating
            window.contentView = NSHostingView(rootView: NativeShellRoot(services: services, application: state))
            windows.append(window)
            window.contentView?.layoutSubtreeIfNeeded()
            // A nonactive app-hosted process still needs visible WebKit animation frames.
            window.orderFrontRegardless()
            return (window, state)
        }

        /// The actual native AI pane consumes the production page's projection without another session owner.
        func mountAi(state: NativeApplicationState, projectId: String) -> NSWindow {
            let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 420, height: 700), styleMask: [.titled], backing: .buffered, defer: false)
            window.isReleasedWhenClosed = false
            window.level = .floating
            window.contentView = NSHostingView(rootView: NativeAiView(state: state, projectId: projectId))
            windows.append(window)
            window.orderFrontRegardless()
            return window
        }

        /// Teardown invalidates Web owners before removing only this fixture's disposable data.
        func remove() {
            for window in windows { window.close(); window.contentView = nil }
            try? FileManager.default.removeItem(at: root)
        }
    }
}
