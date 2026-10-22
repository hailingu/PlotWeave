import Foundation

/// Incremental HTTP/1.1 framing bounds headers and decoded image bytes before aggregation.
struct NativeHTTPParser {
    /// The finite framing modes allow split network buffers without reparsing an ever-growing body.
    private enum Mode { case headers, fixed(Int), closed, chunkLength, chunk(Int), chunkEnd, trailers, done }
    /// Per-hop byte budgets are explicit so tests can exercise limits without production-sized allocation.
    private let maximum: Int
    /// Header and trailer metadata have an independent, small bound.
    private let headerMaximum: Int
    /// Pending wire bytes stay separate from the decoded body and are consumed after each transition.
    private var pending = Data()
    /// Only decoded payload is retained as the eventual response body.
    private var body = Data()
    /// Parsed response metadata survives body framing without retaining the original header block.
    private var status = 0
    /// Normalized framing/redirect fields survive after the header block is consumed.
    private var headers: [String: String] = [:]
    /// Total transfer bounds metadata overhead independently from the decoded-body cap.
    private var wireBytes = 0
    /// Framing and trailer budgets belong to this single response parser.
    private var mode = Mode.headers
    /// Trailer accumulation is bounded across all trailer lines.
    private var trailerBytes = 0

    /// Production uses a 32-KiB header ceiling in addition to the generated-image body cap.
    init(maximum: Int, headerMaximum: Int = 32 * 1024) {
        self.maximum = maximum
        self.headerMaximum = headerMaximum
    }

    /// Appended bytes either remain pending or yield a complete reply; EOF never accepts truncation.
    mutating func append(_ bytes: Data, eof: Bool = false) throws -> NativeHTTPReply? {
        guard wireBytes <= maximum * 2 + headerMaximum * 2 - bytes.count else { throw invalid("图像 HTTP 总传输超过上限") }
        wireBytes += bytes.count
        guard pending.count <= maximum + headerMaximum + 65_536 - bytes.count else { throw invalid("HTTP 缓冲超过上限") }
        pending.append(bytes)
        if let result = try advance() { return result }
        if eof {
            if case .closed = mode { mode = .done; return reply() }
            throw invalid("图像 HTTP 响应被截断")
        }
        return nil
    }

    /// Each state consumes its own bounded bytes, so chunk framing never expands the decoded body budget.
    private mutating func advance() throws -> NativeHTTPReply? {
        while true {
            switch mode {
            case .headers:
                guard let boundary = pending.range(of: Data("\r\n\r\n".utf8)) else {
                    guard pending.count <= headerMaximum else { throw invalid("图像 HTTP 响应头超过上限") }
                    return nil
                }
                let count = pending.distance(from: pending.startIndex, to: boundary.lowerBound)
                guard count + 4 <= headerMaximum else { throw invalid("图像 HTTP 响应头超过上限") }
                try parseHeaders(Data(pending.prefix(count)))
                pending.removeFirst(count + 4)
            case .fixed(let remaining):
                let count = min(remaining, pending.count)
                try consume(count)
                mode = remaining == count ? .done : .fixed(remaining - count)
                if remaining > count { return nil }
            case .closed:
                try consume(pending.count)
                return nil
            case .chunkLength:
                guard let line = try takeLine(limit: headerMaximum) else { return nil }
                let size = line.split(separator: ";", maxSplits: 1, omittingEmptySubsequences: false)[0]
                guard !size.isEmpty, size.utf8.allSatisfy({ (48...57).contains($0) || (65...70).contains($0) || (97...102).contains($0) }),
                      let count = Int(size, radix: 16), count <= maximum - body.count else { throw invalid("图像 HTTP chunk 长度非法或超过上限") }
                mode = count == 0 ? .trailers : .chunk(count)
            case .chunk(let remaining):
                let count = min(remaining, pending.count)
                try consume(count)
                mode = remaining == count ? .chunkEnd : .chunk(remaining - count)
                if remaining > count { return nil }
            case .chunkEnd:
                guard pending.count >= 2 else { return nil }
                guard pending.prefix(2) == Data("\r\n".utf8) else { throw invalid("图像 HTTP chunk 分隔符非法") }
                pending.removeFirst(2)
                mode = .chunkLength
            case .trailers:
                guard let line = try takeLine(limit: headerMaximum - trailerBytes) else { return nil }
                trailerBytes += line.utf8.count + 2
                guard trailerBytes <= headerMaximum else { throw invalid("图像 HTTP trailer 超过上限") }
                if line.isEmpty { mode = .done }
                else { try validateTrailer(line) }
            case .done: return reply()
            }
        }
    }

    /// Framing headers are unambiguous, identity-encoded and validated before any body bytes are admitted.
    private mutating func parseHeaders(_ bytes: Data) throws {
        guard let text = String(data: bytes, encoding: .ascii) else { throw invalid("图像 HTTP 响应头编码非法") }
        let lines = text.components(separatedBy: "\r\n")
        guard let first = lines.first else { throw invalid("缺少 HTTP 状态") }
        let tokens = first.split(separator: " ", omittingEmptySubsequences: true)
        guard tokens.count >= 2, tokens[0] == "HTTP/1.1" || tokens[0] == "HTTP/1.0",
              let code = Int(tokens[1]), (200...599).contains(code) else { throw invalid("图像 HTTP 状态非法") }
        status = code
        for line in lines.dropFirst() {
            guard let split = line.firstIndex(of: ":"), !line.hasPrefix(" "), !line.hasPrefix("\t") else { throw invalid("图像 HTTP header 非法") }
            let name = String(line[..<split]).lowercased()
            guard !name.isEmpty, name.utf8.allSatisfy({ (33...126).contains($0) && $0 != 58 }) else { throw invalid("图像 HTTP header 名非法") }
            let value = line[line.index(after: split)...].trimmingCharacters(in: .whitespaces)
            if headers[name] != nil, name == "content-length" || name == "transfer-encoding" || name == "location" { throw invalid("图像 HTTP framing header 重复") }
            headers[name] = value
        }
        if let coding = headers["content-encoding"], coding.lowercased() != "identity" { throw invalid("图像 HTTP 不支持压缩内容编码") }
        if let transfer = headers["transfer-encoding"] {
            guard transfer.lowercased() == "chunked", headers["content-length"] == nil else { throw invalid("图像 HTTP framing 不明确") }
            mode = .chunkLength
        } else if let length = headers["content-length"] {
            guard !length.isEmpty, length.utf8.allSatisfy({ (48...57).contains($0) }), let count = Int(length), count <= maximum else { throw invalid("图像 HTTP 内容长度超过上限或非法") }
            mode = .fixed(count)
        } else { mode = status == 204 || status == 304 ? .done : .closed }
    }

    /// Metadata lines have their own bound, including arbitrarily split chunk extensions and trailers.
    private mutating func takeLine(limit: Int) throws -> String? {
        guard let boundary = pending.range(of: Data("\r\n".utf8)) else {
            guard pending.count <= limit else { throw invalid("图像 HTTP 元数据行超过上限") }
            return nil
        }
        let count = pending.distance(from: pending.startIndex, to: boundary.lowerBound)
        guard count + 2 <= limit, let text = String(data: pending.prefix(count), encoding: .ascii) else { throw invalid("图像 HTTP 元数据行非法") }
        pending.removeFirst(count + 2)
        return text
    }

    /// Decoded payload is bounded before append, regardless of content-length, chunks or EOF framing.
    private mutating func consume(_ count: Int) throws {
        guard count <= maximum - body.count else { throw invalid("下载图像超过大小上限") }
        body.append(pending.prefix(count))
        pending.removeFirst(count)
    }

    /// Trailers cannot redefine the validated body framing or redirect authority.
    private func validateTrailer(_ line: String) throws {
        guard let split = line.firstIndex(of: ":"), !line.hasPrefix(" "), !line.hasPrefix("\t"),
              !["content-length", "transfer-encoding", "location"].contains(line[..<split].lowercased()) else { throw invalid("图像 HTTP trailer 非法") }
    }

    /// A complete value contains only validated metadata and bounded decoded bytes.
    private func reply() -> NativeHTTPReply { NativeHTTPReply(status: status, headers: headers, body: body) }
    /// Wire errors never echo provider-controlled header contents or the signed URL.
    private func invalid(_ message: String) -> HostFailure { HostFailure(code: "PW_HTTP_INVALID", message: message) }
}
