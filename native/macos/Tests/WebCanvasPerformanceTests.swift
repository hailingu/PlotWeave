import AppKit
import SwiftUI
import Testing
import WebKit
@testable import PlotWeaveNative

/// M15 measurement harness (plan §7.2, issue #523): the real shell hosts the
/// shipped canvas page with a registered perf fixture (`perf:N`), the page's
/// scripted-operation runner sustains drag/pan/zoom/control interactions while
/// native panels toggle mid-run, and WebContent memory is sampled across
/// repeated open/close cycles. Assertions stay structural (counts, phases,
/// observable effects, bounded memory); the recorded p50/p95 numbers are
/// evidence for the migration plan, not CI thresholds — baselines are fixed
/// only after this first measurement round (§7.2).
@MainActor
@Suite(.serialized)
struct WebCanvasPerformanceTests {

    private struct Timeout: Error {}

    /// Scripted run parameters: ~3.5s of sustained interaction per scale.
    private static let scriptOptions: [String: Any] = [
        "dragRounds": 2, "dragSteps": 20,
        "panRounds": 2, "panSteps": 20,
        "zoomRounds": 2, "zoomSteps": 16,
        "stepMs": 14, "settleMs": 250,
    ]

    /// Registered measurement scales mirror src/editor/nativeCanvas/canvasPerfFixture.ts.
    @Test(arguments: [100, 500, 1000])
    func sustainedScriptedOperationsMatchFixtureScale(scale: Int) async throws {
        let webBaseline = WebProcessMemorySampler.webContentPids()
        let layout = ShellLayoutState()
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
        defer { window.close() }

        let webView = try await waitForWebView(in: window)
        // Edges render only after node measurement settles; gate on both so
        // the script starts against the fully mounted fixture.
        try await waitForFixture(webView, nodes: scale, edges: scale / 10 * 9 - 1, deadline: .seconds(90))
        try await Task.sleep(for: .milliseconds(300))
        let renderedAt = ContinuousClock.now
        // WebContent processes are launchd children here; attribute this
        // test's page by the pids that appeared since the pre-mount baseline.
        let trackedPages = WebProcessMemorySampler.pageWebContentPids(since: webBaseline)
        #expect(!trackedPages.isEmpty, "a WebContent process must own the loaded page")
        let baseline = WebProcessMemorySampler.sample(tracking: trackedPages)

        // The script task inherits main-actor isolation so the options dict
        // never crosses actors while native panels toggle mid-run.
        let scriptTask = Task { () -> String? in
            try await webView.callAsyncJavaScript(
                "return JSON.stringify(await window.__pwRunCanvasPerf(options))",
                arguments: ["options": Self.scriptOptions],
                in: nil, contentWorld: .page
            ) as? String
        }
        // Real native panels relayout mid-interaction (matrix M15 "面板操作").
        try await Task.sleep(for: .milliseconds(600))
        layout.toggleInspector()
        try await Task.sleep(for: .milliseconds(900))
        layout.sidebarVisible = false
        try await Task.sleep(for: .milliseconds(700))
        layout.sidebarVisible = true

        let jsonString = try await scriptTask.value
        let payload = try #require(jsonString)
        let report = try Self.parse(payload)
        let after = WebProcessMemorySampler.sample(tracking: trackedPages)

        #expect(report["nodeCount"] as? Int == scale)
        #expect(report["edgeCount"] as? Int == scale / 10 * 9 - 1)
        #expect((report["visibleNodeCount"] as? Int ?? 0) > 0, "at fitView zoom nodes must be visible")
        let phases = try #require(report["phases"] as? [[String: Any]])
        let kinds = phases.compactMap { $0["kind"] as? String }
        #expect(kinds == ["drag", "pan", "zoom", "panel"])
        let total = try #require(report["total"] as? [String: Any])
        #expect((total["samples"] as? Int ?? 0) > 0, "the rAF sampler must observe frames")
        let effects = try #require(report["effects"] as? [String: Any])
        #expect((effects["draggedNodeMovedPx"] as? Double ?? 0) > 0, "the scripted drag must move a node")
        #expect((effects["panTranslatePx"] as? Double ?? 0) > 0, "the scripted pan must translate the viewport")
        #expect((effects["zoomTravel"] as? Double ?? 0) > 0, "the scripted zoom must change scale")

        Self.printEvidence(
            scale: scale, report: report, phases: phases, total: total,
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
    @Test func repeatedHostedCanvasCyclesKeepTotalMemoryBounded() async throws {
        let preLoop = WebProcessMemorySampler.sample(tracking: [])
        var aggregateSamples: [WebProcessMemorySample] = []
        var cycleOwnedPids: Set<Int32> = []
        for cycle in 0..<5 {
            let webBaseline = WebProcessMemorySampler.webContentPids()
            let window = try await mountPerfShell(scale: 100)
            let webView = try await waitForWebView(in: window)
            try await waitForFixture(webView, nodes: 100, edges: 89, deadline: .seconds(90))
            try await Task.sleep(for: .seconds(1))
            // Pool reuse would return an empty diff and fail here explicitly
            // instead of silently measuring the wrong process set.
            let bornThisCycle = WebProcessMemorySampler.pageWebContentPids(since: webBaseline)
            #expect(!bornThisCycle.isEmpty, "cycle \(cycle): a WebContent process must own the loaded page")
            cycleOwnedPids.formUnion(bornThisCycle)
            aggregateSamples.append(WebProcessMemorySampler.sample(tracking: cycleOwnedPids))

            window.contentView = nil
            window.close()
            try await Task.sleep(for: .seconds(2))
        }
        // Let WebKit's process cache retire torn-down pages before the final
        // reading; the during-loop aggregate is recorded either way.
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
        let data = try #require(json.data(using: .utf8))
        return try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
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

    /// One evidence line per scale for the P5 record (values, not thresholds).
    private static func printEvidence(
        scale: Int,
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
        print(
            "PW-PERF scale=\(scale) mountToNodes=\(String(format: "%.0f", milliseconds))ms "
                + "visible=\(report["visibleNodeCount"] ?? -1) dpr=\((report["viewport"] as? [String: Any])?["devicePixelRatio"] ?? -1) "
                + "total[samples=\(total["samples"] ?? -1) p50=\(ms("p50Ms", total)) p95=\(ms("p95Ms", total)) max=\(ms("maxMs", total)) over16=\(total["over16Ms"] ?? -1)] "
                + "\(phaseText) "
                + "longTasks=\(longTasks.map { "[samples=\($0["samples"] ?? -1) max=\(ms("maxMs", $0))]" } ?? "null") "
                + "mem[\(before.description) -> \(after.description)]"
        )
    }
}
