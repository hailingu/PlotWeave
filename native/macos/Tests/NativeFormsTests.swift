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
}
