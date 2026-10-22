import Observation
import Synchronization
import Testing
@testable import PlotWeaveNative

/// Editor chrome slices (issue #544): selection-only updates keep outline,
/// episode focus, history toolbar and zoom readers quiet while selection
/// identity still reaches its own consumers.
@MainActor
struct NativeEditorSliceObservationTests {

    /// Only selection changes: chrome slices stay quiet, selection identity notifies (S1).
    @Test func selectionOnlyUpdateKeepsChromeSlicesQuiet() throws {
        let state = try makeChromeState()
        let chrome = Mutex(0)
        withObservationTracking {
            _ = state.editorOutline; _ = state.focusedEpisode
            _ = state.canUndo; _ = state.canRedo; _ = state.canvasZoom
            _ = state.editorSettings; _ = state.editorAssets
        } onChange: { chrome.withLock { $0 += 1 } }
        let selection = Mutex(0)
        withObservationTracking { _ = state.selectedNodeID } onChange: { selection.withLock { $0 += 1 } }
        try publish(state, sequence: 2, projection: chromeFixture(selected: "node-b"))
        #expect(chrome.withLock { $0 } == 0, "仅选中变化不得使大纲／集聚焦／历史／缩放切片失效")
        #expect(selection.withLock { $0 } == 1)
        #expect(state.selectedNodeID == "node-b")
    }

    /// Real slice changes notify their own readers while unrelated slices stay quiet (S2).
    @Test(arguments: ["outline", "focusedEpisode", "zoom", "canUndo"])
    func changedSliceNotifiesOnlyItsReader(slice: String) throws {
        let state = try makeChromeState()
        let changed = Mutex(0)
        let quiet = Mutex(0)
        withObservationTracking { _ = read(state, slice: slice) } onChange: { changed.withLock { $0 += 1 } }
        withObservationTracking { _ = read(state, slice: unrelated(slice)) } onChange: { quiet.withLock { $0 += 1 } }
        try publish(state, sequence: 2, projection: changedFixture(slice))
        #expect(changed.withLock { $0 } == 1)
        #expect(quiet.withLock { $0 } == 0)
    }

    /// Changed slices publish their new values to the consumers that render them (S2).
    @Test func changedSlicesPublishNewValues() throws {
        let state = try makeChromeState()
        try publish(state, sequence: 2, projection: changedFixture("outline"))
        #expect(state.editorOutline.array.first?["rows"]?.array.last?["label"]?.string == "改名节点")
        try publish(state, sequence: 3, projection: changedFixture("focusedEpisode"))
        #expect(state.focusedEpisode == .number(2))
        try publish(state, sequence: 4, projection: changedFixture("zoom"))
        #expect(state.canvasZoom == 1.75)
        try publish(state, sequence: 5, projection: changedFixture("canUndo"))
        #expect(state.canUndo && state.canRedo)
        try publish(state, sequence: 6, projection: chromeFixture(selected: nil))
        #expect(state.selectedNodeID == nil)
        #expect(state.editorOutline.array.last?["rows"]?.array.first?["label"]?.string == "未聚焦节点")
    }

    /// Project filtering and both reset entry points clear every slice (S3).
    @Test(arguments: ["switch", "beginSession", "invalidate"])
    func resetsAndProjectSwitchClearSlices(mode: String) throws {
        let state = try makeChromeState()
        let changes = Mutex(0)
        withObservationTracking {
            _ = state.editorOutline; _ = state.focusedEpisode; _ = state.selectedNodeID
            _ = state.canUndo; _ = state.canRedo; _ = state.canvasZoom
            _ = state.editorSettings; _ = state.editorAssets
        } onChange: { changes.withLock { $0 += 1 } }
        switch mode {
        case "switch":
            var next = chromeFixture(selected: "node-a")
            next["app"] = ["route": "editor", "project": ["id": "other", "name": "Other"]]
            try publish(state, sequence: 2, projection: next)
        case "beginSession": state.beginSession("replacement")
        default: state.invalidate("isolated failure")
        }
        #expect(changes.withLock { $0 } == 1)
        #expect(state.editorOutline == .null && state.focusedEpisode == .null)
        #expect(state.selectedNodeID == nil && !state.canUndo && !state.canRedo)
        #expect(state.canvasZoom == 1)
        #expect(state.editorSettings == .null && state.editorAssets == .null)
    }

    /// Retained inactive inspectors must receive real setting/asset edits without observing selection-only updates.
    @Test(arguments: ["settings", "assets"])
    func inspectorContextNotifiesOnlyItsChangedReader(slice: String) throws {
        let state = try makeChromeState()
        let changed = Mutex(0)
        let quiet = Mutex(0)
        withObservationTracking { _ = context(state, slice) } onChange: { changed.withLock { $0 += 1 } }
        withObservationTracking { _ = context(state, slice == "settings" ? "assets" : "settings") } onChange: { quiet.withLock { $0 += 1 } }
        var next = chromeFixture()
        var editor = try #require(next["editor"] as? [String: Any])
        if slice == "settings" { editor[slice] = ["characters": [["id": "character", "name": "新名"]], "locations": []] }
        else { editor[slice] = ["byId": ["asset": ["mime": "audio/wav"]]] }
        next["editor"] = editor
        try publish(state, sequence: 2, projection: next)
        #expect(changed.withLock { $0 } == 1)
        #expect(quiet.withLock { $0 } == 0)
        if slice == "settings" { #expect(state.editorSettings["characters"]?.array.first?["name"]?.string == "新名") }
        else { #expect(state.editorAssets["byId"]?["asset"]?["mime"]?.string == "audio/wav") }
    }

    /// Each cached field observes only the project-filtered data it actually displays.
    private func context(_ state: NativeApplicationState, _ slice: String) -> HostJSON {
        slice == "settings" ? state.editorSettings : state.editorAssets
    }

    // MARK: helpers

    /// Synthetic projections exercise the production validation owner without services or user data.
    private func makeChromeState() throws -> NativeApplicationState {
        let state = NativeApplicationState()
        state.beginSession("page")
        try publish(state, sequence: 1, projection: chromeFixture())
        return state
    }

    /// All domains share one project identity; the editor domain carries every chrome slice.
    private func chromeFixture(selected: String? = "node-a", project: String = "project") -> [String: Any] {
        var editor: [String: Any] = [
            "projectId": project,
            "settings": ["characters": [["id": "character", "name": "原名"]], "locations": []],
            "assets": ["byId": ["asset": ["mime": "image/png"]]],
            "outline": [
                ["episode": 1, "title": "第一集", "rows": [["id": "node-a", "label": "场景甲", "level": 1]]],
                ["episode": 2, "title": "第二集", "rows": [["id": "node-c", "label": "未聚焦节点", "level": 1]]],
            ],
            "focusedEpisode": 1,
            "canUndo": false,
            "canRedo": false,
            "zoom": 1.25,
        ]
        if let selected {
            editor["selected"] = ["id": selected, "type": "scene", "data": ["name": "Fixture node"]]
        }
        return [
            "app": ["route": "editor", "project": ["id": project, "name": "Fixture"]],
            "editor": editor,
            "ai": ["projectId": project], "image": ["projectId": project], "settings": ["models": []],
        ]
    }

    /// Changes exactly one slice while selection identity and the other slices keep their values.
    private func changedFixture(_ slice: String) -> [String: Any] {
        var next = chromeFixture()
        var editor = next["editor"] as? [String: Any] ?? [:]
        switch slice {
        case "outline":
            editor["outline"] = [
                ["episode": 1, "title": "第一集", "rows": [["id": "node-a", "label": "改名节点", "level": 1]]],
                ["episode": 2, "title": "第二集", "rows": [["id": "node-c", "label": "未聚焦节点", "level": 1]]],
            ]
        case "focusedEpisode":
            editor["focusedEpisode"] = 2
        case "zoom":
            editor["zoom"] = 1.75
        default:
            editor["canUndo"] = true
            editor["canRedo"] = true
        }
        next["editor"] = editor
        return next
    }

    /// The same complete ordered envelope enters every production projection transition.
    private func publish(_ state: NativeApplicationState, sequence: Int, projection: [String: Any]) throws {
        try state.receiveProjection(["protocolVersion": 1, "sessionId": "page", "sequence": sequence, "projection": projection])
    }

    /// Reads the public slice surface the way each real native consumer does.
    private func read(_ state: NativeApplicationState, slice: String) -> Any {
        switch slice {
        case "outline": state.editorOutline
        case "focusedEpisode": state.focusedEpisode
        case "zoom": state.canvasZoom
        default: state.canUndo
        }
    }

    /// Pairs each changed slice with one that must stay quiet in the same transition.
    private func unrelated(_ slice: String) -> String {
        switch slice {
        case "outline": "zoom"
        case "focusedEpisode": "canUndo"
        case "zoom": "outline"
        default: "focusedEpisode"
        }
    }
}
