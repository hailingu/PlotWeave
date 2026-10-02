/**
 * 剧集标题的规范空白裁剪（issue #122）：与 Rust 保存边界
 * （src-tauri/src/store/validate.rs 的 validate_save_episode_titles，
 * `char::is_whitespace`）对齐——JS `trim` 不剥 U+0085（NEL）而 Rust 剥，
 * 前端曾因此产生被保存边界整次拒绝的「规范」标题。本裁剪集合为 Rust
 * White_Space 的超集（JS trim 集合 ∪ U+0085）：前端多剥只会更规范，
 * 永不触发后端 `title.trim() != title` 拒绝。两端边界夹具同步维护于
 * titleWhitespace.test.ts 与 src-tauri/src/store/validate/tests.rs
 * （episode_titles_* 用例）。
 */

/** 首尾空白判定：单字符属于 ECMAScript `\s` 集合，或为两端 trim 集合
 * 的差异字符 U+0085（NEL，Rust White_Space 成员）。字符串索引在类型层
 * 可为 undefined（越界）；调用点的双指针边界先于取字符成立，此处把
 * undefined 显式判非空白（issue #230），语义与越界不可能发生一致。 */
const isEdgeWhitespace = (ch: string | undefined): boolean =>
  ch !== undefined && (/\s/u.test(ch) || ch === '\u0085')

/** 裁剪标题首尾空白（含 U+0085），内部空白保留；线性双指针，不回溯。 */
export const trimTitleWhitespace = (raw: string): string => {
  let start = 0
  let end = raw.length
  while (start < end && isEdgeWhitespace(raw[start])) start += 1
  while (end > start && isEdgeWhitespace(raw[end - 1])) end -= 1
  return raw.slice(start, end)
}
