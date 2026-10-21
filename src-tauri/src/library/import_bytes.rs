//! 库导入的IPC边界：借用Tauri已解析的JSON先验长，再委托原Vec参数解码。
//! 不复制Value，不改变bytes数组形状；框架已解析的请求体不在本层预算内。

use serde_json::Value;
use tauri::ipc::{CommandArg, CommandItem, InvokeBody, InvokeError};

use super::{error::LibraryError, ASSET_MAX_BYTES};

/// 超限保留领域错误直到命令出口，使既有中文Limit文案不增加InvalidArgs前缀。
/// 缺参、Raw请求、异型及非字节值仍由原Vec CommandArg以原错误路径拒绝。
pub struct ImportBytes(Result<Vec<u8>, LibraryError>);

impl ImportBytes {
    /// 在库根解析、恢复或媒体物化之前取出已受限的字节。
    pub(super) fn into_bytes(self) -> Result<Vec<u8>, LibraryError> {
        self.0
    }
}

impl<'de, R: tauri::Runtime> CommandArg<'de, R> for ImportBytes {
    fn from_command(command: CommandItem<'de, R>) -> Result<Self, InvokeError> {
        let length = match command.message.payload() {
            InvokeBody::Json(root) => root
                .get(command.key)
                .and_then(Value::as_array)
                .map(Vec::len),
            InvokeBody::Raw(_) => None,
        };
        decode_after_size_check(length, ASSET_MAX_BYTES, || {
            <Vec<u8> as CommandArg<'de, R>>::from_command(command)
        })
        .map(Self)
    }
}

/// 惰性调用旧解码器：只在长度允许时分配Vec，并完整保留其传输错误。
/// 可注入小预算验证界值，避免测试构造20MiB的JSON Value数组。
fn decode_after_size_check<E>(
    length: Option<usize>,
    maximum: usize,
    decode: impl FnOnce() -> Result<Vec<u8>, E>,
) -> Result<Result<Vec<u8>, LibraryError>, E> {
    if length.is_some_and(|length| length > maximum) {
        return Ok(Err(LibraryError::Limit {
            detail: "文件超过 20 MiB 上限".into(),
        }));
    }
    decode().map(Ok)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;
    use serde_json::json;

    #[test]
    fn oversized_length_rejects_before_decoder_with_original_limit() {
        let result = decode_after_size_check(
            Some(ASSET_MAX_BYTES + 1),
            ASSET_MAX_BYTES,
            || -> Result<Vec<u8>, InvokeError> {
                panic!("超限不得调用会分配Vec的参数解码器")
            },
        )
        .expect("传输层接受领域拒绝");
        let error = result.expect_err("超限必须拒绝");
        assert!(matches!(error, LibraryError::Limit { .. }));
        assert_eq!(error.to_string(), "文件超过 20 MiB 上限");
    }

    #[test]
    fn at_and_below_limit_keep_original_decoder_bytes() {
        for bytes in [vec![], vec![1], vec![0, 1, 255]] {
            let value = json!(bytes);
            let result =
                decode_after_size_check(Some(bytes.len()), 3, || Vec::<u8>::deserialize(&value))
                    .expect("可解码字节")
                    .expect("界内不是Limit");
            assert_eq!(result, bytes);
        }
        // 固定生产预算本身在等号处也放行；不构造相应大小的JSON数组。
        assert!(
            decode_after_size_check(Some(ASSET_MAX_BYTES), ASSET_MAX_BYTES, || Ok::<_, ()>(
                vec![1]
            ))
            .expect("传输成功")
            .is_ok()
        );
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
            let length = value.as_array().map(Vec::len);
            let original = Vec::<u8>::deserialize(&value)
                .expect_err("非法字节")
                .to_string();
            let error = decode_after_size_check(length, 3, || Vec::<u8>::deserialize(&value))
                .expect_err("仍走旧解码错误");
            assert_eq!(error.to_string(), original);
        }
        assert_eq!(
            decode_after_size_check(None, 3, || Err("missing/raw original error"))
                .expect_err("缺参/Raw继续走旧错误"),
            "missing/raw original error"
        );
    }
}
