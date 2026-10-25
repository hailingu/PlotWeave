import AppKit
import ApplicationServices
import Foundation
import SwiftUI
import Testing
import WebKit
@testable import PlotWeaveNative

/// Accepted direct native export deliveries must settle before quit delivery and final approval (issue #804).
@MainActor
@Suite(.serialized, WebKitTestIsolation())
struct NativeSystemQuitEligibilityTests {
    /// A delivery held at the undecided save panel holds quit delivery, refuses final approval,
    /// then delivers and approves exactly once after the awaited atomic write settles.
    @Test func quitWaitsForPanelPendingDeliveryThenApprovesOnce() async throws {
        let gate = DestinationGate()
        let root = Fixture.makeRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        let target = Fixture.exportTarget(root)
        let fixture = try Fixture(root: root, saveDestination: { _ in await gate.select() })
        defer { fixture.close() }
        try await fixture.waitUntilSaveReady()
        try await fixture.pressSave()
        try await fixture.waitUntil { fixture.services.systemQuitWork.hasPendingDeliveries && gate.isWaiting }
        fixture.quit.acknowledgeListener()
        fixture.quit.request(.terminate)
        // A delivered event would reach the page within milliseconds; only the delivery drain can hold it.
        try await Task.sleep(for: .milliseconds(200))
        #expect(try await fixture.quitEvents() == 0, "面板待决的导出交付在途时退出事件不得投递")
        #expect(fixture.quit.pendingIntent == .terminate)
        do {
            _ = try await fixture.attemptExit(requestId: "panel-pending")
            Issue.record("面板待决的导出交付在途时最终批准不得放行")
        } catch let failure as HostFailure { #expect(failure.code == "PW_NATIVE_SYSTEM_PENDING") }
        #expect(fixture.approvals.isEmpty)
        gate.release(target)
        try await fixture.waitUntil { !fixture.services.systemQuitWork.hasPendingDeliveries }
        try await fixture.waitUntil { try await fixture.quitEvents() == 1 }
        _ = try await fixture.attemptExit(requestId: "settled")
        #expect(fixture.approvals == [.terminate] && fixture.quit.pendingIntent == nil)
        #expect(try String(contentsOf: target, encoding: .utf8) == Fixture.exportText)
    }

    /// A delivery held inside the export write keeps quit blocked until the write actually settles.
    @Test func quitWaitsForInFlightWriteThenApprovesOnce() async throws {
        let gate = WriteGate()
        let root = Fixture.makeRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        let target = Fixture.exportTarget(root)
        let fixture = try Fixture(
            root: root,
            saveDestination: { _ in target },
            saveWrite: { bytes, url in await gate.hold(); try bytes.write(to: url, options: .atomic) }
        )
        defer { fixture.close() }
        try await fixture.waitUntilSaveReady()
        try await fixture.pressSave()
        try await fixture.waitUntil { fixture.services.systemQuitWork.hasPendingDeliveries && gate.isHeld }
        fixture.quit.acknowledgeListener()
        fixture.quit.request(.terminate)
        try await Task.sleep(for: .milliseconds(200))
        #expect(try await fixture.quitEvents() == 0, "写入中的导出交付在途时退出事件不得投递")
        do {
            _ = try await fixture.attemptExit(requestId: "writing")
            Issue.record("写入中的导出交付在途时最终批准不得放行")
        } catch let failure as HostFailure { #expect(failure.code == "PW_NATIVE_SYSTEM_PENDING") }
        #expect(fixture.approvals.isEmpty && fixture.quit.pendingIntent == .terminate)
        gate.release()
        try await fixture.waitUntil { !fixture.services.systemQuitWork.hasPendingDeliveries }
        try await fixture.waitUntil { try await fixture.quitEvents() == 1 }
        _ = try await fixture.attemptExit(requestId: "written")
        #expect(fixture.approvals == [.terminate] && fixture.quit.pendingIntent == nil)
        #expect(try String(contentsOf: target, encoding: .utf8) == Fixture.exportText)
    }

    /// User cancellation settles the delivery without creating a file, and approval follows settlement.
    @Test func cancelledDeliverySettlesWithoutFileAndApproves() async throws {
        let gate = DestinationGate()
        let root = Fixture.makeRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        let fixture = try Fixture(root: root, saveDestination: { _ in await gate.select() })
        defer { fixture.close() }
        try await fixture.waitUntilSaveReady()
        try await fixture.pressSave()
        try await fixture.waitUntil { fixture.services.systemQuitWork.hasPendingDeliveries && gate.isWaiting }
        fixture.quit.acknowledgeListener()
        fixture.quit.request(.terminate)
        do {
            _ = try await fixture.attemptExit(requestId: "cancelling")
            Issue.record("取消决定尚未落定时最终批准不得放行")
        } catch let failure as HostFailure { #expect(failure.code == "PW_NATIVE_SYSTEM_PENDING") }
        gate.release(nil)
        try await fixture.waitUntil { !fixture.services.systemQuitWork.hasPendingDeliveries }
        try await fixture.waitUntil { try await fixture.quitEvents() == 1 }
        _ = try await fixture.attemptExit(requestId: "cancelled")
        #expect(fixture.approvals == [.terminate])
        #expect(!FileManager.default.fileExists(atPath: Fixture.exportTarget(root).path))
    }

    /// A failed write settles as a visible error; approval follows settlement without a fake success file.
    @Test func failedWriteSettlesAndApprovalFollowsWithoutFile() async throws {
        let gate = WriteGate()
        let root = Fixture.makeRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        let target = Fixture.exportTarget(root)
        let fixture = try Fixture(
            root: root,
            saveDestination: { _ in target },
            saveWrite: { _, _ in await gate.hold(); throw CocoaError(.fileWriteUnknown) }
        )
        defer { fixture.close() }
        try await fixture.waitUntilSaveReady()
        try await fixture.pressSave()
        try await fixture.waitUntil { fixture.services.systemQuitWork.hasPendingDeliveries && gate.isHeld }
        fixture.quit.acknowledgeListener()
        fixture.quit.request(.terminate)
        do {
            _ = try await fixture.attemptExit(requestId: "failing")
            Issue.record("写入失败尚未落定时最终批准不得放行")
        } catch let failure as HostFailure { #expect(failure.code == "PW_NATIVE_SYSTEM_PENDING") }
        gate.release()
        try await fixture.waitUntil { !fixture.services.systemQuitWork.hasPendingDeliveries }
        try await fixture.waitUntil { try await fixture.quitEvents() == 1 }
        _ = try await fixture.attemptExit(requestId: "failed")
        #expect(fixture.approvals == [.terminate])
        #expect(!FileManager.default.fileExists(atPath: target.path))
    }

    /// An unheld successful delivery leaves no residue in the quit set and approves immediately.
    @Test func settledSuccessfulDeliveryDoesNotGateLaterQuit() async throws {
        let root = Fixture.makeRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        let target = Fixture.exportTarget(root)
        let fixture = try Fixture(root: root, saveDestination: { _ in target })
        defer { fixture.close() }
        try await fixture.waitUntilSaveReady()
        try await fixture.pressSave()
        try await fixture.waitUntil { !fixture.services.systemQuitWork.hasPendingDeliveries }
        #expect(try String(contentsOf: target, encoding: .utf8) == Fixture.exportText)
        fixture.quit.acknowledgeListener()
        fixture.quit.request(.terminate)
        try await fixture.waitUntil { try await fixture.quitEvents() == 1 }
        _ = try await fixture.attemptExit(requestId: "after-success")
        #expect(fixture.approvals == [.terminate] && fixture.quit.pendingIntent == nil)
    }

    /// A cancelled or replaced quit delivery abandons its export wait promptly instead of staying suspended.
    @Test func cancelledDeliveryReleasesQuitWaitPromptly() async throws {
        let gate = DestinationGate()
        let root = Fixture.makeRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        let fixture = try Fixture(root: root, saveDestination: { _ in await gate.select() })
        defer { fixture.close() }
        try await fixture.waitUntilSaveReady()
        try await fixture.pressSave()
        try await fixture.waitUntil { fixture.services.systemQuitWork.hasPendingDeliveries && gate.isWaiting }
        let installed = fixture.quit.sendEvent
        let released = ReleaseFlag()
        fixture.quit.sendEvent = { name, payload in
            defer { released.set() }
            try await installed?(name, payload)
        }
        fixture.quit.acknowledgeListener()
        fixture.quit.request(.terminate)
        // The current delivery is legitimately held by the accepted export delivery.
        try await Task.sleep(for: .milliseconds(100))
        #expect(!released.value)
        fixture.quit.cancel()
        // The obsolete delivery must unwind while the export delivery is still held, without cancelling it.
        try await fixture.waitUntil { released.value }
        #expect(fixture.services.systemQuitWork.hasPendingDeliveries)
        #expect(try await fixture.quitEvents() == 0)
        gate.release(nil)
        try await fixture.waitUntil { !fixture.services.systemQuitWork.hasPendingDeliveries }
    }

    /// One-shot flag observable across the wrapped production delivery closure.
    @MainActor
    private final class ReleaseFlag {
        private(set) var value = false
        func set() { value = true }
    }

    /// Holds one undecided save destination; the accepted delivery suspends until the test releases it.
    @MainActor
    private final class DestinationGate {
        private var continuation: CheckedContinuation<URL?, Never>?
        private var decisionMade = false
        private var decision: URL?
        var isWaiting: Bool { continuation != nil }

        /// Suspends the system service's destination selection at a deterministic entry gate.
        func select() async -> URL? {
            if decisionMade { return decision }
            return await withCheckedContinuation { continuation = $0 }
        }

        /// Resumes the held selection exactly once; a release ahead of the wait returns immediately.
        func release(_ url: URL?) {
            decisionMade = true
            decision = url
            continuation?.resume(returning: url)
            continuation = nil
        }
    }

    /// Holds the delivery inside the injected export write boundary, before its bytes land or fail.
    @MainActor
    private final class WriteGate {
        private var continuation: CheckedContinuation<Void, Never>?
        private var released = false
        var isHeld: Bool { continuation != nil }

        /// Suspends the injected write until released; the production atomic write has no such hold.
        func hold() async {
            if !released { await withCheckedContinuation { continuation = $0 } }
        }

        /// Resumes one held write exactly once; later holds pass straight through.
        func release() {
            released = true
            continuation?.resume()
            continuation = nil
        }
    }

    /// A real WebKit page, the real export view and the real service quit wiring observe delivery ordering.
    @MainActor
    private final class Fixture {
        static let exportText = "第一幕\n林舟：你好。"
        static let projectName = "pw-system-quit-export"
        let root: URL
        let webView: WKWebView
        let coordinator: WebCanvasCoordinator
        let services: NativeHostServices
        let window: NSWindow
        var quit: HostQuitController { services.quit }
        private let state = NativeApplicationState()
        private let pageState = WebCanvasState()
        private(set) var approvals: [HostQuitController.Intent] = []

        /// The export view and its page session share the caller's gated system service injections.
        init(
            root: URL,
            saveDestination: @escaping NativeHostServices.SaveDestination,
            saveWrite: NativeHostServices.SaveWrite? = nil
        ) throws {
            self.root = root
            services = NativeHostServices(
                dataRoot: nil, quit: HostQuitController(), saveDestination: saveDestination, saveWrite: saveWrite
            )
            try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
            try Self.makePage(at: root.appendingPathComponent("page.html"))
            let configuration = WKWebViewConfiguration()
            webView = try IsolatedWebViewFixture.makeWebView(
                frame: NSRect(x: 0, y: 0, width: 300, height: 200), configuration: configuration
            )
            let state = self.state
            let pageState = self.pageState
            coordinator = WebCanvasCoordinator(
                state: pageState, appearance: CanvasAppearanceState(), entryURL: root.appendingPathComponent("page.html"),
                services: services,
                onProjection: { body in
                    do { try state.receiveProjection(body) }
                    catch { pageState.fail(error.localizedDescription) }
                },
                onConnection: { state.connect($0) }
            )
            configuration.userContentController.add(coordinator, name: WebCanvasCoordinator.bridgeName)
            webView.navigationDelegate = coordinator
            coordinator.loadCanvas(into: webView)
            window = NSWindow(
                contentRect: NSRect(x: 0, y: 0, width: 760, height: 620),
                styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false
            )
            window.isReleasedWhenClosed = false
            window.contentView = NSHostingView(rootView: NativeExportView(
                state: state, services: services, projectId: Self.projectName
            ))
            window.orderFront(nil)
            quit.onApproved = { [weak self] intent in self?.approvals.append(intent) }
        }

        /// Isolated directories belong to one test and are removed with their disposable page data.
        static func makeRoot() -> URL {
            FileManager.default.temporaryDirectory.appendingPathComponent("pw-system-quit-" + UUID().uuidString)
        }

        /// The gated destination resolves to this fixture-owned path; production never receives it from Web input.
        static func exportTarget(_ root: URL) -> URL { root.appendingPathComponent("剧本-export.md") }

        /// The minimal real-protocol page answers export previews, counts quit events and seeds one editor project.
        private static func makePage(at page: URL) throws {
            let text = exportText
                .replacingOccurrences(of: "\\", with: "\\\\")
                .replacingOccurrences(of: "'", with: "\\'")
                .replacingOccurrences(of: "\n", with: "\\n")
            try Data("""
                <!doctype html><meta charset="utf-8"><script>
                window.quitEvents = 0;
                window.__pwDispatchHostEvent = name => { if (name === 'app-quit-requested') window.quitEvents++; };
                window.__pwNativeIntent = async request => {
                  if (request.command === 'editor.exportPreview') {
                    return {ok: {scope: '导出夹具', text: '\(text)', fileName: '剧本-export.md'}};
                  }
                  return {error: {code: 'PW_FIXTURE_COMMAND', message: '未支持的原生命令'}};
                };
                window.webkit.messageHandlers.canvasHost.postMessage({
                    event: 'ready', protocolVersion: 1, sessionId: window.__pwNativeHost.sessionId
                });
                window.webkit.messageHandlers.canvasHost.postMessage({
                    event: 'projection', protocolVersion: 1, sessionId: window.__pwNativeHost.sessionId,
                    sequence: 1,
                    projection: {
                        app: {route: 'editor', project: {id: '\(projectName)', name: '导出夹具'}},
                        editor: {projectId: '\(projectName)', contentRevision: 2}
                    }
                });
                </script>
                """.utf8).write(to: page)
        }

        /// The real preview round trip enables the actual export button; only then may the delivery start.
        func waitUntilSaveReady() async throws {
            try await waitUntil {
                guard let button = try? await NativeCreationControlFixture.element(
                    in: window, named: "保存文件…", roles: [kAXButtonRole]
                ) else { return false }
                return (try? NativeCreationControlFixture.isEnabled(button)) == true
            }
        }

        /// Presses the production save button through the public accessibility API.
        func pressSave() async throws {
            let button = try await NativeCreationControlFixture.element(
                in: window, named: "保存文件…", roles: [kAXButtonRole]
            )
            try #require(try NativeCreationControlFixture.isEnabled(button))
            try NativeCreationControlFixture.press(button)
        }

        /// The final approval entry observes refusals and approvals without ending the test process.
        func attemptExit(requestId: String) async throws -> HostJSON {
            try await services.perform(HostRequest(
                protocolVersion: 1, sessionId: coordinator.sessionId, requestId: requestId, command: "app_exit", args: nil
            ))
        }

        /// Counts quit events actually delivered to the real page.
        func quitEvents() async throws -> Int {
            try await webView.evaluateJavaScript("window.quitEvents") as? Int ?? 0
        }

        /// Bounded polling observes real settlement or delivery, never a guessed duration.
        func waitUntil(_ predicate: () async throws -> Bool) async throws {
            let deadline = ContinuousClock.now.advanced(by: .seconds(8))
            while try await !predicate(), ContinuousClock.now < deadline { try await Task.sleep(for: .milliseconds(10)) }
            try #require(try await predicate())
        }

        /// Session teardown precedes window release so no held intent outlives this fixture.
        func close() {
            window.close()
            window.contentView = nil
            webView.stopLoading()
            coordinator.invalidateSession()
            webView.configuration.userContentController.removeScriptMessageHandler(forName: "plotweaveHost")
            webView.configuration.userContentController.removeScriptMessageHandler(forName: WebCanvasCoordinator.bridgeName)
        }
    }
}
