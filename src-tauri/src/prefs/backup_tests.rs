//! issue #390：成功加载之后被外部损坏的 `settings.json`，在覆盖保存前获得
//! 按字节摘要命名的耐久备份（与图库 `backup_damaged_index` 同款语义）。
//!
//! 复现窗口：设置页已成功加载（`ready` 态，文件当时合法）→ 编辑会话期间
//! 文件被应用外部破坏（截断写入/文件系统故障留下非法 JSON）→ 任意一次
//! 防抖落盘或关闭冲刷。加载期保护（issue #120 的 `ready` 门控）管不到
//! 这条已成功加载之后的覆盖路径。

use super::*;
use serde_json::json;
use sha2::{Digest, Sha256};
use std::fs;
use std::path::PathBuf;

/// 自动回收本测试拥有的目录，包括失败断言留下的临时与备份文件。
struct PrefsBackupDir(PathBuf);

impl PrefsBackupDir {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!("pw-prefs-backup-{}", crate::store::new_id()));
        fs::create_dir(&path).unwrap();
        Self(path)
    }

    fn settings_path(&self) -> PathBuf {
        self.0.join("settings.json")
    }

    /// 经读取内核取当前设置（合法文件的语义断言）。
    fn read(&self) -> serde_json::Value {
        read_prefs_in(&self.0).unwrap()
    }

    /// 目录内全部条目名（排序后稳定比较）。
    fn entry_names(&self) -> Vec<String> {
        let mut names: Vec<_> = fs::read_dir(&self.0)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().into_string().unwrap())
            .collect();
        names.sort();
        names
    }

    /// 损坏备份条目（`settings-corrupt-*.bak`）的 (名字, 字节) 清单。
    fn backups(&self) -> Vec<(String, Vec<u8>)> {
        let mut found: Vec<_> = fs::read_dir(&self.0)
            .unwrap()
            .filter_map(|entry| {
                let path = entry.unwrap().path();
                let name = path.file_name()?.to_str()?.to_string();
                name.starts_with("settings-corrupt-")
                    .then(|| (name, fs::read(&path).unwrap()))
            })
            .collect();
        found.sort();
        found
    }

    /// 唯一备份的路径（已断言恰有一份时使用，不依赖命名算法细节）。
    fn only_backup_path(&self) -> PathBuf {
        let paths: Vec<_> = fs::read_dir(&self.0)
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .filter(|path| {
                path.file_name().is_some_and(|n| {
                    n.to_str()
                        .is_some_and(|n| n.starts_with("settings-corrupt-"))
                })
            })
            .collect();
        assert_eq!(paths.len(), 1);
        paths.into_iter().next().unwrap()
    }
}

impl Drop for PrefsBackupDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn externally_corrupted_settings_backed_up_byte_exact_before_overwrite() {
    let dir = PrefsBackupDir::new();
    // 步骤 1-2：已存在合法设置并成功加载
    fs::write(dir.settings_path(), r#"{"defaultChat":"openai:gpt-4o"}"#).unwrap();
    // 步骤 3：编辑会话期间文件被外部破坏（截断/非法 JSON）
    let corrupted: &[u8] = b"{ not json";
    fs::write(dir.settings_path(), corrupted).unwrap();
    // 步骤 4：任意一次保存
    save_prefs_in(&dir.0, json!({"defaultChat": "anthropic:claude"})).unwrap();
    // 新设置正常落盘
    assert_eq!(
        read_prefs_in(&dir.0).unwrap(),
        json!({"defaultChat": "anthropic:claude"})
    );
    // 损坏原件按字节摘要命名留存，内容与原损坏字节逐字节一致
    let expected_name = format!("settings-corrupt-{:x}.bak", Sha256::digest(corrupted));
    assert_eq!(
        dir.backups(),
        vec![(expected_name, corrupted.to_vec())],
        "实际条目：{:?}",
        dir.entry_names()
    );
}

#[test]
fn healthy_settings_save_creates_no_backup() {
    // 正常文件不产生备份（issue 验收：正常文件不产生备份）
    let dir = PrefsBackupDir::new();
    fs::write(dir.settings_path(), r#"{"defaultChat":"openai:gpt-4o"}"#).unwrap();
    save_prefs_in(&dir.0, json!({"defaultChat": "new"})).unwrap();
    assert!(dir.backups().is_empty());
    assert_eq!(dir.entry_names(), ["settings.json"]);
}

#[test]
fn first_save_without_existing_file_creates_no_backup() {
    // 首启（文件缺失）保存：无原件可保护，不产生备份
    let dir = PrefsBackupDir::new();
    save_prefs_in(&dir.0, json!({"defaultChat": "new"})).unwrap();
    assert_eq!(dir.read(), json!({"defaultChat": "new"}));
    assert_eq!(dir.entry_names(), ["settings.json"]);
}

#[test]
fn invalid_utf8_corruption_backed_up_as_raw_bytes() {
    // 损坏形态含非法 UTF-8：备份按原始字节留存，不因文本转换丢失
    let dir = PrefsBackupDir::new();
    let corrupted: &[u8] = &[0xff, 0xfe, b'{', 0x00];
    fs::write(dir.settings_path(), corrupted).unwrap();
    save_prefs_in(&dir.0, json!({"defaultChat": "new"})).unwrap();
    let expected_name = format!("settings-corrupt-{:x}.bak", Sha256::digest(corrupted));
    assert_eq!(dir.backups(), vec![(expected_name, corrupted.to_vec())]);
}

#[test]
fn valid_non_object_settings_backed_up_before_overwrite() {
    // 与图库同款判定：合法 JSON 但根非对象同样按损坏备份（issue 验收的
    // 「损坏」口径），覆盖前留证
    let dir = PrefsBackupDir::new();
    let raw: &[u8] = b"[1,2,3]";
    fs::write(dir.settings_path(), raw).unwrap();
    save_prefs_in(&dir.0, json!({"defaultChat": "new"})).unwrap();
    let expected_name = format!("settings-corrupt-{:x}.bak", Sha256::digest(raw));
    assert_eq!(dir.backups(), vec![(expected_name, raw.to_vec())]);
}

#[test]
fn resave_same_corruption_reuses_single_backup() {
    // 同一损坏内容的重复覆盖路径复用同一摘要副本，不随保存次数累计
    let dir = PrefsBackupDir::new();
    let corrupted: &[u8] = b"{ broken twice";
    for _ in 0..2 {
        fs::write(dir.settings_path(), corrupted).unwrap();
        save_prefs_in(&dir.0, json!({"defaultChat": "new"})).unwrap();
    }
    let expected_name = format!("settings-corrupt-{:x}.bak", Sha256::digest(corrupted));
    assert_eq!(dir.backups(), vec![(expected_name, corrupted.to_vec())]);
}

#[test]
fn resave_changed_corruption_keeps_distinct_backups() {
    // 原件变化（不同摘要）保留独立备份——两份损坏原件都可事后取证
    let dir = PrefsBackupDir::new();
    let first: &[u8] = b"{ broken one";
    let second: &[u8] = b"{ broken two";
    for raw in [first, second] {
        fs::write(dir.settings_path(), raw).unwrap();
        save_prefs_in(&dir.0, json!({"defaultChat": "new"})).unwrap();
    }
    let mut backups = dir.backups();
    let mut expected = vec![
        (
            format!("settings-corrupt-{:x}.bak", Sha256::digest(first)),
            first.to_vec(),
        ),
        (
            format!("settings-corrupt-{:x}.bak", Sha256::digest(second)),
            second.to_vec(),
        ),
    ];
    backups.sort();
    expected.sort();
    assert_eq!(backups, expected);
}

#[cfg(unix)]
#[test]
fn backup_failure_blocks_overwrite_and_retry_recovers() {
    use std::os::unix::fs::PermissionsExt;
    // issue 验收：备份写入失败时按图库语义阻止覆盖并上抛可诊断错误
    let dir = PrefsBackupDir::new();
    let corrupted: &[u8] = b"{ not json";
    fs::write(dir.settings_path(), corrupted).unwrap();
    fs::set_permissions(&dir.0, fs::Permissions::from_mode(0o500)).unwrap();
    let error = save_prefs_in(&dir.0, json!({"defaultChat": "new"})).unwrap_err();
    fs::set_permissions(&dir.0, fs::Permissions::from_mode(0o700)).unwrap();
    assert!(error.contains("备份损坏设置原件失败"), "实际错误：{error}");
    // 损坏原件保持原状（未被覆盖），目录内无新增条目
    assert_eq!(fs::read(dir.settings_path()).unwrap(), corrupted);
    assert_eq!(dir.entry_names(), ["settings.json"]);
    // 重试可完成：耐久备份 + 新设置覆盖
    save_prefs_in(&dir.0, json!({"defaultChat": "new"})).unwrap();
    assert_eq!(dir.read(), json!({"defaultChat": "new"}));
    let expected_name = format!("settings-corrupt-{:x}.bak", Sha256::digest(corrupted));
    assert_eq!(dir.backups(), vec![(expected_name, corrupted.to_vec())]);
}

#[test]
fn mismatched_existing_backup_blocks_save() {
    // 既有同摘装备份内容不符（证据被动过）：拒绝继续，不覆盖异常备份，
    // 损坏原件保持原状
    let dir = PrefsBackupDir::new();
    let corrupted: &[u8] = b"{ not json";
    fs::write(dir.settings_path(), corrupted).unwrap();
    let name = format!("settings-corrupt-{:x}.bak", Sha256::digest(corrupted));
    fs::write(dir.0.join(&name), b"tampered evidence").unwrap();
    let error = save_prefs_in(&dir.0, json!({"defaultChat": "new"})).unwrap_err();
    assert!(error.contains("内容不符"), "实际错误：{error}");
    assert_eq!(fs::read(dir.settings_path()).unwrap(), corrupted);
    assert_eq!(
        fs::read(dir.only_backup_path()).unwrap(),
        b"tampered evidence"
    );
}
