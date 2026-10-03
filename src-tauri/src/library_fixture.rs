//! 图库、删除恢复与媒体协议的共享磁盘测试夹具（issue #504；仅测试构建）。

use crate::library_journal::JOURNAL_FILE_NAME;
use crate::store::new_id;
use cap_std::{ambient_authority, fs::Dir as CapDir};
use serde_json::{json, Value};
use std::{
    fs,
    path::{Path, PathBuf},
};

/// 对唯一测试根打开受信句柄，等价生产锚定句柄而不触及用户目录。
pub(crate) fn cap(p: &Path) -> CapDir {
    CapDir::open_ambient_dir(p, ambient_authority()).expect("打开测试根句柄")
}

/// 为每次调用创建独立 library/assets 根；返回图库路径与清理根。
pub(crate) fn temp_fixture() -> (PathBuf, PathBuf) {
    let root = std::env::temp_dir().join(format!("pw-library-test-{}", new_id()));
    fs::create_dir_all(root.join("library").join("assets")).expect("创建临时库目录");
    (root.join("library"), root)
}

/// 尽力删除测试临时根；延续既有测试的清理语义。
pub(crate) fn cleanup(root: &Path) {
    let _ = fs::remove_dir_all(root);
}

/// 最小合法索引条目，relPath 按需投毒；完整字段由 asset_entry 统一构造。
pub(crate) fn entry(id: &str, rel: &str) -> Value {
    asset_entry(id, "x", "other", "image/png", rel)
}

/// 构造合法资产字段；名字、类型、mime 和路径由具体用例显式指定。
pub(crate) fn asset_entry(id: &str, name: &str, kind: &str, mime: &str, rel: &str) -> Value {
    json!({
        "id": id,
        "name": name,
        "kind": kind,
        "mime": mime,
        "relPath": rel,
        "source": "upload",
        "createdAt": "2026-01-01T00:00:00.000Z",
        "tags": [],
    })
}

/// 把最小条目数组包装为目标 Record 形状（`{"byId": {id: entry}}`）。
pub(crate) fn by_id(entries: impl IntoIterator<Item = Value>) -> Value {
    let mut m = serde_json::Map::new();
    for e in entries {
        m.insert(e["id"].as_str().unwrap().to_string(), e);
    }
    json!({ "byId": m })
}

/// 绕过生产净化直接写入 JSON，保留投毒索引与兼容形状。
pub(crate) fn write_index_raw(library: &Path, index: &Value) {
    fs::write(
        library.join("library.json"),
        serde_json::to_string(index).expect("序列化"),
    )
    .expect("写索引");
}

/// 原样写日志，允许旧数组或对象形状以模拟恢复前的磁盘状态。
pub(crate) fn write_journal_raw(library: &Path, entries: Value) {
    fs::write(
        library.join(JOURNAL_FILE_NAME),
        serde_json::to_string(&entries).expect("序列化"),
    )
    .expect("写日志");
}

/// 读取真实磁盘 dev/ino；非 Unix 延续既有零身份测试边界。
pub(crate) fn file_identity(p: &Path) -> (u64, u64) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let m = fs::metadata(p).expect("读文件元数据");
        (m.dev(), m.ino())
    }
    #[cfg(not(unix))]
    {
        let _ = p;
        (0, 0)
    }
}

/// 构造绑定真实文件身份的删除事务条目，路径按用例显式指定。
pub(crate) fn journal_entry_json(
    id: &str,
    asset_id: &str,
    rel: &str,
    trash: &str,
    dev: u64,
    ino: u64,
) -> Value {
    json!({
        "id": id,
        "assetId": asset_id,
        "relPath": rel,
        "identity": { "dev": dev, "ino": ino },
        "trashName": trash,
    })
}

/// 读取对象或旧数组日志中的事务条目，供恢复结果的条目语义断言复用。
pub(crate) fn read_journal_raw(library: &Path) -> Value {
    let journal: Value = serde_json::from_str(
        &fs::read_to_string(library.join(JOURNAL_FILE_NAME)).expect("读回日志"),
    )
    .expect("日志 JSON");
    journal.get("entries").cloned().unwrap_or(journal)
}

/// 为项目资产用例同时创建 projects/ 和 library/assets/，每次调用互相隔离。
pub(crate) fn project_fixture() -> (PathBuf, PathBuf, PathBuf) {
    let (library, root) = temp_fixture();
    let projects = root.join("projects");
    fs::create_dir_all(&projects).expect("创建临时 projects 目录");
    (projects, library, root)
}
