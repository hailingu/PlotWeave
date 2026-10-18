/**
 * 输入法组合键判定（issue #570）：应用层以 keydown 承接的 Enter/Escape 动作
 * （提交、发送、取消、收起浮层）在输入法组合在途时必须让位——组合中的
 * Enter/Esc 由输入法消费（确认候选 / 取消合成），不是用户对应用的指令。
 * 两种浏览器事件顺序都要识别：规范顺序（Chromium 等）下组合中的 keydown 带
 * isComposing === true；WebKit（Safari/WKWebView）确认或取消组合的键的
 * keydown 晚于 compositionend 到达，isComposing 已为 false，仅 keyCode === 229
 * （"由输入法处理"）可辨识（WebKit bug 165004）。本项目两个宿主——Tauri on
 * macOS 与 Swift 外壳——均为 WKWebView，故两项并查；不引入 compositionend
 * 之后的计时放宽（不可确定性测试）。
 */

/** 判定所需的键盘事件字段；原生 KeyboardEvent 结构兼容（React 处理器传
 * `e.nativeEvent`）。以独立类型读取 keyCode，不直接访问已弃用的
 * KeyboardEvent.keyCode 声明。 */
export interface CompositionKeyFacts {
  readonly isComposing: boolean
  readonly keyCode: number
}

/** 该 keydown 是否属于输入法组合链路（组合中，或 WebKit 晚到的 229）。 */
export function isCompositionKey(event: CompositionKeyFacts): boolean {
  return event.isComposing || event.keyCode === 229
}
