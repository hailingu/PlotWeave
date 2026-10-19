import OSLog

/// Immutable unified-log handles add domain metadata without owning application or persistence state.
enum NativeLog {
    /// Fixed application identity lets Console filter all native diagnostics together.
    private static let subsystem = "dev.plotweave.PlotWeaveNative"
    /// Exit delivery failures remain distinct from storage or model diagnostics.
    static let quit = make("quit")
    /// Library recovery, cleanup and event delivery share their domain category.
    static let library = make("library")
    /// Temporary-file maintenance reports filesystem failures without interpreting user bytes.
    static let storage = make("storage")
    /// Key migration diagnostics never include plaintext or encrypted credential material.
    static let preferences = make("preferences")

    /// Every cached domain handle shares one construction policy; only its category varies.
    private static func make(_ category: String) -> Logger {
        Logger(subsystem: subsystem, category: category)
    }
}
