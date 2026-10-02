//! #137：局部语法恢复的边界，禁止字符串内容、坏编码和歧义键冒充正常条目。
use super::parse_index;
use serde_json::json;

#[test]
fn strings_and_nested_content_do_not_become_sibling_records() {
    let value = json!({"name":"逗号, \"fake\":{}, \\ ] }", "nested":{"x":1}});
    let raw = format!(r#"{{"assets":{{"byId":{{"a":{value},"bad":NOPE,"b":{{"id":"b"}}}}}}}}"#);
    let (index, warnings, damaged) = parse_index(raw.as_bytes());
    assert!(damaged);
    assert_eq!(index["assets"]["byId"]["a"], value);
    assert_eq!(index["assets"]["byId"].as_object().unwrap().len(), 2);
    assert!(warnings.iter().any(|w| w.contains("bad")));
}

#[test]
fn duplicate_keys_in_damaged_bucket_are_not_guessed() {
    let (index, _, damaged) =
        parse_index(br#"{"assets":{"byId":{"a":{},"a":{"id":"a"},"bad":NOPE,"b":{}}}}"#);
    assert!(damaged);
    assert_eq!(index["assets"]["byId"], json!({"b":{}}));
}

#[test]
fn invalid_utf8_member_is_isolated_without_replacing_its_metadata() {
    let raw = b"{\"assets\":{\"byId\":{\"a\":{},\"bad\":{\"name\":\"\xff\"},\"b\":{}}}}";
    let (index, _, _) = parse_index(raw);
    assert_eq!(index["assets"]["byId"], json!({"a":{},"b":{}}));
}

#[test]
fn complete_legacy_array_members_remain_in_document_order() {
    let (index, _, _) = parse_index(br#"{"assets":[{"id":"a"},BAD,{"id":"b"}],"groups":[]}"#);
    assert_eq!(index["assets"], json!([{"id":"a"},{"id":"b"}]));
}

#[test]
fn unfinished_member_does_not_promote_nested_keys() {
    let (index, _, _) = parse_index(br#"{"assets":{"byId":{"a":{},"bad":{"nested":{"fake":{}}"#);
    assert_eq!(index["assets"]["byId"], json!({"a":{}}));
}

#[test]
fn mismatched_delimiters_keep_only_confirmed_prefix_records() {
    for (broken, padding) in [(r#"{"nested":]"#, "[}"), ("[}", "{]")] {
        for bucket in ["assets", "groups"] {
            let raw = format!(
                r#"{{"{bucket}":{{"byId":{{"a":{{}},"bad":{broken},"fake":{{"id":"fake"}},"pad":{padding}}}}}}}"#
            );
            let (index, warnings, damaged) = parse_index(raw.as_bytes());
            assert!(damaged);
            assert!(!warnings.is_empty());
            assert_eq!(index[bucket]["byId"], json!({"a":{}}));
        }
    }
}

#[test]
fn mismatched_delimiters_do_not_promote_legacy_items_or_root_buckets() {
    let (index, _, _) = parse_index(
        br#"{"assets":[{"id":"a"},{"nested":],{"id":"fake"},[}],"groups":{"byId":{"fake":{}}}}"#,
    );
    assert_eq!(index["assets"], json!([{"id":"a"}]));
    assert_eq!(index["groups"]["byId"], json!({}));
}
