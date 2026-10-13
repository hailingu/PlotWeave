import Foundation
import Testing
@testable import PlotWeaveNative

/// Host appearance semantics for the web canvas
/// (`docs/swiftui-react-flow-migration-plan.md` §2.2): the native side owns
/// a single snapshot source (`NSApp.effectiveAppearance` + `NSWorkspace`
/// accessibility display settings), publishes only actual changes, and
/// encodes the payload the web bridge validates.
@MainActor
struct CanvasAppearanceStateTests {

    /// The erased system reader stays compatible with the main-actor
    /// bridge callable; compiler probes additionally verify call isolation.
    @Test func systemReaderRetainsMainActorContract() {
        let reader: Any = CanvasAppearanceState.Snapshot.current
        #expect(reader is @MainActor () -> CanvasAppearanceState.Snapshot)
    }

    /// The bridge payload must round-trip every semantic field so the web
    /// side can consume it without a second interpretation.
    @Test func payloadJSONRoundTripsEverySemanticField() throws {
        let snapshot = CanvasAppearanceState.Snapshot(
            colorScheme: "dark",
            reduceTransparency: true,
            increaseContrast: false,
            reduceMotion: true
        )
        let decoded = try JSONDecoder().decode(
            CanvasAppearanceState.Snapshot.self,
            from: Data(snapshot.payloadJSON.utf8)
        )
        #expect(decoded == snapshot)
    }

    /// The production reader must answer within the bridge contract, not
    /// crash or return off-contract values.
    @Test func currentSnapshotStaysWithinBridgeContract() {
        let current = CanvasAppearanceState.Snapshot.current()
        #expect(current.colorScheme == "light" || current.colorScheme == "dark")
    }

    /// Only an actual change may notify: identical snapshots stay silent,
    /// a change notifies exactly once with the new value.
    @Test func refreshNotifiesOnlyOnActualChange() {
        let forced = ForcedSnapshot(
            CanvasAppearanceState.Snapshot(
                colorScheme: "light",
                reduceTransparency: false,
                increaseContrast: false,
                reduceMotion: false
            )
        )
        let state = CanvasAppearanceState(reader: { forced.value })
        var notified: [CanvasAppearanceState.Snapshot] = []
        state.onSnapshotChange = { notified.append($0) }

        state.refresh()
        #expect(notified.isEmpty)

        forced.value = CanvasAppearanceState.Snapshot(
            colorScheme: "dark",
            reduceTransparency: false,
            increaseContrast: true,
            reduceMotion: false
        )
        state.refresh()
        #expect(notified == [forced.value])

        state.refresh()
        #expect(notified.count == 1)
    }

    /// Stopping observation detaches the change handler so a retained state
    /// object can never push into a gone web view.
    @Test func stopObservingDetachesChangeHandler() {
        let state = CanvasAppearanceState(reader: {
            CanvasAppearanceState.Snapshot(
                colorScheme: "light",
                reduceTransparency: false,
                increaseContrast: false,
                reduceMotion: false
            )
        })
        state.onSnapshotChange = { _ in
            Issue.record("handler must not fire after stopObserving")
        }
        state.startObserving()
        state.stopObserving()
        #expect(state.onSnapshotChange == nil)
    }
}

/// Mutable holder giving tests a controllable reader behind
/// ``CanvasAppearanceState``.
@MainActor
private final class ForcedSnapshot {
    var value: CanvasAppearanceState.Snapshot

    init(_ value: CanvasAppearanceState.Snapshot) {
        self.value = value
    }
}
