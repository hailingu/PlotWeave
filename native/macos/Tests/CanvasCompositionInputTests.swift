import AppKit
import Testing
import WebKit
@testable import PlotWeaveNative

/// M03/M13 IME composition chain (plan §6 M03 row, issue #570): the canvas
/// inline rename inside a real WKWebView must keep the composition alive
/// across both browser event orders. The spec order delivers the in-flight
/// confirm/cancel keydown with `isComposing === true`; WebKit instead sends
/// `compositionend` first and the same key arrives late with
/// `isComposing === false` and only `keyCode === 229` (WebKit bug 165004).
/// The production page must treat both as input-method keys — no commit, no
/// edit exit — while a genuine Enter still commits the final text.
/// Real input-method candidate windows, marked-text rendering, system focus
/// loss and window deactivation remain manual gaps (P5 evidence §1).
@MainActor
@Suite(.serialized, WebKitTestIsolation())
struct CanvasCompositionInputTests {

    private struct Timeout: Error {}

    /// The inline rename keeps its composition (both orders) and a genuine Enter commits the confirmed text.
    @Test func inlineRenameKeepsCompositionAliveAcrossBothEventOrders() async throws {
        let fixture = try #require(Self.fixtureEntry())
        let state = WebCanvasState()
        let coordinator = WebCanvasCoordinator(state: state, appearance: CanvasAppearanceState(), entryURL: fixture)
        let configuration = WKWebViewConfiguration()
        configuration.userContentController.add(coordinator, name: WebCanvasCoordinator.bridgeName)
        let webView = try IsolatedWebViewFixture.makeWebView(frame: NSRect(x: 0, y: 0, width: 1100, height: 750), configuration: configuration)
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
        coordinator.loadCanvas(into: webView)
        try await Self.waitForReady(state: state, webView: webView)

        let original = try await Self.enterRename(webView)
        #expect(!original.isEmpty, "the demo node card must expose the inline rename")
        // Spec order: composition in flight, the confirm keydown carries isComposing.
        var stage = try await Self.compositionStage(webView, mode: "spec")
        #expect(stage.stillEditing, "spec order: the in-flight Enter belongs to the input method and must not commit the rename")
        #expect(stage.value == "qing", "spec order: the marked text stays in the local draft buffer")
        // WebKit order: compositionend already delivered, the late Enter only carries keyCode 229.
        stage = try await Self.compositionStage(webView, mode: "late")
        #expect(stage.stillEditing, "webkit order: the late keyCode-229 Enter is still an input-method key")
        #expect(stage.value == "清", "webkit order: the confirmed text survives the late confirm key")
        // The cancel key must behave the same way in both orders.
        stage = try await Self.compositionStage(webView, mode: "escape")
        #expect(stage.stillEditing, "a composition Escape only cancels the input-method synthesis, never the edit session")
        #expect(stage.value == "清", "a composition Escape keeps the previously confirmed draft")
        // A genuine Enter after the composition still commits exactly once.
        let commit = try await Self.realEnterCommit(webView)
        #expect(commit.editingExited, "a genuine Enter must still exit the inline rename")
        #expect(commit.name == "清", "a genuine Enter commits the final composition text: \(commit.name)")
    }

    // MARK: helpers

    /// One composition stage's observable outcome in the live page.
    private struct StageFacts {
        let stillEditing: Bool
        let value: String
    }

    /// The committed outcome after the genuine Enter.
    private struct CommitFacts {
        let editingExited: Bool
        let name: String
    }

    /// Bundle entry with the 9-node demo fragment; standalone webview drive.
    private static func fixtureEntry() -> URL? {
        guard let url = Bundle.main.url(forResource: "native-canvas", withExtension: "html") else { return nil }
        var parts = URLComponents(url: url, resolvingAgainstBaseURL: false)
        parts?.fragment = "fixture"
        return parts?.url
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

    /// Double-clicks the first node card name and returns its original text.
    private static func enterRename(_ webView: WKWebView) async throws -> String {
        let original = try await webView.callAsyncJavaScript("""
          const button = document.querySelector('.react-flow__node .pw-editable');
          if (!button) return null;
          const original = button.textContent;
          button.dispatchEvent(new MouseEvent('dblclick', {bubbles: true, cancelable: true, view: window}));
          await new Promise(resolve => requestAnimationFrame(() => resolve(null)));
          const input = document.querySelector('.pw-rename');
          if (!input) return null;
          input.focus();
          return original;
        """, in: nil, contentWorld: .page)
        return try #require(original as? String, "the demo node card must expose the inline rename")
    }

    /// Runs one composition stage in the live inline rename and returns its facts.
    ///
    /// Modes map to the issue #570 matrix rows: "spec" confirms with an
    /// in-flight isComposing Enter over the marked text "qing"; "late" ends
    /// the composition and then sends the WebKit-ordered keyCode-229 Enter;
    /// "escape" starts a second composition over "ming", cancels it with an
    /// isComposing Escape, then a late keyCode-229 Escape. The prototype
    /// value setter bypasses React's value tracker so each input event
    /// behaves like real typing.
    private static func compositionStage(_ webView: WKWebView, mode: String) async throws -> StageFacts {
        let values = try await webView.callAsyncJavaScript("""
          const input = document.querySelector('.pw-rename');
          if (!input) return ['no-input', ''];
          const setValue = (v, composing) => {
            const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
            setter.call(input, v);
            input.dispatchEvent(new InputEvent('input', {
              bubbles: true, cancelable: true, isComposing: composing, data: v,
              inputType: composing ? 'insertCompositionText' : 'insertText'
            }));
          };
          const keyDown = (k, code, composing) => input.dispatchEvent(
            new KeyboardEvent('keydown', {key: k, keyCode: code, isComposing: composing, bubbles: true, cancelable: true})
          );
          const frame = () => new Promise(resolve => requestAnimationFrame(() => resolve(null)));
          if (mode === 'spec') {
            input.dispatchEvent(new CompositionEvent('compositionstart', {bubbles: true}));
            setValue('qing', true);
            keyDown('Enter', 229, true);
            await frame();
            return [String(!!document.querySelector('.pw-rename')), input.value];
          }
          if (mode === 'late') {
            setValue('清', false);
            input.dispatchEvent(new CompositionEvent('compositionend', {bubbles: true, data: '清'}));
            keyDown('Enter', 229, false);
            await frame();
            return [String(!!document.querySelector('.pw-rename')), input.value];
          }
          input.dispatchEvent(new CompositionEvent('compositionstart', {bubbles: true}));
          setValue('ming', true);
          keyDown('Escape', 229, true);
          await frame();
          if (!document.querySelector('.pw-rename')) return ['false', input.value];
          setValue('清', false);
          input.dispatchEvent(new CompositionEvent('compositionend', {bubbles: true, data: ''}));
          keyDown('Escape', 229, false);
          await frame();
          return [String(!!document.querySelector('.pw-rename')), input.value];
        """, arguments: ["mode": mode], in: nil, contentWorld: .page)
        let facts = try #require(values as? [Any], "composition stage \(mode) must return its facts")
        return StageFacts(
            stillEditing: try #require(facts.first as? String) == "true",
            value: try #require(facts.last as? String)
        )
    }

    /// Sends a genuine Enter and waits for the rename to commit on the node card.
    private static func realEnterCommit(_ webView: WKWebView) async throws -> CommitFacts {
        let values = try await webView.callAsyncJavaScript("""
          const input = document.querySelector('.pw-rename');
          if (!input) return ['false', 'no-input'];
          input.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', keyCode: 13, bubbles: true, cancelable: true}));
          const deadline = Date.now() + 2000;
          while (Date.now() < deadline) {
            if (!document.querySelector('.pw-rename')) break;
            await new Promise(resolve => setTimeout(resolve, 20));
          }
          const button = document.querySelector('.react-flow__node .pw-editable');
          return [String(!document.querySelector('.pw-rename')), button ? button.textContent : 'no-button'];
        """, in: nil, contentWorld: .page)
        let facts = try #require(values as? [Any], "the genuine Enter must return its commit facts")
        return CommitFacts(
            editingExited: try #require(facts.first as? String) == "true",
            name: try #require(facts.last as? String)
        )
    }
}
