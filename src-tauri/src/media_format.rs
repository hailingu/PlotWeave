//! 媒体文件扩展名策略（issue #146）：无 IO、无应用模块依赖的叶子能力。
//! 库导入与项目拷贝共享文件名优先策略；生成产物只有 MIME，保留其较窄映射。
//! 两种入口的未知类型均回退 bin，不在此校验 MIME 或改变导入/生成支持范围。

/// mime → 扩展名（未知类型回退 bin，文件名扩展优先）。
pub(crate) fn ext_for(name: &str, mime: &str) -> String {
    if let Some(dot) = name.rfind('.') {
        let ext = &name[dot + 1..];
        let ok =
            !ext.is_empty() && ext.len() <= 8 && ext.chars().all(|c| c.is_ascii_alphanumeric());
        if ok {
            return ext.to_ascii_lowercase();
        }
    }
    match mime {
        "image/png" => "png",
        "image/jpeg" => "jpg",
        "image/webp" => "webp",
        "image/gif" => "gif",
        "image/avif" => "avif",
        _ => "bin",
    }
    .to_string()
}

/// 生成媒体 MIME → 文件名扩展（生成产物没有源文件名，只按 MIME 映射；
/// 调用方已按字节魔数定型 MIME，未知值兜底 bin）。
pub(crate) fn ext_for_mime(mime: &str) -> &'static str {
    match mime {
        "image/png" => "png",
        "image/jpeg" => "jpg",
        "image/webp" => "webp",
        "image/gif" => "gif",
        _ => "bin",
    }
}
