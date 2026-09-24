/**
 * errorBannerMessage 的输入分类行为验证（issue #270）：Error/字符串/
 * 可序列化对象有可读结果；不可序列化（循环引用、BigInt）与 undefined
 * 有非空安全兜底、不产生二次异常。断言以「可读/保留错误信息」为目标，
 * 不对普通措辞做精确匹配；IPC 契约保持 String 入参不变。
 */
import { describe, expect, it } from 'vitest'
import { errorBannerMessage } from './errorBannerMessage'

describe('errorBannerMessage（issue #270：非 Error 输入与字符串化失败）', () => {
  it('Error 取 message，字符串原样：错误信息完整保留', () => {
    expect(errorBannerMessage(new Error('保存失败：磁盘满'))).toContain(
      '保存失败：磁盘满',
    )
    expect(errorBannerMessage('拖放导入失败：文件过大')).toContain(
      '拖放导入失败：文件过大',
    )
  })

  it('可序列化对象与数组字符串化为可读 JSON，字段信息不丢失', () => {
    const object = errorBannerMessage({ code: 'EACCES', path: '/tmp/x.json' })
    expect(object).toContain('EACCES')
    expect(object).toContain('/tmp/x.json')
    expect(errorBannerMessage([1, '两'])).toContain('两')
  })

  it('原始值输入有可读结果（数字/布尔/null 的字符串形态）', () => {
    expect(errorBannerMessage(404)).toContain('404')
    expect(errorBannerMessage(false)).toContain('false')
    expect(errorBannerMessage(null)).toContain('null')
  })

  it('不可序列化输入（循环引用、BigInt）不抛二次异常，兜底非空', () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular
    for (const bad of [circular, { size: 10n }, Symbol('诊断')]) {
      const text = errorBannerMessage(bad)
      expect(typeof text).toBe('string')
      expect(text.trim().length, '兜底文案必须非空').toBeGreaterThan(0)
    }
  })

  it('undefined / 函数等字符串化为 undefined 的输入落到非空兜底', () => {
    for (const empty of [undefined, () => 'fn']) {
      const text = errorBannerMessage(empty)
      expect(typeof text).toBe('string')
      expect(text.trim().length).toBeGreaterThan(0)
    }
  })
})
