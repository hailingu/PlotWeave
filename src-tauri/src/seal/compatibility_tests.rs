//! Frozen Node-generated wire vectors shared with NativePreferencesTests.swift.
//! These predate the RustCrypto migration and use only synthetic machine/key data.

use super::*;

const MATERIAL: &str = " = \"TEST-MACHINE-UUID";
const SECRET: &str = "fixture-secret-测试";
const SALT_HEX: &str = "000102030405060708090a0b0c0d0e0f";
const V1: &str = "pw1:000102030405060708090a0b0c0d0e0f:000102030405060708090a0b6e750af1a5a9e22226dd673d30c9bf203a977b2d5380e5c9009f600beb68e50cfa7111f6cf";
const V2: &str = "pw2:600000:openai:000102030405060708090a0b0c0d0e0f:000102030405060708090a0befb8af7bc6d06a3d8809494dc6119c72de028c2c9caa8b87b0f808d6bc32848b6b679bfa13";
// Additional independent Node crypto vectors pin both inclusive round limits and
// authenticated invalid UTF8 without using production encryption as the oracle.
const MIN_ROUNDS: &str = "pw2:1:openai:000102030405060708090a0b0c0d0e0f:000102030405060708090a0bc6eebd4e6be75422b4e2d0ca797499b93d5f4f40569f31ef256c2b79e79085e47c8af71288";
const MAX_ROUNDS: &str = "pw2:5000000:openai:000102030405060708090a0b0c0d0e0f:000102030405060708090a0b097b2c8ec97f7a2a66f089e277a7e0cf26743d961f4017373489374794e780821e4ac7b341";
const INVALID_UTF8: &str = "pw2:1:openai:000102030405060708090a0b0c0d0e0f:000102030405060708090a0b5f79dea36f80c43d68077c7ab890bcec57cc";

#[test]
fn frozen_old_envelopes_decrypt() {
    assert_eq!(open_for_with(MATERIAL, "any-provider", V1).unwrap(), SECRET);
    assert_eq!(open_for_with(MATERIAL, "openai", V2).unwrap(), SECRET);
}

/// Fixed wire bytes independently pin both KDFs, AAD and nonce/ciphertext/tag order.
#[test]
fn frozen_inputs_produce_identical_bytes() {
    let salt = hex_decode(SALT_HEX, HexCase::Either).unwrap();
    let nonce_bytes: [u8; NONCE_LEN] = std::array::from_fn(|index| index as u8);
    for (key, aad, expected) in [
        (derive_legacy_key(MATERIAL, SALT_HEX), b"".as_slice(), V1),
        (
            derive_hardened_key(MATERIAL, &salt, 600_000),
            b"openai".as_slice(),
            V2,
        ),
    ] {
        let cipher = Aes256Gcm::new_from_slice(&key).unwrap();
        let ciphertext = cipher
            .encrypt(
                &nonce_bytes.into(),
                Payload {
                    msg: SECRET.as_bytes(),
                    aad,
                },
            )
            .unwrap();
        let payload = hex_encode(&[nonce_bytes.as_slice(), &ciphertext].concat());
        assert_eq!(expected.rsplit(':').next().unwrap(), payload);
    }
}

/// Either entropy failure must return no envelope; a later healthy call can recover.
#[test]
fn entropy_failures_return_clean_errors_and_can_retry() {
    let salt = std::array::from_fn(|index| index as u8);
    let nonce = std::array::from_fn(|index| index as u8);
    let failed_salt = seal_for_with_entropy(
        MATERIAL,
        "openai",
        SECRET,
        || Err("synthetic entropy unavailable".to_string()),
        || panic!("nonce generation must not run after salt failure"),
    );
    assert!(failed_salt.is_err());
    assert!(seal_for_with_entropy(
        MATERIAL,
        "openai",
        SECRET,
        || Ok(salt),
        || Err("synthetic entropy unavailable".to_string())
    )
    .is_err());
    assert_eq!(
        seal_for_with_entropy(MATERIAL, "openai", SECRET, || Ok(salt), || Ok(nonce)).unwrap(),
        V2
    );
}

#[test]
fn frozen_envelopes_reject_wrong_machine_and_tampering() {
    for envelope in [V1, V2] {
        assert!(open_for_with("different fixture machine", "openai", envelope).is_err());
        let mut fields: Vec<_> = envelope.split(':').map(str::to_string).collect();
        let salt_index = fields.len() - 2;
        fields[salt_index].replace_range(..2, "ff");
        assert!(open_for_with(MATERIAL, "openai", &fields.join(":")).is_err());
        let payload = envelope.rsplit(':').next().unwrap();
        // Mutate nonce, first ciphertext byte and final tag byte independently.
        for offset in [0, NONCE_LEN * 2, payload.len() - 2] {
            let mut mutated = hex_decode(payload, HexCase::Either).unwrap();
            mutated[offset / 2] ^= 1;
            let prefix = &envelope[..envelope.len() - payload.len()];
            let tampered = format!("{prefix}{}", hex_encode(&mutated));
            assert!(open_for_with(MATERIAL, "openai", &tampered).is_err());
        }
    }
    assert!(open_for_with(MATERIAL, "other", V2).is_err());
    assert!(open_for_with(MATERIAL, "other", &V2.replace(":openai:", ":other:")).is_err());
}

#[test]
fn round_limits_are_inclusive_and_authenticated_utf8_is_required() {
    for envelope in [MIN_ROUNDS, MAX_ROUNDS] {
        assert_eq!(open_for_with(MATERIAL, "openai", envelope).unwrap(), SECRET);
    }
    assert!(open_for_with(MATERIAL, "openai", INVALID_UTF8).is_err());
    for rounds in ["0", "5000001", "4294967296", "-1", "not-a-number"] {
        let invalid = MIN_ROUNDS.replacen("pw2:1:", &format!("pw2:{rounds}:"), 1);
        assert!(open_for_with(MATERIAL, "openai", &invalid).is_err());
    }
}

#[test]
fn truncated_or_non_hex_old_envelopes_never_yield_plaintext() {
    for envelope in [V1, V2] {
        let payload = envelope.rsplit(':').next().unwrap();
        let prefix = &envelope[..envelope.len() - payload.len()];
        for length in [
            0,
            1,
            NONCE_LEN * 2,
            (NONCE_LEN + 16) * 2 - 2,
            payload.len() - 2,
        ] {
            assert!(open_for_with(
                MATERIAL,
                "openai",
                &format!("{prefix}{}", &payload[..length])
            )
            .is_err());
        }
        assert!(open_for_with(MATERIAL, "openai", &format!("{prefix}zz")).is_err());
    }
    // pw2 decodes salt bytes case-insensitively; pw1 hashes the original salt text.
    let uppercase_v2 = V2
        .to_uppercase()
        .replacen("PW2:", "pw2:", 1)
        .replace("OPENAI", "openai");
    assert_eq!(
        open_for_with(MATERIAL, "openai", &uppercase_v2).unwrap(),
        SECRET
    );
    assert!(open_for_with(
        MATERIAL,
        "openai",
        &V1.replacen(SALT_HEX, &SALT_HEX.to_uppercase(), 1)
    )
    .is_err());
    assert!(open_for_with(
        MATERIAL,
        "openai",
        &V2.replacen(SALT_HEX, "zz0102030405060708090a0b0c0d0e0f", 1)
    )
    .is_err());
}
