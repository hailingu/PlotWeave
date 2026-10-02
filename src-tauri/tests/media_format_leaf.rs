//! #146：直接编译生产扩展名模块，当前测试 crate 不声明 library/assets 等应用模块。
//! 编译器因此校验其内部依赖边界；行为断言来自迁移前通过的导入/生成表征用例。

/// 生产叶子在独立 crate 根中编译，不能反向引用应用命令或存储模块。
#[path = "../src/media_format.rs"]
mod media_format;

use media_format::{ext_for, ext_for_mime};

#[test]
fn ext_mapping_prefers_name_and_falls_back_to_mime() {
    for (name, mime, expected) in [
        ("立绘.PNG", "image/png", "png"),
        ("photo.JPG", "image/png", "jpg"),
        ("noext", "image/webp", "webp"),
        ("noext", "image/jpeg", "jpg"),
        ("noext", "image/gif", "gif"),
        ("noext", "image/avif", "avif"),
        ("noext", "application/x-unknown", "bin"),
        ("bad.<script>", "image/png", "png"),
        ("trailing.", "image/png", "png"),
        ("file.12345678", "image/png", "12345678"),
        ("file.123456789", "image/png", "png"),
        ("file.图片", "image/png", "png"),
    ] {
        assert_eq!(ext_for(name, mime), expected, "{name}: {mime}");
    }
}

#[test]
fn generated_extensions_preserve_the_existing_mime_domain() {
    for (mime, expected) in [
        ("image/png", "png"),
        ("image/jpeg", "jpg"),
        ("image/webp", "webp"),
        ("image/gif", "gif"),
        ("image/avif", "bin"),
        ("application/octet-stream", "bin"),
    ] {
        assert_eq!(ext_for_mime(mime), expected);
    }
}
