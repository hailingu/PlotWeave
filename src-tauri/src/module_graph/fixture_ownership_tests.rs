//! issue #504：共享图库测试能力的声明所有权，使用守卫的 Rust 词法解析器。

use super::*;

/// 解析函数声明而非字符串/注释，查找共享能力在指定测试消费者中的所有者。
fn fixture_owners(sources: &BTreeMap<ModuleKey, String>, name: &str) -> BTreeSet<ModuleKey> {
    sources
        .iter()
        .filter(|(path, _)| {
            path.as_str() == "library_fixture.rs"
                || path.starts_with("library/")
                || path.starts_with("library_index/")
                || path.starts_with("assets/")
                || path.starts_with("library_journal/")
                || path.starts_with("media_protocol/")
        })
        .filter_map(|(path, source)| {
            let clean = lexer::strip_comments_and_literals(source);
            let tokens = lexer::tokenize(&clean);
            tokens
                .windows(3)
                .any(|parts| {
                    parts[0] == "fn"
                        && parts[1].trim_start_matches("r#") == name
                        && matches!(parts[2], "(" | "<")
                })
                .then(|| path.clone())
        })
        .collect()
}

/// #504 的所有权契约：图库/日志/媒体协议共用原始磁盘夹具，禁止再声明副本。
#[test]
fn library_fixture_capabilities_have_one_owner() {
    let mut sources = BTreeMap::new();
    load_sources(
        &Path::new(env!("CARGO_MANIFEST_DIR")).join("src"),
        &mut sources,
        "",
    );
    for name in [
        "cap",
        "entry",
        "by_id",
        "write_index_raw",
        "write_journal_raw",
        "file_identity",
        "journal_entry_json",
        "read_journal_raw",
    ] {
        assert_eq!(
            fixture_owners(&sources, name),
            BTreeSet::from(["library_fixture.rs".into()]),
            "共享能力 {name} 必须只有一个声明所有者"
        );
    }
}
