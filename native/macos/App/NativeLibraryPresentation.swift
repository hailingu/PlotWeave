import Foundation

/// Native list filtering consumes read projections and preserves the authoritative asset map identity.
struct NativeLibraryPresentation {
    let items: [HostJSON]

    /// Category and search affect only visibility; names, tags and conflicted members keep their original identities.
    init(_ value: HostJSON, kind: String? = nil, query: String = "") {
        let needle = query.trimmingCharacters(in: .whitespacesAndNewlines)
        items = (value["assets"]?["byId"]?.object ?? [:]).sorted { $0.key < $1.key }.compactMap { id, value in
            guard NativeLibraryIndex.validID(id), var fields = value.object, let name = value["name"]?.string,
                  let category = value["kind"]?.string, NativeLibraryIndex.kinds.contains(category), kind == nil || category == kind else { return nil }
            let matches = needle.isEmpty || name.localizedCaseInsensitiveContains(needle)
                || (value["tags"]?.array ?? []).contains { $0.string?.localizedCaseInsensitiveContains(needle) == true }
            guard matches else { return nil }
            fields["id"] = .string(id)
            return .object(fields)
        }
    }
}

/// Chinese labels remain presentation-only; services validate the stable English wire enums.
enum NativeLibraryLabels {
    static let kinds = [("character", "角色"), ("location", "场景"), ("wardrobe", "服化道"),
        ("colorlight", "色彩与光线"), ("reference", "参考"), ("other", "其他")]
    static let views = [("front", "正面"), ("side", "侧面"), ("back", "背面"), ("three_quarter", "四分之三"),
        ("top", "俯视"), ("expression", "表情"), ("turnout", "转身"), ("other", "其他")]
}
