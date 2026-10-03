//! library_index 迁移/归一化测试共享的索引形状构造 helper（仅测试编译，
//! 供 tests 与 normalize_tests 共用）。

use crate::library_fixture::asset_entry;
pub(crate) use crate::library_fixture::by_id;
use serde_json::{json, Value};

/// 归一化测试的合法 character 条目；复用共享字段但保持该模块的默认值。
pub(crate) fn asset(id: &str) -> Value {
    asset_entry(
        id,
        "x",
        "character",
        "image/png",
        &format!("assets/{id}.png"),
    )
}

/// 合法的最小组条目。
pub(crate) fn group(id: &str, kind: &str) -> Value {
    json!({ "id": id, "name": "g", "kind": kind })
}
