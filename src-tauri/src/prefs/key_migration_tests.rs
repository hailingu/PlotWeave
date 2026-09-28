//! key_migration 的行为测试（issue #392）：旧版 `pw1:` keyEnc 密文在
//! 读取成功后就地重封装为 v2 并原子写回；写回与 save_prefs 互斥，不
//! 覆盖并发写入，失败不影响已取得的明文。

use super::open_key_from_text;
use cap_std::fs::Dir as CapDir;
use std::fs;
use std::path::{Path, PathBuf};

/// 唯一临时目录与锚定根：`{tmp}/pw-keymig-test-{new_id}-{tag}/`。
fn temp_root(tag: &str) -> (PathBuf, CapDir) {
    let dir = std::env::temp_dir().join(format!("pw-keymig-test-{}-{tag}", crate::store::new_id()));
    fs::create_dir_all(&dir).expect("创建临时目录");
    let root = CapDir::open_ambient_dir(&dir, cap_std::ambient_authority()).expect("打开临时根");
    (dir, root)
}

/// 写入一份含旧版密文（真实本机材料封装）的 settings.json，返回文件文本。
fn write_legacy_settings(dir: &Path, secret: &str) -> String {
    let legacy = crate::seal::test_support::legacy_seal(secret).expect("构造旧版密文");
    let text = format!(
        r#"{{"defaultChat":"openai:gpt-4o","providers":[{{"id":"openai","label":"OpenAI 兼容","keyEnc":"{legacy}"}}]}}"#
    );
    fs::write(dir.join("settings.json"), &text).expect("写入设置");
    text
}

/// 读回并解析当前 settings.json。
fn read_settings(dir: &Path) -> serde_json::Value {
    let text = fs::read_to_string(dir.join("settings.json")).expect("读回设置");
    serde_json::from_str(&text).expect("迁移后文件应仍是合法 JSON")
}

#[test]
fn legacy_envelope_is_resealed_in_place_as_pw2() {
    // 读取成功 → 就地迁移：磁盘 keyEnc 变为 v2（provider 绑定可解），
    // 其余字段原样保留；迁移后重复读取幂等（不再触发迁移）
    let secret = "sk-test-migrate-123";
    let (dir, root) = temp_root("migrate");
    let text = write_legacy_settings(&dir, secret);
    let outcome = open_key_from_text(&root, &text, "openai");
    assert_eq!(
        outcome.expect("应返回 Some").expect("旧版密文应解密成功"),
        secret
    );
    let v = read_settings(&dir);
    let enc = v["providers"][0]["keyEnc"].as_str().expect("keyEnc 应在场");
    assert!(
        enc.starts_with(crate::seal::ENVELOPE_PREFIX),
        "磁盘密文应已迁移为 v2：{enc}"
    );
    assert!(!enc.contains(secret), "密文不得含明文");
    assert_eq!(crate::seal::open_for("openai", enc).unwrap(), secret);
    assert_eq!(v["defaultChat"], "openai:gpt-4o", "无关字段不得改动");
    assert_eq!(v["providers"][0]["label"], "OpenAI 兼容");
    // 幂等：v2 密文的读取不触发迁移，密文保持稳定（同一 envelope 原样）
    let after = fs::read_to_string(dir.join("settings.json")).unwrap();
    let outcome2 = open_key_from_text(&root, &after, "openai");
    assert_eq!(outcome2.unwrap().unwrap(), secret);
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn migration_skips_when_disk_envelope_differs_from_opened_one() {
    // 迁移只改写「本次成功解开的那个密文」：磁盘值已被其它写入替换
    //（用户重新录入/清除）时跳过，不覆盖他人写入
    let on_disk = crate::seal::test_support::legacy_seal("sk-current").unwrap();
    let (dir, root) = temp_root("skip");
    fs::write(
        dir.join("settings.json"),
        format!(r#"{{"providers":[{{"id":"openai","keyEnc":"{on_disk}"}}]}}"#),
    )
    .expect("写入设置");
    let stale = crate::seal::test_support::legacy_seal("sk-stale").unwrap();
    super::key_migration::migrate_legacy_envelope(&root, "openai", &stale, "sk-stale");
    let after = fs::read_to_string(dir.join("settings.json")).unwrap();
    assert!(after.contains(&on_disk), "磁盘密文不得被覆盖");
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn migration_failure_never_blocks_the_secret() {
    // best-effort：迁移写回失败（目录去写权限 → 临时文件创建失败）时
    // 读取照常返回明文，仅留诊断
    let secret = "sk-ro-test";
    let (dir, root) = temp_root("readonly");
    let text = write_legacy_settings(&dir, secret);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perm = fs::metadata(&dir).unwrap().permissions();
        perm.set_mode(0o555);
        fs::set_permissions(&dir, perm).expect("去掉目录写权限");
    }
    let outcome = open_key_from_text(&root, &text, "openai");
    assert_eq!(
        outcome.unwrap().unwrap(),
        secret,
        "迁移失败不得影响明文返回"
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perm = fs::metadata(&dir).unwrap().permissions();
        perm.set_mode(0o755);
        fs::set_permissions(&dir, perm).expect("恢复目录权限");
    }
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn concurrent_save_and_migration_never_lose_saved_edits() {
    // 写互斥回归金丝雀（issue #392）：save_prefs 全量保存与迁移写回并发
    // 时，已完成保存的编辑不得被迁移的旧快照回退——无锁时以高概率复现
    // 丢编辑，有锁时确定性不丢（迁移在锁内重读，保存与迁移互斥串行）。
    // 保存线程的快照始终携带旧版密文，模拟前端内存态回退密文版本。
    let secret = "sk-race";
    let legacy = crate::seal::test_support::legacy_seal(secret).unwrap();
    let (dir, root) = temp_root("race");
    fs::write(
        dir.join("settings.json"),
        format!(r#"{{"providers":[{{"id":"openai","keyEnc":"{legacy}"}}]}}"#),
    )
    .expect("写入设置");
    let total = 12usize;
    let opened = legacy.clone();
    let save_dir = dir.clone();
    let saver = std::thread::spawn(move || {
        for i in 1..=total {
            let prefs = serde_json::json!({
                "defaultChat": format!("m{i}"),
                "providers": [{ "id": "openai", "keyEnc": legacy.clone() }],
            });
            super::save_prefs_in(&save_dir, prefs).expect("保存应成功");
            std::thread::sleep(std::time::Duration::from_millis(1));
        }
    });
    let migrater = std::thread::spawn(move || {
        for _ in 0..3 {
            super::key_migration::migrate_legacy_envelope(&root, "openai", &opened, secret);
            std::thread::sleep(std::time::Duration::from_millis(2));
        }
    });
    saver.join().expect("保存线程应正常结束");
    migrater.join().expect("迁移线程应正常结束");
    let v = read_settings(&dir);
    assert_eq!(
        v["defaultChat"],
        serde_json::json!(format!("m{total}")),
        "已完成保存的编辑不得被迁移回退"
    );
    let _ = fs::remove_dir_all(&dir);
}
