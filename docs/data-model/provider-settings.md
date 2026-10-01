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

provider 的 API key 以**密文 `keyEnc`** 存于 provider 配置：Rust `seal` 模块 AES-256-GCM 加密，明文只在加密/请求的进程内存中出现；历史钥匙串数据保留只读回退，不再写入。**envelope v2**（`pw2:<迭代数>:<provider>:<盐>:<密文>`，[issue #392](https://github.com/hailingu/PlotWeave/issues/392)，已实现）：密钥 = PBKDF2-HMAC-SHA256(应用常数 pepper ‖ IOPlatformUUID, 随机盐, envelope 自述迭代数；封装取 600,000，对齐 OWASP 量级)，并以 provider id 作 AES-GCM AAD 把密文绑定到所属条目——密文原样搬到其它 provider 名下解密失败；解密按 envelope 自述迭代数派生，超上界（5,000,000）按格式损坏拒绝以防伪造密文的计算 DoS。旧版 `pw1:`（单次 SHA-256 派生、无 AAD）保持可解以兼容存量密文；读取成功后**就地重封装**为 v2 并原子写回——写回与 `save_prefs` 共用进程内设置写互斥并在锁内重读、只改写本次成功解开的那个密文（磁盘值已变即跳过），不覆盖并发保存，迁移 best-effort（失败仅留诊断，不影响请求）；前端归一化对 `pw1:`/`pw2:` 两个前缀均透传。**机器标识不可用即硬失败**（[issue #260](https://github.com/hailingu/PlotWeave/issues/260)，已实现）：ioreg 执行失败、非零退出（先于 stdout 解析拒绝——被终止进程的截断输出在历史宽松提取语义下仍可能产出无意义材料，PR #283 评审）或输出不可解析时 `machine_material` 返回可诊断错误，`seal_for`/`open_for` 直接拒绝——不得静默回退用户名等可猜材料充当机器绑定；仅成功结果进入进程内缓存，失败不缓存、下次调用重新探测即可恢复；诊断不含用户名、机器标识、密钥或密文。历史弱材料密文兼容策略：修复前在 ioreg 失败窗口以用户名回退封装的 `pw1:` 密文不提供弱材料恢复通道，正常环境下解密按「密文被篡改或非本机数据」同款拒绝，用户在设置页重新录入 API key；成功路径的 IOPlatformUUID 提取语义保持不变，存量机器绑定密文不受影响。

**带凭据请求的传输策略**（[issue #136](https://github.com/hailingu/PlotWeave/issues/136)，已实现）：聊天与生图的 provider POST 共用 Rust `provider_transport`，发送前校验最终端点。远程服务（含局域网）必须使用 HTTPS；HTTP 仅允许 URL 解析后明确为 `localhost`、IPv4 `127.0.0.0/8` 或 IPv6 `::1` 的回环目标，不通过 DNS 为其他域名授予例外。自定义 HTTPS 域名不绑定 provider id，沿用客户端的证书校验。每跳重定向重新执行相同检查，且任何 HTTPS → HTTP 降级均拒绝（包括回环目标）；保留 reqwest 的默认 10 跳限制及跨 host/port 敏感头剥离，不恢复已移除的 Bearer。拒绝通过既有请求错误展示，策略诊断不含原始 URL 或凭据。存量 HTTP 配置保留，用户可在设置页改为 HTTPS 或回环网关后重试；不改变 `settings.json` 格式，也不在加载/保存时替换地址。模型返回的图片下载 URL 仍执行 §13 的独立公网目标策略，不采用回环例外。

**失败诊断的脱敏边界**（[issue #149](https://github.com/hailingu/PlotWeave/issues/149)，已实现）：reqwest 错误的 `Display` 会内嵌完整请求 URL（含 query），用户配置的敏感 query 或签名 URL 的签名参数会随之进入前端诊断；provider 错误正文（摘录 200 字符）也可能回显请求 URL 或 API key。统一脱敏策略：① 凡经 `Display` 到达前端的 reqwest 错误（发送/超时/客户端构造/响应体读取，含 §13 下载路径），把本次请求 URL 的每次出现替换为脱敏形态 `scheme://host[:port]/path`——userinfo、query 与 fragment 一律剥离，路径与错误类别/底层原因文本保留（可行动信息不丢）；② 状态错误摘录先把本次 API key 替换为 `***`、本次请求 URL 替换为脱敏形态，再截断 200 字符（脱敏先于截断，跨边界的 key 不留半截）。脱敏为精确子串替换：URL 的其它拼写形态（百分号编码差异等）与 key 的局部片段不在覆盖范围，属记录边界；主 key 经 Bearer header 发送、代码不直接格式化 header 的既有防线不变。

#### 凭据文件权限状态与不变量（issue #436）

[issue #436](https://github.com/hailingu/PlotWeave/issues/436) 已实现：范围为 Unix
设置文件、原子写临时文件与损坏备份：创建时使用 `0600`（仍受 umask 收紧），
保存及旧密文迁移通过同一私有原子写入口落盘。复用旧备份时，先核对普通文件
身份与原始字节，再通过已打开句柄收紧为 `0600` 并同步，权限操作失败阻止覆盖。
不扫描或自动修改尚未再次保存的设置、未复用的历史备份及崩溃遗留临时文件；
非 Unix 无 POSIX mode，维持现有平台行为，本仓库没有该平台的构建／测试覆盖。
图库索引及其他控制文件继续使用既有默认创建权限。

| 前置状态 | 动作／时序 | 预期可观察结果 | 跨转换不变量及所有者／入口 | 验证结果（2026-10-01） |
| --- | --- | --- | --- | --- |
| 设置缺失，或旧设置为 `0644` | 全量保存 → 临时文件写入 → 同步 → rename | 新设置完整可读；临时文件与最终文件为 `0600` | 原子写层：凭据新文件从创建起无组／其他用户权限；`save_prefs_in` 使用私有入口 | `private_settings_save_creates_owner_only_file`、`private_settings_save_replaces_world_readable_file`、`private_settings_temp_is_owner_only_before_write` |
| 损坏设置待覆盖 | 先排他创建备份临时文件 → 写原字节 → 同步并落位 → 保存 | 备份内容与损坏原件相同，备份临时文件／最终备份为 `0600` | 备份层：凭据副本从创建起私有，原件备份耐久完成后才能覆盖；`SETTINGS_BACKUP` | `private_settings_backup_preserves_bytes_with_owner_only_mode`、`private_settings_backup_temp_is_owner_only_before_write` |
| 同摘要旧备份为 `0644` | 核对身份与字节 → 收紧权限 → 文件／目录同步 → 保存 | 复用原 inode 与字节，权限为 `0600`，不新增副本 | 备份层：权限与备份证据一起耐久；所有复用路径由 `reuse_durable_backup` 拥有 | `private_settings_backup_reuse_tightens_existing_file` |
| 复用备份权限收紧失败 | 拒绝覆盖；解除故障后重试 | 原件与备份字节不变；重试成功，备份私有 | 备份层：未完成权限和同步不得放行覆盖；既有诊断出口继续上抛原因 | `private_settings_backup_permission_failure_blocks_save_then_recovers` |
| 旧版密文可解，或迁移与保存并发／迁移失败 | 锁内重读、精确匹配，再原子迁移 | 成功迁移后设置私有；并发编辑不丢失；失败仍可取得已解密密钥 | 设置层：`key_migration` 与保存共享锁和私有写入口 | `legacy_envelope_is_resealed_in_place_as_pw2` 扩展权限断言；既有迁移失败／并发回归 |
| 临时文件写入／同步／rename 失败，或目标为链接／异型 | 保存与重试，或拒绝目标 | 改名前原件保持；临时文件尽力清理；已提交新文件完整 | 原子写层：私有权限选择不改变排他创建、no-follow、身份绑定和持久性顺序 | 既有 `prefs::save_tests`、`prefs::backup_tests`、共用备份测试 |

权限是文件 inode 的属性，rename 沿用临时文件权限；不增加新的并发调度或
跨进程协议。确定性探针检查写入之前的真实文件元数据；同用户攻击者的目录
换名竞态沿用仓库威胁模型边界。

验证记录（2026-10-01）：7 项新增权限回归与旧密文迁移的权限断言先红后绿；红相文件 mode 为 `0644`，预期为 `0600`，且注入复用备份收权失败时保存未拒绝。绿相完整 Rust 检查通过：在 `src-tauri` 执行 `npm --prefix .. run check:size && cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test`，607 项单元测试及全部集成目标通过，包含共用备份、模块图、迁移失败和并发保存回归。初次沙箱内 `cargo test --lib prefs::` 的 5 项 HTTP 夹具因禁止绑定环回端口失败，允许本地端口后完整测试通过。文档未配置自动行为检查；按创建／复用权限、备份顺序、两条写入口及历史／平台边界作结构化复核。

维护性复核：受影响文件均低于 800 行，新增／修改执行单元均低于 80 代码行。`store/persist.rs` 为 612 行，越过 600 行讨论阈值：本次仅参数化已有原子写协议，权限策略独立为 27 行叶子模块；保留原协议在同一文件避免拆开目标复核、失败清理与屏障的审阅上下文，没有新增 I/O 协议副本。`library_fs.rs` 610 行仅增加备份默认权限字段，不扩展既有行为。圈复杂度 `N/A — no configured complexity tool`，人工检查执行跨度与嵌套深度。
