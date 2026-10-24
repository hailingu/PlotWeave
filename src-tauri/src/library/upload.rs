//! Bounded Web upload assembly. IDs are opaque memory keys, never filesystem paths.
use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    sync::Mutex,
    time::{Duration, Instant},
};
use tauri::{AppHandle, State};

const CHUNK_BYTES: usize = 64 * 1024;
const MAX_ENCODED: usize = CHUNK_BYTES.div_ceil(3) * 4;
const LIFETIME: Duration = Duration::from_secs(120);

/// Application-owned advisory memory; incomplete uploads never modify storage.
/// Mutex recovery is valid: acceptance removes an entry before validation and
/// reconstructs it only after all fallible checks; persistence has its own journal.
#[derive(Default)]
pub(crate) struct LibraryUploads(Mutex<Registry>);

/// Metadata is fixed by the first chunk and compared on every continuation.
#[derive(Clone, PartialEq)]
struct Metadata {
    name: String,
    mime: String,
    kind: String,
    total: usize,
}

impl Metadata {
    /// Fixed-size identity avoids new field-length contracts or unbounded retained metadata.
    fn fingerprint(&self) -> [u8; 32] {
        let mut hash = Sha256::new();
        for value in [&self.name, &self.mime, &self.kind] {
            hash.update(value.len().to_le_bytes());
            hash.update(value.as_bytes());
        }
        hash.update(self.total.to_le_bytes());
        hash.finalize().into()
    }
}

/// A committing slot stays charged until the existing import operation settles.
struct Upload {
    fingerprint: [u8; 32],
    bytes: Vec<u8>,
    started: Instant,
    committing: bool,
}

/// At most two uploads, including commits; expiry is swept on the next request.
#[derive(Default)]
struct Registry {
    uploads: HashMap<String, Upload>,
}

/// Acknowledgements cannot be mistaken for a persisted asset.
enum Step {
    Pending(Value),
    Complete(Metadata, Vec<u8>),
}

/// Reject encoded and decoded size violations before extending any staged buffer.
fn decode_chunk(data: &str, total: usize) -> Result<Vec<u8>, String> {
    if total == 0 || total > super::ASSET_MAX_BYTES || data.len() > MAX_ENCODED {
        return Err("素材上传超过大小上限".into());
    }
    let bytes = STANDARD.decode(data).map_err(|_| "素材上传编码非法")?;
    if bytes.is_empty() || bytes.len() > CHUNK_BYTES {
        return Err("素材上传分块大小非法".into());
    }
    Ok(bytes)
}

impl Registry {
    /// Strict sequential assembly; invalid continuation releases only its own slot.
    fn accept(
        &mut self,
        id: &str,
        metadata: Metadata,
        offset: usize,
        data: &str,
        now: Instant,
    ) -> Result<Step, String> {
        self.uploads
            .retain(|_, upload| upload.committing || now.duration_since(upload.started) < LIFETIME);
        if id.is_empty()
            || id.len() > 128
            || !id
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
        {
            return Err("非法上传身份".into());
        }
        if self.uploads.get(id).is_some_and(|upload| upload.committing) {
            return Err("素材上传正在提交，结果须核对".into());
        }
        let previous = self.uploads.remove(id);
        if metadata.total == 0 && offset == 0 && data.is_empty() {
            return Ok(Step::Pending(json!({"aborted": true})));
        }
        let bytes = decode_chunk(data, metadata.total)?;
        let mut upload = match previous {
            Some(upload) => upload,
            None if offset == 0 && self.uploads.len() < 2 => Upload {
                fingerprint: metadata.fingerprint(),
                bytes: Vec::with_capacity(metadata.total),
                started: now,
                committing: false,
            },
            _ => return Err("素材上传不存在、已过期或上传槽位已满".into()),
        };
        if upload.fingerprint != metadata.fingerprint()
            || offset != upload.bytes.len()
            || bytes.len() > metadata.total.saturating_sub(offset)
        {
            return Err("素材上传顺序或总量不一致".into());
        }
        upload.bytes.extend(bytes);
        let step = if upload.bytes.len() == metadata.total {
            upload.committing = true;
            Step::Complete(metadata, std::mem::take(&mut upload.bytes))
        } else {
            Step::Pending(json!({"received": upload.bytes.len()}))
        };
        self.uploads.insert(id.to_string(), upload);
        Ok(step)
    }
}

/// Closed wire envelope keeps the command signature small and independently decodable.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadRequest {
    upload_id: String,
    name: String,
    mime: String,
    kind: String,
    total: usize,
    offset: usize,
    data: String,
}

/// Sequential base64 chunks bound serialization on both WebView hosts. An empty
/// zero-total request aborts staging only; it cannot cancel an unknown commit.
#[tauri::command]
pub async fn import_library_asset_chunk(
    app: AppHandle,
    uploads: State<'_, LibraryUploads>,
    request: UploadRequest,
) -> Result<Value, String> {
    let UploadRequest {
        upload_id,
        name,
        mime,
        kind,
        total,
        offset,
        data,
    } = request;
    let step = crate::lock::recover_guard(uploads.0.lock(), "library uploads").accept(
        &upload_id,
        Metadata {
            name,
            mime,
            kind,
            total,
        },
        offset,
        &data,
        Instant::now(),
    )?;
    match step {
        Step::Pending(reply) => Ok(reply),
        Step::Complete(metadata, bytes) => {
            let result = super::import_uploaded_asset(
                app,
                metadata.name,
                metadata.mime,
                metadata.kind,
                bytes,
            )
            .await;
            crate::lock::recover_guard(uploads.0.lock(), "library uploads")
                .uploads
                .remove(&upload_id);
            result
        }
    }
}

#[cfg(test)]
mod tests;
