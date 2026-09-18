//! #137：有界索引损坏恢复。只提取已知桶中边界明确、可完整解析的成员，
//! 不补全资产字段、不扫描媒体猜元数据；IO 与原件备份由 library_fs 负责。

use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};

/// 解析索引；语法/编码或根形状损坏时返回局部视图、诊断及损坏标志。
/// 原始字节已由调用方限长；恢复扫描只走根、桶、byId 三层固定结构。
pub(crate) fn parse_index(bytes: &[u8]) -> (Value, Vec<String>, bool) {
    let reason = match serde_json::from_slice::<Value>(bytes) {
        Ok(value) if value.is_object() => return (value, Vec::new(), false),
        Ok(_) => "索引根不是对象".to_string(),
        Err(error) => crate::library::error::LibraryError::CorruptIndex(error).to_string(),
    };
    let mut warnings = vec![format!(
        "图库索引部分数据损坏（{reason}）。可识别的完整条目仍可使用；后续操作会保存可用数据，损坏原件会另存备份。"
    )];
    let fields = object_fields(bytes);
    let mut index = json!({});
    for bucket in ["assets", "groups"] {
        let raw = fields.get(bucket).copied().unwrap_or_default();
        index[bucket] = salvage_bucket(raw, bucket, &mut warnings);
    }
    (index, warnings, true)
}

/// 完整成员交给 serde 和既有领域归一化；损坏成员只报告归属，不拼接修复。
fn salvage_bucket(bytes: &[u8], bucket: &str, warnings: &mut Vec<String>) -> Value {
    if let Ok(value) = serde_json::from_slice::<Value>(bytes) {
        return value;
    }
    if trim(bytes).starts_with(b"[") {
        return Value::Array(
            container_parts(bytes)
                .into_iter()
                .filter_map(|part| serde_json::from_slice(part).ok())
                .collect(),
        );
    }
    let fields = object_fields(bytes);
    let records = object_fields(fields.get("byId").copied().unwrap_or_default());
    let mut recovered = Map::new();
    for (id, raw) in records {
        match serde_json::from_slice::<Value>(raw) {
            Ok(value) => {
                recovered.insert(id, value);
            }
            Err(_) => warnings.push(format!("图库 {bucket} 条目 {id} 损坏，已隔离")),
        }
    }
    json!({"byId": recovered})
}

/// 按 JSON 空白裁剪字节切片，不以有损 UTF-8 转换伪造正常字段。
fn trim(bytes: &[u8]) -> &[u8] {
    let start = bytes
        .iter()
        .position(|b| !b.is_ascii_whitespace())
        .unwrap_or(bytes.len());
    let end = bytes
        .iter()
        .rposition(|b| !b.is_ascii_whitespace())
        .map_or(start, |p| p + 1);
    &bytes[start..end]
}

/// 在字符串、转义和嵌套容器之外切分成员；截断容器保留已结束的前序成员。
/// 未闭合字符串/嵌套对象之后的边界无法确认，不将其内部内容提升成同级条目。
fn container_parts(bytes: &[u8]) -> Vec<&[u8]> {
    let bytes = trim(bytes);
    if !matches!(bytes.first(), Some(b'{' | b'[')) {
        return Vec::new();
    }
    let mut parts = Vec::new();
    let mut start = 1;
    let mut depth = 0usize;
    let mut quoted = false;
    let mut escaped = false;
    for (i, &byte) in bytes.iter().enumerate().skip(1) {
        if quoted {
            if escaped {
                escaped = false;
            } else if byte == b'\\' {
                escaped = true;
            } else if byte == b'"' {
                quoted = false;
            }
            continue;
        }
        match byte {
            b'"' => quoted = true,
            b'{' | b'[' => depth += 1,
            b'}' | b']' if depth > 0 => depth -= 1,
            b'}' | b']' => {
                parts.push(&bytes[start..i]);
                return parts;
            }
            b',' if depth == 0 => {
                parts.push(&bytes[start..i]);
                start = i + 1;
            }
            _ => {}
        }
    }
    parts.push(&bytes[start..]);
    parts
}

/// 只接受可完整解析的字符串键；重复键归属歧义时整个键隔离，绝不任选一项。
fn object_fields(bytes: &[u8]) -> HashMap<String, &[u8]> {
    let mut fields = HashMap::new();
    let mut duplicates = HashSet::new();
    if !trim(bytes).starts_with(b"{") {
        return fields;
    }
    for part in container_parts(bytes) {
        let mut keys = serde_json::Deserializer::from_slice(trim(part)).into_iter::<String>();
        let Some(Ok(key)) = keys.next() else {
            continue;
        };
        let rest = trim(&trim(part)[keys.byte_offset()..]);
        let Some(value) = rest.strip_prefix(b":") else {
            continue;
        };
        if fields.insert(key.clone(), value).is_some() {
            duplicates.insert(key);
        }
    }
    for key in duplicates {
        fields.remove(&key);
    }
    fields
}
