import SwiftUI

/// Assistant Markdown is rendered with native selectable text and structured blocks inside its existing bubble.
struct NativeMarkdownText: View {
    /// This immutable value is derived from the current reply; it never owns conversation or document state.
    private let document: NativeMarkdownDocument

    /// Parse at the message boundary, retaining attributed inline runs for native delivery.
    init(_ source: String) {
        document = NativeMarkdownDocument.parse(source)
    }

    /// Block spacing replaces Markdown separators while preserving the original recovery diagnostic.
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(document.blocks) { block in
                NativeMarkdownBlockView(block: block)
            }
            if let diagnostic = document.diagnostic {
                Text("部分格式暂无法显示，已保留原文。")
                    .font(.caption).foregroundStyle(.secondary)
                    .help(diagnostic)
            }
        }.textSelection(.enabled)
    }
}

/// List markers and quotation rails accompany the same attributed text, including continuation paragraphs.
private struct NativeMarkdownBlockView: View {
    /// The display parser owns all formatting metadata consumed by this view.
    let block: NativeMarkdownBlock

    /// Depth changes indentation, not stored text or conversation identity.
    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            if block.quoteDepth > 0 {
                RoundedRectangle(cornerRadius: 2).fill(.secondary.opacity(0.5)).frame(width: 3)
            }
            if block.listDepth != nil {
                Text(verbatim: block.marker ?? "").monospacedDigit()
                    .frame(minWidth: 22, alignment: .trailing)
                    .accessibilityHidden(block.marker == nil)
            }
            content
        }
        .padding(.leading, CGFloat((block.listDepth ?? 0) + max(0, block.quoteDepth - 1)) * 12)
        .fixedSize(horizontal: false, vertical: true)
    }

    /// Native Text renders inline emphasis; headings, code and separators need explicit block layout.
    @ViewBuilder private var content: some View {
        switch block.style {
        case .heading(let level):
            Text(inlineContent).font(level <= 2 ? .title3.bold() : .headline)
                .accessibilityAddTraits(.isHeader)
        case .code(let language):
            code(language)
        case .divider:
            Divider().padding(.vertical, 3).accessibilityLabel("分隔线")
        case .paragraph:
            Text(inlineContent).multilineTextAlignment(.leading)
        }
    }

    /// SwiftUI inline code uses a monospace font while bold, emphasis, strike and links retain system intents.
    private var inlineContent: AttributedString {
        var text = block.content
        text.presentationIntent = nil
        for run in Array(text.runs) where run.inlinePresentationIntent?.contains(.code) == true {
            text[run.range].font = .system(.body, design: .monospaced)
        }
        return text
    }

    /// Code is literal and horizontally scrollable so indentation and long lines survive narrow sidebars.
    private func code(_ language: String?) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            if let language, !language.isEmpty {
                Text(verbatim: language).font(.caption).foregroundStyle(.secondary)
            }
            ScrollView(.horizontal) {
                Text(verbatim: String(block.content.characters)).font(.system(.body, design: .monospaced))
                    .fixedSize(horizontal: true, vertical: true)
            }
        }
        .padding(10).background(Color.primary.opacity(0.06), in: .rect(cornerRadius: 8))
    }
}
