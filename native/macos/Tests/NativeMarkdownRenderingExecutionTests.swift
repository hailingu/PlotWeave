import SwiftUI
import Testing
@testable import PlotWeaveNative

/// Rendered native text preserves visible content and fallback diagnostics without snapshot or VoiceOver acceptance.
@MainActor
@Suite(.serialized)
struct NativeMarkdownRenderingExecutionTests {
    /// Structured headings, quotation, list markers and literal code survive the actual SwiftUI presentation layer.
    @Test func structuredReplyRendersOriginalContent() async throws {
        let source = "# Semantic heading\n\nA **bold** and `inline` idea.\n\n> Quoted text\n\n- List entry\n\n```swift\nlet fixture = 1\n```\n\n---"
        let view = NativeCoverageWindow(NativeMarkdownText(source))
        defer { view.close() }
        let strings = try await view.strings()
        for expected in ["Semantic heading", "A bold and inline idea.", "Quoted text", "List entry", "let fixture = 1"] {
            #expect(strings.contains { $0.contains(expected) }, "Rendered text is missing \(expected)")
        }
    }

    /// Unsupported formatting retains the full original source and the explicit recovery message in real rendered text.
    @Test func unsupportedReplyShowsOriginalSourceAndRecoveryMessage() async throws {
        let source = "| Name | Role |\n| --- | --- |\n| Lin | Actor |"
        let view = NativeCoverageWindow(NativeMarkdownText(source))
        defer { view.close() }
        let strings = try await view.strings()
        #expect(strings.contains { $0.contains("Name | Role") && $0.contains("Lin | Actor") })
        #expect(strings.contains("部分格式暂无法显示，已保留原文。"))
    }
}
