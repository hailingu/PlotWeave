import Foundation
import Testing
@testable import PlotWeaveNative

/// Fixed-pattern construction errors are recoverable; ICU matching semantics stay unchanged.
struct LegacyTimestampShapesTests {
    /// Either malformed pattern produces the same structured failure rather than terminating the host.
    @Test func invalidPatternsThrowStructuredFailure() {
        for (input, canonical) in [("[", ".*"), (".*", "[")] {
            do {
                _ = try LegacyTimestampShapes(inputPattern: input, canonicalPattern: canonical)
                Issue.record("invalid pattern was accepted")
            } catch {
                #expect(error.code == "PW_TIMESTAMP_PATTERN_INVALID")
            }
        }
    }

    /// Unicode decimal digits, final newlines and arbitrary fractions retain the ICU shape contract.
    @Test func historicalShapeBoundaries() throws {
        let shapes = try LegacyTimestampShapes()
        for value in ["2026-10-04T00:00:00Z", "٢٠٢٦-١٠-٠٤T٠٠:٠٠:٠٠Z",
                      "2026-10-04T00:00:00.123456789Z", "1500-01-01T00:00:00Z",
                      "2026-10-04T00:00:00Z\n"] {
            #expect(shapes.matchesInput(value))
        }
        #expect(!shapes.matchesInput("2026-10-04t00:00:00Z"))
        #expect(shapes.matchesCanonical("2026-10-04T00:00:00.123Z"))
        #expect(!shapes.matchesCanonical("2026-10-04T00:00:00.123456Z"))
    }
}
