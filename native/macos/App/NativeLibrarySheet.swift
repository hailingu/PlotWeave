import SwiftUI

/// Connects a native sheet to the existing shared library actor without opening another store.
struct NativeLibrarySheet: View {
    let state: NativeApplicationState
    let services: NativeHostServices
    @State private var library: NativeLibrary?
    @State private var error: String?

    var body: some View {
        Group {
            if let library { NativeLibraryView(state: state, library: library) }
            else if let error { ContentUnavailableView("素材库无法打开", systemImage: "exclamationmark.triangle", description: Text(error)) }
            else { ProgressView("正在打开素材库") }
        }
        .frame(minWidth: 800, minHeight: 550)
        .task {
            do { let loaded = try await services.libraryService(); if !Task.isCancelled { library = loaded } }
            catch { if !Task.isCancelled { self.error = error.localizedDescription } }
        }
    }
}
