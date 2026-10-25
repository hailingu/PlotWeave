# 数据模型：Provider 设置

[返回数据模型索引](README.md) · 相关主题：[持久化](persistence.md)、[AI 交互](ai-integration.md)

### 10.3 Provider 与模型配置

**最终退出写入资格（[PR #526 R37](../swiftui-react-flow-pr526-fixes.md#反向宿主请求退役与-web-最终退出协调)）**：Swift 开始退出即暂停新 Web 业务及输入，既有密钥加密／状态交付和设置保存仍由原 saver 等待；四源保存与业务／React 提交都空闲才封口，最终批准在途时 `update` 不接纳新设置状态。失败恢复输入、保留已有待存快照并明确重试，不增加配置副本、明文日志或新的密钥草稿持久化。

**编辑期间的保存诊断**（[#594](https://github.com/hailingu/PlotWeave/issues/594)）：500ms 防抖落盘失败立即进入设置 owner 的 `saveError`，Web 与原生只读错误投影同步展示。失败回填仍受最新提交序号守护，保留最新待存快照；Web 的「重试保存」和原生「完成」沿用同一固定点冲刷，分别在当前页恢复或成功后关闭。最新保存成功且无更新待存编辑才清除保存与关闭诊断，旧请求成功/失败不覆盖更新状态。磁盘 schema、串行写入、密钥等待与退出注册不变。

**原生字段提交与投影确认**（[PR #526 R33–R34](../swiftui-react-flow-pr526-fixes.md#设置字段与投影回执)）：原生 `settings.setDefaults` 只携带改动的 `defaultChat` 或 `defaultImage`，也兼容旧式双字段提交；至少一个字段，值仅为字符串或 null，未知字段及空补丁拒绝。缺席字段保留 Web settings owner 当前同步快照的值，null 只清指定项；配置仍由既有保存固定点写入，不改变磁盘 schema。

名称、地址及模型清单是短期普通表单草稿。原生每次编辑在 `settings.patchProvider` 补丁旁携带可选 `edit` 元数据——每字段一个有界正整数编辑身份；Web owner 在同一同步步骤把该身份与被应用的设置快照配对，并在只读投影的对应 provider 上回显 `edits`（仅保留当前 provider 各字段最新身份，provider 删除或 owner 卸载即清理；不携带密钥、不写 `settings.json`）。投影回执替换某字段须同时满足两个条件：值意义上干净（草稿等于前一权威值；模型按逐行去空白语义比较）且该快照的确认严格新于该字段全部待定编辑身份；快照确认达到或超越某字段最新待定身份时清除该待定身份，此后干净字段继续接收外部权威更新。回改原值（A→B→A）后新稿再次等于旧权威值，但旧 B 投影携带的确认落后于待定身份，不能再覆盖新稿；模型的最新确认保留光标所在的原始多行文字与空白。失败保留普通草稿，不自动重放；卡片删除／页面重挂按当前权威值播种；未携带 `edit` 的旧式补丁仍被接受（应用但不记录确认）。密钥保持下述独立保密生命周期。

**字段回改缺陷的修复**（[issue #527](https://github.com/hailingu/PlotWeave/issues/527)、[PR #526 R39](../swiftui-react-flow-pr526-fixes.md#服务文字回改缺陷的后续修复r39)→修复记录）：`39089f7`（R34）引入的值比较保护未覆盖 A→B→A 回改时序，已于 2026-10-14 按上述编辑身份设计修复。最小真实名称／地址 A→B→A 旧投影回归在生产 WK owner 与隔离 Swift `settings.json` 上先红（4 处：字段被旧 B 投影覆盖、磁盘保存非预期文字）后绿；规范化模型列表回改、同值合并确认、三字段交叉与非法元数据拒绝在 Web 与原生边界均有语义回归。磁盘 schema 与密钥生命周期不变；真实中文 IME／VoiceOver 仍属 P5 人工缺口。

**Web 密钥回执的意图归属**（[#850](https://github.com/hailingu/PlotWeave/issues/850)）：Web/Tauri 设置页按 provider 记录密钥提交序号；后续保存或清除立即使旧回执失效，过期成功和失败都不修改设置、草稿或错误。有效回执只将目标 `keyEnc` 合入同步维护的当前设置，不采用加密调用时的完整快照；同批完成的不同 provider 各自保留密文。成功只清空本次提交对应的草稿，提交后继续录入的草稿保留。加密及状态合并仍整体登记到既有 saver，在关闭／退出前等待，并经原串行保存链落盘；原生设置页继续沿用独立的 revision／load generation 防护，envelope 与 `settings.json` 协议不变。

| 前置状态 | 动作／时序 | 预期可观察结果 | 不变量及所有者／入口 | 验证 |
| --- | --- | --- | --- | --- |
| 已有凭据，加密在途 | 保存 → 清除 → 旧成功／失败 → 关闭 | 页面未配置，保存结果不含已清除密钥，无旧错误阻断关闭 | Web key 表单：清除失效此前同 provider 的全部密钥意图 | `SettingsView.keyRace.test.tsx`：clear success/failure |
| 加密在途 | 修改本条／其他 provider、两个默认模型 → 回执 | 新密文与新地址、模型、启用状态、默认模型共同保留 | key 表单仅拥有目标 `keyEnc`，其他字段由当前设置持有 | concurrent edits |
| 同 provider 两次保存 | 第二次先成功 → 第一次成功／失败 | 第二次密文、后续草稿保留，无旧错误 | 序号按提交而非完成顺序递增，保存按钮与 Enter 共用 | superseded success/failure |
| 不同 provider 均在途 | 两个回执在同一 React 批次完成 | 两条新密文均落盘 | 同步合并快照，序号按 provider 隔离 | independent provider completions |
| 最新提交失败 | 更旧成功迟到 → 新提交重试 | 旧密文不复活，最新错误仍可见，重试成功后消除 | 失败不恢复过期意图，当前失败仍沿原错误出口反馈 | latest failure/retry |
| 保存后继续录入 | 关闭 → 有效回执 → 冲刷 | 后续草稿不被消费，新密文落盘后才关闭 | saver 继续拥有固定点关闭冲刷，key 表单只消费提交时草稿 | later draft/close |

上述回归运行真实 Web 页面、settingsStore、typed IPC 与 saver，只在宿主传输边界控制加密延迟、模拟 JSON 持久化；未在真实 Tauri 桌面注入慢加密，不据此宣称重新验证密码学或磁盘原子写。原生现有回归同时保留。

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

**原生未提交密钥的生命周期**（[PR #526 R28](../swiftui-react-flow-pr526-fixes.md#设置滚动与密钥草稿)）：设置页按 provider ID 持有短期内存草稿；供应商卡片滚动离屏或同页加载区域重建不清稿。整页离开、就绪投影确认供应商删除，以及提交前均清除对应草稿；删除后重现相同 ID 不恢复旧输入，提交失败需重新录入。明文不进入普通字段 patch、只读投影、持久设置或日志；已有密钥只显示配置状态，不回显明文。此处清除指应用状态不再保留该字符串，不承诺 Swift 字符串内存的物理零化。

**原生 Swift 设置根边界**（[PR #526](https://github.com/hailingu/PlotWeave/pull/526)，[修复矩阵 R9](../swiftui-react-flow-pr526-fixes.md)）：只有文件缺失返回空对象；合法 JSON 的数组、null 和标量根与语法损坏同样返回 `PW_PREFS_CORRUPT`，不归一化成默认设置。`load_prefs`、模型凭据读取和旧密文迁移共用 `NativePreferences.load`；未知对象字段仍透传。`save_prefs` 在任何磁盘变更前拒绝非对象载荷（`PW_PREFS_INVALID`）；显式保存有效对象恢复损坏设置时，先将原始字节耐久保存为内容寻址的 `0600` 备份，再原子替换。沿用单 actor 的读改写顺序，不扩展磁盘 schema。

provider 的 API key 以**密文 `keyEnc`** 存于 provider 配置：Rust `seal` 模块 AES-256-GCM 加密，明文只在加密/请求的进程内存中出现；历史钥匙串数据保留只读回退，不再写入。**envelope v2**（`pw2:<迭代数>:<provider>:<盐>:<密文>`，[issue #392](https://github.com/hailingu/PlotWeave/issues/392)，已实现）：密钥 = PBKDF2-HMAC-SHA256(应用常数 pepper ‖ IOPlatformUUID, 随机盐, envelope 自述迭代数；封装取 600,000，对齐 OWASP 量级)，并以 provider id 作 AES-GCM AAD 把密文绑定到所属条目——密文原样搬到其它 provider 名下解密失败；解密按 envelope 自述迭代数派生，超上界（5,000,000）按格式损坏拒绝以防伪造密文的计算 DoS。旧版 `pw1:`（单次 SHA-256 派生、无 AAD）保持可解以兼容存量密文；读取成功后**就地重封装**为 v2 并原子写回——写回与 `save_prefs` 共用进程内设置写互斥并在锁内重读、只改写本次成功解开的那个密文（磁盘值已变即跳过），不覆盖并发保存，迁移 best-effort（失败仅留诊断，不影响请求）；前端归一化对 `pw1:`/`pw2:` 两个前缀均透传。**机器标识不可用即硬失败**（[issue #260](https://github.com/hailingu/PlotWeave/issues/260)，已实现）：ioreg 执行失败、非零退出（先于 stdout 解析拒绝——被终止进程的截断输出在历史宽松提取语义下仍可能产出无意义材料，PR #283 评审）或输出不可解析时 `machine_material` 返回可诊断错误，`seal_for`/`open_for` 直接拒绝——不得静默回退用户名等可猜材料充当机器绑定；仅成功结果进入进程内缓存，失败不缓存、下次调用重新探测即可恢复；诊断不含用户名、机器标识、密钥或密文。历史弱材料密文兼容策略：修复前在 ioreg 失败窗口以用户名回退封装的 `pw1:` 密文不提供弱材料恢复通道，正常环境下解密按「密文被篡改或非本机数据」同款拒绝，用户在设置页重新录入 API key；成功路径的 IOPlatformUUID 提取语义保持不变，存量机器绑定密文不受影响。

**RustCrypto 协同迁移**（[issue #743](https://github.com/hailingu/PlotWeave/issues/743)）：两 Rust workspace 的直接 sha2 升至 0.11，Tauri 的 pbkdf2 升至 0.13（保留 `hmac` feature）、aes-gcm 升至 0.11；base64 保持独立的 0.22。封装协议不变：pepper 固定为 `plotweave/key-seal/v1`，pw1 派生输入使用盐的十六进制文本，pw2 使用盐的原始字节；密钥为 32 字节、盐 16 字节、nonce 12 字节、tag 16 字节，负载为 `nonce || ciphertext || tag` 的小写 hex，pw2 AAD 为 provider 的 UTF-8 字节，读迭代范围为闭区间 1–5,000,000。盐与 nonce 分别通过系统安全随机源的 fallible API 生成，任一失败均返回错误，不 panic、不采用确定性回退。Rust 回归原样沿用原生 Swift 测试中由独立 Node 实现生成的冻结 pw1／pw2 向量，并核对固定输入字节一致；原生兼容测试保留。共享 core 的 normal/build 闭包继续接受原漂移门禁，Tauri 其他传递依赖所需的旧 crypto 代际不在清除范围内。

**封装密钥的威胁模型边界**（[issue #520](https://github.com/hailingu/PlotWeave/issues/520)，已知边界）：`pw1:`/`pw2:` envelope 的密钥派生材料是应用常数 pepper（随二进制分发，单独存在不构成密钥）与 IOPlatformUUID（同用户进程经 `ioreg` 同样可读），防的是 `settings.json` 离线泄露、云同步拷贝与他机解密；对以同一用户身份运行的恶意软件无防御——它与 `docs/ui-design.md` §8.2 凭据条目的声明一致，Swift 侧 `NativeSeal.swift` 对齐同一合同（同一 pepper、envelope 格式与机器标识探测语义）。迭代拉伸与 AAD 绑定是该模型内的纵深防御，不改变边界。若将来需要防御同用户恶意软件，须改用系统钥匙串或用户口令派生，作为新功能 issue 另行立项，不在本边界内修补。

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

### 首跳凭据目的地绑定（#653）

聊天与生图均从同一持久化 provider 快照取得目标和密文，调用方 `baseUrl` 只作等价性核对；缺失、损坏、重复或地址不一致的配置在解密／发送前拒绝。已配置的自建 HTTPS 与显式回环 HTTP 保留；Rust 历史 Keychain 只读回退也须先确认已保存目标。设置仍在保存中时，调用方可在保存成功后重新发起请求。

图片下载独立采用 HTTPS、公网地址及每跳固定 DNS 答案的边界（#655），不继承 provider 的本地 HTTP 例外。完整策略、不变量矩阵、验证方法与限制见[模型网络边界](../development/model-network-boundaries.md)。
