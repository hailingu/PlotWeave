//! Frozen native download classification, including embedded IPv4 and allocated IPv6 rows (#655).

use std::net::{IpAddr, Ipv6Addr};

/// Both address families implement the same policy as NativeNetworkPolicy.isPublic.
pub(super) fn is_public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => public_v4(ip.octets()),
        IpAddr::V6(ip) => public_v6(ip),
    }
}

/// IANA special-purpose IPv4 rows retain the two globally reachable 192.0.0/24 exceptions.
fn public_v4(b: [u8; 4]) -> bool {
    match b {
        [0 | 10 | 127 | 224..=255, _, _, _]
        | [172, 16..=31, _, _]
        | [192, 168, _, _]
        | [169, 254, _, _]
        | [100, 64..=127, _, _] => false,
        [192, 0, 0, last] => matches!(last, 9 | 10),
        [192, 0, 2, _]
        | [192, 88, 99, _]
        | [198, 18..=19, _, _]
        | [198, 51, 100, _]
        | [203, 0, 113, _] => false,
        _ => true,
    }
}

/// Mapped/compatible, 6to4 and well-known NAT64 delegate to the embedded address; ISATAP rejects private targets.
fn public_v6(ip: Ipv6Addr) -> bool {
    let b = ip.octets();
    let tail = || public_v4([b[12], b[13], b[14], b[15]]);
    if b[..12] == [0; 12] || (b[..10] == [0; 10] && b[10..12] == [255, 255]) {
        return tail();
    }
    if b[..2] == [0x20, 0x02] {
        return public_v4([b[2], b[3], b[4], b[5]]);
    }
    if b[..12] == [0, 0x64, 0xff, 0x9b, 0, 0, 0, 0, 0, 0, 0, 0] {
        return tail();
    }
    if b[8] & 0xfd == 0 && b[9..12] == [0, 0x5e, 0xfe] && !tail() {
        return false;
    }
    if b[0] & 0xe0 != 0x20 || b[..4] == [0x20, 0x01, 0x0d, 0xb8] {
        return false;
    }
    let value = u128::from(ip);
    if (1..=3).any(|last| value == (0x2001_0001u128 << 96) | last) {
        return true;
    }
    GLOBAL_V6_ROWS.iter().any(|&(high, bits)| {
        let shift = 128 - bits;
        value >> shift == ((high as u128) << 64) >> shift
    })
}

/// Exact NativeNetworkPolicy snapshot: allocated IANA rows dated 2025-10-10 and global 2001::/23 exceptions.
/// Future registry additions must update both implementations and their shared boundary vectors together.
const GLOBAL_V6_ROWS: &[(u64, u32)] = &[
    (0x2001_0003_0000_0000, 32),
    (0x2001_0004_0112_0000, 48),
    (0x2001_0020_0000_0000, 28),
    (0x2001_0030_0000_0000, 28),
    (0x2001_0200_0000_0000, 23),
    (0x2001_0400_0000_0000, 23),
    (0x2001_0600_0000_0000, 23),
    (0x2001_0800_0000_0000, 22),
    (0x2001_0c00_0000_0000, 23),
    (0x2001_0e00_0000_0000, 23),
    (0x2001_1200_0000_0000, 23),
    (0x2001_1400_0000_0000, 22),
    (0x2001_1800_0000_0000, 23),
    (0x2001_1a00_0000_0000, 23),
    (0x2001_1c00_0000_0000, 22),
    (0x2001_2000_0000_0000, 19),
    (0x2001_4000_0000_0000, 23),
    (0x2001_4200_0000_0000, 23),
    (0x2001_4400_0000_0000, 23),
    (0x2001_4600_0000_0000, 23),
    (0x2001_4800_0000_0000, 23),
    (0x2001_4a00_0000_0000, 23),
    (0x2001_4c00_0000_0000, 23),
    (0x2001_5000_0000_0000, 20),
    (0x2001_8000_0000_0000, 19),
    (0x2001_a000_0000_0000, 20),
    (0x2001_b000_0000_0000, 20),
    (0x2003_0000_0000_0000, 18),
    (0x2400_0000_0000_0000, 12),
    (0x2410_0000_0000_0000, 12),
    (0x2600_0000_0000_0000, 12),
    (0x2610_0000_0000_0000, 23),
    (0x2620_0000_0000_0000, 23),
    (0x2630_0000_0000_0000, 12),
    (0x2800_0000_0000_0000, 12),
    (0x2a00_0000_0000_0000, 12),
    (0x2a10_0000_0000_0000, 12),
    (0x2c00_0000_0000_0000, 12),
];
