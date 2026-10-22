import Foundation

/// Read-only preview admission ties delivery to the exact native request identity.
nonisolated struct NativeExportTicket {
    private var key: String?
    private var value: HostJSON?

    /// Starts a replacement preview without authorizing the previous payload.
    mutating func begin(_ key: String) { self.key = key; value = nil }
    /// An out-of-order response cannot authorize another request's preview.
    mutating func complete(_ key: String, value: HostJSON) {
        guard self.key == key, value["text"]?.string != nil, value["fileName"]?.string != nil else { return }
        self.value = value
    }
    /// Only a successful payload for the current key is available for delivery.
    func available(for key: String) -> HostJSON? { self.key == key ? value : nil }
}
