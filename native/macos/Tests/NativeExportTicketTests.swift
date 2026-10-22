import Foundation
import Testing
@testable import PlotWeaveNative

/// A preview belongs to a precise format/scope/content key before native delivery is allowed.
struct NativeExportTicketTests {
    /// Switching format blocks an old preview immediately, even before the replacement task starts.
    @Test func formatChangeAndLateCompletionCannotDeliverOldPreview() {
        var ticket = NativeExportTicket()
        let markdown = HostJSON.object(["text": .string("旧 Markdown"), "fileName": .string("script.md")])
        let json = HostJSON.object(["text": .string("{}"), "fileName": .string("script.json")])
        ticket.begin("md-v1")
        ticket.complete("md-v1", value: markdown)
        #expect(ticket.available(for: "md-v1") == markdown)
        #expect(ticket.available(for: "json-v2") == nil)
        ticket.begin("json-v2")
        ticket.complete("md-v1", value: markdown)
        #expect(ticket.available(for: "json-v2") == nil)
        ticket.complete("json-v2", value: json)
        #expect(ticket.available(for: "json-v2") == json)
    }
}
