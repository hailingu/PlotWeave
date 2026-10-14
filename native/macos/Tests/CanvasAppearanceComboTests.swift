import AppKit
import Testing
import WebKit
@testable import PlotWeaveNative

/// M13 automated slice (plan §6 M13, issue #523): every host appearance
/// combination — light/dark × reduce-transparency / increase-contrast /
/// reduce-motion — must land on the real shipped page and be consumed by the
/// web token layer, not merely reflected as data attributes: `color-scheme`
/// and the canvas controls' material degradation are asserted through
/// computed styles in real WebKit. VoiceOver navigation with a real screen
/// reader, real input-method composition, human visual review, and web
/// accessibility-tree exposure (the WKWebView content AX tree does not come
/// up in the test host without a running AX client) stay manual gaps tracked
/// as separate issues.
@MainActor
@Suite(.serialized)
struct CanvasAppearanceComboTests {

    private struct Timeout: Error {}

    /// One forced appearance combination to sweep through the live page.
    private struct Combo {
        let colorScheme: String
        let reduceTransparency: Bool
        let increaseContrast: Bool
        let reduceMotion: Bool

        var snapshot: CanvasAppearanceState.Snapshot {
            CanvasAppearanceState.Snapshot(
                colorScheme: colorScheme,
                reduceTransparency: reduceTransparency,
                increaseContrast: increaseContrast,
                reduceMotion: reduceMotion
            )
        }
    }

    /// Mutable holder feeding a controllable appearance reader.
    private final class ForcedSnapshot {
        var value: CanvasAppearanceState.Snapshot

        init(_ value: CanvasAppearanceState.Snapshot) {
            self.value = value
        }
    }

    /// Representative sweep: both schemes alone, each accessibility semantic
    /// alone, and everything enabled. Consecutive combos always differ so
    /// `refresh()` reliably notifies.
    private static let combos: [Combo] = [
        Combo(colorScheme: "light", reduceTransparency: false, increaseContrast: false, reduceMotion: false),
        Combo(colorScheme: "dark", reduceTransparency: false, increaseContrast: false, reduceMotion: false),
        Combo(colorScheme: "light", reduceTransparency: true, increaseContrast: false, reduceMotion: false),
        Combo(colorScheme: "dark", reduceTransparency: true, increaseContrast: false, reduceMotion: false),
        Combo(colorScheme: "light", reduceTransparency: false, increaseContrast: true, reduceMotion: false),
        Combo(colorScheme: "dark", reduceTransparency: false, increaseContrast: true, reduceMotion: false),
        Combo(colorScheme: "light", reduceTransparency: false, increaseContrast: false, reduceMotion: true),
        Combo(colorScheme: "dark", reduceTransparency: false, increaseContrast: false, reduceMotion: true),
        Combo(colorScheme: "dark", reduceTransparency: true, increaseContrast: true, reduceMotion: true),
    ]

    @Test func hostAppearanceCombosLandAndTokensRespond() async throws {
        let forced = ForcedSnapshot(Self.combos[0].snapshot)
        let appearance = CanvasAppearanceState(reader: { forced.value })
        let fixture = try #require(Self.fixtureEntry())
        let state = WebCanvasState()
        let coordinator = WebCanvasCoordinator(state: state, appearance: appearance, entryURL: fixture)
        let configuration = WKWebViewConfiguration()
        configuration.userContentController.add(coordinator, name: WebCanvasCoordinator.bridgeName)
        let webView = WKWebView(frame: NSRect(x: 0, y: 0, width: 1000, height: 700), configuration: configuration)
        webView.navigationDelegate = coordinator
        let window = NSWindow(contentRect: webView.frame, styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = webView
        window.orderFront(nil)
        defer {
            webView.stopLoading()
            coordinator.invalidateSession()
            configuration.userContentController.removeScriptMessageHandler(forName: WebCanvasCoordinator.bridgeName)
            window.close()
        }
        coordinator.startAppearanceSync()
        coordinator.loadCanvas(into: webView)
        try await Self.waitForReady(state: state, webView: webView)

        for combo in Self.combos {
            forced.value = combo.snapshot
            appearance.refresh()
            try await Self.waitForAttributes(webView: webView, combo: combo)
            let facts = try await Self.pageFacts(webView)
            #expect(facts.colorScheme == combo.colorScheme, "combo \(combo.colorScheme): tokens.css color-scheme must follow the host push")
            let degraded = combo.reduceTransparency || combo.increaseContrast
            if degraded {
                #expect(facts.controlsBackdropFilter == "none", "combo: material must degrade without transparency")
            } else {
                #expect(facts.controlsBackdropFilter.contains("blur"), "combo: default material keeps its glass blur")
            }
            #expect(
                facts.controlsBorderWidth == (combo.increaseContrast ? "2px" : "1px"),
                "combo: increased contrast thickens the controls border"
            )
            #expect(facts.reduceTransparency == combo.reduceTransparency)
            #expect(facts.increaseContrast == combo.increaseContrast)
            #expect(facts.reduceMotion == combo.reduceMotion)
            #expect(facts.canvasClass == "canvas-root is-swift", "fixture page must consume the Swift-host control styling")
            // Informational only: WebKit's own media query may or may not track
            // the forced snapshot; the gap is recorded in the P5 evidence doc.
            print("PW-M13 combo=\(combo.colorScheme) mediaReduceMotion=\(facts.mediaReduceMotion)")
        }
    }

    // MARK: helpers

    /// Computed-style and attribute facts from the live fixture page.
    private struct PageFacts {
        let colorScheme: String
        let controlsBackdropFilter: String
        let controlsBorderWidth: String
        let reduceTransparency: Bool
        let increaseContrast: Bool
        let reduceMotion: Bool
        let mediaReduceMotion: Bool
        let canvasClass: String
    }

    /// Bundle entry with the 9-node demo fragment; standalone webview drive.
    private static func fixtureEntry() -> URL? {
        guard let url = Bundle.main.url(forResource: "native-canvas", withExtension: "html") else { return nil }
        var parts = URLComponents(url: url, resolvingAgainstBaseURL: false)
        parts?.fragment = "fixture"
        return parts?.url
    }

    /// Reads computed styles and host attributes in one evaluation.
    private static func pageFacts(_ webView: WKWebView) async throws -> PageFacts {
        let script = """
        (function() {
          const root = document.documentElement;
          const controls = document.querySelector('.react-flow__controls');
          const style = controls ? getComputedStyle(controls) : null;
          const canvas = document.querySelector('.canvas-root');
          return [
            getComputedStyle(root).colorScheme,
            style ? String(style.backdropFilter) : 'no-controls',
            style ? String(style.borderWidth) : 'no-controls',
            root.getAttribute('data-host-reduce-transparency'),
            root.getAttribute('data-host-increase-contrast'),
            root.getAttribute('data-host-reduce-motion'),
            String(window.matchMedia('(prefers-reduced-motion: reduce)').matches),
            canvas ? canvas.className : 'no-canvas'
          ];
        })()
        """
        let values = try await webView.evaluateJavaScript(script) as? [String]
        let facts = try #require(values, "appearance facts script must return its array")
        return PageFacts(
            colorScheme: try #require(facts[0]),
            controlsBackdropFilter: try #require(facts[1]),
            controlsBorderWidth: try #require(facts[2]),
            reduceTransparency: try #require(facts[3]) == "true",
            increaseContrast: try #require(facts[4]) == "true",
            reduceMotion: try #require(facts[5]) == "true",
            mediaReduceMotion: try #require(facts[6]) == "true",
            canvasClass: try #require(facts[7])
        )
    }

    /// Waits for the production handshake and the demo node set.
    private static func waitForReady(state: WebCanvasState, webView: WKWebView) async throws {
        let deadline = ContinuousClock.now.advanced(by: .seconds(17))
        while state.phase == .loading && ContinuousClock.now < deadline {
            try await Task.sleep(for: .milliseconds(100))
        }
        #expect(state.phase == .ready)
        while ContinuousClock.now < deadline {
            let nodes = try await webView.evaluateJavaScript(
                "document.querySelectorAll('.react-flow__node').length"
            ) as? Int
            if nodes == 9 { return }
            try await Task.sleep(for: .milliseconds(100))
        }
        throw Timeout()
    }

    /// Waits until all four host semantics match the forced combination.
    private static func waitForAttributes(webView: WKWebView, combo: Combo) async throws {
        let script = """
        (function() {
          const root = document.documentElement;
          return [
            root.getAttribute('data-host-color-scheme'),
            root.getAttribute('data-host-reduce-transparency'),
            root.getAttribute('data-host-increase-contrast'),
            root.getAttribute('data-host-reduce-motion')
          ].join('|');
        })()
        """
        let expected = [
            combo.colorScheme,
            String(combo.reduceTransparency),
            String(combo.increaseContrast),
            String(combo.reduceMotion),
        ].joined(separator: "|")
        let deadline = ContinuousClock.now.advanced(by: .seconds(5))
        while ContinuousClock.now < deadline {
            let current = try await webView.evaluateJavaScript(script) as? String
            if current == expected { return }
            try await Task.sleep(for: .milliseconds(50))
        }
        throw Timeout()
    }
}
