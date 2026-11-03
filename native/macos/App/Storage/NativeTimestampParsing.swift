import Foundation
import Synchronization

/// Issue #824: timestamp parsing, normalization and canonical rendering share one set of
/// process-wide cached tools instead of rebuilding formatters and regexes per call, which
/// cost hundreds of microseconds per library index entry and per home-list sort row.
///
/// Behavior is preserved exactly by layering: unambiguous calendar-valid shapes in the
/// Gregorian era (year 1583–9999, the first full Gregorian year after the 1582-10-15
/// cutover) take a pure-integer fast path; every other input — including ICU's lenient
/// rollovers (hour 24, non-leap Feb 29, month overflow), pre-Gregorian years, Unicode
/// digits and oversized offsets — falls back to shared cached `ISO8601DateFormatter`s,
/// so the accept/reject set and normalized output stay byte-identical to the historical
/// per-call implementation.
enum NativeTimestampParsing {
    /// Read-side normalization returns the canonical UTC millisecond string, or nil for unparseable input.
    static func normalizedTimestamp(_ value: String) -> String? {
        if let millis = strictEpochMillis(value) { return canonicalUTCString(from: millis) }
        return legacyNormalizedTimestamp(value)
    }

    /// Envelope parsing accepts exactly the same timestamp forms as the library contract.
    static func parseTime(_ text: String) -> Date? {
        if let millis = strictEpochMillis(text) { return Date(timeIntervalSince1970: Double(millis) / 1000) }
        return legacyParseTime(text)
    }

    /// Newly materialized native assets and projects always use explicit UTC milliseconds.
    static func canonicalTimestamp(_ date: Date) -> String {
        legacy.withLock { $0.canonical.string(from: date) }
    }

    // MARK: - Strict fast path

    /// Strict shapes — ASCII digits, separators, valid civil date, fields without rollover,
    /// fraction of any length, `Z` or offset within ±23:59 — resolve to exact integer epoch
    /// milliseconds without any formatter; the era guard keeps every reachable instant inside
    /// the proleptic-Gregorian range where ICU's cutover calendar agrees with this arithmetic.
    static func strictEpochMillis(_ value: String) -> Int64? {
        let bytes = Array(value.utf8)
        guard bytes.count >= 20 else { return nil }
        func digits(_ from: Int, _ to: Int) -> Int? {
            var number = 0
            for index in from..<to {
                guard bytes[index] >= 48, bytes[index] <= 57 else { return nil }
                number = number * 10 + Int(bytes[index] - 48)
            }
            return number
        }
        guard bytes[4] == 45, bytes[7] == 45, bytes[10] == 84, bytes[13] == 58, bytes[16] == 58 else { return nil }
        guard let year = digits(0, 4), let month = digits(5, 7), let day = digits(8, 10),
              let hour = digits(11, 13), let minute = digits(14, 16), let second = digits(17, 19) else { return nil }
        guard (1583...9999).contains(year), (1...12).contains(month), day >= 1, day <= daysInMonth(year: year, month: month),
              hour <= 23, minute <= 59, second <= 59 else { return nil }
        var index = 19
        var millis = 0
        if bytes[index] == 46 {
            index += 1
            var place = 100
            var seenDigit = false
            while index < bytes.count, bytes[index] >= 48, bytes[index] <= 57 {
                if place >= 1 { millis += Int(bytes[index] - 48) * place; place /= 10 }
                seenDigit = true
                index += 1
            }
            guard seenDigit else { return nil }
        }
        guard index < bytes.count else { return nil }
        var offsetMinutes = 0
        if bytes[index] == 90, index + 1 == bytes.count {
            // `Z` consumed to the end of the string.
        } else if (bytes[index] == 43 || bytes[index] == 45) && index + 6 == bytes.count {
            guard bytes[index + 3] == 58,
                  let offsetHours = digits(index + 1, index + 3), let offsetMinutesValue = digits(index + 4, index + 6),
                  offsetHours <= 23, offsetMinutesValue <= 59 else { return nil }
            offsetMinutes = bytes[index] == 43 ? offsetHours * 60 + offsetMinutesValue : -(offsetHours * 60 + offsetMinutesValue)
        } else { return nil }
        let seconds = daysFromCivil(year: Int64(year), month: Int64(month), day: Int64(day)) * 86_400
            + Int64(hour) * 3_600 + Int64(minute) * 60 + Int64(second) - Int64(offsetMinutes) * 60
        return seconds * 1_000 + Int64(millis)
    }

    /// Canonical rendering of exact epoch milliseconds: UTC civil fields, always three fraction
    /// digits, always `Z`; years beyond four digits cannot satisfy the canonical shape and yield nil.
    static func canonicalUTCString(from millis: Int64) -> String? {
        let seconds = floorDivide(millis, 1_000)
        let fraction = millis - seconds * 1_000
        let days = floorDivide(seconds, 86_400)
        let remainder = seconds - days * 86_400
        let (year, month, day) = civilFromDays(days)
        guard year >= 0, year <= 9_999 else { return nil }
        let hour = remainder / 3_600, minute = (remainder % 3_600) / 60, second = remainder % 60
        return padded(year, 4) + "-" + padded(month, 2) + "-" + padded(day, 2) + "T"
            + padded(hour, 2) + ":" + padded(minute, 2) + ":" + padded(second, 2) + "." + padded(fraction, 3) + "Z"
    }

    /// Month lengths including the leap-year rule; the caller has already bounded the month.
    static func daysInMonth(year: Int, month: Int) -> Int {
        let leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0
        switch month {
        case 1, 3, 5, 7, 8, 10, 12: return 31
        case 4, 6, 9, 11: return 30
        default: return leap ? 29 : 28
        }
    }

    /// Howard Hinnant's civil-from-days and days-from-civil algorithms, valid proleptically.
    static func daysFromCivil(year y0: Int64, month: Int64, day: Int64) -> Int64 {
        let y = month <= 2 ? y0 - 1 : y0
        let era = y.quotientAndRemainder(dividingBy: 400).quotient
        let yearOfEra = y - era * 400
        let monthPrime = (month + 9) % 12
        let dayOfYear = (153 * monthPrime + 2) / 5 + day - 1
        let dayOfEra = yearOfEra * 365 + yearOfEra / 4 - yearOfEra / 100 + dayOfYear
        return era * 146_097 + dayOfEra - 719_468
    }

    static func civilFromDays(_ z0: Int64) -> (year: Int64, month: Int64, day: Int64) {
        let z = z0 + 719_468
        let era = z.quotientAndRemainder(dividingBy: 146_097).quotient
        let dayOfEra = z - era * 146_097
        let yearOfEra = (dayOfEra - dayOfEra / 1_460 + dayOfEra / 36_524 - dayOfEra / 146_096) / 365
        let year = yearOfEra + era * 400
        let dayOfYear = dayOfEra - (365 * yearOfEra + yearOfEra / 4 - yearOfEra / 100)
        let monthPrime = (5 * dayOfYear + 2) / 153
        let day = dayOfYear - (153 * monthPrime + 2) / 5 + 1
        let month = monthPrime < 10 ? monthPrime + 3 : monthPrime - 9
        return (month <= 2 ? year + 1 : year, month, day)
    }

    /// Floor division so pre-epoch milliseconds decompose like the Rust kernel (−1 ms → 1969-12-31T23:59:59.999).
    static func floorDivide(_ value: Int64, _ divisor: Int64) -> Int64 {
        let quotient = value.quotientAndRemainder(dividingBy: divisor).quotient
        let remainder = value - quotient * divisor
        return remainder == 0 ? quotient : quotient - ((value < 0) == (divisor < 0) ? 0 : 1)
    }

    private static func padded(_ value: Int64, _ width: Int) -> String {
        let digits = String(value)
        return String(repeating: "0", count: max(0, width - digits.count)) + digits
    }

    // MARK: - Legacy shared tooling

    /// The historical ICU path with per-process cached tools. The formatters and regexes are
    /// immutable after construction but not `Sendable`, so one mutex serializes every access.
    private struct LegacyTimestampTools {
        let fractional: ISO8601DateFormatter
        let basic: ISO8601DateFormatter
        let canonical: ISO8601DateFormatter
        let shapes: LegacyTimestampShapes?

        /// Cache fixed ICU patterns once; an invalid future pattern fails closed with a stable diagnostic.
        init() {
            fractional = ISO8601DateFormatter()
            fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            basic = ISO8601DateFormatter()
            basic.formatOptions = [.withInternetDateTime]
            canonical = ISO8601DateFormatter()
            canonical.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            canonical.timeZone = TimeZone(secondsFromGMT: 0)
            do {
                shapes = try LegacyTimestampShapes()
            } catch {
                NativeLog.storage.error("PW_TIMESTAMP_PATTERN_INVALID: timestamp shape initialization failed")
                shapes = nil
            }
        }

        /// Mirrors the historical guard: only regex-shaped input reaches the formatters.
        func matchesInputShape(_ value: String) -> Bool {
            shapes?.matchesInput(value) ?? false
        }

        /// The output must be the canonical UTC shape to count as normalized.
        func matchesCanonicalShape(_ value: String) -> Bool {
            shapes?.matchesCanonical(value) ?? false
        }

    }

    private static let legacy = Mutex(LegacyTimestampTools())

    /// The fallback for everything the strict scanner does not answer: shape-gated parse,
    /// canonical format, canonical-shape check — the exact historical sequence.
    private static func legacyNormalizedTimestamp(_ value: String) -> String? {
        legacy.withLock { tools in
            guard tools.matchesInputShape(value),
                  let date = tools.fractional.date(from: value) ?? tools.basic.date(from: value) else { return nil }
            let normalized = tools.canonical.string(from: date)
            return tools.matchesCanonicalShape(normalized) ? normalized : nil
        }
    }

    /// The historical two-step parse: fractional first, basic as fallback.
    private static func legacyParseTime(_ text: String) -> Date? {
        legacy.withLock { tools in tools.fractional.date(from: text) ?? tools.basic.date(from: text) }
    }
}
