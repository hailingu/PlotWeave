//! 旧版 `pw1:` keyEnc 密文的就地迁移（issue #392）。
//!
//! 读取侧（provider_secret）成功解开旧版密文后，把该 provider 条目的
//! `keyEnc` 重封装为 v2（PBKDF2 迭代派生 + provider AAD 绑定）并原子
//! 写回。迁移是 best-effort：失败仅留结构化诊断，绝不影响本次已取得的
//! 明文与请求；旧密文在下一次成功读取前始终可解，失败无损。
//!
//! 写回与 save_prefs 共用设置写互斥（super::settings_write_guard）并在
//! 锁内重读最新文件、只改写「本次成功解开的那个密文」——并发的前端
//! 全量保存（经 save_prefs 命令，同在本进程）要么先于锁内重读（其编辑
//! 被保留）、要么后于迁移写（其快照回退的只是密文版本，无害且下次读取
//! 再迁移），不存在迁移覆盖用户编辑的窗口。

use cap_std::fs::Dir as CapDir;

/// 迁移入口（best-effort）：`opened` 必须是本次成功解开的旧版密文原文
/// ——磁盘上该 provider 条目的 `keyEnc` 仍精确等于它时才改写，任何差异
///（用户重新录入/清除/其它写入）都跳过，不覆盖他人写入。失败仅诊断。
pub(crate) fn migrate_legacy_envelope(
    root: &CapDir,
    provider_id: &str,
    opened: &str,
    plaintext: &str,
) {
    if let Err(e) = try_migrate(root, provider_id, opened, plaintext) {
        eprintln!("[prefs] keyEnc 旧版密文迁移失败（不影响本次请求）：{e}");
    }
}

/// 迁移内核：锁内重读 → 精确匹配校验 → 重封装 → 大小校验 → 原子写。
fn try_migrate(
    root: &CapDir,
    provider_id: &str,
    opened: &str,
    plaintext: &str,
) -> Result<(), String> {
    let _guard = super::settings_write_guard();
    let text = match super::read_prefs_text_capped(root) {
        Ok(text) => text,
        Err(super::PrefsReadError::Io(e)) => return Err(format!("重读设置失败：{e}")),
        Err(super::PrefsReadError::TooLarge) => return Err("设置文件过大，跳过迁移".into()),
        Err(super::PrefsReadError::NotRegularFile) => {
            return Err("设置文件是符号链接或非普通文件，跳过迁移".into())
        }
        Err(super::PrefsReadError::Replaced) => {
            return Err("设置文件在读取前被替换，跳过迁移".into())
        }
    };
    let mut v: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| format!("设置文件损坏，跳过迁移：{e}"))?;
    let Some(entry) = provider_entry_mut(&mut v, provider_id) else {
        return Ok(()); // 条目已不存在（结构被并发改动），跳过
    };
    if entry.get("keyEnc").and_then(|x| x.as_str()) != Some(opened) {
        return Ok(()); // 磁盘密文已非本次解开的那个，不覆盖他人写入
    }
    let sealed = crate::seal::seal_for(provider_id, plaintext)?;
    entry["keyEnc"] = serde_json::Value::String(sealed);
    let out = serde_json::to_string_pretty(&v).map_err(|e| format!("序列化失败：{e}"))?;
    if out.len() > super::PREFS_MAX_BYTES {
        return Err("迁移后设置内容过大，跳过迁移".into());
    }
    crate::store::atomic_write_private(root, super::SETTINGS_FILE_NAME, &out)
        .map_err(|e| format!("写回设置失败：{e}"))
}

/// 按 id 定位 providers 数组中的可变条目。
fn provider_entry_mut<'a>(
    v: &'a mut serde_json::Value,
    provider_id: &str,
) -> Option<&'a mut serde_json::Value> {
    v.get_mut("providers")?
        .as_array_mut()?
        .iter_mut()
        .find(|p| p.get("id").and_then(|x| x.as_str()) == Some(provider_id))
}
