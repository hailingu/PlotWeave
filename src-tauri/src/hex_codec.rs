//! Shared byte hex codec (#628): canonical lowercase output with explicit consumer acceptance.
//! Seal preserves either-case envelope compatibility; media URLs retain lowercase-only input.

/// Existing wire consumers intentionally differ in which ASCII letter case they accept.
#[derive(Clone, Copy)]
pub(crate) enum HexCase {
    /// Media URL segments remain canonical lowercase hex.
    Lowercase,
    /// Existing encrypted envelopes continue accepting uppercase or lowercase ASCII.
    Either,
}

/// Encode every byte as two lowercase ASCII digits, including leading zeroes.
pub(crate) fn encode(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for &byte in bytes {
        out.push(HEX[(byte >> 4) as usize] as char);
        out.push(HEX[(byte & 0x0f) as usize] as char);
    }
    out
}

/// Decode complete ASCII pairs; malformed/non-ASCII input is rejected without partial output.
pub(crate) fn decode(input: &str, case: HexCase) -> Option<Vec<u8>> {
    if !input.len().is_multiple_of(2) {
        return None;
    }
    input
        .as_bytes()
        .chunks_exact(2)
        .map(|pair| Some((nibble(pair[0], case)? << 4) | nibble(pair[1], case)?))
        .collect()
}

/// Keep digit interpretation in one place while making domain case policy explicit.
fn nibble(byte: u8, case: HexCase) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' if matches!(case, HexCase::Either) => Some(byte - b'A' + 10),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every binary value, not merely UTF-8 text, retains its leading bits and zeroes.
    #[test]
    fn all_bytes_roundtrip_with_canonical_lowercase_output() {
        let bytes: Vec<u8> = (0..=255).collect();
        let encoded = encode(&bytes);
        assert_eq!(encoded.len(), 512);
        assert!(encoded
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)));
        assert_eq!(encode(&[0, 171, 255]), "00abff");
        assert_eq!(decode(&encoded, HexCase::Lowercase), Some(bytes.clone()));
        assert_eq!(
            decode(&encoded.to_ascii_uppercase(), HexCase::Either),
            Some(bytes)
        );
    }

    /// The shared parser preserves intentionally different acceptance contracts.
    #[test]
    fn case_policy_preserves_each_consumers_existing_domain() {
        assert_eq!(decode("00aBfF", HexCase::Either), Some(vec![0, 171, 255]));
        assert_eq!(decode("00aBfF", HexCase::Lowercase), None);
        assert_eq!(decode("1234", HexCase::Lowercase), Some(vec![18, 52]));
        assert_eq!(encode(&[]), "");
        assert_eq!(decode("", HexCase::Lowercase), Some(vec![]));
        assert_eq!(decode("", HexCase::Either), Some(vec![]));
    }

    /// Invalid pairs never panic, accept partial results or treat Unicode lookalikes as digits.
    #[test]
    fn invalid_inputs_are_rejected_under_both_policies() {
        for case in [HexCase::Either, HexCase::Lowercase] {
            for invalid in ["0", "abc", "0g", " a", "00 1", "é", "ＦＦ", "\0\0"] {
                assert_eq!(decode(invalid, case), None, "{invalid:?}");
            }
        }
    }
}
