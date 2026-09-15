import AppKit
import Foundation
import Observation

/// Host-side appearance semantics for the web canvas
/// (`docs/swiftui-react-flow-migration-plan.md` §2.2): the native side
/// owns a single snapshot source — `NSApp.effectiveAppearance` plus the
/// `NSWorkspace` accessibility display settings — and pushes it to the web
/// side instead of assuming the target WebKit honors every media query.
/// Main-actor isolated: AppKit reads and push callbacks arrive on the main
/// thread.
@MainActor
@Observable
final class CanvasAppearanceState {

    /// Semantic appearance snapshot crossing the host bridge; field values
    /// are host enums and booleans only, so the JSON text doubles as a safe
    /// JS expression literal.
    struct Snapshot: Equatable, Codable {
        /// Window appearance, `"light"` or `"dark"`.
        let colorScheme: String
        let reduceTransparency: Bool
        let increaseContrast: Bool
        let reduceMotion: Bool

        /// Reads the live system values; the sole production reader.
        static func current() -> Snapshot {
            Snapshot(
                colorScheme: currentColorScheme(),
                reduceTransparency: NSWorkspace.shared
                    .accessibilityDisplayShouldReduceTransparency,
                increaseContrast: NSWorkspace.shared
                    .accessibilityDisplayShouldIncreaseContrast,
                reduceMotion: NSWorkspace.shared
                    .accessibilityDisplayShouldReduceMotion
            )
        }

        /// Bridge payload; an encoding failure degrades to an empty object
        /// the web side's validation already rejects.
        var payloadJSON: String {
            guard let data = try? JSONEncoder().encode(self),
                let json = String(data: data, encoding: .utf8)
            else { return "{}" }
            return json
        }

        /// Maps the app's effective appearance onto the bridge contract;
        /// unknown or unmatched appearances fall back to light.
        private static func currentColorScheme() -> String {
            guard
                let appearance = NSApp?.effectiveAppearance,
                let match = appearance.bestMatch(from: [.aqua, .darkAqua])
            else { return "light" }
            return match == NSAppearance.Name.darkAqua ? "dark" : "light"
        }
    }

    /// Reads the live snapshot; injectable so tests can drive changes.
    typealias SnapshotReader = @MainActor () -> Snapshot

    /// Latest snapshot; starts from one reader pass at init.
    private(set) var snapshot: Snapshot

    /// Notified only when a refresh produces an actual change; owned by the
    /// web canvas coordinator, which forwards the payload to the live page.
    var onSnapshotChange: ((Snapshot) -> Void)?

    private let reader: SnapshotReader
    private var appearanceObservation: NSKeyValueObservation?
    private var workspaceObservations: [NSKeyValueObservation] = []

    init(reader: @escaping SnapshotReader = Snapshot.current) {
        self.reader = reader
        self.snapshot = reader()
    }

    /// Starts observing system appearance and accessibility display
    /// settings (KVO-compliant `NSWorkspace` properties). Idempotent: a
    /// second call replaces the observers.
    func startObserving() {
        appearanceObservation = NSApp?.observe(
            \.effectiveAppearance,
            options: []
        ) { [weak self] _, _ in
            Task { @MainActor in self?.refresh() }
        }
        let workspace = NSWorkspace.shared
        workspaceObservations = [
            workspace.observe(
                \.accessibilityDisplayShouldReduceTransparency,
                options: []
            ) { [weak self] _, _ in
                Task { @MainActor in self?.refresh() }
            },
            workspace.observe(
                \.accessibilityDisplayShouldIncreaseContrast,
                options: []
            ) { [weak self] _, _ in
                Task { @MainActor in self?.refresh() }
            },
            workspace.observe(
                \.accessibilityDisplayShouldReduceMotion,
                options: []
            ) { [weak self] _, _ in
                Task { @MainActor in self?.refresh() }
            },
        ]
    }

    /// Stops observing and detaches the change handler so a retained state
    /// object can never push into a gone web view.
    func stopObserving() {
        appearanceObservation = nil
        workspaceObservations = []
        onSnapshotChange = nil
    }

    /// Re-reads the snapshot; publishes only an actual change so identical
    /// snapshots never spam the bridge.
    func refresh() {
        let next = reader()
        guard next != snapshot else { return }
        snapshot = next
        onSnapshotChange?(next)
    }
}
