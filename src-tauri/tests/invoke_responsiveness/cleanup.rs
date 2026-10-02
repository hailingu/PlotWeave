//! 测试独占应用目录的失败安全清理守卫（issue #277）：`create_dir_all`
//! 之后的建窗/启动失败会展开栈，绕过 `run_return` 之后的顺序清理——
//! 守卫以 RAII 接管**本次新建**的目录，Drop 时清理并另行报告清理失败，
//! 不吞掉也不掩盖主失败诊断。只删除本次创建的目录：目录已存在时不
//! 接管，显式清理成功后守卫退化为空操作（后续同名目录不得误删）。
//! 本文件被 harness=false 的 invoke_responsiveness 二进制与其单测载体
//! invoke_cleanup_guard.rs（#[path] 复用）共同编译。

use std::fs;
use std::path::PathBuf;

/// 接管本次新建的应用目录；Drop 兜底清理失败路径。
pub struct OwnedAppDataDir {
    dir: PathBuf,
    created: bool,
}

impl OwnedAppDataDir {
    /// 断言目录不存在后创建并接管：已存在（上次遗留或外部创建）时
    /// 直接 panic——不拥有即永不删除，禁止删除非本次创建的目录。
    pub fn create_new(dir: PathBuf) -> Self {
        assert!(!dir.exists(), "测试目录必须是新的：{}", dir.display());
        fs::create_dir_all(&dir).expect("建测试应用目录");
        Self { dir, created: true }
    }

    /// 成功路径的显式强清理：失败即断言失败（保持既有清理语义）；
    /// 成功后守卫退化为空操作，Drop 不再二次删除。
    pub fn remove_now(&mut self) {
        if !self.created {
            return;
        }
        fs::remove_dir_all(&self.dir).expect("清理测试应用目录");
        self.created = false;
    }
}

impl Drop for OwnedAppDataDir {
    fn drop(&mut self) {
        if !self.created {
            return;
        }
        // 展开中的 Drop 再 panic 会中止进程并吞掉主失败诊断：清理失败
        // 仅另行报告（stderr 随子进程 Output 可见），主失败照常上浮。
        if let Err(err) = fs::remove_dir_all(&self.dir) {
            eprintln!("清理测试应用目录失败 {}: {err}", self.dir.display());
        }
    }
}
