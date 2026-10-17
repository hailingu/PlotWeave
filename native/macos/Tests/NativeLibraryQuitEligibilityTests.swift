import AppKit
import Foundation
import Testing
import WebKit
@testable import PlotWeaveNative

/// Accepted native-library write batches must settle before quit delivery and final approval (issue #529).
@MainActor
@Suite(.serialized, WebKitTestIsolation())
struct NativeLibraryQuitEligibilityTests {
    /// The quit event stays undelivered while an accepted import batch is in flight, then delivers after settlement.
    @Test func quitDeliveryWaitsForAcceptedImportBatch() async throws {
        let fixture = try QuitFixture()
        defer { fixture.close() }
        try await fixture.waitUntilReady()
        let gate = SelectionGate()
        let model = fixture.model { await gate.select() }
        defer { model.close() }
        try await fixture.load(model)
        model.pickFiles(kind: "other")
        try await fixture.waitUntil { fixture.services.libraryQuitWork.hasPendingBatches && gate.isWaiting }
        fixture.quit.acknowledgeListener()
        fixture.quit.request(.terminate)
        // A delivered event would reach the page within milliseconds; only the batch drain can hold it.
        try await Task.sleep(for: .milliseconds(200))
        #expect(try await fixture.quitEvents() == 0, "已接纳批次在途时退出事件不得投递")
        #expect(fixture.quit.pendingIntent == .terminate)
        gate.release([fixture.first, fixture.second])
        try await fixture.waitUntil { !fixture.services.libraryQuitWork.hasPendingBatches && !model.busy }
        try await fixture.waitUntil { try await fixture.quitEvents() == 1 }
        #expect(fixture.approvals.isEmpty)
    }

    /// Final approval refuses while an accepted batch is in flight and approves exactly once after settlement.
    @Test func finalApprovalRefusesUntilImportBatchSettles() async throws {
        let fixture = try QuitFixture()
        defer { fixture.close() }
        try await fixture.waitUntilReady()
        let gate = SelectionGate()
        let model = fixture.model { await gate.select() }
        defer { model.close() }
        try await fixture.load(model)
        model.pickFiles(kind: "other")
        try await fixture.waitUntil { fixture.services.libraryQuitWork.hasPendingBatches && gate.isWaiting }
        fixture.quit.acknowledgeListener()
        fixture.quit.request(.terminate)
        do {
            _ = try await fixture.attemptExit(requestId: "refuse")
            Issue.record("批次在途时最终批准不得放行")
        } catch let failure as HostFailure { #expect(failure.code == "PW_NATIVE_LIBRARY_PENDING") }
        #expect(fixture.approvals.isEmpty && fixture.quit.pendingIntent == .terminate)
        gate.release([fixture.first, fixture.second])
        try await fixture.waitUntil { !fixture.services.libraryQuitWork.hasPendingBatches && !model.busy }
        _ = try await fixture.attemptExit(requestId: "approve")
        #expect(fixture.approvals == [.terminate] && fixture.quit.pendingIntent == nil)
        try await fixture.expectImportedAssets(names: ["first.png", "second.png"], bytes: [Data([1, 2]), Data([5])])
    }

    /// A batch held inside the real import boundary keeps approval blocked until the whole batch settles.
    @Test func importCheckpointBatchBlocksFinalApproval() async throws {
        let fixture = try QuitFixture()
        defer { fixture.close() }
        try await fixture.waitUntilReady()
        let gate = ImportGate()
        gate.arm(1)
        let library = NativeLibrary(root: fixture.root) { stage in
            if stage == .mediaCommitted { gate.hold() }
        }
        let model = fixture.model(selectFiles: { [fixture.first, fixture.second] }, library: library)
        defer { model.close() }
        try await fixture.load(model)
        model.pickFiles(kind: "other")
        try await fixture.waitUntil { fixture.services.libraryQuitWork.hasPendingBatches && gate.isHeld }
        fixture.quit.acknowledgeListener()
        fixture.quit.request(.terminate)
        do {
            _ = try await fixture.attemptExit(requestId: "mid-import")
            Issue.record("导入中途的已接纳批次不得被最终批准绕过")
        } catch let failure as HostFailure { #expect(failure.code == "PW_NATIVE_LIBRARY_PENDING") }
        gate.release()
        try await fixture.waitUntil { !fixture.services.libraryQuitWork.hasPendingBatches && !model.busy }
        _ = try await fixture.attemptExit(requestId: "settled")
        #expect(fixture.approvals == [.terminate])
        try await fixture.expectImportedAssets(names: ["first.png", "second.png"], bytes: [Data([1, 2]), Data([5])], library: library)
    }

    /// A failed batch settles with its committed items preserved; approval follows settlement without replay or rollback.
    @Test func failedBatchSettlesAndPreservesCommittedAssets() async throws {
        let fixture = try QuitFixture()
        defer { fixture.close() }
        try await fixture.waitUntilReady()
        let model = fixture.model { [fixture.first, fixture.root.appendingPathComponent("missing.png")] }
        defer { model.close() }
        try await fixture.load(model)
        model.pickFiles(kind: "other")
        try await fixture.waitUntil { !model.busy && model.error != nil }
        fixture.quit.acknowledgeListener()
        fixture.quit.request(.terminate)
        try await fixture.waitUntil { try await fixture.quitEvents() == 1 }
        _ = try await fixture.attemptExit(requestId: "after-failure")
        #expect(fixture.approvals == [.terminate])
        try await fixture.expectImportedAssets(names: ["first.png"], bytes: [Data([1, 2])])
    }

    /// Sheet cancellation must reach actual completion before approval, and a cancelled batch imports nothing.
    @Test func cancelledBatchCompletionPrecedesApproval() async throws {
        let fixture = try QuitFixture()
        defer { fixture.close() }
        try await fixture.waitUntilReady()
        let gate = SelectionGate()
        let model = fixture.model { await gate.select() }
        try await fixture.load(model)
        model.pickFiles(kind: "other")
        try await fixture.waitUntil { fixture.services.libraryQuitWork.hasPendingBatches && gate.isWaiting }
        model.close()
        // The cancel request alone does not settle the batch; its suspended task keeps the entry registered.
        #expect(fixture.services.libraryQuitWork.hasPendingBatches)
        fixture.quit.acknowledgeListener()
        fixture.quit.request(.terminate)
        do {
            _ = try await fixture.attemptExit(requestId: "cancelling")
            Issue.record("取消完成前最终批准不得放行")
        } catch let failure as HostFailure { #expect(failure.code == "PW_NATIVE_LIBRARY_PENDING") }
        gate.release([fixture.first])
        try await fixture.waitUntil { !fixture.services.libraryQuitWork.hasPendingBatches }
        _ = try await fixture.attemptExit(requestId: "cancelled")
        #expect(fixture.approvals == [.terminate])
        try await fixture.expectImportedAssets(names: [], bytes: [])
    }

    /// An old batch's completion must not release the quit delivery while a newly accepted batch is still in flight.
    @Test func oldBatchCompletionDoesNotReleaseNewWork() async throws {
        let fixture = try QuitFixture()
        defer { fixture.close() }
        try await fixture.waitUntilReady()
        let oldGate = SelectionGate()
        let newGate = SelectionGate()
        let oldModel = fixture.model { await oldGate.select() }
        let newModel = fixture.model { await newGate.select() }
        defer { oldModel.close(); newModel.close() }
        try await fixture.load(oldModel)
        try await fixture.load(newModel)
        oldModel.pickFiles(kind: "other")
        newModel.pickFiles(kind: "other")
        try await fixture.waitUntil { fixture.services.libraryQuitWork.hasPendingBatches && oldGate.isWaiting && newGate.isWaiting }
        fixture.quit.acknowledgeListener()
        fixture.quit.request(.terminate)
        oldGate.release([])
        try await fixture.waitUntil { !oldModel.busy }
        try await Task.sleep(for: .milliseconds(200))
        #expect(try await fixture.quitEvents() == 0, "旧批次完成不得释放仍在途的新批次")
        #expect(fixture.quit.pendingIntent == .terminate)
        newGate.release([fixture.first, fixture.second])
        try await fixture.waitUntil { !fixture.services.libraryQuitWork.hasPendingBatches && !newModel.busy }
        try await fixture.waitUntil { try await fixture.quitEvents() == 1 }
        try await fixture.expectImportedAssets(names: ["first.png", "second.png"], bytes: [Data([1, 2]), Data([5])])
    }

    /// A direct mutation accepted while quitting blocks final approval until it settles on the shared actor.
    @Test func directMutationGatesFinalApproval() async throws {
        let fixture = try QuitFixture()
        defer { fixture.close() }
        try await fixture.waitUntilReady()
        let gate = ImportGate()
        let library = NativeLibrary(root: fixture.root) { stage in
            if stage == .mediaCommitted { gate.hold() }
        }
        let seeded = try await library.importAsset(name: "seed.png", mime: "image/png", kind: "other", bytes: Data([3]))
        let id = try #require(seeded["id"]?.string)
        let model = fixture.model(library: library)
        defer { model.close() }
        try await fixture.load(model)
        gate.arm(1)
        let holder = Task { try await library.importAsset(name: "holder.png", mime: "image/png", kind: "other", bytes: Data([7])) }
        try await fixture.waitUntil { gate.isHeld }
        model.mutate("update_library_asset", args: ["id": .string(id), "patch": .object(["name": .string("changed")])])
        #expect(fixture.services.libraryQuitWork.hasPendingBatches)
        fixture.quit.acknowledgeListener()
        fixture.quit.request(.terminate)
        do {
            _ = try await fixture.attemptExit(requestId: "mutating")
            Issue.record("直接 mutate 在途时最终批准不得放行")
        } catch let failure as HostFailure { #expect(failure.code == "PW_NATIVE_LIBRARY_PENDING") }
        gate.release()
        _ = try await holder.value
        try await fixture.waitUntil { !fixture.services.libraryQuitWork.hasPendingBatches && !model.busy }
        _ = try await fixture.attemptExit(requestId: "mutated")
        #expect(fixture.approvals == [.terminate])
        let list = try await library.invoke("list_library_assets", args: [:])
        #expect(list["assets"]?["byId"]?[id]?["name"] == .string("changed"))
        let media = try await library.openMedia(id: id)
        #expect(try media.read(maxBytes: 10) == Data([3]))
    }

    /// A read-only refresh never registers quit eligibility, so approval passes while the list is still in flight.
    @Test func readOnlyRefreshDoesNotGateQuit() async throws {
        let fixture = try QuitFixture()
        defer { fixture.close() }
        try await fixture.waitUntilReady()
        let gate = ImportGate()
        let library = NativeLibrary(root: fixture.root) { stage in
            if stage == .mediaCommitted { gate.hold() }
        }
        let model = fixture.model(library: library)
        defer { model.close() }
        try await fixture.load(model)
        gate.arm(1)
        let holder = Task { try await library.importAsset(name: "holder.png", mime: "image/png", kind: "other", bytes: Data([7])) }
        try await fixture.waitUntil { gate.isHeld }
        model.refresh()
        #expect(model.busy)
        fixture.quit.acknowledgeListener()
        fixture.quit.request(.terminate)
        try await fixture.waitUntil { try await fixture.quitEvents() == 1 }
        _ = try await fixture.attemptExit(requestId: "reading")
        #expect(fixture.approvals == [.terminate] && model.busy)
        gate.release()
        _ = try await holder.value
        try await fixture.waitUntil { !model.busy }
        let list = try await library.invoke("list_library_assets", args: [:])
        #expect(list["assets"]?["byId"]?.object?.count == 1)
    }

    /// A cancelled or replaced quit delivery abandons its batch wait promptly instead of staying suspended.
    @Test func cancelledDeliveryReleasesBatchWaitPromptly() async throws {
        let fixture = try QuitFixture()
        defer { fixture.close() }
        try await fixture.waitUntilReady()
        let gate = SelectionGate()
        let model = fixture.model { await gate.select() }
        defer { model.close() }
        try await fixture.load(model)
        model.pickFiles(kind: "other")
        try await fixture.waitUntil { fixture.services.libraryQuitWork.hasPendingBatches && gate.isWaiting }
        let installed = fixture.quit.sendEvent
        let released = ReleaseFlag()
        fixture.quit.sendEvent = { name, payload in
            defer { released.set() }
            try await installed?(name, payload)
        }
        fixture.quit.acknowledgeListener()
        fixture.quit.request(.terminate)
        // The current delivery is legitimately held by the accepted batch.
        try await Task.sleep(for: .milliseconds(100))
        #expect(!released.value)
        fixture.quit.cancel()
        // The obsolete delivery must unwind while the batch is still held, without touching the batch itself.
        try await fixture.waitUntil { released.value }
        #expect(fixture.services.libraryQuitWork.hasPendingBatches && model.busy)
        #expect(try await fixture.quitEvents() == 0)
        gate.release([])
        try await fixture.waitUntil { !fixture.services.libraryQuitWork.hasPendingBatches && !model.busy }
    }

    /// One-shot flag observable across the wrapped production delivery closure.
    @MainActor
    private final class ReleaseFlag {
        private(set) var value = false
        func set() { value = true }
    }

    /// Holds one deterministic selection; the accepted batch suspends until the test releases it.
    @MainActor
    private final class SelectionGate {
        private var continuation: CheckedContinuation<[URL], Never>?
        private var released: [URL]?
        var isWaiting: Bool { continuation != nil }

        /// Suspends the presentation's file selection at a deterministic entry gate.
        func select() async -> [URL] {
            if let released { return released }
            return await withCheckedContinuation { continuation = $0 }
        }

        /// Resumes the held selection exactly once; a release ahead of the wait returns immediately.
        func release(_ urls: [URL]) {
            released = urls
            continuation?.resume(returning: urls)
            continuation = nil
        }
    }

    /// Blocks real imports at their checkpoint while the library lock stays held, exactly like production contention.
    private final class ImportGate: @unchecked Sendable {
        private let semaphore = DispatchSemaphore(value: 0)
        private let lock = NSLock()
        private var holdsRemaining = 0
        private var held = 0

        /// Arming holds the next `holds` imports; imports before arming pass untouched.
        func arm(_ holds: Int) {
            lock.lock()
            holdsRemaining = holds
            lock.unlock()
        }

        /// True while a real import is suspended inside the storage boundary.
        var isHeld: Bool {
            lock.lock(); defer { lock.unlock() }
            return held > 0
        }

        /// An armed import blocks here until released; disarmed calls return immediately.
        func hold() {
            lock.lock()
            let enter = holdsRemaining > 0
            if enter { holdsRemaining -= 1; held += 1 }
            lock.unlock()
            if enter { semaphore.wait() }
        }

        /// Releases one held import.
        func release() {
            lock.lock()
            let open = held > 0
            if open { held -= 1 }
            lock.unlock()
            if open { semaphore.signal() }
        }
    }

    /// A real WebKit page with the real service quit wiring observes approval ordering without host termination.
    @MainActor
    private final class QuitFixture {
        let root: URL
        let webView: WKWebView
        let coordinator: WebCanvasCoordinator
        let services: NativeHostServices
        var quit: HostQuitController { services.quit }
        private let pageState = WebCanvasState()
        private(set) var approvals: [HostQuitController.Intent] = []
        var first: URL { root.appendingPathComponent("first.png") }
        var second: URL { root.appendingPathComponent("second.png") }

        init() throws {
            services = NativeHostServices(dataRoot: nil, quit: HostQuitController())
            root = FileManager.default.temporaryDirectory.appendingPathComponent("pw-library-quit-" + UUID().uuidString)
            try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
            try Data([1, 2]).write(to: root.appendingPathComponent("first.png"))
            try Data([5]).write(to: root.appendingPathComponent("second.png"))
            let page = root.appendingPathComponent("page.html")
            try Data("""
                <!doctype html><script>
                window.quitEvents = 0;
                window.__pwDispatchHostEvent = name => { if (name === 'app-quit-requested') window.quitEvents++; };
                window.webkit.messageHandlers.canvasHost.postMessage({event: 'ready'});
                </script>
                """.utf8).write(to: page)
            let configuration = WKWebViewConfiguration()
            webView = try IsolatedWebViewFixture.makeWebView(frame: NSRect(x: 0, y: 0, width: 300, height: 200), configuration: configuration)
            coordinator = WebCanvasCoordinator(
                state: pageState, appearance: CanvasAppearanceState(), entryURL: page,
                services: services, onProjection: nil
            )
            configuration.userContentController.add(coordinator, name: WebCanvasCoordinator.bridgeName)
            webView.navigationDelegate = coordinator
            coordinator.loadCanvas(into: webView)
            quit.onApproved = { [weak self] intent in self?.approvals.append(intent) }
        }

        /// The presentation model registers accepted writes with the service-owned app-level registry.
        func model(selectFiles: @escaping NativeLibraryModel.FileSelection = { [] }, library: NativeLibrary? = nil) -> NativeLibraryModel {
            NativeLibraryModel(library: library ?? NativeLibrary(root: root), quitWork: services.libraryQuitWork, selectFiles: selectFiles)
        }

        /// Writes are enabled only after an actual successful initial library read.
        func load(_ model: NativeLibraryModel) async throws {
            model.refresh()
            try await waitUntil { !model.busy }
            try #require(model.writable && model.error == nil)
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
            let deadline = ContinuousClock.now.advanced(by: .seconds(5))
            while try await !predicate(), ContinuousClock.now < deadline { try await Task.sleep(for: .milliseconds(10)) }
            try #require(try await predicate())
        }

        /// Observes production readiness through the actual script handshake.
        func waitUntilReady() async throws {
            let deadline = ContinuousClock.now.advanced(by: .seconds(5))
            while pageState.phase == .loading && ContinuousClock.now < deadline {
                try await Task.sleep(for: .milliseconds(20))
            }
            try #require(pageState.phase == .ready)
        }

        /// The authoritative index and media bytes must agree with the settled batch result.
        func expectImportedAssets(names: [String], bytes: [Data], library: NativeLibrary? = nil) async throws {
            let owner = library ?? NativeLibrary(root: root)
            let list = try await owner.invoke("list_library_assets", args: [:])
            let assets = try #require(list["assets"]?["byId"]?.object)
            #expect(assets.count == names.count)
            for (name, expected) in zip(names, bytes) {
                let id = try #require(assets.values.first { $0["name"]?.string == name }?["id"]?.string)
                let media = try await owner.openMedia(id: id)
                #expect(try media.read(maxBytes: 10) == expected)
            }
        }

        /// Model work settles before this root is removed, so no task can mutate another test's data.
        func close() {
            webView.stopLoading()
            coordinator.invalidateSession()
            webView.configuration.userContentController.removeScriptMessageHandler(forName: "plotweaveHost")
            webView.configuration.userContentController.removeScriptMessageHandler(forName: WebCanvasCoordinator.bridgeName)
            try? FileManager.default.removeItem(at: root)
        }
    }
}
