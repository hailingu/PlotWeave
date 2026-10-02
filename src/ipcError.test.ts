/** IPC 错误机器码的解析与展示剥离（issue #229）：后端在需要程序判定的
 * 错误文案前加 `[code] ` 前缀（与 issue #144 保留的 Result<_, String>
 * 出口契约兼容）；码只服务分支判定、不上屏，无码错误按未知类别保守处理。 */
import { describe, expect, it } from 'vitest'
import { displayIpcError, ipcErrorCode } from './ipcError'

describe('ipcErrorCode（issue #229）', () => {
  it('提取字符串与 Error 的 [code] 前缀', () => {
    expect(ipcErrorCode('[project_not_found] 项目不存在：p-1')).toBe(
      'project_not_found',
    )
    expect(ipcErrorCode(new Error('[project_not_found] 项目不存在：p-1'))).toBe(
      'project_not_found',
    )
  })

  it('无码/非法形态回退 null——消费者按未知错误保守处理', () => {
    // 裸文案（旧后端或本地构造）不得被误判为「项目不存在」
    expect(ipcErrorCode('项目不存在：p-1')).toBeNull()
    expect(ipcErrorCode(new Error('读取项目文件失败：denied'))).toBeNull()
    // 码白名单为小写蛇形；大写/空码不视为合法码
    expect(ipcErrorCode('[Bad] 非合法码')).toBeNull()
    expect(ipcErrorCode('[] 空码')).toBeNull()
    expect(ipcErrorCode(42)).toBeNull()
    expect(ipcErrorCode(null)).toBeNull()
  })
})

describe('displayIpcError（issue #229）', () => {
  it('剥离码前缀：机器码不上屏，诊断文案原样保留', () => {
    expect(displayIpcError('[project_not_found] 项目不存在：p-1')).toBe(
      '项目不存在：p-1',
    )
    expect(
      displayIpcError(new Error('[project_not_found] 项目不存在：p-1')),
    ).toBe('项目不存在：p-1')
  })

  it('无码错误原样返回（Error 取 message，不带 Error: 前缀）', () => {
    expect(displayIpcError('项目文件损坏：无法判别文档信封')).toBe(
      '项目文件损坏：无法判别文档信封',
    )
    expect(displayIpcError(new Error('denied'))).toBe('denied')
    expect(displayIpcError(42)).toBe('42')
  })
})
