import Foundation

/// Block styles bridge Foundation presentation intents to native message typography.
enum NativeMarkdownStyle: Equatable {
    case paragraph
    case heading(Int)
    case code(String?)
    case divider
}

/// One semantic block retains inline formatting, list membership and quotation depth.
struct NativeMarkdownBlock: Identifiable {
    /// Position in the derived message, independent of persisted conversation identity.
    let id: Int
    /// Inline runs remain attributed rather than reparsed or serialized.
    var content: AttributedString
    /// The innermost block determines its native typography.
    let style: NativeMarkdownStyle
    /// A list item gets its marker only on its first block.
    let marker: String?
    /// Nil indicates no list; zero is an outermost list item or continuation.
    let listDepth: Int?
    /// Nested quotations retain their indentation without a second document model.
    let quoteDepth: Int
}

/// Read-only Markdown derivation uses the system parser and preserves source on unsupported or failed input.
struct NativeMarkdownDocument {
    /// Consecutive inline runs are grouped by their owning block identity.
    let blocks: [NativeMarkdownBlock]
    /// Stable display diagnostics explain an explicit original-text recovery.
    let diagnostic: String?

    /// Assistant replies are parsed without extended attributes, HTML execution or media loading.
    static func parse(_ source: String) -> Self {
        guard !source.isEmpty else { return Self(blocks: [], diagnostic: nil) }
        do {
            var parsed = try AttributedString(markdown: source, options: .init(
                allowsExtendedAttributes: false, interpretedSyntax: .full, failurePolicy: .throwError
            ))
            guard !parsed.characters.isEmpty else { return original(source, diagnostic: "PW_AI_MARKDOWN_EMPTY") }
            for run in parsed.runs {
                let components = run.presentationIntent?.components ?? []
                guard components.allSatisfy({ supported($0.kind) }) else {
                    return original(source, diagnostic: "PW_AI_MARKDOWN_UNSUPPORTED")
                }
                if run.imageURL != nil && parsed[run.range].characters.contains("\u{FFFC}") {
                    return original(source, diagnostic: "PW_AI_MARKDOWN_IMAGE")
                }
            }
            sanitize(&parsed)
            return Self(blocks: group(parsed), diagnostic: nil)
        } catch {
            return original(source, diagnostic: "PW_AI_MARKDOWN_INVALID")
        }
    }

    /// Recovery shows the entire original message instead of partially losing blocks or inline content.
    private static func original(_ source: String, diagnostic: String) -> Self {
        Self(blocks: [NativeMarkdownBlock(id: 0, content: AttributedString(source), style: .paragraph,
                                         marker: nil, listDepth: nil, quoteDepth: 0)], diagnostic: diagnostic)
    }

    /// Unsupported table and future block intents trigger whole-message recovery until native layout exists.
    private static func supported(_ kind: PresentationIntent.Kind) -> Bool {
        switch kind {
        case .paragraph, .header, .codeBlock, .thematicBreak, .orderedList, .unorderedList, .listItem, .blockQuote:
            return true
        case .table, .tableHeaderRow, .tableRow, .tableCell:
            return false
        @unknown default:
            return false
        }
    }

    /// Only explicit HTTP(S) links remain interactive; image attributes never leave the parser layer.
    private static func sanitize(_ parsed: inout AttributedString) {
        for run in Array(parsed.runs) {
            parsed[run.range].imageURL = nil
            if let link = run.link {
                let scheme = link.scheme?.lowercased()
                if (scheme != "https" && scheme != "http") || link.host?.isEmpty != false {
                    parsed[run.range].link = nil
                }
            }
        }
    }

    /// Block identity, rather than inline-run count, determines paragraph and list boundaries.
    private static func group(_ parsed: AttributedString) -> [NativeMarkdownBlock] {
        var blocks: [NativeMarkdownBlock] = []
        var lastIdentity: Int?
        var emittedItems: Set<Int> = []
        for run in parsed.runs {
            let components = run.presentationIntent?.components ?? []
            let identity = components.first?.identity
            if identity == lastIdentity && !blocks.isEmpty {
                blocks[blocks.count - 1].content.append(AttributedString(parsed[run.range]))
            } else {
                let item = components.first { if case .listItem = $0.kind { return true }; return false }
                let firstInItem = item.map { emittedItems.insert($0.identity).inserted } ?? false
                let lists = components.filter { isList($0.kind) }
                blocks.append(NativeMarkdownBlock(
                    id: blocks.count, content: AttributedString(parsed[run.range]), style: style(components),
                    marker: firstInItem ? marker(components) : nil,
                    listDepth: lists.isEmpty ? nil : lists.count - 1,
                    quoteDepth: components.filter { $0.kind == .blockQuote }.count
                ))
            }
            lastIdentity = identity
        }
        return blocks
    }

    /// The nearest list parent defines the marker, even inside a differently ordered outer list.
    private static func marker(_ components: [PresentationIntent.IntentType]) -> String? {
        guard let index = components.firstIndex(where: { if case .listItem = $0.kind { return true }; return false }),
              case .listItem(let ordinal) = components[index].kind else { return nil }
        for parent in components.dropFirst(index + 1) {
            if parent.kind == .orderedList { return "\(ordinal)." }
            if parent.kind == .unorderedList { return "•" }
        }
        return nil
    }

    /// List depth counts list containers rather than every presentation-intent ancestor.
    private static func isList(_ kind: PresentationIntent.Kind) -> Bool {
        kind == .orderedList || kind == .unorderedList
    }

    /// Paragraph, title, code and thematic-break blocks map to the minimal native styling vocabulary.
    private static func style(_ components: [PresentationIntent.IntentType]) -> NativeMarkdownStyle {
        for component in components {
            switch component.kind {
            case .header(let level): return .heading(level)
            case .codeBlock(let language): return .code(language)
            case .thematicBreak: return .divider
            default: continue
            }
        }
        return .paragraph
    }
}
