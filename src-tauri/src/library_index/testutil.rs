//! library_index 迁移/归一化测试共享的索引形状构造 helper（仅测试编译，
//! 供 tests 与 normalize_tests 共用）。

use serde_json::{json, Value};

/// 合法的最小资产条目（目标形状，按需改字段）。
pub(crate) fn asset(id: &str) -> Value {
    json!({
        "id": id,
        "name": "x",
        "kind": "character",
        "mime": "image/png",
        "relPath": format!("assets/{id}.png"),
        "source": "upload",
        "createdAt": "2026-01-01T00:00:00.000Z",
        "tags": [],
    })
}

/// 合法的最小组条目。
pub(crate) fn group(id: &str, kind: &str) -> Value {
    json!({ "id": id, "name": "g", "kind": kind })
}

/// 目标 Record 形状的资产桶。
pub(crate) fn by_id(entries: Vec<Value>) -> Value {
    let mut m = serde_json::Map::new();
    for e in entries {
        m.insert(e["id"].as_str().unwrap().to_string(), e);
    }
    json!({ "byId": m })
}
