import Foundation
import Observation

/// Load lifecycle of the embedded web canvas, backing the M01 readiness
/// contract (`docs/swiftui-react-flow-migration-plan.md` §6): a visible
/// diagnostic on failure instead of a fake empty canvas, and a late ready
/// from an already-failed load cannot mask the failure.
enum WebCanvasPhase: Equatable {
    /// The page is loading and has not reported the ready handshake yet.
    case loading
    /// The web canvas reported the ready handshake.
    case ready
    /// Loading or the handshake failed; carries a user-facing diagnostic.
    case failed(String)
}

/// State machine owned by the web canvas section; transitions are explicit
/// methods so ordering stays testable. Main-actor isolated: WKWebView
/// callbacks and SwiftUI updates all arrive on the main thread.
@MainActor
@Observable
final class WebCanvasState {

    /// Current load phase; private(set) keeps every transition named.
    private(set) var phase: WebCanvasPhase = .loading

    /// Increments on retry; the host reloads the page when it changes.
    private(set) var reloadToken = 0

    /// Records the web ready handshake; ignored once a load has failed so a
    /// stale page can never overwrite the diagnostic.
    func markReady() {
        if case .loading = phase {
            phase = .ready
        }
    }

    /// Records a load or handshake failure with a user-facing diagnostic.
    func fail(_ message: String) {
        phase = .failed(message)
    }

    /// Resets to loading for a user-triggered reload; bumps reloadToken so
    /// the host starts a fresh load.
    func retry() {
        phase = .loading
        reloadToken += 1
    }
}
