import AppKit
import Foundation
import SwiftUI
import Testing
import WebKit
@testable import PlotWeaveNative

/// First-drag startup evidence (issue #544): the real production shell, editor
/// page and independent storage host a 15-node project; synthetic mouse events
/// drive the same node twice per variant (inspector expanded, then collapsed)
/// while the page records startup-to-first-position and rAF intervals. The
/// assertions stay structural (the drags move nodes and produce samples); the
/// printed numbers are same-condition first/second evidence for the
/// diagnostics record, not CI thresholds.
@MainActor
@Suite(.serialized, WebKitTestIsolation())
struct WebCanvasFirstDragLatencyTests {

    private struct Timeout: Error {}

    /// One measured drag: values come from the page itself, never inferred host-side.
    private struct DragReport: Decodable {
        let firstPositionMs: Double?
        let maxFrameMs: Double
        let over33Ms: Int
        let frameSamples: Int
        let movedPx: Double
    }

    /// Both drags of one variant plus the graph facts the script observed.
    private struct VariantReport: Decodable {
        let nodeCount: Int
        let first: DragReport
        let second: DragReport
    }

    /// The suspension control reports whether its page-level stub actually held.
    private struct SuspendedVariantReport: Decodable {
        let suspended: Bool
        let report: VariantReport
    }

    /// Same node, two drags, real shell: the comparison the issue's acceptance asks for.
    @Test func sameNodeFirstAndSecondDragRecordStartupEvidence() async throws {
        let fixture = Fixture()
        defer { fixture.remove() }
        let mounted = try await seedProjectWithCascade(fixture, nodes: 15)
        try await Task.sleep(for: .milliseconds(600))

        let expanded = try await runDragVariant(mounted: mounted, nodeIndex: 0, inspectorVisible: true)
        mounted.layout.inspectorVisible = false
        try await Task.sleep(for: .milliseconds(400))
        let collapsed = try await runDragVariant(mounted: mounted, nodeIndex: 1, inspectorVisible: false)
        let preselected = try await runPreselectedVariant(mounted: mounted, nodeIndex: 2)
        let dropped = try await runProjectionControlVariant(mounted: mounted, nodeIndex: 3, mode: "dropped")
        let renamed = try await runProjectionControlVariant(mounted: mounted, nodeIndex: 4, mode: "renamed")

        try assertStructural(expanded, variant: "inspector-expanded")
        try assertStructural(collapsed, variant: "inspector-collapsed")
        try assertStructural(preselected, variant: "click-preselected")
        try assertStructural(dropped.report, variant: "projection-dropped")
        try assertStructural(renamed.report, variant: "projection-renamed")
        #expect(dropped.applied && renamed.applied, "投影归因对照必须实际生效，否则该变体不构成证据")
        print("PW-DRAG inspector=expanded " + Self.describe(expanded))
        print("PW-DRAG inspector=collapsed " + Self.describe(collapsed))
        print("PW-DRAG preselect=click " + Self.describe(preselected))
        print("PW-DRAG projection=dropped " + Self.describe(dropped.report))
        print("PW-DRAG projection=renamed " + Self.describe(renamed.report))
        await fixture.services.close()
    }

    // MARK: helpers

    /// Creates the project, opens it and seeds a diagonal node cascade through
    /// production intents only (create once, duplicate the latest node).
    private func seedProjectWithCascade(_ fixture: Fixture, nodes: Int) async throws -> (window: NSWindow, state: NativeApplicationState, layout: ShellLayoutState) {
        let projects = try #require(fixture.services.projectStore)
        let metadata = try await projects.invoke(command: "create_project", args: ["name": .string("首拖证据")])
        let id = try #require(metadata["id"]?.string)
        let mounted = fixture.mount()
        try await wait { mounted.state.route == "home" && mounted.state.app["loading"] == .bool(false) }
        let webView = try #require(Self.findWebView(mounted.window.contentView))
        try await waitForHostReady(webView)
        _ = try await mounted.state.request("app.open", args: ["id": .string(id)])
        try await wait { mounted.state.route == "editor" && mounted.state.editor["projectId"]?.string == id }
        _ = try await mounted.state.request("editor.create", args: ["projectId": .string(id), "nodeType": .string("scene")])
        try await wait { mounted.state.editor["nodes"]?.arrayValue?.count == 1 }
        while mounted.state.editor["nodes"]?.arrayValue?.count ?? 0 < nodes {
            let latest = try #require(mounted.state.editor["nodes"]?.arrayValue?.last?["id"]?.string)
            _ = try await mounted.state.request("editor.duplicate", args: ["projectId": .string(id), "id": .string(latest)])
            try await wait { mounted.state.editor["nodes"]?.arrayValue?.count ?? 0 > 0 }
        }
        return mounted
    }

    /// Runs the in-page two-drag script and decodes its self-measured report.
    private func runDragVariant(
        mounted: (window: NSWindow, state: NativeApplicationState, layout: ShellLayoutState),
        nodeIndex: Int,
        inspectorVisible: Bool
    ) async throws -> VariantReport {
        let webView = try #require(Self.findWebView(mounted.window.contentView))
        let json = try await callDragScript(webView, nodeIndex: nodeIndex, preselectByClick: false, projectionMode: "live")
        return try JSONDecoder().decode(VariantReport.self, from: Data(json.utf8))
    }

    /// Clicks the node first (selection commit paid before the drag), then drags it twice.
    private func runPreselectedVariant(
        mounted: (window: NSWindow, state: NativeApplicationState, layout: ShellLayoutState),
        nodeIndex: Int
    ) async throws -> VariantReport {
        let webView = try #require(Self.findWebView(mounted.window.contentView))
        let json = try await callDragScript(webView, nodeIndex: nodeIndex, preselectByClick: true, projectionMode: "live")
        return try JSONDecoder().decode(VariantReport.self, from: Data(json.utf8))
    }

    /// Attribution controls for the projection path (issue #544): `dropped` keeps the
    /// page-side serialization but never posts to the host; `renamed` posts the full
    /// envelope with an event name the host ignores, isolating marshaling/IPC from
    /// host-side decode and SwiftUI updates.
    private func runProjectionControlVariant(
        mounted: (window: NSWindow, state: NativeApplicationState, layout: ShellLayoutState),
        nodeIndex: Int,
        mode: String
    ) async throws -> (report: VariantReport, applied: Bool) {
        let webView = try #require(Self.findWebView(mounted.window.contentView))
        let json = try await callDragScript(webView, nodeIndex: nodeIndex, preselectByClick: false, projectionMode: mode)
        let pair = try JSONDecoder().decode(SuspendedVariantReport.self, from: Data(json.utf8))
        return (pair.report, pair.suspended)
    }

    /// Shared in-page entry returning the script's raw JSON payload.
    private func callDragScript(
        _ webView: WKWebView, nodeIndex: Int, preselectByClick: Bool, projectionMode: String
    ) async throws -> String {
        let json = try await webView.callAsyncJavaScript(
            Self.dragScript,
            arguments: [
                "nodeIndex": nodeIndex, "preselectByClick": preselectByClick,
                "projectionMode": projectionMode,
            ],
            in: nil, contentWorld: .page
        ) as? String
        return try #require(json)
    }

    /// Structural invariants only; measured milliseconds are recorded, never thresholded.
    private func assertStructural(_ report: VariantReport, variant: String) throws {
        #expect(report.nodeCount == 15, "\(variant): the seeded graph must stay mounted")
        for (label, drag) in [("first", report.first), ("second", report.second)] {
            #expect(drag.movedPx > 0, "\(variant)/\(label): the drag must move the node")
            #expect(drag.frameSamples > 0, "\(variant)/\(label): the rAF sampler must observe frames")
            #expect(drag.firstPositionMs != nil, "\(variant)/\(label): a first position change must be observed")
        }
    }

    /// One evidence line per variant for the diagnostics record.
    private static func describe(_ report: VariantReport) -> String {
        func text(_ drag: DragReport) -> String {
            let first = drag.firstPositionMs.map { String(format: "%.1f", $0) } ?? "null"
            return "firstPosition=\(first)ms maxFrame=\(String(format: "%.1f", drag.maxFrameMs))ms"
                + " over33=\(drag.over33Ms) samples=\(drag.frameSamples) moved=\(String(format: "%.1f", drag.movedPx))px"
        }
        return "nodes=\(report.nodeCount) first[\(text(report.first))] second[\(text(report.second))]"
    }

    /// Dispatches real mouse events at ~16ms cadence and measures each drag
    /// from the page: threshold-move dispatch to the first observed transform
    /// change (MutationObserver) plus rAF intervals and the moved distance.
    private static let dragScript = #"""
        const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const fire = (target, type, x, y, buttons) => target.dispatchEvent(
          new MouseEvent(type, {bubbles: true, cancelable: true, view: window,
            clientX: x, clientY: y, button: 0, buttons: buttons})
        );
        const parseTranslate = (element) => {
          const match = /translate\((-?[\d.]+)px,\s*(-?[\d.]+)px\)/.exec(element.style.transform || '');
          return match ? {x: Number(match[1]), y: Number(match[2])} : null;
        };
        const pickNode = (index) => {
          const nodes = Array.from(document.querySelectorAll('.react-flow__node'));
          const visible = nodes.filter((node) => {
            const rect = node.getBoundingClientRect();
            const centerX = rect.left + rect.width / 2;
            const centerY = rect.top + rect.height / 2;
            return centerX >= 0 && centerX <= window.innerWidth
              && centerY >= 0 && centerY <= window.innerHeight;
          });
          const list = visible.length >= 2 ? visible : nodes;
          return list[Math.min(index, list.length - 1)];
        };
        const dragOnce = async (node) => {
          const rect = node.getBoundingClientRect();
          const startX = rect.left + rect.width / 2;
          const startY = rect.top + rect.height / 2;
          const before = parseTranslate(node);
          const frames = [];
          let previous = performance.now();
          let firstPositionMs = null;
          let thresholdAt = 0;
          let frameId = 0;
          const tick = (at) => {
            frames.push(at - previous);
            previous = at;
            frameId = requestAnimationFrame(tick);
          };
          const observer = new MutationObserver(() => {
            const now = parseTranslate(node);
            if (firstPositionMs === null && now && before
                && (now.x !== before.x || now.y !== before.y)) {
              firstPositionMs = performance.now() - thresholdAt;
            }
          });
          observer.observe(node, {attributes: true, attributeFilter: ['style']});
          fire(node, 'mousedown', startX, startY, 1);
          thresholdAt = performance.now();
          fire(window, 'mousemove', startX + 10, startY + 6, 1);
          frameId = requestAnimationFrame(tick);
          const steps = 18;
          for (let step = 1; step <= steps; step += 1) {
            await sleep(16);
            fire(window, 'mousemove', startX + 10 + step * 8, startY + 6 + step * 3, 1);
          }
          fire(window, 'mouseup', startX + 10 + steps * 8, startY + 6 + steps * 3, 0);
          await sleep(300);
          cancelAnimationFrame(frameId);
          observer.disconnect();
          const after = parseTranslate(node);
          return {
            firstPositionMs: firstPositionMs,
            maxFrameMs: frames.length ? Math.max(...frames) : 0,
            over33Ms: frames.filter((delta) => delta > 33).length,
            frameSamples: frames.length,
            movedPx: before && after ? Math.hypot(after.x - before.x, after.y - before.y) : 0,
          };
        };
        const node = pickNode(nodeIndex);
        let suspended = false;
        const originalWebkit = window.webkit;
        if (projectionMode !== 'live' && originalWebkit && originalWebkit.messageHandlers) {
          const realHost = originalWebkit.messageHandlers.canvasHost;
          try {
            window.webkit = {
              messageHandlers: {
                canvasHost: {postMessage: (body) => {
                  if (projectionMode !== 'dropped' && body && body.event === 'projection') {
                    return realHost.postMessage(Object.assign({}, body, {event: 'attribution-noop'}));
                  }
                  if (projectionMode === 'dropped' && body && body.event === 'projection') return undefined;
                  return realHost.postMessage(body);
                }},
                plotweaveHost: originalWebkit.messageHandlers.plotweaveHost,
              },
            };
            suspended = window.webkit.messageHandlers.canvasHost !== realHost;
          } catch (error) { suspended = false; }
        }
        if (preselectByClick) {
          const rect = node.getBoundingClientRect();
          const clickX = rect.left + rect.width / 2;
          const clickY = rect.top + rect.height / 2;
          fire(node, 'mousedown', clickX, clickY, 1);
          fire(window, 'mouseup', clickX, clickY, 0);
          await sleep(500);
        }
        const first = await dragOnce(node);
        await sleep(400);
        const second = await dragOnce(node);
        if (suspended) { window.webkit = originalWebkit; }
        const payload = {
          nodeCount: document.querySelectorAll('.react-flow__node').length,
          first: first,
          second: second,
        };
        return JSON.stringify(projectionMode !== 'live'
          ? {suspended: suspended, report: payload}
          : payload);
        """#

    /// Bounded polling observes actual state transitions and reports a useful last-state failure.
    private func wait(_ predicate: () -> Bool) async throws {
        let deadline = ContinuousClock.now.advanced(by: .seconds(12))
        while !predicate() && ContinuousClock.now < deadline { try await Task.sleep(for: .milliseconds(30)) }
        try #require(predicate(), "生产原生页面未在期限内完成业务状态转换")
    }

    /// Probes the real native ready guard without admitting a business intent.
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
        throw Timeout()
    }

    /// Finds the persistent canvas underneath the real SwiftUI composition without rebuilding it.
    private static func findWebView(_ view: NSView?) -> WKWebView? {
        guard let view else { return nil }
        if let webView = view as? WKWebView { return webView }
        for child in view.subviews { if let result = findWebView(child) { return result } }
        return nil
    }

    /// Every service/window belongs to this unique temporary root; default app-support paths are never selected.
    @MainActor private final class Fixture {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("pw-native-first-drag-" + UUID().uuidString)
        let quit = HostQuitController()
        let services: NativeHostServices
        private var windows: [NSWindow] = []

        /// Actor construction remains lazy until the fixture's explicit project request.
        init() { services = NativeHostServices(dataRoot: root, quit: quit) }

        /// Presents one actual native shell so WebKit can run the production frame-driven handshake.
        func mount() -> (window: NSWindow, state: NativeApplicationState, layout: ShellLayoutState) {
            let state = NativeApplicationState()
            let layout = ShellLayoutState()
            let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1280, height: 860), styleMask: [.titled], backing: .buffered, defer: false)
            window.isReleasedWhenClosed = false
            // Keep this disposable integration window visible above the foreground test client.
            window.level = .floating
            window.contentView = NSHostingView(rootView: NativeShellRoot(layout: layout, services: services, application: state))
            windows.append(window)
            window.contentView?.layoutSubtreeIfNeeded()
            // A nonactive app-hosted process still needs visible WebKit animation frames.
            window.orderFrontRegardless()
            return (window, state, layout)
        }

        /// Teardown invalidates Web owners before removing only this fixture's disposable data.
        func remove() {
            for window in windows { window.close(); window.contentView = nil }
            try? FileManager.default.removeItem(at: root)
        }
    }
}
