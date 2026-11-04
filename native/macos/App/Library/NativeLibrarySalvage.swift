import Foundation

/// Bounded JSON recovery extracts only complete members of the two authoritative library buckets.
enum NativeLibrarySalvage {
    /// Healthy JSON is authoritative; malformed syntax never authorizes media cleanup.
    static func parse(_ bytes: Data) -> (HostJSON, Bool) {
        if let value = try? HostJSON.decode(bytes), value.object != nil { return (value, false) }
        let fields = objectFields(Array(bytes))
        return (.object(["assets": bucket(fields["assets"] ?? []), "groups": bucket(fields["groups"] ?? [])]), true)
    }

    /// Recovers legacy arrays or Record entries without synthesizing missing asset fields.
    private static func bucket(_ bytes: [UInt8]) -> HostJSON {
        if let value = try? HostJSON.decode(Data(bytes)) { return value }
        if trimmed(bytes).first == 91 {
            return .array(parts(bytes).compactMap { try? HostJSON.decode(Data($0)) })
        }
        let fields = objectFields(bytes)
        let recovered = objectFields(fields["byId"] ?? []).compactMapValues {
            try? HostJSON.decode(Data($0))
        }
        return .object(["byId": .object(recovered)])
    }

    /// Root, bucket and byId keys are accepted only when their quoted key is complete and unique.
    private static func objectFields(_ raw: [UInt8]) -> [String: [UInt8]] {
        let bytes = trimmed(raw)
        guard bytes.first == 123 else { return [:] }
        var fields: [String: [UInt8]] = [:]
        var duplicates = Set<String>()
        for rawPart in parts(bytes) {
            let part = trimmed(rawPart)
            guard part.first == 34, let end = quotedEnd(part),
                  let key = try? JSONDecoder().decode(String.self, from: Data(part[...end])) else { continue }
            let rest = trimmed(Array(part.dropFirst(end + 1)))
            guard rest.first == 58 else { continue }
            if fields[key] != nil { duplicates.insert(key) }
            fields[key] = Array(rest.dropFirst())
        }
        for key in duplicates { fields.removeValue(forKey: key) }
        return fields
    }

    /// Finds the closing quote while preserving escaped quotes and invalid UTF-8 for the JSON decoder.
    private static func quotedEnd(_ bytes: [UInt8]) -> Int? {
        var escaped = false
        for index in bytes.indices.dropFirst() {
            if escaped { escaped = false }
            else if bytes[index] == 92 { escaped = true }
            else if bytes[index] == 34 { return index }
        }
        return nil
    }

    /// Splits only at outer commas; delimiter mismatch stops scanning before later ambiguous data.
    private static func parts(_ raw: [UInt8]) -> [[UInt8]] {
        let bytes = trimmed(raw)
        guard let first = bytes.first, first == 123 || first == 91 else { return [] }
        var output: [[UInt8]] = []
        var start = 1
        var stack = [first]
        var quoted = false
        var escaped = false
        for index in bytes.indices.dropFirst() {
            let byte = bytes[index]
            if quoted {
                if escaped { escaped = false }
                else if byte == 92 { escaped = true }
                else if byte == 34 { quoted = false }
                continue
            }
            if byte == 34 { quoted = true }
            else if byte == 123 || byte == 91 { stack.append(byte) }
            else if byte == 125 || byte == 93 {
                let opener = stack.popLast()
                let matched = (opener == 123 && byte == 125) || (opener == 91 && byte == 93)
                if !matched || stack.isEmpty {
                    output.append(Array(bytes[start..<index]))
                    return output
                }
            } else if byte == 44, stack.count == 1 {
                output.append(Array(bytes[start..<index]))
                start = index + 1
            }
        }
        output.append(Array(bytes[start...]))
        return output
    }

    /// Only JSON ASCII whitespace is trimmed; malformed byte sequences are never repaired lossily.
    private static func trimmed(_ bytes: [UInt8]) -> [UInt8] {
        let whitespace: Set<UInt8> = [9, 10, 13, 32]
        let start = bytes.firstIndex { !whitespace.contains($0) } ?? bytes.count
        let end = bytes.lastIndex { !whitespace.contains($0) }.map { $0 + 1 } ?? start
        return Array(bytes[start..<end])
    }
}
