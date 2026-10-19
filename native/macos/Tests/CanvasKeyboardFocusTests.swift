import AppKit
import Testing
import WebKit
@testable import PlotWeaveNative

/// Issue #596: the shipped CSS must expose keyboard focus separately from selection.
/// Uses real WebKit computed styles with explicit pseudo-state modeling, as the
/// app-hosted test runner does not provide an active key window. Matching state
/// attributes preserve pseudo-class specificity; WebKit still owns the cascade,
/// theme values and layout. Actual keyboard behavior is covered by React tests.
@MainActor
@Suite(.serialized, WebKitTestIsolation())
struct CanvasKeyboardFocusTests {
    /// A real bundled memory canvas, isolated from user storage and other WebKit suites.
    @MainActor
    private final class Fixture {
        /// Owns observable load readiness for this isolated page.
        let state = WebCanvasState()
        /// Uses the production appearance and handshake path.
        let coordinator: WebCanvasCoordinator
        /// Hosts the actual bundled canvas and CSS.
        let webView: WKWebView
        /// Provides an owned window without relying on foreground activation.
        let window: NSWindow

        /// Loads the existing explicit demo entry with a deterministic host appearance.
        init(scheme: String) throws {
            let url = try #require(Bundle.main.url(forResource: "native-canvas", withExtension: "html"))
            var parts = URLComponents(url: url, resolvingAgainstBaseURL: false)
            parts?.fragment = "fixture"
            let entry = try #require(parts?.url)
            let appearance = CanvasAppearanceState(reader: {
                CanvasAppearanceState.Snapshot(
                    colorScheme: scheme, reduceTransparency: false,
                    increaseContrast: false, reduceMotion: true
                )
            })
            coordinator = WebCanvasCoordinator(state: state, appearance: appearance, entryURL: entry)
            let configuration = WKWebViewConfiguration()
            configuration.userContentController.add(coordinator, name: WebCanvasCoordinator.bridgeName)
            webView = try IsolatedWebViewFixture.makeWebView(
                frame: NSRect(x: 0, y: 0, width: 1100, height: 750), configuration: configuration
            )
            webView.navigationDelegate = coordinator
            window = NSWindow(contentRect: webView.frame, styleMask: [.titled], backing: .buffered, defer: false)
            window.isReleasedWhenClosed = false
            window.contentView = webView
            window.orderFront(nil)
            coordinator.startAppearanceSync()
            coordinator.loadCanvas(into: webView)
        }

        /// Rehosts the actual bundled sheets inline because file-URL sheets have opaque CSSOM origins.
        /// Only focus pseudo-states are modeled; their attribute replacements preserve specificity.
        func modelFocusStates() async throws {
            let links = try #require(try await webView.evaluateJavaScript(
                "Array.from(document.querySelectorAll('link[rel=stylesheet]'), link => link.href)"
            ) as? [String])
            try #require(!links.isEmpty, "the shipped page must load its stylesheet bundle")
            let styles = try links.map { link in
                try String(contentsOf: #require(URL(string: link)), encoding: .utf8)
            }
            _ = try await webView.callAsyncJavaScript("""
              const visit = rules => {
                for (const rule of rules) {
                  if (rule instanceof CSSStyleRule) {
                    rule.selectorText = rule.selectorText
                      .replaceAll(':focus-visible', '[data-test-focus-visible]')
                      .replaceAll(':focus-within', '[data-test-focus-within]');
                  }
                  if ('cssRules' in rule) visit(rule.cssRules);
                }
              };
              for (const link of document.querySelectorAll('link[rel=stylesheet]')) link.disabled = true;
              for (const css of styles) {
                const style = document.createElement('style'); style.textContent = css;
                document.head.append(style); visit(style.sheet.cssRules);
              }
            """, arguments: ["styles": styles], in: nil, contentWorld: .page)
        }

        /// Stops the page and releases the same bridge/window resources created by this fixture.
        func close() {
            webView.stopLoading()
            coordinator.invalidateSession()
            webView.configuration.userContentController.removeScriptMessageHandler(forName: WebCanvasCoordinator.bridgeName)
            window.close()
        }

        /// Waits for observable node readiness rather than assuming a fixed load duration.
        func ready() async throws {
            let deadline = ContinuousClock.now.advanced(by: .seconds(17))
            while ContinuousClock.now < deadline {
                if state.phase == .ready,
                   try await webView.evaluateJavaScript("document.querySelectorAll('.react-flow__node').length") as? Int == 9 {
                    return
                }
                try await Task.sleep(for: .milliseconds(50))
            }
            throw ReadyTimeout()
        }
    }

    /// A bounded fixture load did not expose the real canvas.
    private struct ReadyTimeout: Error {}

    /// Both appearances keep an independent focus ring on unselected and selected nodes.
    @Test(arguments: ["light", "dark"])
    func focusedNodeRetainsSelectionAndGeometry(scheme: String) async throws {
        let fixture = try Fixture(scheme: scheme)
        defer { fixture.close() }
        try await fixture.ready()
        try await fixture.modelFocusStates()
        let values = try await fixture.webView.callAsyncJavaScript("""
          const probe = document.createElement('span'); probe.style.color = 'var(--accent)';
          document.body.append(probe); const accent = getComputedStyle(probe).color; probe.remove();
          const node = document.querySelector('.react-flow__node');
          const width = node.getBoundingClientRect().width;
          node.focus(); node.dataset.testFocusVisible = '';
          const rest = getComputedStyle(node);
          const unselected = [document.activeElement === node, rest.outlineStyle, rest.outlineWidth, rest.outlineOffset];
          node.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', bubbles: true, cancelable: true}));
          await new Promise(resolve => requestAnimationFrame(resolve));
          const card = node.querySelector('.pw-card');
          const selected = getComputedStyle(node);
          return [...unselected, node.classList.contains('selected'), card.classList.contains('pw-on'),
            selected.outlineStyle, selected.outlineWidth, selected.outlineOffset,
            getComputedStyle(card).outlineStyle, width === node.getBoundingClientRect().width,
            selected.outlineColor === accent && accent !== 'rgba(0, 0, 0, 0)'].map(String);
        """, in: nil, contentWorld: .page)
        let facts = try #require(values as? [String])
        #expect(facts[0] == "true", "the real node wrapper remains the focused DOM element")
        #expect(facts[1] == "dashed" && facts[2] == "2px" && facts[3] == "4px")
        #expect(facts[4] == "true" && facts[5] == "true", "Enter still selects the real node/card")
        #expect(facts[6] == "dashed" && facts[7] == "2px" && facts[8] == "4px")
        #expect(facts[9] == "solid", "the inner selection outline remains distinct")
        #expect(facts[10] == "true", "focus and selection must not resize the node")
        #expect(facts[11] == "true", "focus uses the resolved semantic accent in either appearance")
    }

    /// Sidebar CSS is shared with Web/Tauri; the Swift shell itself uses native sidebars.
    /// A small DOM fixture exercises its real stylesheet without enabling a second editor session.
    @Test(arguments: ["light", "dark"], ["pw-settings-item", "pw-asset"])
    func sidebarDeleteFocusIsImmediatelyVisible(scheme: String, rowClass: String) async throws {
        let fixture = try Fixture(scheme: scheme)
        defer { fixture.close() }
        try await fixture.ready()
        try await fixture.modelFocusStates()
        let values = try await fixture.webView.callAsyncJavaScript("""
          const row = document.createElement('div'); row.className = rowClass;
          row.style.cssText = 'position:fixed;top:5px;left:5px;z-index:10000;pointer-events:none';
          const input = document.createElement('input');
          const button = document.createElement('button'); button.className = 'pw-settings-x'; button.textContent = '×';
          let activated = 0; button.addEventListener('click', () => activated++);
          row.append(input, button); document.body.append(row);
          const rest = getComputedStyle(button).opacity;
          button.focus(); button.dataset.testFocusVisible = ''; row.dataset.testFocusWithin = '';
          const focused = getComputedStyle(button);
          const direct = [document.activeElement === button, focused.opacity, focused.outlineStyle,
            focused.outlineWidth, focused.transitionDuration, activated];
          input.focus(); delete button.dataset.testFocusVisible;
          const within = getComputedStyle(button).opacity;
          input.blur(); delete row.dataset.testFocusWithin;
          getComputedStyle(button).opacity;
          for (const animation of button.getAnimations()) animation.finish();
          const blurred = getComputedStyle(button).opacity;
          row.remove();
          return [rest, ...direct, within, blurred].map(String);
        """, arguments: ["rowClass": rowClass], in: nil, contentWorld: .page)
        let facts = try #require(values as? [String])
        #expect(facts[0] == "0")
        #expect(facts[1] == "true")
        #expect(facts[2] == "1" && facts[3] == "solid" && facts[4] == "2px")
        #expect(facts[5] == "0s", "keyboard focus must not wait through an opacity transition")
        #expect(facts[6] == "0", "focusing the delete button never activates it")
        #expect(facts[7] == "1", "focus within the row also reveals its delete action")
        #expect(facts[8] == "0", "leaving the row restores the original non-hover appearance")
    }
}
