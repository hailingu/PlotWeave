import CryptoKit
import Foundation

/// Bounded Web staging uses opaque memory IDs; no Web-controlled paths reach storage.
struct NativeLibraryUploads {
    /// Decoded bytes per frame; base64 has a separately checked encoded length.
    static let chunkBytes = 64 * 1024
    /// The first frame fixes metadata and total for all continuations.
    struct Metadata: Equatable {
        let name: String
        let mime: String
        let kind: String
        let total: Int
    }
    /// Hashes length-delimited fields without adding a MIME or filename length contract.
    private static func fingerprint(_ metadata: Metadata) -> Data {
        var hash = SHA256()
        for value in [metadata.name, metadata.mime, metadata.kind, String(metadata.total)] {
            hash.update(data: Data("\(value.utf8.count):".utf8))
            hash.update(data: Data(value.utf8))
        }
        return Data(hash.finalize())
    }

    /// A complete buffer leaves a charged placeholder until persistence settles.
    private struct Upload {
        let fingerprint: Data
        let started: Date
        var bytes: Data
        var committing = false
    }
    /// Acknowledgements and persisted assets have distinct shapes.
    enum Step {
        case reply(HostJSON)
        case complete(Metadata, Data)
    }
    private var uploads: [String: Upload] = [:]

    /// Expiry is lazy but memory always has two slots, including in-flight commits.
    mutating func accept(_ request: [String: HostJSON], now: Date = Date()) throws -> Step {
        uploads = uploads.filter { $0.value.committing || now.timeIntervalSince($0.value.started) < 120 }
        let id = try request.requiredString("uploadId", domain: .library)
        guard !id.isEmpty, id.utf8.count <= 128, id.utf8.allSatisfy({ (48...57).contains($0) || (65...90).contains($0) || (97...122).contains($0) || $0 == 45 || $0 == 95 }) else { throw invalid() }
        guard uploads[id]?.committing != true else { throw NativeLibraryIndex.invalid("素材上传正在提交，结果须核对") }
        let previous = uploads.removeValue(forKey: id)
        let total = try integer(request["total"])
        let offset = try integer(request["offset"])
        let data = try request.requiredString("data", domain: .library)
        if total == 0, offset == 0, data.isEmpty { return .reply(.object(["aborted": .bool(true)])) }
        guard total > 0, total <= NativeLibrary.maximumBytes, data.utf8.count <= ((Self.chunkBytes + 2) / 3) * 4,
              let bytes = Data(base64Encoded: data), !bytes.isEmpty, bytes.count <= Self.chunkBytes else { throw invalid() }
        let metadata = Metadata(name: try request.requiredString("name", domain: .library), mime: try request.requiredString("mime", domain: .library), kind: try request.requiredString("kind", domain: .library), total: total)
        let fingerprint = Self.fingerprint(metadata)
        var upload: Upload
        if let previous { upload = previous }
        else {
            guard offset == 0, uploads.count < 2 else { throw invalid() }
            upload = Upload(fingerprint: fingerprint, started: now, bytes: Data(capacity: total))
        }
        guard upload.fingerprint == fingerprint, offset == upload.bytes.count, bytes.count <= total - offset else { throw invalid() }
        upload.bytes.append(bytes)
        if upload.bytes.count == total {
            let complete = upload.bytes
            upload.bytes = Data()
            upload.committing = true
            uploads[id] = upload
            return .complete(metadata, complete)
        }
        uploads[id] = upload
        return .reply(.object(["received": .number(Double(upload.bytes.count))]))
    }

    /// Retires only the settled commit; abort never claims to undo persistence.
    mutating func finish(_ id: String) { uploads.removeValue(forKey: id) }

    /// Rejects negative, fractional and oversized scalars before any arithmetic or allocation.
    private func integer(_ value: HostJSON?) throws -> Int {
        guard let number = value?.number, number >= 0, number <= Double(NativeLibrary.maximumBytes), number.rounded() == number else { throw invalid() }
        return Int(number)
    }

    /// Upload failures stay visible through the established library domain code.
    private func invalid() -> HostFailure { NativeLibraryIndex.invalid("素材上传大小、顺序、编码或槽位非法") }
}
