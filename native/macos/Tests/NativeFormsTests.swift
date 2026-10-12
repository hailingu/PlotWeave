import Foundation
import Testing
@testable import PlotWeaveNative

/// Native form rules keep drafts local and enforce the shared projection/intent contracts.
@MainActor
struct NativeFormsTests {
    /// Presentation accepts both stored timestamp forms without changing the metadata or inventing dates for damage.
    @Test func projectDatesPreserveMillisecondsAndRejectInvalidMetadata() throws {
        for (timestamp, expected) in [("2026-10-12T03:05:04.123Z", 1_791_774_304.123),
                                      ("2026-10-12T03:05:04Z", 1_791_774_304.0)] {
            let project = try #require(NativeProjectProjection(.object([
                "id": .string("dated"), "name": .string("Date"), "updatedAt": .string(timestamp)
            ])))
            let date = try #require(project.updatedDate)
            #expect(abs(date.timeIntervalSince1970 - expected) < 0.0001)
            #expect(project.updatedAt == timestamp)
        }
        for metadata in [HostJSON.object([:]), .object(["updatedAt": .string("invalid")]),
                         .object(["updatedAt": .string("2026-10-12T03:05:04.123Z"), "error": .string("损坏")])] {
            var value = try #require(metadata.object)
            value["id"] = .string("dated")
            value["name"] = .string("Date")
            #expect(NativeProjectProjection(.object(value))?.updatedDate == nil)
        }
    }

    /// The complete library retains persisted IDs, source ordering and dirty-data diagnostics.
    @Test func homePreservesAllIdentitiesAndUnreadableProjects() {
        let projects = HostJSON.array([
            .object(["id": .string("first"), "name": .string("Night 剧本"), "updatedAt": .string("2026-10-04T00:00:00Z")]),
            .object(["id": .string("dirty"), "name": .string("损坏项目"), "error": .string("无法读取")]),
            .object(["id": .string("second"), "name": .string("白天"), "updatedAt": .string("2026-10-03T00:00:00Z")])
        ])
        let home = NativeHomeProjection(.object(["projects": projects, "loading": .bool(false)]))
        #expect(home.projects.map(\.id) == ["first", "dirty", "second"])
        #expect(home.projects[1].error == "无法读取")
        #expect(home.canMutate(busy: false))
        #expect(!home.canMutate(busy: true))
        #expect(!NativeHomeProjection(.null).canMutate(busy: false))
    }

    /// Confirmation uses the current list, so a removed target cannot issue another delete.
    @Test func staleHomeConfirmationCannotDeleteAnotherTarget() {
        let home = NativeHomeProjection(.object(["loading": .bool(false), "projects": .array([
            .object(["id": .string("new"), "name": .string("同名项目")])
        ])]))
        #expect(!home.contains(id: "old"))
        #expect(home.contains(id: "new"))
    }

    /// Native fields never turn an unready/error/closing snapshot into writable defaults.
    @Test func settingsMutationsRequireLoadedIdleOwner() {
        for phase in ["loading", "error", "unknown"] {
            let settings = NativeSettingsProjection(.object(["phase": .string(phase)]))
            #expect(!settings.canMutate(busy: false))
        }
        let ready = NativeSettingsProjection(.object(["phase": .string("ready"), "closing": .bool(false)]))
        #expect(ready.canMutate(busy: false))
        #expect(!ready.canMutate(busy: true))
        let closing = NativeSettingsProjection(.object(["phase": .string("ready"), "closing": .bool(true)]))
        #expect(!closing.canMutate(busy: false))
    }

    /// The existing provider patch contract trims model lines, locks built-in labels, and clears key drafts on send.
    @Test func providerDraftKeepsSecretsOutOfOrdinaryPatches() throws {
        let provider = try #require(NativeProviderProjection(.object([
            "id": .string("openai"), "label": .string("OpenAI 兼容"), "baseUrl": .string("https://example.test/v1"),
            "enabled": .bool(true), "models": .array([.string("chat")]), "keyConfigured": .bool(true)
        ])))
        #expect(provider.isBuiltin)
        var draft = NativeProviderDraft(provider)
        draft.models = " chat \n\n image \n "
        draft.key = "  fixture-only-key  "
        #expect(draft.modelsPatch == .object(["models": .array([.string("chat"), .string("image")])]))
        #expect(draft.takeKeyArguments(id: provider.id) == ["id": .string("openai"), "key": .string("fixture-only-key")])
        #expect(draft.key.isEmpty)
        #expect(draft.takeKeyArguments(id: provider.id) == nil)
        #expect(draft.modelsPatch["key"] == nil)
        #expect(draft.modelsPatch["keyEnc"] == nil)
    }

    /// Clean fields follow authority; dirty model text survives earlier echoes and canonical acknowledgment.
    @Test func providerProjectionAcknowledgesWithoutReplacingNewerCaretText() throws {
        let initial = try provider(label: "初始", url: "https://initial.test/v1", models: ["old"])
        let earlier = try provider(label: "更新", url: "https://next.test/v1", models: ["first"])
        var draft = NativeProviderDraft(initial)
        draft.models = " first \n second \n "
        draft.receive(previous: initial, next: earlier)
        #expect(draft.label == "更新")
        #expect(draft.baseUrl == "https://next.test/v1")
        #expect(draft.models == " first \n second \n ")
        #expect(draft.modelsPatch == .object(["models": .array([.string("first"), .string("second")])]))
        let acknowledged = try provider(label: "更新", url: "https://next.test/v1", models: ["first", "second"])
        draft.receive(previous: earlier, next: acknowledged)
        #expect(draft.models == " first \n second \n ")
        let external = try provider(label: "外部", url: "https://external.test/v1", models: ["external"])
        draft.receive(previous: acknowledged, next: external)
        #expect(draft.label == "外部")
        #expect(draft.baseUrl == "https://external.test/v1")
        #expect(draft.models == "external")
    }

    /// Ordinary failed drafts remain local while a replacement form starts from the actual authority.
    @Test func failedProviderDraftSurvivesEchoButDoesNotResurrectAfterRemount() throws {
        let initial = try provider(label: "初始", url: "https://initial.test/v1", models: ["old"])
        var draft = NativeProviderDraft(initial)
        draft.label = "未确认文字"
        draft.baseUrl = "尚在输入的地址"
        draft.models = "new\n"
        draft.receive(previous: initial, next: initial)
        #expect(draft.label == "未确认文字")
        #expect(draft.baseUrl == "尚在输入的地址")
        #expect(draft.models == "new\n")
        let replacement = NativeProviderDraft(initial)
        #expect(replacement.label == "初始")
        #expect(replacement.baseUrl == "https://initial.test/v1")
        #expect(replacement.models == "old")
    }

    /// Complete credential-free snapshots isolate provider acknowledgment semantics from services and UI layout.
    private func provider(label: String, url: String, models: [String]) throws -> NativeProviderProjection {
        try #require(NativeProviderProjection(.object([
            "id": .string("fixture"), "label": .string(label), "baseUrl": .string(url),
            "enabled": .bool(true), "models": .array(models.map(HostJSON.string)), "keyConfigured": .bool(false)
        ])))
    }
}
