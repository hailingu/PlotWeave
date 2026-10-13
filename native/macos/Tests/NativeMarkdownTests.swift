import Foundation
import Testing
@testable import PlotWeaveNative

/// Foundation-backed message presentation preserves Markdown semantics without altering stored replies.
struct NativeMarkdownTests {
    /// Inline formatting remains attached to its paragraph while title and following paragraph keep separate identities.
    @Test func formatsInlineRunsWithinSeparateBlocks() throws {
        let document = NativeMarkdownDocument.parse("# Summary\n\nA **bold** and *italic* idea with ~~old~~ and `code`.\n\nNext paragraph.")
        #expect(document.diagnostic == nil)
        #expect(document.blocks.count == 3)
        let heading = try #require(document.blocks.first)
        #expect(heading.style == .heading(1))
        #expect(String(heading.content.characters) == "Summary")
        let paragraph = try #require(document.blocks.dropFirst().first)
        #expect(paragraph.content.runs.contains { $0.inlinePresentationIntent?.contains(.stronglyEmphasized) == true })
        #expect(paragraph.content.runs.contains { $0.inlinePresentationIntent?.contains(.emphasized) == true })
        #expect(paragraph.content.runs.contains { $0.inlinePresentationIntent?.contains(.strikethrough) == true })
        #expect(paragraph.content.runs.contains { $0.inlinePresentationIntent?.contains(.code) == true })
        #expect(String(document.blocks[2].content.characters) == "Next paragraph.")
    }

    /// List-item identity emits one marker across continuation paragraphs and mixed nested lists.
    @Test func preservesNestedListMarkersAndContinuationParagraphs() {
        let document = NativeMarkdownDocument.parse("3. outer\n\n   continuation\n\n   - inner\n\n   return to outer\n\n4. next")
        #expect(document.diagnostic == nil)
        #expect(document.blocks.map { $0.marker } == ["3.", nil, "•", nil, "4."])
        #expect(document.blocks.map { $0.listDepth } == [0, 0, 1, 0, 0])
        #expect(document.blocks.map { String($0.content.characters) } == ["outer", "continuation", "inner", "return to outer", "next"])
    }

    /// Literal code survives Markdown markers and indentation while quotations retain their depth.
    @Test func keepsCodeWhitespaceAndQuoteHierarchy() throws {
        let document = NativeMarkdownDocument.parse("> quoted **idea**\n>\n> > nested\n\n```swift\nlet value = 1\n    print(value)\n**literal**\n```\n\n---")
        #expect(document.diagnostic == nil)
        #expect(document.blocks.map { $0.quoteDepth } == [1, 2, 0, 0])
        let code = try #require(document.blocks.first { $0.style == .code("swift") })
        #expect(String(code.content.characters) == "let value = 1\n    print(value)\n**literal**\n")
        #expect(document.blocks.last?.style == .divider)
    }

    /// Block typography and quotation context compose without collapsing an explicit line break.
    @Test func composesHeadingsWithQuotesAndPreservesHardBreaks() throws {
        let document = NativeMarkdownDocument.parse("> ## Quoted title\n\nfirst  \nsecond")
        #expect(document.diagnostic == nil)
        let title = try #require(document.blocks.first)
        #expect(title.style == .heading(2))
        #expect(title.quoteDepth == 1)
        let paragraph = try #require(document.blocks.last)
        #expect(String(paragraph.content.characters) == "first\nsecond")
    }

    /// Only web destinations remain interactive and image alternatives cannot request media.
    @Test func retainsWebLinksButNeverImageLoadsOrExecutableLinks() throws {
        let document = NativeMarkdownDocument.parse("[web](https://example.test/help) [local](file:///tmp/private) [script](javascript:alert) ![portrait](https://example.test/image.png)")
        #expect(document.diagnostic == nil)
        let content = try #require(document.blocks.first?.content)
        #expect(content.runs.compactMap { $0.link?.scheme } == ["https"])
        #expect(content.runs.allSatisfy { $0.imageURL == nil })
        #expect(String(content.characters) == "web local script portrait")
    }

    /// HTML source remains readable text rather than a Web-rendered document.
    @Test func keepsHTMLAsLiteralText() throws {
        let document = NativeMarkdownDocument.parse("<div>Hello</div>")
        #expect(document.diagnostic == nil)
        let content = try #require(document.blocks.first?.content)
        #expect(String(content.characters).contains("<div>Hello</div>"))
        #expect(content.runs.allSatisfy { $0.link == nil && $0.imageURL == nil })
    }

    /// Unsupported or empty parsed content recovers the entire original message.
    @Test func fallsBackWithoutLosingUnsupportedOrUnrepresentedContent() {
        for source in ["| Name | Role |\n| --- | --- |\n| Lin | Actor |", "![](https://example.test/image.png)", "```swift\n```"] {
            let document = NativeMarkdownDocument.parse(source)
            #expect(document.diagnostic != nil)
            #expect(document.blocks.count == 1)
            #expect(document.blocks.first?.content == AttributedString(source))
        }
        #expect(NativeMarkdownDocument.parse("").blocks.isEmpty)
    }
}
