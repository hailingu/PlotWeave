import Foundation

/// Native drop payloads carry logical identities only; graph mutation remains with the current canvas owner.
enum NativeOutlineContract {
    /// A drop must refer to the captured current project and live source/anchor identities before emitting an intent.
    static func moveArguments(payload: String, projectId: String, ids: Set<String>, target: HostJSON) -> [String: HostJSON]? {
        guard let data = payload.data(using: .utf8), let decoded = try? JSONDecoder().decode(HostJSON.self, from: data),
              let fields = decoded.object, Set(fields.keys) == ["projectId", "id"], fields["projectId"]?.string == projectId,
              let id = fields["id"]?.string, ids.contains(id), let destination = target.object else { return nil }
        switch destination["kind"]?.string {
        case "row":
            guard Set(destination.keys) == ["kind", "anchorId", "position"], let anchor = destination["anchorId"]?.string,
                  ids.contains(anchor), anchor != id, ["before", "after"].contains(destination["position"]?.string ?? "") else { return nil }
        case "groupEnd":
            guard Set(destination.keys) == ["kind", "episode"] else { return nil }
            if destination["episode"] != .null {
                guard let number = destination["episode"]?.number, number >= 1, number <= 9_007_199_254_740_991, number.rounded() == number else { return nil }
            }
        default: return nil
        }
        return ["projectId": .string(projectId), "id": .string(id), "target": target]
    }

    /// Generated payloads retain Unicode opaque node IDs and reject an encoding failure by offering no drag item.
    static func payload(projectId: String, id: String) -> String? {
        let value = HostJSON.object(["projectId": .string(projectId), "id": .string(id)])
        guard let bytes = try? JSONEncoder().encode(value) else { return nil }
        return String(data: bytes, encoding: .utf8)
    }
}
