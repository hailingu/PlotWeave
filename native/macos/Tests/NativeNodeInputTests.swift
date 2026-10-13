import Foundation
import Testing
@testable import PlotWeaveNative

/// Native number drafts obey the exact JavaScript safe-positive-integer editing boundary.
struct NativeNodeInputTests {
    @Test func draftBoundaryDoesNotCoerceInvalidInputIntoAnotherValue() {
        #expect(NativeIntegerDraft.parse(" 12 ") == 12)
        #expect(NativeIntegerDraft.parse("9007199254740991") == 9007199254740991)
        for value in ["", "0", "-1", "1.5", "1e20", "9007199254740992", "nan", "abc"] {
            #expect(NativeIntegerDraft.parse(value) == nil)
        }
    }
}
