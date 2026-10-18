import AppKit
import CoreFoundation
import SwiftUI
import Testing
import WebKit
@testable import PlotWeaveNative

/// M15 measurement harness (plan §7.2, issues #523/#572): the real shell hosts
/// the shipped canvas page with a registered perf fixture (`perf:N`), and the
/// page's scripted-operation runner sustains drag/pan/zoom/control interactions.
/// Native-panel mode toggles Swift panels mid-run; common-web mode keeps them
/// collapsed for the Tauri A/B. WebContent memory is sampled across the script
/// and repeated open/close cycles. Assertions stay structural (counts, phases,
/// observable effects, bounded memory); recorded numbers are migration evidence,
/// not CI thresholds.
@MainActor
@Suite(.serialized, WebKitTestIsolation())
struct WebCanvasPerformanceTests {

    private struct Timeout: Error {}

    /// Comparison-only RSS failure; teardown trend tests intentionally allow zero processes.
    private struct ComparisonMemoryFailure: Error, Equatable {
        let appResidentBytes: UInt64
        let expectedProcesses: Int
        let actualProcesses: Int
    }

    /// A structural report failure that must abort before PW-PERF is emitted.
    private struct CanvasReportFailure: Error, Equatable {
        let detail: String
    }

    /// Registered measurement scales mirror src/editor/nativeCanvas/canvasPerfFixture.ts.
    @Test(.enabled(if: NativeStressTestProfile.enabled, "按需运行：sh scripts/test-native.sh stress"), arguments: [100, 500, 1000])
    func sustainedScriptedOperationsMatchFixtureScale(scale: Int) async throws {
        try await measureScriptedOperations(scale: scale, nativePanelMode: true)
    }

    /// Common-mode A/B for issue #572: native panels stay collapsed and no
    /// Swift-only panel operation is mixed into the shared Web script.
    @Test(.enabled(if: NativeStressTestProfile.enabled, "按需运行：sh scripts/test-native.sh stress"), arguments: [100, 500, 1000])
    func commonModeSupportsTauriBaselineComparison(scale: Int) async throws {
        try await measureScriptedOperations(scale: scale, nativePanelMode: false)
    }

    /// A lost host or tracked WebContent process must not become valid zero-RSS evidence.
    @Test func comparisonMemoryRejectsLostTrackedProcess() throws {
        let trackedPages: Set<Int32> = [42]
        let valid = WebProcessMemorySample(
            appResidentBytes: 1, webContentResidentBytes: 1, webContentProcessCount: 1
        )
        try Self.requireComparisonMemory(valid, trackedPages: trackedPages)
        let lostPage = WebProcessMemorySample(
            appResidentBytes: 1, webContentResidentBytes: 0, webContentProcessCount: 0
        )
        #expect(throws: ComparisonMemoryFailure.self) {
            try Self.requireComparisonMemory(lostPage, trackedPages: trackedPages)
        }
        let lostHost = WebProcessMemorySample(
            appResidentBytes: 0, webContentResidentBytes: 1, webContentProcessCount: 1
        )
        #expect(throws: ComparisonMemoryFailure.self) {
            try Self.requireComparisonMemory(lostHost, trackedPages: trackedPages)
        }
    }

    /// Invalid frame metrics must throw before any machine-readable evidence is printed.
    @Test func frameMetricsRejectMissingSamplesAndPercentiles() throws {
        let jsonTrue = try Self.requireValue(
            JSONSerialization.jsonObject(with: Data("true".utf8), options: .fragmentsAllowed) as? NSNumber, "jsonTrue"
        )
        let valid: [String: Any] = [
            "samples": 1, "p50Ms": 17.0, "p95Ms": 18.0,
            "maxMs": 20.0, "over16Ms": 1, "over33Ms": 0,
        ]
        try Self.requireFrameMetrics(valid)
        let invalid: [[String: Any]] = [
            ["samples": 0, "p50Ms": 17.0, "p95Ms": 18.0, "maxMs": 20.0, "over16Ms": 1, "over33Ms": 0],
            ["samples": 1, "p50Ms": NSNull(), "p95Ms": 18.0, "maxMs": 20.0, "over16Ms": 1, "over33Ms": 0],
            ["samples": 1, "p50Ms": 17.0, "p95Ms": NSNull(), "maxMs": 20.0, "over16Ms": 1, "over33Ms": 0],
            ["samples": 1, "p50Ms": 17.0, "p95Ms": 18.0, "over16Ms": 1, "over33Ms": 0],
            ["samples": 1, "p50Ms": 17.0, "p95Ms": 18.0, "maxMs": 20.0, "over16Ms": NSNull(), "over33Ms": 0],
            ["samples": 1, "p50Ms": 17.0, "p95Ms": 18.0, "maxMs": 20.0, "over16Ms": 1, "over33Ms": NSNull()],
            ["samples": 1, "p50Ms": 17.0, "p95Ms": 18.0, "maxMs": -1.0, "over16Ms": 1, "over33Ms": 0],
            ["samples": 1, "p50Ms": 17.0, "p95Ms": 18.0, "maxMs": 20.0, "over16Ms": -1, "over33Ms": 0],
            ["samples": jsonTrue, "p50Ms": 17.0, "p95Ms": 18.0, "maxMs": 20.0, "over16Ms": 1, "over33Ms": 0],
            ["samples": 1, "p50Ms": jsonTrue, "p95Ms": 18.0, "maxMs": 20.0, "over16Ms": 1, "over33Ms": 0],
            ["samples": 1, "p50Ms": 17.0, "p95Ms": 18.0, "maxMs": 20.0, "over16Ms": 1.5, "over33Ms": 0],
            ["samples": 1, "p50Ms": 17.0, "p95Ms": 18.0, "maxMs": 20.0, "over16Ms": 1, "over33Ms": jsonTrue],
        ]
        for frames in invalid {
            #expect(throws: (any Error).self) {
                try Self.requireFrameMetrics(frames)
            }
        }
    }

    /// Version, viewport, and optional long-task evidence must fail closed too.
    @Test func reportMetadataRejectsInvalidVersionViewportAndLongTasks() throws {
        let jsonTrue = try Self.requireValue(
            JSONSerialization.jsonObject(with: Data("true".utf8), options: .fragmentsAllowed) as? NSNumber, "jsonTrue"
        )
        let valid: [String: Any] = [
            "version": 1,
            "viewport": ["width": 1280, "height": 860, "devicePixelRatio": 2],
            "longTasks": NSNull(),
        ]
        try Self.requireReportMetadata(valid)
        var invalidVersion = valid
        invalidVersion["version"] = 2
        var invalidViewport = valid
        invalidViewport["viewport"] = ["width": 0, "height": 860, "devicePixelRatio": 2]
        var invalidLongTasks = valid
        invalidLongTasks["longTasks"] = ["samples": 1]
        var negativeLongTasks = valid
        negativeLongTasks["longTasks"] = ["samples": -1, "maxMs": 0.0]
        var booleanVersion = valid
        booleanVersion["version"] = jsonTrue
        var booleanViewport = valid
        booleanViewport["viewport"] = ["width": 1280, "height": 860, "devicePixelRatio": jsonTrue]
        var booleanLongTasks = valid
        booleanLongTasks["longTasks"] = ["samples": jsonTrue, "maxMs": 0.0]
        let invalid = [
            invalidVersion, invalidViewport, invalidLongTasks, negativeLongTasks,
            booleanVersion, booleanViewport, booleanLongTasks,
        ]
        for report in invalid {
            #expect(throws: (any Error).self) {
                try Self.requireReportMetadata(report)
            }
        }
    }

    /// Runs the shared Web fixture and script in either common or native-panel mode.
    private func measureScriptedOperations(scale: Int, nativePanelMode: Bool) async throws {
        let webBaseline = WebProcessMemorySampler.webContentPids()
        let layout = ShellLayoutState()
        if !nativePanelMode {
            layout.inspectorVisible = false
            layout.sidebarVisible = false
        }
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1280, height: 860),
            styleMask: [.titled], backing: .buffered, defer: false
        )
        window.isReleasedWhenClosed = false
        let mountedAt = ContinuousClock.now
        window.contentView = NSHostingView(
            rootView: NativeShellRoot(
                layout: layout, appearance: CanvasAppearanceState(),
                demoMode: true, demoFragment: "perf:\(scale)"
            )
        )
        window.orderFront(nil)
        defer { window.contentView = nil; window.close() }

        let webView = try await waitForWebView(in: window)
        // Edges render only after node measurement settles; gate on both so
        // the script starts against the fully mounted fixture. The readiness
        // timestamp is taken here, before the settlement sleep, so
        // mountToNodes reports the metric it names (PR #574 review).
        try await waitForFixture(webView, nodes: scale, edges: scale / 10 * 9 - 1, deadline: .seconds(90))
        let renderedAt = ContinuousClock.now
        try await Task.sleep(for: .milliseconds(300))
        // The shared suite permit excludes sibling page launches across all
        // awaits in this window. Reuse or ambiguous diffs throw before sampling.
        let trackedPages = try WebProcessMemorySampler.pageWebContentPids(since: webBaseline)
        let baseline = WebProcessMemorySampler.sample(tracking: trackedPages)
        try Self.requireComparisonMemory(baseline, trackedPages: trackedPages)

        // The script task inherits main-actor isolation; the Web runner owns
        // the single default configuration used by both host measurements.
        let scriptTask = Task { () -> String? in
            try await webView.callAsyncJavaScript(
                "return JSON.stringify(await window.__pwRunCanvasPerf())",
                arguments: [:],
                in: nil, contentWorld: .page
            ) as? String
        }
        if nativePanelMode {
            // Real native panels relayout mid-interaction (matrix M15 "面板操作").
            try await Task.sleep(for: .milliseconds(600))
            layout.toggleInspector()
            try await Task.sleep(for: .milliseconds(900))
            layout.sidebarVisible = false
            try await Task.sleep(for: .milliseconds(700))
            layout.sidebarVisible = true
        }

        let jsonString = try await scriptTask.value
        let payload = try Self.requireValue(jsonString, "payload")
        let report = try Self.parse(payload)
        try Self.requireReportMetadata(report)
        let after = WebProcessMemorySampler.sample(tracking: trackedPages)
        try Self.requireComparisonMemory(after, trackedPages: trackedPages)

        let nodeCount = try Self.requireInteger(report["nodeCount"], "nodeCount")
        try Self.requireCondition(nodeCount == scale, "nodeCount")
        let edgeCount = try Self.requireInteger(report["edgeCount"], "edgeCount")
        try Self.requireCondition(edgeCount == scale / 10 * 9 - 1, "edgeCount")
        let visibleNodeCount = try Self.requireInteger(report["visibleNodeCount"], "visibleNodeCount")
        try Self.requireCondition(visibleNodeCount > 0, "visibleNodeCount")
        let phases = try Self.requireValue(report["phases"] as? [[String: Any]], "phases")
        let kinds = phases.compactMap { $0["kind"] as? String }
        try Self.requireCondition(kinds == ["drag", "pan", "zoom", "panel"], "phaseKinds")
        for phase in phases {
            let frames = try Self.requireValue(phase["frames"] as? [String: Any], "frames")
            try Self.requireFrameMetrics(frames)
        }
        let total = try Self.requireValue(report["total"] as? [String: Any], "total")
        try Self.requireFrameMetrics(total)
        let effects = try Self.requireValue(report["effects"] as? [String: Any], "effects")
        _ = try Self.requirePositiveNumber(effects["draggedNodeMovedPx"], "dragEffect")
        _ = try Self.requirePositiveNumber(effects["panTranslatePx"], "panEffect")
        _ = try Self.requirePositiveNumber(effects["zoomTravel"], "zoomEffect")

        Self.printEvidence(
            scale: scale, mode: nativePanelMode ? "native-panels" : "common-web",
            report: report, phases: phases, total: total,
            mountToRendered: renderedAt - mountedAt, before: baseline, after: after
        )
    }

    /// Repeated open/close cycles must not grow total memory without bound
    /// (matrix M15 invariant). Each cycle mounts a fresh hosted shell and
    /// destroys it (`contentView = nil` runs SwiftUI dismantle → coordinator
    /// invalidation and handler removal). The bound covers the **aggregate**
    /// of every cycle-owned WebContent pid — including destroyed-but-lingering
    /// ones WebKit's process cache keeps alive — plus the host app's own
    /// resident memory, so retained processes or retained Swift objects both
    /// fail it (PR #574 reviews).
    @Test(.enabled(if: NativeStressTestProfile.enabled, "按需运行：sh scripts/test-native.sh stress"))
    func repeatedHostedCanvasCyclesKeepTotalMemoryBounded() async throws {
        let preLoop = WebProcessMemorySampler.sample(tracking: [])
        var aggregateSamples: [WebProcessMemorySample] = []
        var cycleOwnedPids: Set<Int32> = []
        for cycle in 0..<5 {
            let webBaseline = WebProcessMemorySampler.webContentPids()
            let window = try await mountPerfShell(scale: 100)
            // Attribution now throws: failure must dismantle the host before
            // releasing the shared suite permit to another WebKit owner.
            defer {
                window.contentView = nil
                if window.isVisible { window.close() }
            }
            let webView = try await waitForWebView(in: window)
            try await waitForFixture(webView, nodes: 100, edges: 89, deadline: .seconds(90))
            try await Task.sleep(for: .seconds(1))
            // Hold the same exclusive suite permit across every cycle; a
            // reused page cannot collide with a sibling suite's new process.
            // Fail closed on empty/multi-process diffs before changing the union.
            let bornThisCycle = try WebProcessMemorySampler.pageWebContentPids(since: webBaseline)
            cycleOwnedPids.formUnion(bornThisCycle)
            aggregateSamples.append(WebProcessMemorySampler.sample(tracking: cycleOwnedPids))

            window.contentView = nil
            window.close()
            try await Task.sleep(for: .seconds(2))
            // Process exit after teardown is WebKit process-cache timing
            // (measured to vary between ~10s and 30s+ here, independent of
            // app-side teardown), so it is RECORDED per cycle, not asserted
            // — the app-owned release (dismantle → coordinator invalidation
            // and handler removal) is covered by the lifecycle suites
            // (PR #574 reviews).
            let residual = WebProcessMemorySampler.sample(tracking: bornThisCycle)
            print("PW-PERF cycle-\(cycle) teardown+2s: \(residual.description)")
        }
        try await Task.sleep(for: .seconds(8))
        let settled = WebProcessMemorySampler.sample(tracking: cycleOwnedPids)
        aggregateSamples.append(settled)
        let trend = aggregateSamples.map(\.description).joined(separator: " -> ")
        print("PW-PERF cycle-aggregate-trend: \(trend)")
        print("PW-PERF pre-loop: \(preLoop.description)")

        let first = try #require(aggregateSamples.first)
        let bound: UInt64 = 400 * 1_048_576
        // Every collected sample must stay bounded, not only the endpoints:
        // torn-down processes accumulating mid-loop and exiting during the
        // settlement would otherwise spike an intermediate sample unseen
        // (PR #574 review).
        for (index, sample) in aggregateSamples.enumerated() {
            #expect(
                sample.webContentResidentBytes <= first.webContentResidentBytes + bound,
                "cycle \(index): cycle-owned WebContent aggregate must stay bounded: \(trend)"
            )
            #expect(
                sample.appResidentBytes <= first.appResidentBytes + bound,
                "cycle \(index): host app memory must stay bounded across destroy/recreate cycles: \(trend)"
            )
        }
    }

    /// Issue #573 isolates same-view navigation from the destroy/recreate boundary.
    /// Every reload must replace the document, render the full fixture, and keep
    /// the original readable process before its RSS can enter the trend. The
    /// broad M15 bound is a regression guard; plateau acceptance uses the
    /// recorded late-window deltas, not a machine-specific CI timing threshold.
    @Test(.enabled(if: NativeStressTestProfile.enabled, "按需运行：sh scripts/test-native.sh stress"))
    func repeatedReloadsRecordLongMemoryTrend() async throws {
        let webBaseline = WebProcessMemorySampler.webContentPids()
        let window = try await mountPerfShell(scale: 100)
        defer {
            window.contentView = nil
            if window.isVisible { window.close() }
        }
        let webView = try await waitForWebView(in: window)
        try await waitForFixture(webView, nodes: 100, edges: 89, deadline: .seconds(90))
        try await Task.sleep(for: .seconds(1))
        let trackedPages = try WebProcessMemorySampler.pageWebContentPids(since: webBaseline)
        let first = WebProcessMemorySampler.sample(tracking: trackedPages)
        try Self.requireComparisonMemory(first, trackedPages: trackedPages)
        let bound: UInt64 = 400 * 1_048_576
        print("PW-RELOAD pids=\(trackedPages.sorted()) cycle=0 \(first.description)")
        for cycle in 1...100 {
            _ = try await webView.evaluateJavaScript("window.__pwReloadProbe = true; null")
            _ = try #require(webView.reload())
            try await waitForReloadedFixture(webView)
            try await Task.sleep(for: .seconds(1))
            let currentPages = try WebProcessMemorySampler.pageWebContentPids(since: webBaseline)
            try Self.requireCondition(currentPages == trackedPages, "reloadProcessChanged")
            let sample = WebProcessMemorySampler.sample(tracking: trackedPages)
            try Self.requireComparisonMemory(sample, trackedPages: trackedPages)
            print("PW-RELOAD cycle=\(cycle) \(sample.description)")
            #expect(sample.webContentResidentBytes <= first.webContentResidentBytes + bound)
            #expect(sample.appResidentBytes <= first.appResidentBytes + bound)
        }
        try await Task.sleep(for: .seconds(15))
        let settled = WebProcessMemorySampler.sample(tracking: trackedPages)
        try Self.requireComparisonMemory(settled, trackedPages: trackedPages)
        print("PW-RELOAD settled+15s \(settled.description)")
        #expect(settled.webContentResidentBytes <= first.webContentResidentBytes + bound)
        #expect(settled.appResidentBytes <= first.appResidentBytes + bound)
    }

    /// The previous page's ready DOM cannot satisfy a reload measurement.
    private func waitForReloadedFixture(_ webView: WKWebView) async throws {
        let deadline = ContinuousClock.now.advanced(by: .seconds(90))
        while ContinuousClock.now < deadline {
            if !webView.isLoading {
                let ready = try await webView.evaluateJavaScript("""
                    window.__pwReloadProbe === undefined &&
                    document.querySelectorAll('.react-flow__node').length === 100 &&
                    document.querySelectorAll('.react-flow__edge').length === 89
                    """) as? Bool
                if ready == true { return }
            }
            try await Task.sleep(for: .milliseconds(100))
        }
        throw Timeout()
    }

    // MARK: helpers

    /// Mounts a fresh hosted shell window for the requested perf scale.
    private func mountPerfShell(scale: Int) async throws -> NSWindow {
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1280, height: 860),
            styleMask: [.titled], backing: .buffered, defer: false
        )
        window.isReleasedWhenClosed = false
        window.contentView = NSHostingView(
            rootView: NativeShellRoot(
                layout: ShellLayoutState(), appearance: CanvasAppearanceState(),
                demoMode: true, demoFragment: "perf:\(scale)"
            )
        )
        window.orderFront(nil)
        return window
    }

    // MARK: helpers

    /// Parses the runner's JSON payload.
    private static func parse(_ json: String) throws -> [String: Any] {
        let data = try requireValue(json.data(using: .utf8), "jsonData")
        return try requireValue(
            JSONSerialization.jsonObject(with: data) as? [String: Any], "jsonObject"
        )
    }

    /// Depth-first search for the shell's hosted web view.
    private static func firstWebView(in view: NSView) -> WKWebView? {
        if let webView = view as? WKWebView { return webView }
        for subview in view.subviews {
            if let found = firstWebView(in: subview) { return found }
        }
        return nil
    }

    /// Finds the shell's WKWebView once SwiftUI mounted the canvas section.
    private func waitForWebView(in window: NSWindow) async throws -> WKWebView {
        let deadline = ContinuousClock.now.advanced(by: .seconds(15))
        while ContinuousClock.now < deadline {
            if let contentView = window.contentView,
                let webView = Self.firstWebView(in: contentView) {
                return webView
            }
            try await Task.sleep(for: .milliseconds(50))
        }
        throw Timeout()
    }

    /// Waits until the page reports the fixture's full node and edge set.
    private func waitForFixture(_ webView: WKWebView, nodes: Int, edges: Int, deadline: Duration) async throws {
        let deadline = ContinuousClock.now.advanced(by: deadline)
        var lastCounts = "n/a"
        while ContinuousClock.now < deadline {
            lastCounts = (try await webView.evaluateJavaScript(
                """
                document.querySelectorAll('.react-flow__node').length + ',' +
                document.querySelectorAll('.react-flow__edge').length + ',' +
                document.querySelectorAll('.pw-edge-attach').length + ',' +
                Array.from(document.querySelectorAll('.react-flow__edge'))
                    .filter(e => (e.dataset.id || '').includes('bridge')).length + ',' +
                document.querySelectorAll('.react-flow__handle').length
                """
            ) as? String) ?? "n/a"
            if lastCounts.hasPrefix("\(nodes),\(edges),") { return }
            try await Task.sleep(for: .milliseconds(100))
        }
        struct FixtureTimeout: Error { let detail: String }
        throw FixtureTimeout(detail: "expected \(nodes) nodes/\(edges) edges, got \(lastCounts)")
    }

    /// Requires the host and every attributed page to remain readable across a comparison.
    private static func requireComparisonMemory(
        _ sample: WebProcessMemorySample, trackedPages: Set<Int32>
    ) throws {
        guard sample.appResidentBytes > 0,
            sample.webContentProcessCount == trackedPages.count else {
            throw ComparisonMemoryFailure(
                appResidentBytes: sample.appResidentBytes,
                expectedProcesses: trackedPages.count,
                actualProcesses: sample.webContentProcessCount
            )
        }
    }

    /// Validates the report version, positive viewport, and optional long-task shape.
    private static func requireReportMetadata(_ report: [String: Any]) throws {
        let version = try requireInteger(report["version"], "version")
        try requireCondition(version == 1, "version")
        let viewport = try requireValue(report["viewport"] as? [String: Any], "viewport")
        for field in ["width", "height", "devicePixelRatio"] {
            _ = try requirePositiveNumber(viewport[field], field)
        }
        if !(report["longTasks"] is NSNull) {
            let tasks = try requireValue(report["longTasks"] as? [String: Any], "longTasks")
            let samples = try requireInteger(tasks["samples"], "longTasks.samples")
            try requireCondition(samples >= 0, "longTasks.samples")
            _ = try requireNonnegativeNumber(tasks["maxMs"], "longTasks.maxMs")
        }
    }

    /// Throws unless samples and numeric p50/p95 exist for a total or phase report.
    private static func requireFrameMetrics(_ frames: [String: Any]) throws {
        let samples = try requireInteger(frames["samples"], "samples")
        try requireCondition(samples > 0, "samples")
        _ = try requireNonnegativeNumber(frames["p50Ms"], "p50Ms")
        _ = try requireNonnegativeNumber(frames["p95Ms"], "p95Ms")
        _ = try requireNonnegativeNumber(frames["maxMs"], "maxMs")
        let over16 = try requireInteger(frames["over16Ms"], "over16Ms")
        try requireCondition(over16 >= 0, "over16Ms")
        let over33 = try requireInteger(frames["over33Ms"], "over33Ms")
        try requireCondition(over33 >= 0, "over33Ms")
    }

    /// Returns a required report value or throws before evidence formatting.
    private static func requireValue<T>(_ value: T?, _ detail: String) throws -> T {
        guard let value else { throw CanvasReportFailure(detail: detail) }
        return value
    }

    /// Accepts NSNumber while explicitly excluding JSON's CFBoolean bridge.
    private static func requireNumber(_ value: Any?, _ detail: String) throws -> NSNumber {
        let number = try requireValue(value as? NSNumber, detail)
        guard CFGetTypeID(number) != CFBooleanGetTypeID() else {
            throw CanvasReportFailure(detail: detail)
        }
        return number
    }

    /// Requires an exact, non-fractional integer rather than a numeric coercion.
    private static func requireInteger(_ value: Any?, _ detail: String) throws -> Int {
        let number = try requireNumber(value, detail)
        let integer = number.intValue
        try requireCondition(number.doubleValue == Double(integer), detail)
        return integer
    }

    /// Requires a finite nonnegative report duration.
    private static func requireNonnegativeNumber(_ value: Any?, _ detail: String) throws -> Double {
        let number = try requireNumber(value, detail).doubleValue
        try requireCondition(number.isFinite && number >= 0, detail)
        return number
    }

    /// Requires a finite positive report number.
    private static func requirePositiveNumber(_ value: Any?, _ detail: String) throws -> Double {
        let number = try requireNumber(value, detail).doubleValue
        try requireCondition(number.isFinite && number > 0, detail)
        return number
    }

    /// Enforces a report predicate without relying on non-throwing test expectations.
    private static func requireCondition(_ condition: Bool, _ detail: String) throws {
        guard condition else { throw CanvasReportFailure(detail: detail) }
    }

    /// One evidence line per scale for the P5 record (values, not thresholds).
    private static func printEvidence(
        scale: Int,
        mode: String,
        report: [String: Any],
        phases: [[String: Any]],
        total: [String: Any],
        mountToRendered: Duration,
        before: WebProcessMemorySample,
        after: WebProcessMemorySample
    ) {
        func ms(_ key: String, _ dict: [String: Any]) -> String {
            guard let value = dict[key] as? Double else { return "n/a" }
            return String(format: "%.1f", value)
        }
        let phaseText = phases.compactMap { phase -> String? in
            guard let kind = phase["kind"] as? String,
                let frames = phase["frames"] as? [String: Any] else { return nil }
            return "\(kind)[p50=\(ms("p50Ms", frames)) p95=\(ms("p95Ms", frames)) max=\(ms("maxMs", frames)) over16=\(frames["over16Ms"] ?? -1) over33=\(frames["over33Ms"] ?? -1)]"
        }.joined(separator: " ")
        let longTasks = report["longTasks"] as? [String: Any]
        let milliseconds = Double(mountToRendered.components.seconds) * 1_000
            + Double(mountToRendered.components.attoseconds) / 1e15
        let viewport = report["viewport"] as? [String: Any]
        print(
            "PW-PERF host=swift mode=\(mode) scale=\(scale) mountToNodes=\(String(format: "%.0f", milliseconds))ms "
                + "visible=\(report["visibleNodeCount"] ?? -1) viewport=\(viewport?["width"] ?? -1)x\(viewport?["height"] ?? -1)@\(viewport?["devicePixelRatio"] ?? -1) "
                + "total[samples=\(total["samples"] ?? -1) p50=\(ms("p50Ms", total)) p95=\(ms("p95Ms", total)) max=\(ms("maxMs", total)) over16=\(total["over16Ms"] ?? -1)] "
                + "\(phaseText) "
                + "longTasks=\(longTasks.map { "[samples=\($0["samples"] ?? -1) max=\(ms("maxMs", $0))]" } ?? "null") "
                + "mem[\(before.description) -> \(after.description)]"
        )
    }
}
