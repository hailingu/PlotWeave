//! API key 加密封装（§8.2 修订：key 不入钥匙串，加密后随 settings.json 落盘）。
//!
//! 方案：AES-256-GCM；密钥 = SHA-256(pepper ‖ 本机标识 ‖ 随机盐)，
//! 盐与 nonce 封装在密文 envelope 内（`pw1:<salt>:<nonce+ciphertext>` hex）。
//! 威胁模型：防 settings.json 明文泄露/云同步/拷贝到其它机器解密；
//! 不敌能以同一用户身份读取本机标识的恶意程序——这是无钥匙串前提下的
//! 务实折中，属加密静态存储而非交互式秘密保管。
//!
//! 机器标识不可用即硬失败（issue #260）：ioreg 执行失败或输出不可解析时
//! `seal`/`open` 直接拒绝，不得静默回退用户名等可猜材料充当机器绑定；
//! 失败结果不缓存，下次调用重新探测可恢复；诊断不含用户名/机器标识/密钥/密文。
//! 历史弱材料密文（修复前在 ioreg 失败窗口以用户名回退封装）不提供恢复
//! 通道，正常环境下按非本机数据同款拒绝，用户在设置页重新录入 key。

use aes_gcm::aead::{Aead, AeadCore, KeyInit, OsRng};
use aes_gcm::{Aes256Gcm, Nonce};
use sha2::{Digest, Sha256};
use std::sync::OnceLock;

/// envelope 版本前缀：算法/格式变更时递增。
pub const ENVELOPE_PREFIX: &str = "pw1:";

const NONCE_LEN: usize = 12;
const SALT_LEN: usize = 16;

/// 应用常数 pepper（与二进制同源；单独存在不构成密钥）。
const PEPPER: &[u8] = b"plotweave/key-seal/v1";

pub fn new_salt() -> String {
    // generate_nonce 固定 12 字节；拼接两个补足 SALT_LEN
    let a = Aes256Gcm::generate_nonce(&mut OsRng);
    let b = Aes256Gcm::generate_nonce(&mut OsRng);
    let mut bytes = [0u8; SALT_LEN];
    bytes[..NONCE_LEN].copy_from_slice(&a);
    bytes[NONCE_LEN..].copy_from_slice(&b[..SALT_LEN - NONCE_LEN]);
    hex_encode(&bytes)
}

/// 从 ioreg 输出提取机器材料。提取结果是既有密文的密钥派生输入，
/// 属稳定契约：保持历史提取语义不变，否则存量密文不可解。
fn extract_platform_uuid(text: &str) -> Option<String> {
    let idx = text.find("IOPlatformUUID")?;
    let tail = &text[idx..];
    let a = tail.find('"')?;
    let b = tail.rfind('"')?;
    if b > a + 1 {
        Some(tail[a + 1..b].to_string())
    } else {
        None
    }
}

/// 探测本机标识：macOS 取 IOPlatformUUID；失败返回诊断（不含敏感值）。
#[cfg(target_os = "macos")]
fn probe_machine_id() -> Result<String, String> {
    let out = std::process::Command::new("/usr/sbin/ioreg")
        .args(["-rd1", "-c", "IOPlatformExpertDevice"])
        .output()
        .map_err(|e| format!("本机标识不可用（ioreg 执行失败：{}）", e.kind()))?;
    interpret_probe_output(out.status.success(), &out.stdout)
}

/// 解读 ioreg 结果：非零退出先于 stdout 解析拒绝——被终止的进程可能留下
/// 截断的 `IOPlatformUUID" = "...`，宽松提取器会把它当作材料缓存并封装出
/// 重启后不可解的密文（PR #283 评审）。
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn interpret_probe_output(exit_ok: bool, stdout: &[u8]) -> Result<String, String> {
    if !exit_ok {
        return Err("本机标识不可用（ioreg 非零退出）".into());
    }
    let text = String::from_utf8_lossy(stdout);
    extract_platform_uuid(&text).ok_or_else(|| "本机标识不可用（ioreg 输出无法解析）".into())
}

#[cfg(not(target_os = "macos"))]
fn probe_machine_id() -> Result<String, String> {
    Err("本机标识不可用（当前平台未实现机器标识获取）".into())
}

/// 缓存内核（可注入探测，便于测试）：只缓存成功结果，失败不入缓存，
/// 后续调用重新探测得以恢复（issue #260：失败不得被永久固化）。
fn cached_machine_material(
    cache: &OnceLock<String>,
    probe: impl FnOnce() -> Result<String, String>,
) -> Result<String, String> {
    if let Some(v) = cache.get() {
        return Ok(v.clone());
    }
    let id = probe()?;
    Ok(cache.get_or_init(|| id).clone())
}

/// 本机标识：不可用时返回可诊断错误，绝不回退用户名等可猜材料。
pub fn machine_material() -> Result<String, String> {
    static CACHE: OnceLock<String> = OnceLock::new();
    cached_machine_material(&CACHE, probe_machine_id)
}

fn derive_key(material: &str, salt: &str) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(PEPPER);
    hasher.update(material.as_bytes());
    hasher.update(salt.as_bytes());
    hasher.finalize().into()
}

/// 加密：返回 `pw1:<salt_hex>:<nonce+ct_hex>`；机器标识不可用时拒绝封装。
pub fn seal(plaintext: &str) -> Result<String, String> {
    seal_with(&machine_material()?, plaintext)
}

fn seal_with(material: &str, plaintext: &str) -> Result<String, String> {
    let salt = new_salt();
    let cipher = Aes256Gcm::new_from_slice(&derive_key(material, &salt))
        .map_err(|e| format!("密钥初始化失败：{e}"))?;
    let nonce = Aes256Gcm::generate_nonce(&mut OsRng);
    let ct = cipher
        .encrypt(&nonce, plaintext.as_bytes())
        .map_err(|e| format!("加密失败：{e}"))?;
    Ok(format!(
        "{ENVELOPE_PREFIX}{}:{}",
        salt,
        hex_encode(&[nonce.as_slice(), ct.as_slice()].concat())
    ))
}

/// 解密 envelope；任何篡改/环境不匹配/机器标识不可用都返回 Err，
/// 绝不输出明文碎片，也不尝试弱材料兼容解密。
pub fn open(envelope: &str) -> Result<String, String> {
    open_with(&machine_material()?, envelope)
}

fn open_with(material: &str, envelope: &str) -> Result<String, String> {
    let body = envelope
        .strip_prefix(ENVELOPE_PREFIX)
        .ok_or_else(|| "密文格式未知（缺少版本前缀）".to_string())?;
    let (salt, payload) = body.split_once(':').ok_or("密文格式损坏")?;
    if salt.len() != SALT_LEN * 2 {
        return Err("密文盐长度非法".into());
    }
    let bytes = hex_decode(payload).ok_or("密文不是合法 hex")?;
    if bytes.len() <= NONCE_LEN {
        return Err("密文负载过短".into());
    }
    let (nonce, ct) = bytes.split_at(NONCE_LEN);
    let cipher = Aes256Gcm::new_from_slice(&derive_key(material, salt))
        .map_err(|e| format!("密钥初始化失败：{e}"))?;
    let plain = cipher
        .decrypt(Nonce::from_slice(nonce), ct)
        .map_err(|_| "解密失败：密文被篡改或非本机数据".to_string())?;
    String::from_utf8(plain).map_err(|_| "解密结果不是合法 UTF-8".to_string())
}

fn hex_encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push_str(&format!("{b:02x}"));
    }
    out
}

fn hex_decode(s: &str) -> Option<Vec<u8>> {
    if !s.len().is_multiple_of(2) {
        return None;
    }
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(s.len() / 2);
    for pair in bytes.chunks(2) {
        let hi = (pair[0] as char).to_digit(16)?;
        let lo = (pair[1] as char).to_digit(16)?;
        out.push(((hi << 4) | lo) as u8);
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    const MATERIAL: &str = "test-machine-uuid-0000";

    #[test]
    fn roundtrip_preserves_plaintext() {
        // 公开 API 走真实 machine_material：成功路径 + 加解密集成
        let secret = "sk-kimi-测试-🔑-1234567890";
        let envelope = seal(secret).unwrap();
        assert!(envelope.starts_with(ENVELOPE_PREFIX));
        assert!(!envelope.contains("sk-kimi"));
        assert_eq!(open(&envelope).unwrap(), secret);
    }

    #[test]
    fn each_seal_uses_fresh_salt_and_nonce() {
        let a = seal_with(MATERIAL, "same-secret").unwrap();
        let b = seal_with(MATERIAL, "same-secret").unwrap();
        assert_ne!(a, b);
        assert_eq!(open_with(MATERIAL, &a).unwrap(), "same-secret");
        assert_eq!(open_with(MATERIAL, &b).unwrap(), "same-secret");
    }

    #[test]
    fn tampered_payload_is_rejected() {
        let envelope = seal_with(MATERIAL, "secret").unwrap();
        let mut chars: Vec<char> = envelope.chars().collect();
        let last = chars.len() - 1;
        chars[last] = if chars[last] == '0' { '1' } else { '0' };
        let tampered: String = chars.into_iter().collect();
        assert!(open_with(MATERIAL, &tampered).is_err());
    }

    #[test]
    fn malformed_envelopes_are_rejected() {
        assert!(open_with(MATERIAL, "").is_err());
        assert!(open_with(MATERIAL, "xx:00:00").is_err());
        assert!(open_with(MATERIAL, "pw1:short:00").is_err());
        assert!(open_with(MATERIAL, "pw1:0123456789abcdef0123456789abcdef:zz").is_err());
        assert!(open_with(MATERIAL, "pw1:0123456789abcdef0123456789abcdef:00").is_err());
    }

    #[test]
    fn envelope_sealed_with_different_material_is_rejected() {
        // 历史弱材料密文兼容策略（issue #260）：材料不匹配即拒绝，
        // 不提供弱材料恢复通道，用户重新录入 key
        let weak = seal_with("guessable-username", "secret").unwrap();
        assert!(open_with(MATERIAL, &weak).is_err());
    }

    #[test]
    fn extract_platform_uuid_matches_legacy_semantics() {
        // 提取语义是既有密文的派生输入，属稳定契约：不得随重构漂移
        let text =
            "  +-o X  <class IOPlatformExpertDevice>\n    \"IOPlatformUUID\" = \"AAAA-BBBB\"\n";
        assert_eq!(extract_platform_uuid(text).unwrap(), " = \"AAAA-BBBB");
        assert!(extract_platform_uuid("no uuid here").is_none());
        assert!(extract_platform_uuid("IOPlatformUUID").is_none());
        assert!(extract_platform_uuid("IOPlatformUUID\"\"").is_none());
    }

    #[test]
    fn non_zero_ioreg_exit_is_rejected_before_parsing_partial_stdout() {
        // 截断输出在宽松提取器下仍能产出材料，退出码必须先拒绝
        let partial = b"    \"IOPlatformUUID\" = \"AAAA-BB";
        assert!(extract_platform_uuid(&String::from_utf8_lossy(partial)).is_some());
        let err = interpret_probe_output(false, partial).unwrap_err();
        assert!(!err.contains("AAAA"), "诊断不得回显材料");
        // 退出成功时沿用历史提取语义（截断输出下产出的是无意义材料，正是要拒绝的原因）
        assert_eq!(interpret_probe_output(true, partial).unwrap(), " = ");
        assert!(interpret_probe_output(true, b"nothing").is_err());
    }

    #[test]
    fn failed_probe_is_not_cached_and_recovery_succeeds() {
        let cache = OnceLock::new();
        let err = cached_machine_material(&cache, || Err("探测失败".into()));
        assert!(err.is_err());
        assert!(cache.get().is_none(), "失败结果不得缓存");
        let ok = cached_machine_material(&cache, || Ok("uuid-1".into()));
        assert_eq!(ok.unwrap(), "uuid-1");
        let cached = cached_machine_material(&cache, || panic!("成功后不得再探测"));
        assert_eq!(cached.unwrap(), "uuid-1");
    }

    #[test]
    fn probe_failure_diagnostics_do_not_leak_secrets() {
        let cache = OnceLock::new();
        let err = cached_machine_material(&cache, || Err("本机标识不可用：ioreg 执行失败".into()))
            .unwrap_err();
        let user = std::env::var("USER").unwrap_or_default();
        assert!(
            user.is_empty() || !err.contains(&user),
            "诊断不得泄露用户名"
        );
    }

    #[test]
    fn hex_helpers_roundtrip() {
        let bytes = vec![0x00, 0x0f, 0xff, 0xa5];
        assert_eq!(hex_decode(&hex_encode(&bytes)).unwrap(), bytes);
        assert!(hex_decode("0g").is_none());
        assert!(hex_decode("abc").is_none());
    }
}
