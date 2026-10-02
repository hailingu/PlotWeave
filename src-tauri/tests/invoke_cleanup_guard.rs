//! invoke_responsiveness 清理守卫（issue #277）的单测载体：该测试本体是
//! harness=false 的裸二进制（自定义 main，#[test] 不进调用图），此处以
//! #[path] 复用同一 cleanup.rs 实现，在默认 harness 下验证守卫语义。

#![cfg(target_os = "macos")]

#[path = "invoke_responsiveness/cleanup.rs"]
mod cleanup;

use std::fs;
use std::path::PathBuf;

use cleanup::OwnedAppDataDir;

/// 每个用例独占的临时目录（进程号 + 用例名保证不冲突、不复用遗留）。
fn fixture(name: &str) -> PathBuf {
    std::env::temp_dir().join(format!("pw-277-guard-{}-{name}", std::process::id()))
}

/// 受控初始化失败（展开）后目录被清理，主失败诊断原样保留（验收 1）。
#[test]
fn unwind_cleans_dir_and_preserves_primary_panic() {
    let dir = fixture("unwind");
    let payload = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _owned = OwnedAppDataDir::create_new(dir.clone());
        panic!("建窗失败（主诊断）");
    }))
    .expect_err("注入的展开应被捕获");
    assert!(
        !dir.exists(),
        "展开后守卫应清理本次创建的目录：{}",
        dir.display()
    );
    let message = payload
        .downcast_ref::<&str>()
        .copied()
        .or_else(|| payload.downcast_ref::<String>().map(String::as_str));
    assert_eq!(message, Some("建窗失败（主诊断）"), "主失败诊断须原样保留");
}

/// 成功路径显式强清理后守卫解除武装：不得删除后续同名目录（验收 2/3）。
#[test]
fn explicit_cleanup_disarms_drop_and_never_touches_later_dir() {
    let dir = fixture("disarm");
    let mut owned = OwnedAppDataDir::create_new(dir.clone());
    owned.remove_now();
    assert!(!dir.exists(), "成功路径应完成清理");
    // 清理后同名目录由他人重建：守卫已解除武装，Drop 不得删除
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join("marker"), b"kept").unwrap();
    drop(owned);
    assert!(
        dir.join("marker").exists(),
        "已解除武装的守卫不得删除后续同名目录"
    );
    fs::remove_dir_all(&dir).unwrap();
}

/// 目录已存在（上次遗留/外部创建）时拒绝接管：任何路径都不得删除它。
#[test]
fn preexisting_dir_is_never_owned_or_removed() {
    let dir = fixture("preexisting");
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join("marker"), b"kept").unwrap();
    let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _ = OwnedAppDataDir::create_new(dir.clone());
    }));
    assert!(outcome.is_err(), "已存在目录应拒绝接管");
    assert!(dir.join("marker").exists(), "未接管即不得删除它");
    fs::remove_dir_all(&dir).unwrap();
}
