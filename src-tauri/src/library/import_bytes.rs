//! 库导入的IPC边界：借用Tauri已解析的JSON先验长，再委托原Vec参数解码。
//! 越界数组仅验证标量，不分配Vec；框架已解析的请求体不在本层预算内。

use serde::Deserialize;
use serde_json::Value;
use tauri::ipc::{CommandArg, CommandItem, InvokeBody, InvokeError};

use super::{error::LibraryError, ASSET_MAX_BYTES};

/// 超限保留领域错误直到命令出口，使既有中文Limit文案不增加InvalidArgs前缀。
/// 包括越界数组在内，非法字节仍保留原Vec参数解码的错误优先级与文案。
pub struct ImportBytes(Result<Vec<u8>, LibraryError>);

impl ImportBytes {
    /// 在库根解析、恢复或媒体物化之前取出已受限的字节。
    pub(super) fn into_bytes(self) -> Result<Vec<u8>, LibraryError> {
        self.0
    }
}

impl<'de, R: tauri::Runtime> CommandArg<'de, R> for ImportBytes {
    /// 仅借用载荷预检，参数错误沿用Tauri原包装；界内仍由原Vec解码。
    fn from_command(command: CommandItem<'de, R>) -> Result<Self, InvokeError> {
        let values = match command.message.payload() {
            InvokeBody::Json(root) => root
                .get(command.key)
                .and_then(Value::as_array)
                .map(Vec::as_slice),
            InvokeBody::Raw(_) => None,
        };
        let name = command.name;
        let key = command.key;
        decode_after_size_check(
            values,
            ASSET_MAX_BYTES,
            |error| tauri::Error::InvalidArgs(name, key, error).into(),
            || <Vec<u8> as CommandArg<'de, R>>::from_command(command),
        )
        .map(Self)
    }
}

/// 界内只调用旧解码器；越界逐项使用同一u8反序列化规则，保留其首个错误。
/// 仅全为合法字节的越界数组返回Limit，不克隆Value也不构造临时字节向量。
fn decode_after_size_check<E>(
    values: Option<&[Value]>,
    maximum: usize,
    invalid: impl FnOnce(serde_json::Error) -> E,
    decode: impl FnOnce() -> Result<Vec<u8>, E>,
) -> Result<Result<Vec<u8>, LibraryError>, E> {
    if let Some(values) = values.filter(|values| values.len() > maximum) {
        for value in values {
            if let Err(error) = u8::deserialize(value) {
                return Err(invalid(error));
            }
        }
        return Ok(Err(LibraryError::Limit {
            detail: "文件超过 20 MiB 上限".into(),
        }));
    }
    decode().map(Ok)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::convert::identity;

    fn array(value: &Value) -> Option<&[Value]> {
        value.as_array().map(Vec::as_slice)
    }

    #[test]
    fn oversized_valid_array_rejects_without_byte_vector_decoder() {
        let value = json!([0, 1, 255, 3]);
        let result = decode_after_size_check(
            array(&value),
            3,
            identity,
            || -> Result<Vec<u8>, serde_json::Error> {
                panic!("越界不得调用会分配Vec的参数解码器")
            },
        )
        .expect("合法字节不产生参数错误");
        let error = result.expect_err("超限必须拒绝");
        assert!(matches!(error, LibraryError::Limit { .. }));
        assert_eq!(error.to_string(), "文件超过 20 MiB 上限");
    }

    #[test]
    fn at_and_below_limit_keep_original_decoder_bytes() {
        for bytes in [vec![], vec![1], vec![0, 1, 255]] {
            let value = json!(bytes);
            let result = decode_after_size_check(array(&value), 3, identity, || {
                Vec::<u8>::deserialize(&value)
            })
            .expect("可解码字节")
            .expect("界内不是Limit");
            assert_eq!(result, bytes);
        }
    }

    #[test]
    fn oversized_malformed_array_preserves_original_decoder_error() {
        for value in [
            json!([0, 1, 2, null]),
            json!([256, 1, 2, 3]),
            json!([0, 1, 2, 0.5]),
            json!([0, 1, 2, "x"]),
        ] {
            let original = Vec::<u8>::deserialize(&value)
                .expect_err("非法字节")
                .to_string();
            let error = decode_after_size_check(
                array(&value),
                3,
                identity,
                || -> Result<Vec<u8>, serde_json::Error> {
                    panic!("越界非法数组也不得调用Vec解码器")
                },
            )
            .expect_err("越界数组的非法字节仍优先返回参数解码错误");
            assert_eq!(error.to_string(), original);
        }
    }

    #[test]
    fn invalid_shapes_values_and_missing_lengths_preserve_decoder_error() {
        for value in [
            json!(-1),
            json!({}),
            Value::Null,
            json!([-1]),
            json!([256]),
            json!([0.5]),
            json!([null]),
            json!(["1"]),
        ] {
            let original = Vec::<u8>::deserialize(&value)
                .expect_err("非法字节")
                .to_string();
            let error = decode_after_size_check(array(&value), 3, identity, || {
                Vec::<u8>::deserialize(&value)
            })
            .expect_err("仍走旧解码错误");
            assert_eq!(error.to_string(), original);
        }
        assert_eq!(
            decode_after_size_check(
                None,
                3,
                |_| panic!("缺参不做字节预检"),
                || Err("missing/raw original error")
            )
            .expect_err("缺参/Raw继续走旧错误"),
            "missing/raw original error"
        );
    }
}
