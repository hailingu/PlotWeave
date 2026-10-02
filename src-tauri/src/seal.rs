//! API key 加密封装（§8.2 修订：key 不入钥匙串，加密后随 settings.json 落盘）。
//!
//! 方案（envelope v2，issue #392）：AES-256-GCM；密钥 =
//! PBKDF2-HMAC-SHA256(pepper ‖ 本机标识, 随机盐, envelope 内迭代数)，
//! 并以 provider id 作 AES-GCM AAD 把密文绑定到所属 provider 条目——
//! 密文原样搬到其它 provider 名下解密失败。迭代数、盐与 nonce 封装在
//! envelope 内（`pw2:<iter>:<provider>:<salt_hex>:<nonce+ct_hex>`）。
//! 旧版 `pw1:`（单次 SHA-256 派生、无 AAD）保持可解以兼容存量密文，
//! 读取成功后由 prefs 侧就地重封装迁移（读取边界与写互斥见 prefs 模块）。
//! 威胁模型：防 settings.json 明文泄露/云同步/拷贝到其它机器解密；
//! 不敌能以同一用户身份读取本机标识的恶意程序——这是无钥匙串前提下的
//! 务实折中，属加密静态存储而非交互式秘密保管。迭代拉伸与 AAD 绑定是
//! 该模型内的纵深防御（抬高离线穷举成本、封堵密文跨条目搬移），不改变
//! 模型边界。
//!
//! 机器标识不可用即硬失败（issue #260）：ioreg 执行失败或输出不可解析时
//! `seal_for`/`open_for` 直接拒绝，不得静默回退用户名等可猜材料充当机器
//! 绑定；失败结果不缓存，下次调用重新探测可恢复；诊断不含用户名/机器
//! 标识/密钥/密文。历史弱材料密文（修复前在 ioreg 失败窗口以用户名回退
//! 封装）不提供恢复通道，正常环境下按非本机数据同款拒绝，用户在设置页
//! 重新录入 key。

use aes_gcm::aead::{Aead, AeadCore, KeyInit, OsRng, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use pbkdf2::pbkdf2_hmac;
use sha2::{Digest, Sha256};
use std::sync::OnceLock;

/// envelope 版本前缀：算法/格式变更时递增。v2 相对 v1 的差异：
/// PBKDF2 迭代派生（迭代数入 envelope）+ provider id 的 AAD 绑定。
pub const ENVELOPE_PREFIX: &str = "pw2:";

/// 旧版 envelope 前缀（单次 SHA-256 派生、无 provider 绑定）：仅保持
/// 解密兼容（存量密文），新封装一律使用 [`ENVELOPE_PREFIX`]；识别旧
/// 密文以驱动就地迁移见 [`is_legacy_envelope`]。
pub const LEGACY_ENVELOPE_PREFIX: &str = "pw1:";

const NONCE_LEN: usize = 12;
const SALT_LEN: usize = 16;
const PROVIDER_ID_MAX_LEN: usize = 64;

/// v2 密钥派生迭代数（封装时写入 envelope 的值）：对齐 OWASP 对
/// PBKDF2-HMAC-SHA256 的现行建议量级，把离线穷举成本从单次哈希抬高
/// 约 6 个数量级（issue #392；密钥材料本为 128 bit 机器标识，此处属
/// 纵深防御而非唯一防线）。
const KDF_ROUNDS: u32 = 600_000;

/// v2 解密接受的迭代数上界：迭代数来自 envelope（自描述），伪造
/// envelope 塞入天文数字会按每迭代线性消耗 CPU——超上界按格式损坏
/// 拒绝，防经由 settings.json 的计算 DoS。
const MAX_OPEN_ROUNDS: u32 = 5_000_000;

/// 应用常数 pepper（与二进制同源；单独存在不构成密钥）。
const PEPPER: &[u8] = b"plotweave/key-seal/v1";

/// envelope 绑定字段的格式不变量：provider id 非空、≤64 字符且限于
/// ASCII 字母数字/`-`/`_`。该子集不含 envelope 定界符 `:`，既是 AAD
/// 绑定材料的稳定拼写，也保证解析无歧义；与 prefs 的 provider id
/// 校验同规则，此处独立守卫 seal 自身的格式边界。
fn valid_provider_binding(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= PROVIDER_ID_MAX_LEN
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// 生成 SALT_LEN 随机盐（原始字节）。
fn new_salt_bytes() -> [u8; SALT_LEN] {
    // generate_nonce 固定 12 字节；拼接两个补足 SALT_LEN
    let a = Aes256Gcm::generate_nonce(&mut OsRng);
    let b = Aes256Gcm::generate_nonce(&mut OsRng);
    let mut bytes = [0u8; SALT_LEN];
    bytes[..NONCE_LEN].copy_from_slice(&a);
    bytes[NONCE_LEN..].copy_from_slice(&b[..SALT_LEN - NONCE_LEN]);
    bytes
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

/// v2 派生：PBKDF2-HMAC-SHA256(pepper ‖ 机器标识, 盐原始字节, iter)。
/// 迭代数是 envelope 自述的派生参数（issue #392 的拉伸成本所在）。
fn derive_hardened_key(material: &str, salt_bytes: &[u8], rounds: u32) -> [u8; 32] {
    let mut password = Vec::with_capacity(PEPPER.len() + material.len());
    password.extend_from_slice(PEPPER);
    password.extend_from_slice(material.as_bytes());
    let mut key = [0u8; 32];
    pbkdf2_hmac::<Sha256>(&password, salt_bytes, rounds, &mut key);
    key
}

/// 旧版派生（单次 SHA-256）：存量 `pw1:` 密文的兼容解密输入，语义
/// 冻结——任何改动都会使存量密文不可解。
fn derive_legacy_key(material: &str, salt: &str) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(PEPPER);
    hasher.update(material.as_bytes());
    hasher.update(salt.as_bytes());
    hasher.finalize().into()
}

/// 加密：返回 `pw2:<iter>:<provider>:<salt_hex>:<nonce+ct_hex>`，以
/// provider id 为 AAD 绑定密文所属条目；机器标识不可用时拒绝封装。
pub fn seal_for(provider_id: &str, plaintext: &str) -> Result<String, String> {
    seal_for_with(&machine_material()?, provider_id, plaintext)
}

fn seal_for_with(material: &str, provider_id: &str, plaintext: &str) -> Result<String, String> {
    if !valid_provider_binding(provider_id) {
        return Err(format!("非法 provider id：{provider_id}"));
    }
    let salt = new_salt_bytes();
    let cipher = Aes256Gcm::new_from_slice(&derive_hardened_key(material, &salt, KDF_ROUNDS))
        .map_err(|e| format!("密钥初始化失败：{e}"))?;
    let nonce = Aes256Gcm::generate_nonce(&mut OsRng);
    let ct = cipher
        .encrypt(
            &nonce,
            Payload {
                msg: plaintext.as_bytes(),
                aad: provider_id.as_bytes(),
            },
        )
        .map_err(|e| format!("加密失败：{e}"))?;
    Ok(format!(
        "{ENVELOPE_PREFIX}{KDF_ROUNDS}:{provider_id}:{}:{}",
        hex_encode(&salt),
        hex_encode(&[nonce.as_slice(), ct.as_slice()].concat())
    ))
}

/// 解密 envelope：v2 按 envelope 自述迭代数派生并校验 provider 绑定
///（AAD），旧版 `pw1:` 走兼容路径。任何篡改/环境不匹配/机器标识不可用
/// 都返回 Err，绝不输出明文碎片，也不尝试弱材料兼容解密。
pub fn open_for(provider_id: &str, envelope: &str) -> Result<String, String> {
    open_for_with(&machine_material()?, provider_id, envelope)
}

fn open_for_with(material: &str, provider_id: &str, envelope: &str) -> Result<String, String> {
    if let Some(body) = envelope.strip_prefix(ENVELOPE_PREFIX) {
        return open_v2_with(material, provider_id, body);
    }
    let legacy = envelope
        .strip_prefix(LEGACY_ENVELOPE_PREFIX)
        .ok_or_else(|| "密文格式未知（缺少版本前缀）".to_string())?;
    open_legacy_with(material, legacy)
}

/// v2 解密：`<iter>:<provider>:<salt_hex>:<nonce+ct_hex>`。迭代数越界、
/// 嵌入 provider 与请求不符、hex/长度非法、AAD 校验失败均拒绝。
fn open_v2_with(material: &str, provider_id: &str, body: &str) -> Result<String, String> {
    let fields: Vec<&str> = body.split(':').collect();
    if fields.len() != 4 {
        return Err("密文格式损坏".into());
    }
    if !valid_provider_binding(provider_id) {
        return Err(format!("非法 provider id：{provider_id}"));
    }
    if fields[1] != provider_id {
        return Err("密文与 provider 不匹配".into());
    }
    let rounds: u32 = fields[0]
        .parse()
        .map_err(|_| "密文迭代数非法".to_string())?;
    if rounds == 0 || rounds > MAX_OPEN_ROUNDS {
        return Err("密文迭代数超出合法范围".into());
    }
    if fields[2].len() != SALT_LEN * 2 {
        return Err("密文盐长度非法".into());
    }
    let salt = hex_decode(fields[2]).ok_or("密文盐不是合法 hex")?;
    let bytes = hex_decode(fields[3]).ok_or("密文不是合法 hex")?;
    if bytes.len() <= NONCE_LEN {
        return Err("密文负载过短".into());
    }
    let (nonce, ct) = bytes.split_at(NONCE_LEN);
    let cipher = Aes256Gcm::new_from_slice(&derive_hardened_key(material, &salt, rounds))
        .map_err(|e| format!("密钥初始化失败：{e}"))?;
    let plain = cipher
        .decrypt(
            Nonce::from_slice(nonce),
            Payload {
                msg: ct,
                aad: provider_id.as_bytes(),
            },
        )
        .map_err(|_| "解密失败：密文被篡改或非本机数据".to_string())?;
    String::from_utf8(plain).map_err(|_| "解密结果不是合法 UTF-8".to_string())
}

/// 旧版 `pw1:` 解密（兼容存量密文）：单次 SHA-256 派生、无 AAD——
/// 密文不绑定 provider；格式与派生语义冻结。
fn open_legacy_with(material: &str, body: &str) -> Result<String, String> {
    let (salt, payload) = body.split_once(':').ok_or("密文格式损坏")?;
    if salt.len() != SALT_LEN * 2 {
        return Err("密文盐长度非法".into());
    }
    let bytes = hex_decode(payload).ok_or("密文不是合法 hex")?;
    if bytes.len() <= NONCE_LEN {
        return Err("密文负载过短".into());
    }
    let (nonce, ct) = bytes.split_at(NONCE_LEN);
    let cipher = Aes256Gcm::new_from_slice(&derive_legacy_key(material, salt))
        .map_err(|e| format!("密钥初始化失败：{e}"))?;
    let plain = cipher
        .decrypt(Nonce::from_slice(nonce), ct)
        .map_err(|_| "解密失败：密文被篡改或非本机数据".to_string())?;
    String::from_utf8(plain).map_err(|_| "解密结果不是合法 UTF-8".to_string())
}

/// 判断 envelope 是否旧版 `pw1:` 密文：读取侧据此在成功解开后就地
/// 重封装迁移（issue #392）；迁移本身由 prefs 模块执行。
pub fn is_legacy_envelope(envelope: &str) -> bool {
    envelope.starts_with(LEGACY_ENVELOPE_PREFIX)
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

/// 测试专用：构造旧版 `pw1:` 密文（seal 自测与 prefs 迁移测试共用）。
/// 生产路径自 v2 起不再产出旧版密文；其派生与封装语义已冻结，此处
/// 按同一语义复刻，供兼容解密与迁移路径的行为测试构造夹具。
#[cfg(test)]
pub(crate) mod test_support {
    use aes_gcm::aead::{Aead, AeadCore, KeyInit};

    /// 以指定材料按 v1 冻结语义封装（单次 SHA-256 派生、无 AAD）。
    pub fn legacy_seal_with(material: &str, plaintext: &str) -> Result<String, String> {
        let salt = super::hex_encode(&super::new_salt_bytes());
        let cipher = aes_gcm::Aes256Gcm::new_from_slice(&super::derive_legacy_key(material, &salt))
            .map_err(|e| format!("密钥初始化失败：{e}"))?;
        let nonce = aes_gcm::Aes256Gcm::generate_nonce(&mut aes_gcm::aead::OsRng);
        let ct = cipher
            .encrypt(&nonce, plaintext.as_bytes())
            .map_err(|e| format!("加密失败：{e}"))?;
        Ok(format!(
            "{}{}:{}",
            super::LEGACY_ENVELOPE_PREFIX,
            salt,
            super::hex_encode(&[nonce.as_slice(), ct.as_slice()].concat())
        ))
    }

    /// 以真实本机材料构造旧版密文（prefs 侧迁移测试用）。
    pub fn legacy_seal(plaintext: &str) -> Result<String, String> {
        legacy_seal_with(&super::machine_material()?, plaintext)
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::legacy_seal_with;
    use super::*;

    const MATERIAL: &str = "test-machine-uuid-0000";
    const PROVIDER: &str = "openai";

    #[test]
    fn roundtrip_preserves_plaintext() {
        // 公开 API 走真实 machine_material：成功路径 + 加解密集成
        let secret = "sk-kimi-测试-🔑-1234567890";
        let envelope = seal_for(PROVIDER, secret).unwrap();
        assert!(envelope.starts_with(ENVELOPE_PREFIX));
        assert!(!envelope.contains("sk-kimi"));
        assert_eq!(open_for(PROVIDER, &envelope).unwrap(), secret);
    }

    #[test]
    fn pw2_envelope_embeds_rounds_and_provider_binding() {
        // envelope 是随 settings.json 落盘的线格式契约：v2 字段自描述
        //（迭代数 + provider 绑定），解密不得依赖隐式常量
        let envelope = seal_for_with(MATERIAL, PROVIDER, "secret").unwrap();
        let fields: Vec<&str> = envelope
            .strip_prefix(ENVELOPE_PREFIX)
            .unwrap()
            .split(':')
            .collect();
        assert_eq!(fields.len(), 4);
        assert_eq!(fields[0], KDF_ROUNDS.to_string());
        assert_eq!(fields[1], PROVIDER);
    }

    #[test]
    fn each_seal_uses_fresh_salt_and_nonce() {
        let a = seal_for_with(MATERIAL, PROVIDER, "same-secret").unwrap();
        let b = seal_for_with(MATERIAL, PROVIDER, "same-secret").unwrap();
        assert_ne!(a, b);
        assert_eq!(
            open_for_with(MATERIAL, PROVIDER, &a).unwrap(),
            "same-secret"
        );
        assert_eq!(
            open_for_with(MATERIAL, PROVIDER, &b).unwrap(),
            "same-secret"
        );
    }

    #[test]
    fn cross_provider_open_is_rejected() {
        // issue #392 AAD 绑定：A provider 的密文原样搬到 B 条目下解密失败
        let envelope = seal_for_with(MATERIAL, "prov-a", "secret").unwrap();
        assert!(open_for_with(MATERIAL, "prov-b", &envelope).is_err());
    }

    #[test]
    fn rewritten_embedded_provider_still_fails_via_aad() {
        // 把 envelope 内嵌 provider 字段改写成目标条目：前置比对放行后
        // AAD 校验仍拒绝——绑定不依赖明文字段自身
        let envelope = seal_for_with(MATERIAL, "prov-a", "secret").unwrap();
        let tampered = envelope.replace(":prov-a:", ":prov-b:");
        assert_ne!(envelope, tampered);
        assert!(open_for_with(MATERIAL, "prov-b", &tampered).is_err());
    }

    #[test]
    fn tampered_payload_is_rejected() {
        let envelope = seal_for_with(MATERIAL, PROVIDER, "secret").unwrap();
        let mut chars: Vec<char> = envelope.chars().collect();
        let last = chars.len() - 1;
        chars[last] = if chars[last] == '0' { '1' } else { '0' };
        let tampered: String = chars.into_iter().collect();
        assert!(open_for_with(MATERIAL, PROVIDER, &tampered).is_err());
    }

    #[test]
    fn tampered_legacy_envelope_is_rejected() {
        let envelope = legacy_seal_with(MATERIAL, "secret").unwrap();
        let mut chars: Vec<char> = envelope.chars().collect();
        let last = chars.len() - 1;
        chars[last] = if chars[last] == '0' { '1' } else { '0' };
        let tampered: String = chars.into_iter().collect();
        assert!(open_for_with(MATERIAL, PROVIDER, &tampered).is_err());
    }

    #[test]
    fn malformed_envelopes_are_rejected() {
        // 旧版 pw1 兼容路径：格式、盐长、hex、负载
        assert!(open_for_with(MATERIAL, PROVIDER, "").is_err());
        assert!(open_for_with(MATERIAL, PROVIDER, "xx:00:00").is_err());
        assert!(open_for_with(MATERIAL, PROVIDER, "pw1:short:00").is_err());
        assert!(open_for_with(
            MATERIAL,
            PROVIDER,
            "pw1:0123456789abcdef0123456789abcdef:zz"
        )
        .is_err());
        assert!(open_for_with(
            MATERIAL,
            PROVIDER,
            "pw1:0123456789abcdef0123456789abcdef:00"
        )
        .is_err());
        // v2 路径：迭代数（非数值/0/超上界）、字段数、provider 失配、
        // 盐长、hex、负载
        assert!(open_for_with(
            MATERIAL,
            PROVIDER,
            "pw2:bad:openai:0123456789abcdef0123456789abcdef:00ff"
        )
        .is_err());
        assert!(open_for_with(
            MATERIAL,
            PROVIDER,
            "pw2:0:openai:0123456789abcdef0123456789abcdef:00ff"
        )
        .is_err());
        let over = format!(
            "pw2:{}:openai:0123456789abcdef0123456789abcdef:00ff",
            MAX_OPEN_ROUNDS as u64 + 1
        );
        assert!(open_for_with(MATERIAL, PROVIDER, &over).is_err());
        assert!(open_for_with(MATERIAL, PROVIDER, "pw2:100000:openai:short:00ff").is_err());
        assert!(open_for_with(
            MATERIAL,
            PROVIDER,
            "pw2:100000:openai:0123456789abcdef0123456789abcdef:zz"
        )
        .is_err());
        assert!(open_for_with(
            MATERIAL,
            PROVIDER,
            "pw2:100000:openai:0123456789abcdef0123456789abcdef:00"
        )
        .is_err());
        assert!(open_for_with(
            MATERIAL,
            PROVIDER,
            "pw2:100000:openai:0123456789abcdef0123456789abcdef:00ff:extra"
        )
        .is_err());
        assert!(open_for_with(
            MATERIAL,
            PROVIDER,
            "pw2:100000:other:0123456789abcdef0123456789abcdef:00ff"
        )
        .is_err());
    }

    #[test]
    fn embedded_rounds_participate_in_derivation() {
        // 迭代数是派生输入：与封装值差 1 即解密失败（错配/降级均不可解）
        let envelope = seal_for_with(MATERIAL, PROVIDER, "secret").unwrap();
        let mut fields: Vec<String> = envelope.split(':').map(str::to_string).collect();
        fields[1] = (KDF_ROUNDS + 1).to_string();
        let tampered = fields.join(":");
        assert!(open_for_with(MATERIAL, PROVIDER, &tampered).is_err());
    }

    #[test]
    fn invalid_provider_binding_is_rejected_at_seal() {
        for bad in ["", "a:b", "a/b", &"x".repeat(PROVIDER_ID_MAX_LEN + 1)] {
            assert!(
                seal_for_with(MATERIAL, bad, "secret").is_err(),
                "非法 provider id 应拒绝：{bad:?}"
            );
        }
    }

    #[test]
    fn envelope_sealed_with_different_material_is_rejected() {
        // 历史弱材料密文兼容策略（issue #260）：材料不匹配即拒绝，
        // 不提供弱材料恢复通道，用户重新录入 key
        let weak = seal_for_with("guessable-username", PROVIDER, "secret").unwrap();
        assert!(open_for_with(MATERIAL, PROVIDER, &weak).is_err());
    }

    #[test]
    fn legacy_pw1_envelope_opens_without_provider_binding() {
        // 兼容路径：存量 pw1 密文无 AAD，任意 provider 名下都可解
        //（与历史行为一致）；迁移由 prefs 读取侧在成功解开后进行
        let legacy = legacy_seal_with(MATERIAL, "secret").unwrap();
        assert!(is_legacy_envelope(&legacy));
        assert!(!is_legacy_envelope("pw2:1:openai:00:00"));
        assert_eq!(
            open_for_with(MATERIAL, "any-provider", &legacy).unwrap(),
            "secret"
        );
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
