//! API key 加密封装（§8.2 修订：key 不入钥匙串，加密后随 settings.json 落盘）。
//!
//! 方案：AES-256-GCM；密钥 = SHA-256(pepper ‖ 本机标识 ‖ 随机盐)，
//! 盐与 nonce 封装在密文 envelope 内（`pw1:<salt>:<nonce+ciphertext>` hex）。
//! 威胁模型：防 settings.json 明文泄露/云同步/拷贝到其它机器解密；
//! 不敌能以同一用户身份读取本机标识的恶意程序——这是无钥匙串前提下的
//! 务实折中，属加密静态存储而非交互式秘密保管。

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

/// 本机标识：macOS 取 IOPlatformUUID（结果缓存）；失败回退用户名。
pub fn machine_material() -> String {
    static CACHE: OnceLock<String> = OnceLock::new();
    CACHE
        .get_or_init(|| {
            #[cfg(target_os = "macos")]
            {
                if let Ok(out) = std::process::Command::new("ioreg")
                    .args(["-rd1", "-c", "IOPlatformExpertDevice"])
                    .output()
                {
                    let text = String::from_utf8_lossy(&out.stdout);
                    if let Some(idx) = text.find("IOPlatformUUID") {
                        let tail = &text[idx..];
                        if let (Some(a), Some(b)) = (tail.find('"'), tail.rfind('"')) {
                            if b > a + 1 {
                                return tail[a + 1..b].to_string();
                            }
                        }
                    }
                }
            }
            std::env::var("USER").unwrap_or_else(|_| "plotweave-local".into())
        })
        .clone()
}

fn derive_key(salt: &str) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(PEPPER);
    hasher.update(machine_material().as_bytes());
    hasher.update(salt.as_bytes());
    hasher.finalize().into()
}

/// 加密：返回 `pw1:<salt_hex>:<nonce+ct_hex>`。
pub fn seal(plaintext: &str) -> Result<String, String> {
    let salt = new_salt();
    let cipher = Aes256Gcm::new_from_slice(&derive_key(&salt))
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

/// 解密 envelope；任何篡改/环境不匹配都返回 Err，绝不输出明文碎片。
pub fn open(envelope: &str) -> Result<String, String> {
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
    let cipher =
        Aes256Gcm::new_from_slice(&derive_key(salt)).map_err(|e| format!("密钥初始化失败：{e}"))?;
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

    #[test]
    fn roundtrip_preserves_plaintext() {
        let secret = "sk-kimi-测试-🔑-1234567890";
        let envelope = seal(secret).unwrap();
        assert!(envelope.starts_with(ENVELOPE_PREFIX));
        assert!(!envelope.contains("sk-kimi"));
        assert_eq!(open(&envelope).unwrap(), secret);
    }

    #[test]
    fn each_seal_uses_fresh_salt_and_nonce() {
        let a = seal("same-secret").unwrap();
        let b = seal("same-secret").unwrap();
        assert_ne!(a, b);
        assert_eq!(open(&a).unwrap(), "same-secret");
        assert_eq!(open(&b).unwrap(), "same-secret");
    }

    #[test]
    fn tampered_payload_is_rejected() {
        let envelope = seal("secret").unwrap();
        let mut chars: Vec<char> = envelope.chars().collect();
        let last = chars.len() - 1;
        chars[last] = if chars[last] == '0' { '1' } else { '0' };
        let tampered: String = chars.into_iter().collect();
        assert!(open(&tampered).is_err());
    }

    #[test]
    fn malformed_envelopes_are_rejected() {
        assert!(open("").is_err());
        assert!(open("xx:00:00").is_err());
        assert!(open("pw1:short:00").is_err());
        assert!(open("pw1:0123456789abcdef0123456789abcdef:zz").is_err());
        assert!(open("pw1:0123456789abcdef0123456789abcdef:00").is_err());
    }

    #[test]
    fn hex_helpers_roundtrip() {
        let bytes = vec![0x00, 0x0f, 0xff, 0xa5];
        assert_eq!(hex_decode(&hex_encode(&bytes)).unwrap(), bytes);
        assert!(hex_decode("0g").is_none());
        assert!(hex_decode("abc").is_none());
    }
}
