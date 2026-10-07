/** 原生剪贴板与文本交付服务：系统回执是成功依据，取消保存是正常可见结果。 */
import {
  invokeSwiftHost,
  SwiftHostError,
  SYSTEM_HOST_COMMANDS,
} from './swiftHost'

/** 原生剪贴板写入完成前不报告成功；载荷不进入诊断日志。 */
export async function copySystemText(text: string): Promise<void> {
  const result = await invokeSwiftHost(SYSTEM_HOST_COMMANDS.copyText, { text })
  if (result !== null)
    throw new SwiftHostError(
      'PW_HOST_PROTOCOL_INVALID',
      '剪贴板回执不符合协议，本次结果未知',
      true,
    )
}

/** 保存面板由用户关闭；返回取消状态而非伪造已保存结果。 */
export async function saveSystemText(
  text: string,
  fileName: string,
): Promise<{ cancelled: boolean }> {
  const result = await invokeSwiftHost(SYSTEM_HOST_COMMANDS.saveText, {
    text,
    fileName,
  })
  if (
    result === null ||
    typeof result !== 'object' ||
    typeof (result as Record<string, unknown>).cancelled !== 'boolean'
  ) {
    throw new SwiftHostError(
      'PW_HOST_PROTOCOL_INVALID',
      '文件保存回执不符合协议，本次结果未知',
      true,
    )
  }
  return { cancelled: (result as { cancelled: boolean }).cancelled }
}
