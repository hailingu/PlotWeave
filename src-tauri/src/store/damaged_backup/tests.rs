//! 共用内核行为测试（issue #390 提取，语义先由 #137 图库侧确立）：损坏
//! 判定、字节精确备份、失败重试复用、fail-closed 拒绝族与耐久写入协议。

use super::*;
use cap_std::{ambient_authority, fs::Dir as CapDir};
use std::fs;
use std::path::PathBuf;

/// 测试规格：小上限（64 字节）让超限用例无需巨型夹具。
const TEST_BACKUP: DamagedFileBackup = DamagedFileBackup {
    permissions: FilePermissions::Default,
    file_name: "control.json",
    backup_prefix: "control-corrupt-",
    max_bytes: 64,
    source_label: "测试控制文件",
    backup_label: "测试控制文件",
};

/// 每个测试持有独立目录；析构回收，不触及用户应用目录。
struct Fixture {
    path: PathBuf,
    dir: CapDir,
}

impl Fixture {
    fn new() -> Self {
        let path =
            std::env::temp_dir().join(format!("pw-damaged-backup-{}", crate::store::new_id()));
        fs::create_dir(&path).unwrap();
        let dir = CapDir::open_ambient_dir(&path, ambient_authority()).unwrap();
        Self { path, dir }
    }

    fn write_source(&self, bytes: &[u8]) {
        fs::write(self.path.join(TEST_BACKUP.file_name), bytes).unwrap();
    }

    fn source_bytes(&self) -> Vec<u8> {
        fs::read(self.path.join(TEST_BACKUP.file_name)).unwrap()
    }

    /// 备份条目 (名字, 字节) 清单（排序稳定）。
    fn backups(&self) -> Vec<(String, Vec<u8>)> {
        let mut found: Vec<_> = fs::read_dir(&self.path)
            .unwrap()
            .filter_map(|entry| {
                let path = entry.unwrap().path();
                let name = path.file_name()?.to_str()?.to_string();
                name.starts_with(TEST_BACKUP.backup_prefix)
                    .then(|| (name, fs::read(&path).unwrap()))
            })
            .collect();
        found.sort();
        found
    }

    fn expected_name(bytes: &[u8]) -> String {
        format!(
            "{}{:x}.bak",
            TEST_BACKUP.backup_prefix,
            Sha256::digest(bytes)
        )
    }

    /// 唯一备份的路径（已断言恰有一份时使用）。
    fn only_backup_path(&self) -> PathBuf {
        let paths: Vec<_> = fs::read_dir(&self.path)
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .filter(|path| {
                path.file_name().is_some_and(|n| {
                    n.to_str()
                        .is_some_and(|n| n.starts_with("control-corrupt-"))
                })
            })
            .collect();
        assert_eq!(paths.len(), 1);
        paths.into_iter().next().unwrap()
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

#[test]
fn missing_source_creates_no_backup() {
    // 仅条目缺失视为无原件可保护（首启语义），不产生备份
    let fixture = Fixture::new();
    backup_damaged_file(&fixture.dir, &TEST_BACKUP).unwrap();
    assert!(fixture.backups().is_empty());
}

#[test]
fn healthy_object_source_creates_no_backup() {
    let fixture = Fixture::new();
    fixture.write_source(br#"{"a":1}"#);
    backup_damaged_file(&fixture.dir, &TEST_BACKUP).unwrap();
    assert!(fixture.backups().is_empty());
}

#[test]
fn damaged_json_backed_up_byte_exact_with_digest_name() {
    let fixture = Fixture::new();
    let raw: &[u8] = b"{ not json";
    fixture.write_source(raw);
    backup_damaged_file(&fixture.dir, &TEST_BACKUP).unwrap();
    assert_eq!(
        fixture.backups(),
        vec![(Fixture::expected_name(raw), raw.to_vec())]
    );
}

#[test]
fn valid_non_object_json_counts_as_damaged() {
    // 与图库同款判定：解析成功但根非对象（数组/标量）同样按损坏备份
    for raw in [br#"[1,2]"#.as_slice(), b"42", b"\"text\"", b"null"] {
        let fixture = Fixture::new();
        fixture.write_source(raw);
        backup_damaged_file(&fixture.dir, &TEST_BACKUP).unwrap();
        assert_eq!(
            fixture.backups(),
            vec![(Fixture::expected_name(raw), raw.to_vec())],
            "原始字节：{raw:?}"
        );
    }
}

#[test]
fn invalid_utf8_source_backed_up_as_raw_bytes() {
    // 按字节而非文本留存：非法 UTF-8 原件不得因文本转换丢失或变形
    let fixture = Fixture::new();
    let raw: &[u8] = &[0xff, 0xfe, b'{', 0x00, b'}'];
    fixture.write_source(raw);
    backup_damaged_file(&fixture.dir, &TEST_BACKUP).unwrap();
    assert_eq!(
        fixture.backups(),
        vec![(Fixture::expected_name(raw), raw.to_vec())]
    );
}

#[test]
fn repeated_calls_reuse_single_identical_backup() {
    // 同一损坏原件的失败重试复用同一副本，不随重试累计
    let fixture = Fixture::new();
    let raw: &[u8] = b"{ broken";
    fixture.write_source(raw);
    backup_damaged_file(&fixture.dir, &TEST_BACKUP).unwrap();
    backup_damaged_file(&fixture.dir, &TEST_BACKUP).unwrap();
    assert_eq!(
        fixture.backups(),
        vec![(Fixture::expected_name(raw), raw.to_vec())]
    );
}

#[test]
fn changed_original_keeps_distinct_backups() {
    let fixture = Fixture::new();
    let first: &[u8] = b"{ broken";
    let second: &[u8] = b"{ broken differently";
    for raw in [first, second] {
        fixture.write_source(raw);
        backup_damaged_file(&fixture.dir, &TEST_BACKUP).unwrap();
    }
    let mut backups = fixture.backups();
    backups.sort();
    let mut expected = vec![
        (Fixture::expected_name(first), first.to_vec()),
        (Fixture::expected_name(second), second.to_vec()),
    ];
    expected.sort();
    assert_eq!(backups, expected);
}

#[test]
fn mismatched_existing_backup_blocks_without_touching_evidence() {
    let fixture = Fixture::new();
    let raw: &[u8] = b"{ broken";
    fixture.write_source(raw);
    fs::write(
        fixture.path.join(Fixture::expected_name(raw)),
        b"different evidence",
    )
    .unwrap();
    let error = backup_damaged_file(&fixture.dir, &TEST_BACKUP).unwrap_err();
    assert!(error.to_string().contains("内容不符"), "实际错误：{error}");
    assert_eq!(fixture.source_bytes(), raw);
    assert_eq!(
        fixture.backups(),
        vec![(Fixture::expected_name(raw), b"different evidence".to_vec())]
    );
}

#[cfg(unix)]
#[test]
fn irregular_existing_backup_blocks_reuse() {
    use std::os::unix::fs::symlink;
    for as_symlink in [false, true] {
        let fixture = Fixture::new();
        let raw: &[u8] = b"{ broken";
        fixture.write_source(raw);
        let name = Fixture::expected_name(raw);
        let outside = fixture.path.join("outside-copy");
        fs::write(&outside, raw).unwrap();
        if as_symlink {
            symlink(&outside, fixture.path.join(&name)).unwrap();
        } else {
            fs::create_dir(fixture.path.join(&name)).unwrap();
        }
        let error = backup_damaged_file(&fixture.dir, &TEST_BACKUP).unwrap_err();
        assert!(error.to_string().contains("拒绝复用"), "实际错误：{error}");
        assert_eq!(fixture.source_bytes(), raw);
        assert_eq!(fs::read(&outside).unwrap(), raw);
    }
}

#[cfg(unix)]
#[test]
fn symlink_source_rejected_without_backup() {
    use std::os::unix::fs::symlink;
    let fixture = Fixture::new();
    let outside = fixture.path.join("outside.json");
    fs::write(&outside, b"{ broken").unwrap();
    symlink(&outside, fixture.path.join(TEST_BACKUP.file_name)).unwrap();
    let error = backup_damaged_file(&fixture.dir, &TEST_BACKUP).unwrap_err();
    assert!(error.to_string().contains("符号链接"), "实际错误：{error}");
    assert!(fixture.backups().is_empty());
}

#[test]
fn directory_source_rejected_without_backup() {
    let fixture = Fixture::new();
    fs::create_dir(fixture.path.join(TEST_BACKUP.file_name)).unwrap();
    let error = backup_damaged_file(&fixture.dir, &TEST_BACKUP).unwrap_err();
    assert!(
        error.to_string().contains("不是普通文件"),
        "实际错误：{error}"
    );
    assert!(fixture.backups().is_empty());
}

#[test]
fn oversize_source_rejected_as_backup_failure() {
    // 超限原件无法在限读内物化：按备份异常拒绝（fail-closed），不降级为
    // 「无原件」语义，也不盲目覆盖
    let fixture = Fixture::new();
    fixture.write_source(&[b'x'; TEST_BACKUP.max_bytes + 1]);
    let error = backup_damaged_file(&fixture.dir, &TEST_BACKUP).unwrap_err();
    assert!(
        error.to_string().contains("超过") && error.to_string().contains("拒绝读取"),
        "实际错误：{error}"
    );
    assert!(fixture.backups().is_empty());
}

#[cfg(unix)]
#[test]
fn backup_write_failure_blocks_and_leaves_no_residue() {
    use std::os::unix::fs::PermissionsExt;
    let fixture = Fixture::new();
    let raw: &[u8] = b"{ broken";
    fixture.write_source(raw);
    fs::set_permissions(&fixture.path, fs::Permissions::from_mode(0o500)).unwrap();
    let error = backup_damaged_file(&fixture.dir, &TEST_BACKUP).unwrap_err();
    fs::set_permissions(&fixture.path, fs::Permissions::from_mode(0o700)).unwrap();
    assert!(error.to_string().contains("备份"), "实际错误：{error}");
    assert_eq!(fixture.source_bytes(), raw);
    assert!(fixture.backups().is_empty());
    // 权限恢复后重试可完成：耐久备份 + 原件仍在（覆盖归调用方执行）
    backup_damaged_file(&fixture.dir, &TEST_BACKUP).unwrap();
    assert_eq!(
        fixture.backups(),
        vec![(Fixture::expected_name(raw), raw.to_vec())]
    );
    assert_eq!(fixture.source_bytes(), raw);
}

#[test]
fn injected_create_failure_blocks_and_cleans_temp_file() {
    use crate::store::atomic_write_faults::{Injection, Stage};
    let fixture = Fixture::new();
    let raw: &[u8] = b"{ broken";
    fixture.write_source(raw);
    let injection = Injection::new(Some(Stage::Create), None);
    let error = backup_damaged_file(&fixture.dir, &TEST_BACKUP).unwrap_err();
    assert!(
        error.to_string().contains("injected Create failure"),
        "实际错误：{error}"
    );
    assert_eq!(fixture.source_bytes(), raw);
    // 失败清理：目录内除源文件外无临时/备份残留
    assert_eq!(
        fs::read_dir(&fixture.path)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().into_string().unwrap())
            .filter(|name| name != TEST_BACKUP.file_name)
            .count(),
        0
    );
    drop(injection);
    backup_damaged_file(&fixture.dir, &TEST_BACKUP).unwrap();
    assert_eq!(
        fixture.backups(),
        vec![(Fixture::expected_name(raw), raw.to_vec())]
    );
}

#[test]
fn raced_backup_target_refused_at_rename_recheck() {
    // 预检通过后、rename 前被并发写者占位：拒绝覆盖既有备份（fail-closed）
    use crate::store::atomic_write_faults::{Injection, Stage};
    let fixture = Fixture::new();
    let raw: &[u8] = b"{ broken";
    fixture.write_source(raw);
    let raced = fixture.path.join(Fixture::expected_name(raw));
    let injection = Injection::with_probe(Stage::Create, move || {
        fs::write(&raced, b"raced writer").unwrap()
    });
    let error = backup_damaged_file(&fixture.dir, &TEST_BACKUP).unwrap_err();
    drop(injection);
    assert!(error.to_string().contains("已存在"), "实际错误：{error}");
    assert_eq!(
        fs::read(fixture.only_backup_path()).unwrap(),
        b"raced writer"
    );
    assert_eq!(fixture.source_bytes(), raw);
}
