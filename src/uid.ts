/** 本地唯一标识符 = 可读前缀 + crypto.randomUUID（RFC 4122 v4，CSPRNG）。
 * 节点/资产 ID 只要求唯一性，不依赖不可预测性，但统一走加密级随机
 * 以满足 SonarQube S2245（禁用 Math.random 类弱伪随机生成标识符）。
 * crypto.randomUUID 仅在安全上下文可用——Tauri WebView 与 localhost
 * 开发服务器均满足。 */
export const uid = (prefix: string): string => `${prefix}-${crypto.randomUUID()}`
