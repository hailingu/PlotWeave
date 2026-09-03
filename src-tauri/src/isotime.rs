//! ISO 8601 时间工具（自 store.rs 拆出的纯函数集，无外部依赖）：
//! 生成（now_iso/iso_from_ms，civil-from-days 算法）、宽松校验与解析
//! （is_valid_iso8601/iso8601_to_epoch_millis：接受 `Z` 与 `±HH:MM` 偏移、
//! 可变小数秒，同一瞬间归一化为同一 epoch 毫秒排序键）、规范 UTC 形校验
//! （is_canonical_utc_timestamp：与前端 toISOString() 同形，恒 3 位毫秒、
//! 恒 `Z`——§7.1/§10.5 保存边界只收此形，宽松形留给加载与排序）。

use std::time::{SystemTime, UNIX_EPOCH};

/// epoch 毫秒 → ISO 8601（UTC，civil-from-days 算法，无外部依赖）。
pub(crate) fn iso_from_ms(ms: u64) -> String {
    let secs = ms / 1000;
    let millis = ms % 1000;
    let days = (secs / 86400) as i64;
    let rem = secs % 86400;
    let (h, m, s) = (rem / 3600, rem % 3600 / 60, rem % 60);
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365; // [0, 399]
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let d = doy - (153 * mp + 2) / 5 + 1; // [1, 31]
    let mo = if mp < 10 { mp + 3 } else { mp - 9 }; // [1, 12]
    let y = if mo <= 2 { y + 1 } else { y };
    format!("{y:04}-{mo:02}-{d:02}T{h:02}:{m:02}:{s:02}.{millis:03}Z")
}

pub(crate) fn now_iso() -> String {
    let ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    iso_from_ms(ms)
}

/// ISO 8601 固定前缀 `YYYY-MM-DDTHH:MM:SS` 的解析结果。
struct IsoFields {
    year: i64,
    month: u32,
    day: u32,
    hour: u32,
    min: u32,
    sec: u32,
}

/// 解析固定前缀的形状（长度、数字位、分隔符）；形状不符返回 None。
fn parse_iso_prefix(s: &str) -> Option<IsoFields> {
    let b = s.as_bytes();
    if b.len() < 20 {
        return None;
    }
    for i in [0usize, 1, 2, 3, 5, 6, 8, 9, 11, 12, 14, 15, 17, 18] {
        if !b[i].is_ascii_digit() {
            return None;
        }
    }
    if b[4] != b'-' || b[7] != b'-' || b[10] != b'T' || b[13] != b':' || b[16] != b':' {
        return None;
    }
    let num = |from: usize, to: usize| s[from..to].parse::<u32>().unwrap_or(u32::MAX);
    Some(IsoFields {
        year: num(0, 4) as i64,
        month: num(5, 7),
        day: num(8, 10),
        hour: num(11, 13),
        min: num(14, 16),
        sec: num(17, 19),
    })
}

/// 月份天数；month 越界返回 0，由调用方的范围检查一并拒绝。
fn days_in_month(year: i64, month: u32) -> u32 {
    let leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if leap => 29,
        2 => 28,
        _ => 0,
    }
}

/// 各字段取值范围（含闰年月份天数）。
fn iso_fields_in_range(f: &IsoFields) -> bool {
    (1..=12).contains(&f.month)
        && f.hour <= 23
        && f.min <= 59
        && f.sec <= 59
        && f.day >= 1
        && f.day <= days_in_month(f.year, f.month)
}

/// 校验 `±HH:MM` 时区偏移：从符号位起恰好消费剩余 6 字节。
fn zone_offset_valid(s: &str, i: usize) -> bool {
    let b = s.as_bytes();
    if b.len() != i + 6 || b[i + 3] != b':' {
        return false;
    }
    for j in [i + 1, i + 2, i + 4, i + 5] {
        if !b[j].is_ascii_digit() {
            return false;
        }
    }
    let off_h = s[i + 1..i + 3].parse::<u32>().unwrap_or(u32::MAX);
    let off_m = s[i + 4..i + 6].parse::<u32>().unwrap_or(u32::MAX);
    off_h <= 23 && off_m <= 59
}

/// 校验可选小数秒与结尾时区（`Z` 或 `±HH:MM`），从第 19 字节起消费到串尾。
fn iso_suffix_valid(s: &str) -> bool {
    let b = s.as_bytes();
    let mut i = 19;
    if b.get(i) == Some(&b'.') {
        i += 1;
        let start = i;
        while i < b.len() && b[i].is_ascii_digit() {
            i += 1;
        }
        if i == start {
            return false;
        }
    }
    match b.get(i) {
        Some(b'Z') => i + 1 == b.len(),
        Some(b'+') | Some(b'-') => zone_offset_valid(s, i),
        _ => false,
    }
}

/// 规范 UTC 时间戳（§7.1/§10.5）：toISOString() 同形——恒 3 位毫秒、恒 `Z`
/// （长 24）；偏移/缺毫秒的合法 ISO 往返不稳定，资产 createdAt 保存只收此形。
pub(crate) fn is_canonical_utc_timestamp(s: &str) -> bool {
    is_valid_iso8601(s) && s.len() == 24 && s.ends_with('Z')
}

/// ISO 8601 校验：`YYYY-MM-DDTHH:MM:SS[.fff](Z|±HH:MM)`，含各字段取值
/// 范围与闰年规则——反序列化不校验字符串内容，边界自行把关。
pub(crate) fn is_valid_iso8601(s: &str) -> bool {
    match parse_iso_prefix(s) {
        Some(f) => iso_fields_in_range(&f) && iso_suffix_valid(s),
        None => false,
    }
}

/// 从 ISO 串尾部提取毫秒小数与分钟级时区偏移（Z 视为 0）；
/// 形状由 is_valid_iso8601 先行校验，此处不做防御性检查。
fn iso_suffix_parts(s: &str) -> (i64, i64) {
    let b = s.as_bytes();
    let mut i = 19;
    let mut millis = 0i64;
    if b.get(i) == Some(&b'.') {
        i += 1;
        let start = i;
        while i < b.len() && b[i].is_ascii_digit() {
            i += 1;
        }
        let frac = &s[start..i];
        millis = frac[..frac.len().min(3)].parse().unwrap_or(0);
        for _ in frac.len()..3 {
            millis *= 10;
        }
    }
    let offset_min = match b.get(i) {
        Some(b'+') | Some(b'-') => {
            let h: i64 = s[i + 1..i + 3].parse().unwrap_or(0);
            let m: i64 = s[i + 4..i + 6].parse().unwrap_or(0);
            let v = h * 60 + m;
            if b[i] == b'-' {
                -v
            } else {
                v
            }
        }
        _ => 0,
    };
    (millis, offset_min)
}

/// 民用日期 → 1970-01-01 起的天数（Howard Hinnant 算法，公历全程有效）。
fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y.rem_euclid(400);
    let mp = i64::from((m + 9) % 12);
    let doy = (153 * mp + 2) / 5 + i64::from(d) - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// ISO 8601 → Unix epoch 毫秒（项目列表排序键）：时区偏移与小数秒归一化后
/// 同一瞬间得同一键——字典序无法比较 `+10:00` 与 `Z` 之类的等价/交错写法；
/// 非法串返回 None，由调用方决定兜底次序。
pub(crate) fn iso8601_to_epoch_millis(s: &str) -> Option<i64> {
    if !is_valid_iso8601(s) {
        return None;
    }
    let f = parse_iso_prefix(s)?;
    let (millis, offset_min) = iso_suffix_parts(s);
    let local_secs = days_from_civil(f.year, f.month, f.day) * 86_400
        + i64::from(f.hour) * 3_600
        + i64::from(f.min) * 60
        + i64::from(f.sec);
    Some((local_secs - offset_min * 60) * 1_000 + millis)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn iso_from_ms_marks_known_instants() {
        assert_eq!(iso_from_ms(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(iso_from_ms(1_700_000_000_000), "2023-11-14T22:13:20.000Z");
        // 闰日边界：2024-02-29T00:00:00Z = 1_709_164_800_000
        assert_eq!(iso_from_ms(1_709_164_800_000), "2024-02-29T00:00:00.000Z");
    }

    #[test]
    fn iso8601_accepts_z_and_offset_forms() {
        assert!(is_valid_iso8601("2026-08-31T06:27:27.000Z"));
        assert!(is_valid_iso8601("2026-08-31T06:27:27Z"));
        assert!(is_valid_iso8601("2026-08-31T14:27:27+08:00"));
        assert!(is_valid_iso8601("2024-02-29T00:00:00.000Z")); // 闰日
        for bad in [
            "",
            "2026-08-31",               // 缺时间
            "2026-08-31T06:27:27",      // 缺时区
            "2026-13-01T00:00:00.000Z", // 月份越界
            "2026-08-32T00:00:00.000Z", // 日期越界
            "2023-02-29T00:00:00.000Z", // 非闰年 2/29
            "2026-08-31T25:00:00.000Z", // 小时越界
            "2026-08-31T06:27:27.",     // 小数秒无数字
            "2026-08-31T06:27:27+0800", // 偏移缺冒号
            "not-a-date",
        ] {
            assert!(!is_valid_iso8601(bad), "应拒绝 {bad:?}");
        }
    }

    #[test]
    fn iso8601_to_epoch_millis_normalizes_offsets_and_precision() {
        // 同一瞬间的三种合法写法必须得到同一排序键
        assert_eq!(iso8601_to_epoch_millis("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(
            iso8601_to_epoch_millis("1970-01-01T08:00:00+08:00"),
            Some(0)
        );
        assert_eq!(
            iso8601_to_epoch_millis("1969-12-31T16:00:00-08:00"),
            Some(0)
        );
        // 小数秒补齐/截断到毫秒
        assert_eq!(
            iso8601_to_epoch_millis("1970-01-01T00:00:00.500Z"),
            Some(500)
        );
        assert_eq!(iso8601_to_epoch_millis("1970-01-01T00:00:00.5Z"), Some(500));
        // 非法串无排序键
        assert_eq!(iso8601_to_epoch_millis("not-a-date"), None);
        assert_eq!(iso8601_to_epoch_millis(""), None);
    }
}
