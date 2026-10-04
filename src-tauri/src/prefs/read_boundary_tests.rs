//! issue #391：prefs 读取边界的 no-follow 归类——符号链接与 FIFO（非普通
//! 文件）在打开前拒绝：不跟随符号链接读出外部内容、不因打开 FIFO 无限期
//! 阻塞 blocking 池 worker。普通文件行为不变由既有 `tests`/`save_tests`
//! 覆盖；条目归类与打开之间的替换窗口（身份绑定）无确定性触发手段，为
//! 记录缺口（与 store::persist 同层）。

use super::*;
use std::fs;

/// 唯一临时目录：`{tmp}/pw-prefs-boundary-{new_id}-{tag}/`。
fn temp_boundary_dir(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "pw-prefs-boundary-{}-{tag}",
        crate::store::new_id()
    ));
    fs::create_dir_all(&dir).expect("创建临时目录");
    dir
}

#[test]
fn read_prefs_rejects_symlink_settings_without_following() {
    // 符号链接形式的 settings.json 不得被跟随读取：目标内容（即使是合法
    // JSON）不得进入读取结果、进而经设置页回写（issue #391 后果一）
    let dir = temp_boundary_dir("symlink");
    let outside = temp_boundary_dir("symlink-target");
    let target = outside.join("real-settings.json");
    fs::write(&target, r#"{"defaultChat":"leaked"}"#).expect("写入链接目标");
    std::os::unix::fs::symlink(&target, dir.join("settings.json")).expect("创建符号链接");
    let err = read_prefs_in(&dir).expect_err("符号链接应拒绝");
    assert!(err.contains("符号链接或非普通文件"), "实际错误：{err}");
    // 只拒读取：条目与目标内容保持原状
    assert_eq!(
        fs::read_to_string(&target).expect("链接目标应保持原状"),
        r#"{"defaultChat":"leaked"}"#
    );
    let _ = fs::remove_dir_all(&dir);
    let _ = fs::remove_dir_all(&outside);
}

#[test]
fn read_prefs_rejects_fifo_settings_without_blocking() {
    // FIFO 形式的 settings.json 必须在打开前拒绝：跟随路径的 File::open 会
    // 无限期阻塞并占用 blocking 池 worker（issue #391 后果二）；5 秒看门狗
    // 把「阻塞」转化为可失败的断言，而不是挂死测试进程
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;
    use std::sync::mpsc;

    let dir = temp_boundary_dir("fifo");
    let fifo = dir.join("settings.json");
    let c_path = CString::new(fifo.as_os_str().as_bytes()).expect("路径转 CString");
    assert_eq!(
        unsafe { libc::mkfifo(c_path.as_ptr(), 0o600) },
        0,
        "创建 FIFO"
    );
    let (tx, rx) = mpsc::channel();
    let read_dir = dir.clone();
    std::thread::spawn(move || {
        let _ = tx.send(read_prefs_in(&read_dir));
    });
    let result = rx
        .recv_timeout(std::time::Duration::from_secs(5))
        .expect("FIFO 读取不得阻塞（5 秒看门狗超时）");
    let err = result.expect_err("FIFO 应拒绝");
    assert!(err.contains("符号链接或非普通文件"), "实际错误：{err}");
    let _ = fs::remove_dir_all(&dir);
}
