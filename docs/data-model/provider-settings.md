# 数据模型：Provider 设置

[返回数据模型索引](README.md) · 相关主题：[持久化](persistence.md)、[AI 交互](ai-integration.md)

### 10.3 Provider 与模型配置

BYOK 下 provider 分两层：**内置适配器在代码里，用户配置（含加密后的 API key）在 `settings.json`**。

代码层（不进配置文件的静态定义）：

```ts
/** 内置 provider：请求适配器，非纯数据。 */
interface ProviderDef {
  key: string                // 'openai' | 'ark' | ...
  label: string
  defaultBaseUrl: string
  endpoints: { chat?: string; image?: string; video?: string }
  /** 统一参数 ↔ 厂商格式的双向适配；OpenAI 兼容 provider 用默认透传实现。 */
  requestAdapter: (op: string, params: unknown) => unknown
  responseAdapter: (op: string, raw: unknown) => unknown
}

/** 内置模型目录：能力与可选参数清单。 */
interface ModelDef {
  key: string
  label: string
  type: 'text' | 'image' | 'video'
  providers: string[]        // 支持哪些 provider
  capabilities: string[]     // 如 'text-to-image' / 'first-frame' / 'tool-calling'
  options?: Record<string, string[]>   // 可选参数清单：sizes / ratios / durations...
  defaultParams?: Record<string, unknown>
}
```

`settings.json` 中用户可改的部分（按 provider key 分桶）：

```ts
/** 应用级设置：provider 配置与模型选择，不含密钥。
 * 无外观字段：跟随系统外观（HIG——应用内不设主题开关）。 */
interface AppSettings {
  providers: Record<string, ProviderSettings>
  selectedModels: { text?: string; image?: string; video?: string }
}

interface ProviderSettings {
  baseUrl?: string                                    // 覆盖默认值
  customModels?: Array<{ key: string; label: string }> // 用户自建模型条目
  disabledModelKeys?: string[]                        // 用户隐藏的内置模型
}
```

**模型可见性 = 三层过滤**：在内置目录或自定义条目里 → 所属 provider 已配置（key + baseUrl 齐备）→ 未被用户禁用。过滤结果是计算属性，不持久化。

> 落地状态（2026-09-04）：已发布的实现收敛为扁平 `AppSettings { providers: ProviderConfig[]; defaultChat: string | null; defaultImage: string | null }`（"providerId:modelId"，§13 图像生成首版随 `defaultImage` 落地）；`ProviderDef`/`ModelDef` 的能力目录与 `selectedModels` 三段结构为目录化演进预留，引入时按下表 §10.5 命令边界对齐。
### 10.4 密钥管理

provider 的 API key 以**密文 `keyEnc`** 存于 provider 配置：Rust `seal` 模块 AES-256-GCM 加密（密钥 = 应用常数 + IOPlatformUUID + 随机盐，封装于 envelope），明文只在加密/请求的进程内存中出现；历史钥匙串数据保留只读回退，不再写入。**机器标识不可用即硬失败**（[issue #260](https://github.com/hailingu/PlotWeave/issues/260)，已实现）：ioreg 执行失败、非零退出（先于 stdout 解析拒绝——被终止进程的截断输出在历史宽松提取语义下仍可能产出无意义材料，PR #283 评审）或输出不可解析时 `machine_material` 返回可诊断错误，`seal`/`open` 直接拒绝——不得静默回退用户名等可猜材料充当机器绑定；仅成功结果进入进程内缓存，失败不缓存、下次调用重新探测即可恢复；诊断不含用户名、机器标识、密钥或密文。历史弱材料密文兼容策略：修复前在 ioreg 失败窗口以用户名回退封装的 `pw1:` 密文不提供弱材料恢复通道，正常环境下解密按「密文被篡改或非本机数据」同款拒绝，用户在设置页重新录入 API key；成功路径的 IOPlatformUUID 提取语义保持不变，存量机器绑定密文不受影响。

**带凭据请求的传输策略**（[issue #136](https://github.com/hailingu/PlotWeave/issues/136)，已实现）：聊天与生图的 provider POST 共用 Rust `provider_transport`，发送前校验最终端点。远程服务（含局域网）必须使用 HTTPS；HTTP 仅允许 URL 解析后明确为 `localhost`、IPv4 `127.0.0.0/8` 或 IPv6 `::1` 的回环目标，不通过 DNS 为其他域名授予例外。自定义 HTTPS 域名不绑定 provider id，沿用客户端的证书校验。每跳重定向重新执行相同检查，且任何 HTTPS → HTTP 降级均拒绝（包括回环目标）；保留 reqwest 的默认 10 跳限制及跨 host/port 敏感头剥离，不恢复已移除的 Bearer。拒绝通过既有请求错误展示，策略诊断不含原始 URL 或凭据。存量 HTTP 配置保留，用户可在设置页改为 HTTPS 或回环网关后重试；不改变 `settings.json` 格式，也不在加载/保存时替换地址。模型返回的图片下载 URL 仍执行 §13 的独立公网目标策略，不采用回环例外。

**失败诊断的脱敏边界**（[issue #149](https://github.com/hailingu/PlotWeave/issues/149)，已实现）：reqwest 错误的 `Display` 会内嵌完整请求 URL（含 query），用户配置的敏感 query 或签名 URL 的签名参数会随之进入前端诊断；provider 错误正文（摘录 200 字符）也可能回显请求 URL 或 API key。统一脱敏策略：① 凡经 `Display` 到达前端的 reqwest 错误（发送/超时/客户端构造/响应体读取，含 §13 下载路径），把本次请求 URL 的每次出现替换为脱敏形态 `scheme://host[:port]/path`——userinfo、query 与 fragment 一律剥离，路径与错误类别/底层原因文本保留（可行动信息不丢）；② 状态错误摘录先把本次 API key 替换为 `***`、本次请求 URL 替换为脱敏形态，再截断 200 字符（脱敏先于截断，跨边界的 key 不留半截）。脱敏为精确子串替换：URL 的其它拼写形态（百分号编码差异等）与 key 的局部片段不在覆盖范围，属记录边界；主 key 经 Bearer header 发送、代码不直接格式化 header 的既有防线不变。
