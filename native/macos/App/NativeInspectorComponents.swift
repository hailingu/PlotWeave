import SwiftUI

extension EnvironmentValues {
    /// Opts only node inspectors into stacked field labels; other native forms retain their system layout.
    @Entry var nativeInspectorFields = false
}

/// A readable content surface matches canvas cards while the system inspector owns surrounding material.
struct NativeInspectorSection<Content: View>: View {
    let title: String
    @ViewBuilder var content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title).font(.caption).foregroundStyle(.secondary)
            VStack(alignment: .leading, spacing: 14) { content }
                .padding(14)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 14))
                .overlay { RoundedRectangle(cornerRadius: 14).strokeBorder(Color(nsColor: .separatorColor), lineWidth: 0.5) }
        }
    }
}

/// Stacked labels give editable text the full column width and preserve the native control's accessible name.
struct NativeInspectorField<Content: View>: View {
    let label: String
    @ViewBuilder var content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(label).font(.caption).foregroundStyle(.secondary).accessibilityHidden(true)
            content.labelsHidden().frame(maxWidth: .infinity, alignment: .leading)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// Native switches align on the trailing edge without changing their binding, action or accessible name.
struct NativeInspectorToggle: View {
    let label: String
    @Binding var isOn: Bool

    var body: some View {
        HStack {
            Text(label)
            Spacer(minLength: 12)
            Toggle(label, isOn: $isOn).labelsHidden().accessibilityLabel(label)
        }
    }
}

/// Selection metadata introduces the node using the same monochrome type vocabulary as canvas cards.
struct NativeInspectorHeader: View {
    let type: String
    let data: HostJSON

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label(kind.name, systemImage: kind.symbol).font(.caption).foregroundStyle(.secondary)
            Text(title).font(.system(size: 16, weight: .semibold)).lineLimit(2).help(title)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
    }

    /// Known node kinds use system line symbols; unrecognized projections remain visibly editable.
    private var kind: (name: String, symbol: String) {
        switch type {
        case "scene": ("场景", "film")
        case "beat": ("节奏卡", "bolt")
        case "dialogue": ("对白", "text.bubble")
        case "branch": ("分支", "point.3.connected.trianglepath.dotted")
        case "shot": ("分镜", "film.stack")
        case "image": ("图片", "photo")
        default: ("节点", "square")
        }
    }

    /// Titles are derived from the current read-only selection, never stored as a second editable document.
    private var title: String {
        if type == "shot" { return "SHOT " + (data["shotNo"]?.number.map { String(format: "%02.0f", $0) } ?? "—") }
        let text = data[type == "branch" || type == "image" ? "prompt" : "name"]?.string ?? ""
        return text.isEmpty ? "未命名" + kind.name : text
    }
}
