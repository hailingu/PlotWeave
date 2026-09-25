//! store/library 首次创建目录的宿主持久化屏障测试（issue #309，自
//! tests.rs 拆分以维持源文件 800 行上限）：注入宿主同步失败必须显式
//! 上抛并拆除本次新建层级，重试重新创建并同步；已有目录不重复同步。

use super::*;

/// 首次创建 library/ 的宿主同步失败（issue #309）：注入宿主同步失败后
/// 必须返回错误并拆除本次新建层级，不得以成功返回掩盖屏障缺失；重试
/// （无注入）重新创建并同步成功。
#[cfg(unix)]
#[test]
fn ensure_library_dir_host_sync_failure_removes_created_dir_and_retries() {
    let root = std::env::temp_dir().join(format!("pw-library-durable-{}", crate::store::new_id()));
    fs::create_dir_all(&root).expect("创建临时根");
    let root_handle = cap(&root);
    {
        let _injection = crate::store::atomic_write_faults::Injection::new(
            Some(crate::store::atomic_write_faults::Stage::ChildHostSync),
            None,
        );
        let err = crate::library_fs::ensure_library_dir(&root_handle).unwrap_err();
        assert!(
            err.to_string().contains("injected ChildHostSync failure"),
            "实际错误：{err}"
        );
    }
    assert!(!root.join("library").exists(), "同步失败应拆除本次新建层级");
    let dir = crate::library_fs::ensure_library_dir(&root_handle).expect("重试应重新创建并同步");
    drop(dir);
    assert!(root.join("library").is_dir(), "重试后目录应存在");
    cleanup(&root);
}

/// 首次创建 assets/ 的宿主同步失败（issue #309）：同款契约在 assets_root
/// 创建路径上的映射（LibraryError::from），失败拆除重建。
#[cfg(unix)]
#[test]
fn assets_root_host_sync_failure_removes_created_dir_and_retries() {
    let (library, root) = temp_fixture();
    fs::remove_dir(library.join("assets")).expect("移除 assets 模拟首次创建");
    let library_handle = cap(&library);
    {
        let _injection = crate::store::atomic_write_faults::Injection::new(
            Some(crate::store::atomic_write_faults::Stage::ChildHostSync),
            None,
        );
        let err = crate::library_fs::assets_root(&library_handle).unwrap_err();
        assert!(
            err.to_string().contains("injected ChildHostSync failure"),
            "实际错误：{err}"
        );
    }
    assert!(
        !library.join("assets").exists(),
        "同步失败应拆除本次新建层级"
    );
    let dir = crate::library_fs::assets_root(&library_handle).expect("重试应重新创建并同步");
    drop(dir);
    assert!(library.join("assets").is_dir(), "重试后目录应存在");
    cleanup(&root);
}
