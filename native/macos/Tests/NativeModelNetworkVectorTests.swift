import Foundation
import Testing
@testable import PlotWeaveNative

/// Both downloaders consume independent expected verdicts for the owner-approved policy alignment.
struct NativeModelNetworkVectorTests {
    /// Pure vectors cover syntax and literal boundaries without resolving or contacting any host.
    @Test func sharedDownloadNetworkVectors() throws {
        let file = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("crates/plotweave-core/testdata/model-network.json")
        let vectors = try JSONDecoder().decode(HostJSON.self, from: Data(contentsOf: file))
        #expect(vectors["version"] == .number(1))
        let addresses = try #require(vectors["addresses"]?.arrayValue)
        let urls = try #require(vectors["urls"]?.arrayValue)
        #expect(!addresses.isEmpty && !urls.isEmpty)
        for row in addresses {
            let input = try #require(row["input"]?.string)
            #expect(HostJSON.bool(NativeNetworkPolicy.isPublic(input)) == row["accepted"], "\(input)")
        }
        for row in urls {
            let input = try #require(row["input"]?.string)
            let url = try #require(URL(string: input))
            let target = try? NativeNetworkPolicy.download(url)
            let accepted = target.map { !NativeNetworkPolicy.isLiteral($0.0) || NativeNetworkPolicy.isPublic($0.0) } ?? false
            #expect(HostJSON.bool(accepted) == row["accepted"], "\(input)")
        }
    }
}
