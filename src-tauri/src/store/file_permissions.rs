//! 控制文件的创建权限策略：设置凭据显式选择 Unix 私有 mode，其他域保持
//! 默认权限；只构造排他创建选项，不解析路径或改变持久化协议。

use cap_std::fs::OpenOptions;

/// 文件域声明的权限策略，供原子写及损坏备份共用，避免凭据副本遗漏收权。
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum FilePermissions {
    /// 沿用平台默认创建权限与进程 umask。
    Default,
    /// Unix 创建 mode 为 0600（umask 可进一步收紧）；非 Unix 沿用默认。
    OwnerOnly,
}

impl FilePermissions {
    /// 从排他创建起应用权限，保证临时文件写入凭据之前已经私有。
    pub(crate) fn new_file_options(self) -> OpenOptions {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        if self == Self::OwnerOnly {
            use cap_std::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        options
    }
}
