import Observation
import SwiftUI
import Synchronization
import Testing
@testable import PlotWeaveNative

/// Projection notifications follow changed presentation domains without invalidating unrelated shell readers.
@MainActor
struct NativeProjectionObservationTests {
    /// The production root's body depends on navigation and visibility, not ordinary node selection.
    @Test func editorSelectionDoesNotInvalidateShellBody() throws {
        let state = try makeState()
        let root = NativeShellRoot(application: state)
        let changes = Mutex(0)
        withObservationTracking { _ = root.body } onChange: { changes.withLock { $0 += 1 } }
        try publish(state, sequence: 2, projection: fixture(selected: "second"))
        #expect(changes.withLock { $0 } == 0)
        #expect(state.editor["selected"]?["id"]?.string == "second")
    }

    /// Real navigation and title changes still invalidate the production root and publish their new values.
    @Test(arguments: ["name", "route", "id"])
    func navigationChangesNotifyShellBody(field: String) throws {
        let state = try makeState()
        let root = NativeShellRoot(application: state)
        let changes = Mutex(0)
        withObservationTracking { _ = root.body } onChange: { changes.withLock { $0 += 1 } }
        var next = fixture()
        var app = try #require(next["app"] as? [String: Any])
        if field == "route" {
            app["route"] = "settings"
        } else {
            var project = try #require(app["project"] as? [String: Any])
            project[field] = "replacement"
            app["project"] = project
        }
        next["app"] = app
        try publish(state, sequence: 2, projection: next)
        #expect(changes.withLock { $0 } == 1)
        switch field {
        case "name": #expect(state.projectName == "replacement")
        case "route": #expect(state.route == "settings")
        default: #expect(state.projectId == "replacement" && state.editor == .null)
        }
    }

    /// Unchanged domains remain usable without scheduling work when a different node becomes selected.
    @Test(arguments: ["app", "ai", "image", "settings"])
    func editorSelectionDoesNotInvalidateOtherDomains(domain: String) throws {
        let state = try makeState()
        let changes = Mutex(0)
        withObservationTracking { _ = read(state, domain: domain) } onChange: { changes.withLock { $0 += 1 } }
        try publish(state, sequence: 2, projection: fixture(selected: "second"))
        #expect(changes.withLock { $0 } == 0)
        #expect(state.editor["selected"]?["id"]?.string == "second")
    }

    /// Actual domain changes still reach the subscribed reader rather than being hidden by isolation.
    @Test(arguments: ["app", "editor", "ai", "image", "settings"])
    func changedDomainNotifiesItsReader(domain: String) throws {
        let state = try makeState()
        let changes = Mutex(0)
        withObservationTracking { _ = read(state, domain: domain) } onChange: { changes.withLock { $0 += 1 } }
        var next = fixture()
        var section = try #require(next[domain] as? [String: Any])
        section["testValue"] = "changed"
        next[domain] = section
        try publish(state, sequence: 2, projection: next)
        #expect(changes.withLock { $0 } == 1)
        #expect(read(state, domain: domain)["testValue"]?.string == "changed")
    }

    /// Project identity changes revalidate retained feature domains before their replacement arrives.
    @Test func projectSwitchFiltersOldFeatureDomainsAndNotifies() throws {
        let state = try makeState()
        let changes = Mutex(0)
        withObservationTracking { _ = state.editor; _ = state.ai; _ = state.image } onChange: { changes.withLock { $0 += 1 } }
        var next = fixture()
        next["app"] = ["route": "editor", "project": ["id": "replacement", "name": "Replacement"]]
        try publish(state, sequence: 2, projection: next)
        #expect(changes.withLock { $0 } == 1)
        #expect(state.projectId == "replacement")
        #expect(state.projectName == "Replacement")
        #expect(state.editor == .null && state.ai == .null && state.image == .null)
        try publish(state, sequence: 3, projection: fixture(project: "replacement"))
        #expect(state.editor["projectId"]?.string == "replacement")
        #expect(state.ai["projectId"]?.string == "replacement")
        #expect(state.image["projectId"]?.string == "replacement")
    }

    /// Equal snapshots consume their sequence without invalidating readers; rejected or malformed ones publish nothing.
    @Test func equalAndRejectedSnapshotsKeepNotificationsQuiet() throws {
        let state = try makeState()
        let changes = Mutex(0)
        withObservationTracking { _ = state.projection; _ = state.app; _ = state.editor } onChange: { changes.withLock { $0 += 1 } }
        try publish(state, sequence: 5, projection: fixture())
        try publish(state, sequence: 4, projection: fixture(selected: "stale"))
        try publish(state, sequence: 6, projection: fixture(selected: "wrong-page"), session: "old-page")
        var invalid = fixture(selected: "invalid")
        invalid["app"] = ["route": "unsupported"]
        #expect(throws: HostFailure.self) { try publish(state, sequence: 6, projection: invalid) }
        #expect(changes.withLock { $0 } == 0)
        #expect(state.editor["selected"]?["id"]?.string == "first")
        try publish(state, sequence: 6, projection: fixture(selected: "recovered"))
        #expect(state.editor["selected"]?["id"]?.string == "recovered")
        #expect(changes.withLock { $0 } == 1)
    }

    /// Both lifecycle reset entry points clear every cached presentation value and admit only the new page.
    @Test(arguments: [false, true])
    func resetClearsEveryPresentationDomain(failure: Bool) throws {
        let state = try makeState()
        let changes = Mutex(0)
        withObservationTracking { _ = state.editor } onChange: { changes.withLock { $0 += 1 } }
        if failure {
            state.invalidate("isolated failure")
            #expect(state.error == "isolated failure")
        } else {
            state.beginSession("replacement-page")
        }
        #expect(changes.withLock { $0 } == 1)
        #expect(state.projection == .object([:]))
        #expect(state.projectId == nil && state.projectName == "PlotWeave" && state.route == "loading")
        for domain in ["app", "editor", "ai", "image", "settings"] { #expect(read(state, domain: domain) == .null) }
        try publish(state, sequence: 2, projection: fixture(selected: "old"))
        #expect(state.editor == .null)
        if failure { state.beginSession("replacement-page") }
        #expect(state.error == nil)
        try publish(state, sequence: 1, projection: fixture(selected: "new"), session: "replacement-page")
        #expect(state.editor["selected"]?["id"]?.string == "new")
        state.beginSession("replacement-page")
        #expect(state.editor["selected"]?["id"]?.string == "new")
    }

    /// Synthetic projections exercise the production validation owner without services or user data.
    private func makeState() throws -> NativeApplicationState {
        let state = NativeApplicationState()
        state.beginSession("page")
        try publish(state, sequence: 1, projection: fixture())
        return state
    }

    /// All domains share one project identity so tests can vary one field without changing unrelated values.
    private func fixture(selected: String = "first", project: String = "project") -> [String: Any] {
        [
            "app": ["route": "editor", "project": ["id": project, "name": "Fixture"]],
            "editor": ["projectId": project, "selected": ["id": selected, "type": "scene", "data": ["name": "Fixture node"]]],
            "ai": ["projectId": project], "image": ["projectId": project], "settings": ["models": []]
        ]
    }

    /// The same complete ordered envelope enters every production projection transition.
    private func publish(_ state: NativeApplicationState, sequence: Int, projection: [String: Any], session: String = "page") throws {
        try state.receiveProjection(["protocolVersion": 1, "sessionId": session, "sequence": sequence, "projection": projection])
    }

    /// Reading the public presentation surface establishes the dependency each real native consumer uses.
    private func read(_ state: NativeApplicationState, domain: String) -> HostJSON {
        switch domain {
        case "app": state.app
        case "editor": state.editor
        case "ai": state.ai
        case "image": state.image
        default: state.settings
        }
    }
}
