import { describe, expect, it } from 'vitest'
import { trimTitleWhitespace } from './titleWhitespace'

/**
 * 剧集标题空白裁剪的共享边界夹具（issue #122）：本组字面量与 Rust 保存
 * 边界契约用例（src-tauri/src/store/validate/tests.rs 的
 * episode_titles_*）保持一致——两端规则漂移时两侧测试同步失败。
 * U+0085（NEL）是两端 trim 集合的关键差异字符：Rust
 * char::is_whitespace 剥而 JS trim 不剥，前端因此产生过会被保存边界
 * 整次拒绝的"规范"标题。
 */
describe('trimTitleWhitespace（与 Rust 保存边界对齐的规范裁剪）', () => {
  it('剥 U+0085（NEL）：两端 trim 集合的差异字符', () => {
    expect(trimTitleWhitespace('\u0085标题\u0085')).toBe('标题')
    expect(trimTitleWhitespace('\u0085')).toBe('')
  })

  it('剥常规空白与全角空格（两端一致集合）', () => {
    expect(trimTitleWhitespace('  第二集 ')).toBe('第二集')
    expect(trimTitleWhitespace('\u3000夜戏\u3000')).toBe('夜戏')
  })

  it('剥 U+FEFF（JS 集合成员，超集裁剪保留）', () => {
    expect(trimTitleWhitespace('\ufeff摊牌')).toBe('摊牌')
  })

  it('保留标题内部空白：裁剪只作用于首尾', () => {
    expect(trimTitleWhitespace('剧 名')).toBe('剧 名')
    expect(trimTitleWhitespace('\u3000第 二 集\u3000')).toBe('第 二 集')
  })
})
