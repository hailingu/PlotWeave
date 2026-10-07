# 原生版本功能补齐记录

> 2026-10-07 主目录集成：完整实现从归档快照恢复到当前分支，当前构建与验证结果见[合入记录](swiftui-react-flow-integration.md)。下方各日期结果保留原执行范围。

日期：2026-10-04。基线：本地 `dev` 的 `752cd5c`，已合入 `codex/swiftui-react-flow` 的 `08653d2`。本记录对应所有者“补充 swiftui-react-flow 里和 dev 上对比缺失的功能”的任务，沿用[迁移计划](swiftui-react-flow-migration-plan.md)的单写入者、持久化和数据隔离合同。

## 差异与实施范围

比较起点：生产 React 项目管理、六类节点编辑、历史、大纲、设定、资产、设置、AI 与导出均已在分支中，但原生入口只有内存演示，服务和正常退出未接通。当前已实现 SwiftUI 首页、设置、大纲、检查器、设定、图库、AI 与导出，25 条业务命令和两条退出命令由 Swift 承接，另提供两条系统文本交付命令。默认入口运行真实编辑会话，`#fixture` 仅用于隔离演示。补齐复用既有编辑动作，不升级磁盘 schema；视频制作、JSON 导入和资产收藏回库等 dev 尚未实现的规划功能不计入差异。

所有者于 2026-10-04 明确选择“存储、素材和模型服务也用 Swift 实现”。服务改为 Swift 原生实现，旧 Tauri/Rust 作为行为与磁盘合同回归基线；新宿主不链接 Rust，事件、媒体资源及系统交付由 Swift 管理。React 保持唯一文档写入者和保存协调者。界面全部使用 SwiftUI，React Flow 保留画布和单一编辑会话；沿用原计划的独立数据／测试身份，不访问真实 Tauri 项目或历史 Keychain。

## 实现前关键状态与不变量矩阵

以下矩阵在生产实现前记录，并在完成验证后更新末列。各域最小行为测试已观察预期失败，再实现并通过对应回归；末列列出实际覆盖及保留缺口。

| ID | 前置状态／动作与顺序 | 预期可观察结果 | 不变量、责任方与入口 | 验证与当前缺口 |
| --- | --- | --- | --- | --- |
| F01 | 有效加载会话发送 25 类业务和两类退出请求；缺桥、坏载荷或协议版本不支持 | 成功返回真实结果；失败有结构化诊断，不进入浏览器内存回退 | 平台传输与 Swift router 仅服务受信页面／有效会话；所有 IPC 入口 | 通过：`swiftHost`、`HostCommandRouterTests` 和真实 WK 生产链；坏协议、非主页面、未知命令拒绝 |
| F02 | 请求 A 在途，页面重载到 B；相同会话同 requestId 重复请求或回执超时 | 旧回执不作用于 B；重复不重做副作用；超时显示结果未知 | Swift router 拥有请求去重，Web 拥有回执会话归属；创建／复制／删除／模型／系统保存 | 通过：router 在途／完成去重、参数冲突、容量拒绝与页面失效；Web 超时和旧回执回归。已提交副作用不承诺取消回滚 |
| F03 | 隔离根创建项目→编辑→防抖保存；旧保存完成后再编辑→退出→重开 | 文件恢复最新文档、视口与独立 AI 历史 | React 文档／历史／保存链为唯一写入者；原生和画布动作进入同一路径 | 通过：`NativeProductionLifecycleTests` 真实 WK→文件→退出→重开→JSON 导出；项目、视口和 AI 临时根往返 |
| F04 | 保存失败、删除在途或返回首页后有失败快照→重试／重开／复制删除 | 失败可见，最新快照保留；删除成功不被迟到保存复活 | 应用会话协调层拥有项目、画布、AI 三类写入顺序；所有导航／删除入口 | 通过：既有 App／保存链回归、原生连续编辑与 `NativeProjectStoreTests` 删除后项目／AI 写入不复活；fsync 故障注入未覆盖 |
| F05 | 启动注册前退出；关窗／⌘Q／Dock；冲刷中又产生编辑或写入失败 | 缓冲请求只重放一次；排空至固定点才关闭；失败留窗可重试 | Swift 生命周期拥有终止权，React 重用现有保存协调并增加设置／在途 key 冲刷；每种退出入口 | 通过：`HostQuitTests`、`NativeWindowLifecycleTests`、实际 WK 冲刷及 `useExitFlush.swift` 固定点（含设置／在途 key）；真实 Dock／菜单按键目验未做 |
| F06 | 打开设置、收展面板、切选择与属性编辑，含目标已删除／投影陈旧 | 同一 WebView 与会话存活；命令进入共享历史；失效目标拒绝 | React 编辑动作拥有文档；Swift 仅只读投影和表单草稿；原生面板／菜单／画布 | 通过：`nativeEditorShell`、`NativeApplicationStateTests`、真实 WK 生命周期与稳定目标 ID 回归；中文输入法／焦点目验未做 |
| F07 | 图库导入／删除／恢复失败；诊断事件乱序；媒体缺失、取消或切项目 | 单条错误不清空有效列表；诊断序号单调；媒体正确显示或明确失败 | Swift 索引／事务／限读／资源所有权与 WK scheme adapter；库／项目／生成媒体 | 通过：Swift 库迁移／删除恢复／诊断、资产复制绑定与撤销、真实 WK 媒体解码、取消／限并发；实际 NSOpenPanel 和拖放目验未做 |
| F08 | 独立数据根读取／保存设置；配置坏文件；未配置 keyEnc 时调用模型 | 读取失败不覆盖；密文原合同兼容；隔离宿主不读旧 Keychain | Swift prefs/seal 与显式 secret policy；设置／聊天／生成入口 | 通过：`NativePreferencesTests` pw1/pw2 合成密文、0600、坏文件／限读；原生设置连发和成功保存后消费者重载。未访问真实凭据／历史 Keychain |
| F09 | 聊天／生图长请求；先取消或切会话后迟到结果；同时收到退出 | 取消可达，不阻塞其他服务；旧结果不覆盖新会话，产物按既有规则落盘 | Swift 任务所有权／作业注册表及 React AI 控制器；发送／取消／关闭入口 | 通过：注入模型传输、URLProtocol 重定向、受限公开下载策略／HTTP framing、生成取消和实际产物提交；真实公网 TLS／付费模型未调用 |
| F10 | 导出 Markdown／JSON、复制文本；用户取消保存面板或系统写入失败 | 实际成功后才反馈成功；取消／失败不冒充下载完成 | Web 导出生成器与 Swift 系统服务；所有导出／复制入口 | 通过：真实隔离 pasteboard、注入目标的 UTF-8 文件写入、取消和错误；实际 NSSavePanel 用户选址目验未做 |
| F11 | Web 内容进程终止或宿主释放时仍有异步任务 | 可见恢复提示，拒绝空文档写入，无释放后回调访问 | Swift 页面代次／Swift 任务所有权；进程终止／重载／释放 | 通过：页面／请求／窗口生命周期，失效取消排队写入、缺失原生意图回执显式失败；崩溃后未落盘编辑恢复不承诺 |
| F12 | 原生 AI 模型选择、发送、取消、新会话、删除类改动预览确认与重开 | 与 dev 相同会话与批次；未确认删除不执行，失败和未落盘状态可见 | 既有 React AI 执行／保存协调器拥有图修改，SwiftUI 呈现和 Swift 模型服务；所有原生 AI 入口 | 通过：真实 AI 控制器选择模型→发送、取消晚回执、清空确认、删除预览先确认再执行／撤销、坏 AI 会话加载阻止空写 |
| F13 | 原生角色／地点／文档增改删、集改名／聚焦／大纲排序，目标在提交前已删除 | 进入同一撤销历史，旧目标拒绝，不复活实体或改错项目 | React 设定／大纲动作拥有文档，SwiftUI 表单只有草稿；原生侧栏与设定入口 | 通过：角色／地点／文档、细粒度列表、关系、集号清除、大纲移动／撤销及目标失效；Swift 拖放载荷合同测试通过，实际手势未验 |
| F14 | 原生导出选择 Markdown／JSON、包含大纲或省略；系统取消／失败 | 文本与 dev 导出同合同，未落盘编辑也能导出；取消不假成功 | 既有纯导出生成器与 Swift 系统交付；原生导出表单 | 通过：当前未落盘文档 JSON 语义、既有 Markdown／大纲导出回归、`NativeExportTicketTests` 格式／范围切换拒绝旧预览、系统交付取消／失败 |

单用户单实例范围保持；不引入多写者同步、跨进程冲突仲裁或对同用户攻击者目录替换的额外防御。Windows、旧 macOS、真实模型计费、签名分发不属于本次自动验证。视觉、VoiceOver、真实输入法和触控板性能缺口分别记录，不用通过单测替代。

## 桥合同

命令通道使用 WebKit 带回执 handler `plotweaveHost`。文档开始时注入 `__pwNativeHost={kind:"swift",protocolVersion:1,sessionId:…}`，会话身份随每次加载更新。请求包含 `protocolVersion`、`sessionId`、`requestId`、`command` 与可选参数对象 `args`；回执为 `{ok:…}` 或 `{error:{code,message}}`。25 条现有业务 snake_case 命令及两条退出命令保持载荷语义；系统文本交付为 `system.copyText` 和 `system.saveText`。

同一会话请求去重覆盖在途和完成结果，不自动重试删除、复制或计费请求。媒体字节通过 Swift 资源服务／`WKURLSchemeHandler`，不进入 JSON 或 base64 命令回执。宿主事件由 `__pwDispatchHostEvent` 投递 `app-quit-requested`、`library-diagnostics`，监听建立后才确认退出就绪。

## 验证证据

验证环境为 macOS 26.6.2／Xcode 27.0／Swift 6.4／SDK 27.0、Node 24.18.0；工作分支 `codex/swiftui-react-flow`，合并基线 `08653d2`，功能补齐为当前未提交工作树。测试使用临时数据根、合成密钥与注入传输，未读写真实 Tauri 数据或调用付费模型。新原生数据根由 bundle ID 派生为 `dev.plotweave.PlotWeaveNative.development`。

- 前端：`npm run format:check && npm run lint && npm run check:size && npm run typecheck:strict && npm run build` 已通过；最终 `npm test` 为 208 文件／3032 项全通过，日志 `/private/tmp/pw-frontend-launch-final-green.log`。两条设置用例改为等待真实异步入口并保证 finally 排空后，全量通过。
- 原生：先前全量 114 tests／33 suites 通过；随后新增日志边界、缺失回执和取消守卫，focused 44 tests／14 suites 与最终全量 118 tests／34 suites 通过。路由命令：`npm run check:size && npm run build:native-canvas && xcodebuild -project native/macos/PlotWeaveNative.xcodeproj -scheme PlotWeaveNative -destination 'platform=macOS' -derivedDataPath native/macos/build/DerivedData test`，日志 `/private/tmp/pw-native-final-full-green.log`。最终旧引用 delta 修复后再次重打包，389 个模块构建及 118 tests／34 suites 全量通过，最终日志 `/private/tmp/pw-native-launch-final-green.log`。
- CI 配置：`npx prettier --check .github` 通过；未创建 PR，托管 `xcode-27` CI 未运行。本次未改 Rust 源码或配置，未重复 Cargo 路由；已有合并的 Rust 检查证据保留在 P2 记录。
- 文档：无配置的自动语义检查，已结构化核对实现状态、目录、链接、矩阵与保留边界；补充 `git diff --check`。
- 未创建提交、推送或 PR；未执行该类操作所需的新 Sonar 门禁与远端 CI。已有合并／工具链结果保留在相应历史证据中，不代替本次功能结果。

已知边界：旧扁平（v0／versionless）项目的异型排序元数据 `updated_at` 为小数时，Swift 转换为 ISO 时间，而旧 Rust `as_u64` 回退空串；影响仅为该脏 legacy 摘要排序，图与保存 payload 不受影响，按 P2 留待所有者处置。系统 fsync 故障注入、真实公网 TLS 信任链、实际保存／导入面板、菜单／Dock、中文输入法、VoiceOver、视觉与性能对照未覆盖。当前能力属于本地验证版本，签名／分发未执行。原生 bundle 的本地 ad-hoc 签名经 `codesign --verify --deep --strict` 检查通过；这不代表公证或发行签名。

### F13 细粒度编辑状态补充

| 状态与入口 | 转移 | 可观察结果 | 不变量及所有者 | 验证 |
| --- | --- | --- | --- | --- |
| 同一页连续原生编辑设定/列表 | 两个请求在 React 批处理窗口内到达 | 两项修改都保留 | React 文档唯一写入者；原生命令完成前提交当前状态 | 原生编辑控制器并发回归 |
| 对白/分支/分镜已有列表项 | 修改/增删某项 | 基于当前列表修改；删选项同步删边，撤销恢复 | 稳定项 ID 不复活，旧投影不得替换整列表 | 列表修改与级联撤销 |
| 项目及分镜有效，库条目可绑定 | 导入中删除目标/卸载项目 | 不将结果写入已失效会话 | 素材导入前后检查目标；复合历史包含索引和绑定 | 导入成功/晚完成测试 |
| 可选集号/地点已设置 | 原生明确清除 | 重新导出无该字段 | 清除仅限允许的可选字段，不用无效 null 覆盖 | 导出语义验证 |

网络服务使用临时根和注入传输验证，不调用真实付费模型。

F12 补充：模型选择 → 同一任务内发送、删除批次确认 → 执行须先提交 React 状态；依旧以会话控制器为不变量所有者，新增原生连发回归。F14 补充：导出格式/范围/文档版本变化后，预览必须重新匹配当前请求才能复制或保存；旧预览等待期间禁提交。设定条目删除确认捕获原身份，后续选择变化不得重定向删除。

### 素材删除恢复边界补充（L09／L10）

| 状态与入口 | 转移 | 可观察结果 | 不变量及所有者 | 验证 |
| --- | --- | --- | --- | --- |
| 对象 journal 或旧 archive 中清理计数异型／越界，旧 bytes 看似有效 | 正常删除有效素材 | 丢弃无来源旧字节，重新累计当前保留媒体 | `NativeLibraryJournal`：计数损坏不得承认旧总量 | `invalidCleanupCountDiscardsUnprovenBytes` 四组合先红后绿 |
| 删除日志紧凑快照 >512KiB、但仍在 1MiB 读预算内 | 请求删除／追加 transaction | 在恢复或移动媒体前拒绝，原 index／journal／媒体保留 | `NativeLibrary.deleteAsset` 与 journal：删除必须保留半预算余量；actor＋flock 串行边界不变 | `oversizedDeleteJournalRefusesBeforeRecovery`、`appendedTransactionReservesHeadroom` 先红后绿 |

会话失效取消由 router 负责，真实临时根覆盖旧排队创建不得落盘；已提交效果保留“结果未知”语义。原生意图 `undefined` 回执由 `WebCanvasCoordinator` 拒绝为 `PW_INVALID_REPLY`，真实 WK 测试通过，不将空返回当成功。

### F13 旧失效引用下的细粒度编辑补充

实现前复核用真实校验器探针确认：原生细粒度操作把保留的整个列表交给 AI 写入校验，会被普通删除后留下的旧失效引用阻止。修复范围限定于原生普通表单入口，AI 批次信任边界保持。

| 状态与入口 | 转移 | 可观察结果 | 不变量及所有者 | 验证 |
| --- | --- | --- | --- | --- |
| 对白已有失效 speaker 与未知透传成员字段 | 编辑健康／旧行文字、增删其他行／撤销 | 修改成功，旧引用与未知字段保留，撤销恢复文字 | 当前文档与 granular list action：只校验本次新写字段／引用，不让旧行锁住正常编辑 | 真实 `nativeEditorShell` 回归先红后绿，健康／旧行编辑、增删与撤销通过 |
| 分镜 refs 已有缺失 assetId | 修改健康自由位或旧位、增删其他位 | 保留旧引用且普通操作可完成 | 新写入 assetId 须当前有效、MIME 匹配；当前项未改引用不得被替换 | 同套真实控制器先红后绿；旧位／健康位编辑、增删／撤销通过，新无效引用／kind 变化／未知补丁仍拒绝 |
| 场景角色或文档关联已有已删除实体 | 切换有效新关联／撤销 | 旧失效关联保留，新关联正确加入或移除 | native toggle action 以当前实体身份校验新增成员；不清除历史引用或误改项目 | 同套先红后绿覆盖角色与文档关联切换／撤销；新缺失实体仍拒绝 |

正常 entityDelete 可达这些状态，恢复／撤销相关；actor 或跨进程并发不新增，单一文档／历史所有者保持。

最终增量编辑证据：`npm test -- src/editor/nativeCanvas/nativeEditorShell.test.tsx src/moduleGraph.test.ts`，15 项真实控制器与 30 项模块守卫通过，日志 `/private/tmp/pw-native-dangling-green.log`。修复保留既有透传内容，新增 helper／动作文件经格式、零警告 lint、严格类型与规模检查通过；不放宽 AI 全局或原始整列表命令。


### 启动与产物

按所有者此前启动指令，通过全部检查后以 `open -n native/macos/build/DerivedData/Build/Products/Debug/PlotWeaveNative.app` 启动最新生产入口；启动前核对同一路径无活动实例，启动后进程 PID 52810 持续存在。此处仅记录进程启动，不替代上述人工视觉／输入验收。主程序及 debug dylib 的动态依赖为 Apple／Swift 系统框架，无 Rust/Tauri 链接。

一次性 `dist/`、`native/macos/App/WebCanvas/`、DerivedData 的测试报告、编译／索引缓存和其他产品已清理；仅保留明确授权运行的 app bundle（约 12MiB）。重新构建使用工作流中的 `npm run build:native`，会重新生成画布与编译缓存。

主要改动位于 `native/macos/App/`（原生服务与业务界面）、`native/macos/Tests/`（临时根／真实 WK 回归）、`src/platform/`（传输／事件／系统服务）、`src/editor/nativeCanvas/`（当前文档意图／投影）、`src/settings/`（原生设置与退出冲刷），以及 App／编辑器装配和相关开发、UI、数据模型文档。Xcode 工程保持现有文件夹同步成员机制，项目文件无变更；存储 schema、既有 Rust 域和其他任务工作树保持。

### 左侧首页导航布局补充（2026-10-04）

所有者截图圈选左侧栏，要求优化首页布局；本次限于原生侧栏呈现，沿用现有导航意图、设置保存链和单一 WebView，不新增业务或持久化入口。以下矩阵在布局实现前记录。本次为可逆的视觉调整，不新增断言布局细节的单元测试；沿用真实窗口／页面生命周期回归，并用公开 `ImageRenderer` 渲染 SwiftUI 侧栏内容进行目验。

| ID | 前置状态／动作与顺序 | 预期可观察结果 | 不变量、责任方与入口 | 验证与缺口 |
| --- | --- | --- | --- | --- |
| N01 | 首页窗口首次显示／纵向扩展 | 首页导航靠上且占侧栏可用宽度，设置入口靠底；首页不显示项目大纲空状态 | `NativeNavigationView` 拥有侧栏布局；窗口大小变化不把导航整体居中 | 通过：280×860 侧栏内容浅／深色预览确认顶部首页、底部设置与整行选中。既有真实窗口生命周期回归通过；窗口缩放／系统玻璃最终合成未目验。公开 AX children 查询为空，未建立 AX frame 结论 |
| N02 | 首页→打开项目→设置→关闭设置→设置→首页 | 首页／设置选中态跟随实际 route；仅编辑页显示项目大纲与设定／素材入口 | 原生侧栏只读 `NativeApplicationState` 投影；编辑文档与 WebView 身份不随导航替换 | 通过：一次性临时根生产页驱动首页→打开项目→设置，三路由浅／深色内容预览确认选中与项目区可见性；既有生产持久化与面板切换 WK 身份回归通过。设置关闭／返回首页完整原生点击链未新增实测，沿用既有 F04／F06 覆盖 |
| N03 | 加载／意图在途，或设置保存失败 | 禁用导航；失败仍保留实际页面和对应选中态，不提前切换 | `NativeApplicationState.request` 拥有保存顺序；侧栏不增加本地导航状态 | 加载禁用／route 投影实现复核；保存失败沿既有 F04／F06 证据，未新增故障机制或实测 AX 断言 |

此布局不新增后台任务、写入边界或重试机制，因此沿用既有并发／恢复覆盖；完整 VoiceOver、键盘焦点、外观材质和触控板仍需实机验收。

本次完成验证：`npm run check:size && npm run build:native-canvas && xcodebuild -project native/macos/PlotWeaveNative.xcodeproj -scheme PlotWeaveNative -destination 'platform=macOS' -derivedDataPath native/macos/build/DerivedData test` 全通过（676 个维护文件，389 个画布模块，118 tests／34 suites）；日志 `/private/tmp/pw-sidebar-native-green.log`。`codesign --verify --deep --strict` 与 `git diff --check` 通过。新侧栏位于 `native/macos/App/NativeNavigationView.swift`，设计同步至 UI §12.1，相关章节锚点已修正；文档未配置自动语义检查，完成结构化复核。

旧实例 PID 52810 经正常 Quit 保存后退出；更新版本重新启动，PID 73265。一次性 AX／渲染夹具源码已移除，保留六张侧栏内容预览在 `/private/tmp/pw-sidebar-content-{home,editor,settings}-{light,dark}.png`；这组图片不包含系统玻璃或标题栏最终合成。清理 DerivedData 测试／编译缓存与生成的 WebCanvas，仅保留明确授权运行的 app bundle。未修改前端、Rust、工程配置、依赖或存储合同，本次未重复其未受影响的完整路由；没有提交／推送／PR 操作。

### 右侧检查器的页面归属补充（2026-10-04）

所有者截图确认首页仍显示无节点检查器。本次仅收紧原生检查器及工具栏入口的页面归属，保留编辑展开偏好和单一 WebView；属于可逆的界面修正，沿用现有真实窗口回归，不新增布局细节测试。以下矩阵在生产修改前记录。

| ID | 前置状态／动作与顺序 | 预期可观察结果 | 不变量、责任方与入口 | 验证与缺口 |
| --- | --- | --- | --- | --- |
| N04 | 启动加载→首页／首页打开设置 | 无右检查器或检查器工具栏入口；片库使用余下内容宽度 | Shell 按实际 route 和项目身份控制显示，不以残留 editor 投影或默认展开偏好决定首页布局 | 通过：编辑路由＋项目身份共同判定；非编辑页使用 `.constant(false)`；检查器按钮采用同一页面条件。完整原生检查通过；实际首页窗口目验留待用户确认 |
| N05 | 编辑中展开／收起检查器→设置／首页→回编辑 | 离开编辑时隐藏，返回时保留用户展开偏好；选节点／AI 仍可在编辑页展开 | 实际呈现与 `ShellLayoutState.inspectorVisible` 偏好分离；非编辑页自动收起的回写不覆盖偏好 | 通过：`ShellLayoutStateTests` 翻转偏好、`ShellWebCanvasLifecycleTests` 实际面板收展＋同一 WK 页面存活；非编辑绑定不写偏好。内存画布夹具明确允许检查器；完整生产页点击往返未新增实测 |

不新增导航命令、保存顺序、持久化或异步状态；设置保存失败继续保持实际设置路由。原生实际点击与 VoiceOver 仍为目验边界。

验证命令为仓库根的 `npm run check:size && npm run build:native-canvas && xcodebuild -project native/macos/PlotWeaveNative.xcodeproj -scheme PlotWeaveNative -destination 'platform=macOS' -derivedDataPath native/macos/build/DerivedData test`，676 文件大小检查、389 模块打包与 118 tests／34 suites 全通过；日志 `/private/tmp/pw-home-inspector-native-green.log`。`codesign --verify --deep --strict` 和 `git diff --check` 通过。改动位于 `NativeShellRoot.swift`、`NativeEditorToolbar.swift` 及 `ShellLayoutState.swift` 的偏好文档；UI §12.1 已同步，文档无配置的自动语义检查，完成结构化复核。没有修改前端／Rust／依赖／工程配置，未重复未受影响的路由；未提交或推送。

旧实例 PID 73265 正常 Quit 完成保存后退出，修复版已启动为 PID 67575。清理本次编译／测试输出与生成的 WebCanvas，保留已授权运行的 app bundle；自动检查不代替最终窗口材质、实际点击及 VoiceOver 目验。

### 原生设置布局与风格补充（2026-10-04）

所有者截图指出设置区域与 macOS 27 设计不符。本次保留同窗设置路由和所有绑定／保存合同，仅改用系统 grouped Form、Section 和 LabeledContent；默认模型前置，内容居中并限制宽度，模型编辑器保持短高度。依据 [Apple grouped form](https://developer.apple.com/documentation/swiftui/groupedformstyle) 和 [Liquid Glass 采用指南](https://developer.apple.com/documentation/technologyoverviews/adopting-liquid-glass)，系统负责分组、行距与导航材质；760 点内容上限为本项目布局选择，不是 Apple 固定规格。部署仍为 macOS 26，不强行采用仅 27 可用的文本样式。属于可逆视觉改动，不新增布局细节测试。以下矩阵在生产修改前记录。

| ID | 前置状态／动作与顺序 | 预期可观察结果 | 不变量、责任方与入口 | 验证与缺口 |
| --- | --- | --- | --- | --- |
| N06 | 宽／窄窗口显示已就绪设置；滚动查看多个服务 | 默认模型优先；服务分组、字段对齐；内容不随宽窗口无限拉长，模型编辑器内部滚动且多行内容左对齐 | 单一 grouped Form 拥有滚动和分组；最大宽度只约束呈现，控件沿用系统样式与语义颜色 | 通过：CUA 实际浅色宽窗口截图确认居中限宽、默认模型优先、系统分组、字段对齐及修正后的模型内容左对齐；原生 AX 列出完整字段。结构复核与完整原生编译／回归另行通过。窄窗口、深色、长列表双层滚动及键盘／VoiceOver 仍未交互验证 |
| N07 | 编辑地址／模型多行／默认模型；启用开关或 provider 投影更新 | 即时进入既有 debounced 保存；保留未完成模型换行与不可用默认选择 | `NativeProviderDraft`＋当前 React 设置 owner 拥有值；ForEach 按 provider.id，普通补丁无密钥 | 通过：`NativeFormsTests` 4 项、F08 所在的完整原生回归及稳定 provider 身份／既有绑定复核。不重建独立可写配置或改变提交策略；新布局中的配置编辑／保存点击链与输入法未实测 |
| N08 | 未配置／已有 key 输入→保存／清除；加载／读取失败／关闭中 | SecureField 不回显；提交前消费明文草稿；禁写和保存失败留页仍有效 | 原生表单只临时持有 key；ready／closing／busy 门禁和现有关闭保存链保持 | 通过：既有草稿消费、readiness、配置持久化及关闭失败回归；加载／失败分支与既有门禁保持。未通过新布局实际提交／清除 key，未访问真实凭据或调用模型；表单滚出屏幕触发 onDisappear 对未提交密钥的影响尚未实测 |

不新增依赖、服务、磁盘 schema 或网络行为；截图中入口的冗余工具栏按钮只在设置路由隐藏，编辑工具和保存命令保持。

最终验证在当前任务工作树根运行：`npm run check:size && npm run build:native-canvas && xcodebuild -project native/macos/PlotWeaveNative.xcodeproj -scheme PlotWeaveNative -destination 'platform=macOS' -derivedDataPath native/macos/build/DerivedData test`，676 个维护文件、389 个画布模块、118 tests／34 suites 全通过；日志 `/private/tmp/pw-settings-native-green.log`。此前聚焦 `NativeFormsTests` 的 4 项回归通过，日志 `/private/tmp/pw-settings-form-focused.log`。`codesign --verify --deep --strict` 与 `git diff --check` 通过。设计同步至 UI §12.1，文档无配置的自动语义检查，已进行结构化复核。

改动限定于 `NativeSettingsView.swift`、`NativeEditorToolbar.swift` 和上述两份设计／验证文档；没有新增布局细节测试或修改前端、Rust、依赖、工程配置与服务合同，未重复未受影响的前端／Rust 路由。原生实际打开设置、浅色宽窗口最终合成和模型左对齐已目验；运行系统仍是 macOS 26.6.2，使用 Xcode／SDK 27.0，不能据此声称 macOS 27 运行时最终视觉已验收。

原 PID 67575 正常 Quit 后退出；最终修正构建再次通过全部原生检查并启动为 PID 5737，当前窗口停留在设置页。通过 CUA 正常 ⌘Q 重启中间版本，未编辑用户配置。已清理本次 DerivedData 测试／编译缓存与生成的 WebCanvas，仅保留明确授权运行的 app bundle；没有提交、推送或 PR 操作。

### 图 2 设置卡片布局补充（2026-10-04）

所有者提供参考图 2，要求优化现有密钥及模型区域。本次仅调整原生设置呈现：服务标题置于卡片内，启用／地址保留紧凑列表行；密钥标签、整行输入与按钮、配置状态纵向排列；模型以全宽列表行展示，折叠的“编辑模型列表”复用既有多行编辑和逐次提交。勾选只投影实际的对话／图像默认模型，不增加模型行点击选择或认证成功语义。保留系统 Form 的滚动、语义背景、默认 Picker 和原保存链；不新增依赖或磁盘合同。属于可逆视觉改动，沿用既有行为测试，不新增布局细节测试。以下矩阵在生产修改前记录。

| ID | 前置状态／动作与顺序 | 预期可观察结果 | 不变量、责任方与入口 | 验证与缺口 |
| --- | --- | --- | --- | --- |
| N09 | 设置就绪；一个服务未配置／已配置密钥；窗口宽度变化 | 服务卡片内显示启用／地址列表；密钥标签在上、输入与保存／清除同排、状态在下，输入提示位于框内，不局限右半列 | `NativeProviderSettingsForm` 拥有布局；密钥仍由既有 SecureField 草稿和消费链提交；ready／busy／closing 禁写条件不变 | 通过：最终构建的浅色宽窗口 CUA 截图及 AX 确认服务标题在卡片内、白色启用／地址行、全宽 SecureField 的框内提示与右侧保存按钮、下方未配置状态；完整原生路由通过。配置过密钥的清除按钮、窄窗口与深色仅结构复核，真实密钥提交未目验 |
| N10 | 模型清单为空、多个或重复 ID；展开／折叠编辑，模型投影返回 | 全宽逐行展示且空清单有提示；编辑入口复用原多行草稿及即时规范化补丁，折叠不提交第二份配置 | provider.id 保持外层身份；只读模型行用位置身份容纳重复值，折叠状态仅决定呈现；普通补丁继续不带密钥 | 通过：最终构建 CUA 确认两个模型的整行列表、空清单提示，编辑入口从 off→on→off；展开后左对齐多行输入、完整说明可见，未修改配置。既有草稿／设置保存回归及结构复核通过；重复值、长清单、输入法和编辑后的持久化未在新布局交互实测 |
| N11 | 默认为 nil、属于其他服务、同一行对话／图像默认或已不可用；切换顶部 Picker | 只匹配完整 providerId:modelId 的行显示带用途的勾选；不可用选择保留并标明，不改变实际默认 | React 设置 owner 仍拥有默认选择；行只展示，不点击改默认，不推断模型能力或认证结果 | 通过：精确 wire 比较及只读行复核，完整原生回归通过；实际 nil 默认时没有勾选。其他服务、两个用途、不可用状态及切换 Picker 后标记仅结构复核，未为目验修改用户默认值 |

本次不新增后台任务、重试或并发入口；模型编辑和关闭失败继续沿既有 F08／N07／N08 证据。勾选依据当前设置投影，不表示磁盘保存已确认。上述视觉验证使用 macOS 26.6.2 的浅色宽窗口；键盘／VoiceOver、窄窗口、深色、长列表及 macOS 27 运行时未交互验证。

最终代码在当前任务工作树根运行 `npm run check:size && npm run build:native-canvas && xcodebuild -project native/macos/PlotWeaveNative.xcodeproj -scheme PlotWeaveNative -destination 'platform=macOS' -derivedDataPath native/macos/build/DerivedData test`，退出码 0：676 个维护文件尺寸检查、389 个画布模块构建以及 118 tests／34 suites 全通过；日志 `/private/tmp/pw-settings-card-native-green.log`。此前聚焦的 `NativeFormsTests` 4 项通过，日志 `/private/tmp/pw-settings-card-focused.log`。`codesign --verify --deep --strict` 与 `git diff --check` 通过。日志包含已有的 CoreDevice／CoreSimulator 和系统 WebKit 服务诊断，没有阻止本次 macOS 目标构建及测试。

本次生产修改仅 `native/macos/App/NativeSettingsView.swift`（375 行，各新增呈现单元低于 80 行），同步 `docs/ui-design.md` §12.1 与本节。没有新增测试、依赖、服务、前端／Rust 改动或工程配置，未重复未受影响的前端／Rust 路由。文档没有配置的自动语义检查，已按截图、实际实现、矩阵结果与边界进行结构化复核。

通过 CUA 正常 ⌘Q 退出中间版本后，最终构建启动为 PID 2007，当前停留在设置页；只查看和展开／收起编辑区，没有修改用户配置、读取真实密钥或调用模型。清理本次 DerivedData 测试／编译缓存及生成的 WebCanvas，仅保留明确授权运行的 app bundle。未提交、推送或创建 PR。


### 统一服务说明（2026-10-04）

所有者要求 HTTPS／本机回环地址说明仅在设置内容最底部显示一次。本次属于可逆视觉调整：从每张服务卡片移出同一说明，在 ready Form 的服务清单之后使用统一系统页脚；沿用原语句与网络限制，不改服务、模型、密钥或保存行为，不新增布局文本测试。以下矩阵在生产修改前记录。

| ID | 前置状态／动作与顺序 | 预期可观察结果 | 不变量、责任方与入口 | 验证与缺口 |
| --- | --- | --- | --- | --- |
| N12 | 设置 ready；服务清单为零／多个；展开模型编辑后滚动到底部 | 每张服务卡片不再重复说明，清单之后只有一条统一说明；展开内容仍在说明之前 | `NativeSettingsView` 拥有唯一页脚；provider.id 与原草稿／禁写／提交生命周期保持；加载与失败页不显示 ready 表单 | 通过：最终构建 CUA 的 AX 在两张服务卡片之后仅列出一条说明；滚动到底部，截图确认说明位于末张卡片下方，没有空卡片或重复说明。完整原生路由通过；零服务、加载／失败及展开后的排序只做结构复核，未为目验修改用户配置 |

本次不新增状态、并发、恢复或网络入口；失败恢复及编辑保存沿既有 F08／N07／N08 证据。只读复核确认外层 provider.id、草稿和全部绑定不变，统一页脚属于 ready Form、在服务 ForEach 之后。

在当前任务工作树根执行 `npm run check:size && npm run build:native-canvas && xcodebuild -project native/macos/PlotWeaveNative.xcodeproj -scheme PlotWeaveNative -destination 'platform=macOS' -derivedDataPath native/macos/build/DerivedData test`，退出码 0：676 个维护文件、389 个画布模块、118 tests／34 suites 全通过；日志 `/private/tmp/pw-settings-single-notice-green.log`。`git diff --check` 与 `codesign --verify --deep --strict` 通过。没有新增文本／布局测试，未重复未受影响的前端／Rust 路由；文档无配置的自动语义检查，已按实际代码及窗口作结构化复核。

本次仅修改 `NativeSettingsView.swift`（376 行）、UI §12.1 及本节。正常退出旧 PID 2007 后，最终修正版运行于 PID 32271，窗口停留在设置内容底部；未编辑配置或调用模型。清理本次编译／测试缓存和生成 WebCanvas，保留授权运行的 app bundle；没有提交、推送或 PR。视觉验证使用 macOS 26.6.2 浅色宽窗口，零服务、深色／窄窗口和 macOS 27 运行时未实测。


### 应用设置的唯一入口（2026-10-04）

所有者要求三个设置按钮只保留一个符合 Apple 规范的位置。[Apple 官方说明](https://developer.apple.com/videos/play/wwdc2021/10289/?time=976) 将设置入口放在应用菜单并配备 Command-comma。项目已有 `CommandGroup(replacing: .appSettings)`，本次保留该唯一命令及 `⌘,`，移除首页正文、工具栏与侧栏中的应用设置按钮；保留原同窗设置路由、完成返回和保存失败留页，不改为新的窗口架构。属于可逆的呈现去重，沿用既有行为回归，不新增按钮布局／文本测试。以下矩阵在生产修改前记录。

| ID | 前置状态／动作与顺序 | 预期可观察结果 | 不变量、责任方与入口 | 验证与缺口 |
| --- | --- | --- | --- | --- |
| N13 | 首页／编辑页／设置页；侧栏展开或隐藏 | 窗口无重复应用设置按钮；应用菜单仅一个“设置…”命令，`⌘,` 调用同一入口 | `PlotWeaveNativeApp` 的 `.appSettings` 命令拥有唯一全局入口；项目“设定集”保留独立职责，非应用设置 | 通过：最终首页 CUA AX 与截图确认正文、工具栏、侧栏均无应用设置按钮；展开应用菜单仅一个“设置…”应用命令并点击进入设置。完整原生路由通过；编辑页与侧栏隐藏仅结构复核，未为目验修改项目 |
| N14 | 首页打开设置→完成返回；编辑中打开设置→完成；加载／busy／隔离演示时菜单 | 原设置页可达、关闭仍等待保存；菜单禁写门禁不变，失败保持设置页 | 原 `application.send("app.settings")`、settings.close 与单一 WebView／React owner 拥有导航和保存；移除按钮不增加命令或状态 | 通过：菜单→设置→完成→首页，以及 ⌘,→同一设置页→完成→首页实际 CUA 往返；菜单原有 loading／busy／hosted-test 门禁与 F04／F06 保存链复核，完整原生回归通过。失败、编辑页、忙碌及隔离演示不新增故障交互验证 |

不新增持久化、并发、重试或恢复路径；失败恢复沿 F04／F06／N07／N08。早前 N01–N03 中底部设置按钮是历史布局证据，当前入口以本节为准。保留原同窗设置，不以此次菜单位置对齐声明整个 Settings 窗口模式或 macOS 27 视觉已验收。

最终在当前任务工作树根执行 `npm run check:size && npm run build:native-canvas && xcodebuild -project native/macos/PlotWeaveNative.xcodeproj -scheme PlotWeaveNative -destination 'platform=macOS' -derivedDataPath native/macos/build/DerivedData test`，退出码 0：676 个维护文件尺寸检查、389 个画布模块及 118 tests／34 suites 全通过；日志 `/private/tmp/pw-settings-single-entry-final.log`。`codesign --verify --deep --strict` 与 `git diff --check` 通过。

首轮同一完整路由退出 65，唯一失败为 `NativeProductionLifecycleTests.nativeProjectEditFlushAndReloadUsesActualIndependentStorage` 的 `PW_CANVAS_NOT_READY`，日志 `/private/tmp/pw-settings-single-entry-green.log`；单项 `xcodebuild` 加 `-only-testing:PlotWeaveNativeTests/NativeProductionLifecycleTests` 复跑 1 test／1 suite 通过，日志 `/private/tmp/pw-settings-single-entry-lifecycle.log`，随后未再改代码，完整路由复跑通过。只读分析发现该既有测试只等待首页投影／项目 list 加载，宿主 ready 握手仍可能在下一帧，不能用这个谓词证明意图可发送；日志未提供失败请求栈，因此这里只记录最符合的先后窗口，未声明确定根因或已修复。测试与生产握手代码本次均未改动，保留该测试可靠性债务，不放宽 ready 守卫或增加副作用重试。

本次源码修改仅 `NativeHomeView.swift`（215 行）、`NativeEditorToolbar.swift`（56 行）与 `NativeNavigationView.swift`（120 行），同步 UI §12.1 与本节，各修改单元低于 80 行。没有新增布局测试、依赖、前端／Rust／配置／服务合同改动，未重复未受影响的前端／Rust 路由。文档无配置的自动语义检查，已结构化复核。

正常退出旧 PID 32271 后，最终版本运行于 PID 84719，窗口留在首页；菜单点击及快捷键只打开／关闭设置，未修改用户配置、项目或真实凭据。清理本次编译／测试缓存及生成的 WebCanvas，仅保留授权运行的 app bundle。未提交、推送或创建 PR；深色／窄窗口、VoiceOver、启动／忙碌菜单状态和 macOS 27 运行时尚未交互实测。


### 首页移除无用左侧栏（2026-10-04）

所有者要求首页不再显示仅有品牌和首页项的左侧栏。本次将左侧栏与系统侧栏按钮限定于已打开项目的编辑页；加载、首页和应用设置页使用释放的宽度。保留编辑页展开偏好和单一 NavigationSplitView／WKWebView，隔离演示继续支持面板生命周期回归。应用菜单的“设置…”与 `⌘,` 不变。属于可逆的呈现调整，沿用既有业务／生命周期回归和实际窗口验证，不新增布局或实现镜像测试。以下风险矩阵在生产修改前记录。

| ID | 前置状态／动作与顺序 | 预期可观察结果 | 不变量、责任方与入口 | 验证与缺口 |
| --- | --- | --- | --- | --- |
| N15 | 加载→首页；首页→设置→完成／保存失败 | 首页和设置无左右项目面板及左侧栏按钮；片库获得完整主区宽度，设置菜单仍可达，保存失败保持设置页 | NativeShellRoot 根据已验证路由决定面板可用性；菜单及保存链沿用单一 application，无独立导航状态 | 通过：最终首页 AX／截图均无左侧栏、侧栏按钮及右侧检查器；⌘,→设置→完成→首页实际往返且全程无左栏；完整原生路由通过。失败恢复沿 F04／F06，未新增故障注入 |
| N16 | 首页→打开项目；编辑时收起左栏→首页→再次打开项目；展开左栏→首页→再次打开项目 | 项目大纲与工具仍可达；返回首页隐藏左栏，再进入编辑恢复用户展开／收起偏好 | ShellLayoutState 拥有编辑显示偏好，非编辑的自动隐藏不写偏好；单一 WKWebView／React 文档 owner 在面板和路由往返中保持存活 | 通过：ShellWebCanvasLifecycleTests 与 NativeProductionLifecycleTests；实际打开既有项目、收起左栏→首页→重新打开仍收起，展开左栏→首页→重新打开恢复大纲；项目→设置→完成恢复展开状态。未编辑项目内容。忙碌／失败门禁结构复核，极窄窗口和辅助技术未实测 |

不新增持久化、并发、重试、恢复或业务入口。页面失效、无项目及非编辑投影继续隐藏项目面板；操作失败或意图在途而实际路由未离开编辑页时，仍保留项目上下文；现有 busy 门禁不变。早前 N01–N03 的首页侧栏为历史布局证据，当前行为以本节为准。

最终在当前任务工作树根执行 `npm run check:size && npm run build:native-canvas && xcodebuild -project native/macos/PlotWeaveNative.xcodeproj -scheme PlotWeaveNative -destination 'platform=macOS' -derivedDataPath native/macos/build/DerivedData test`，退出码 0：676 个维护文件尺寸检查、389 个画布模块和 118 tests／34 suites 全通过；日志 `/private/tmp/pw-home-no-sidebar-final-scoped.log`。`codesign --verify --deep --strict` 与 `git diff --check` 通过。

首轮完整路由退出 65，唯一失败是既有 `ShellWebCanvasLifecycleTests.panelTogglesKeepWebViewAndPageAlive` 在面板切换前断言初始 `hostColorScheme == light`，日志 `/private/tmp/pw-home-no-sidebar-check.log`；该测试等待节点数，未等待宿主外观同步完成，因此节点就绪不能证明外观已到达。本次未修改外观、握手或测试代码，不宣称修复该可靠性债务。原路由追加 `-only-testing:PlotWeaveNativeTests/ShellWebCanvasLifecycleTests` 单项复查 2 tests／1 suite 通过（`/private/tmp/pw-home-no-sidebar-lifecycle.log`），未改代码的完整复跑也通过（`/private/tmp/pw-home-no-sidebar-final.log`）。实际窗口随后发现侧栏按钮仍存在，将同一公开 `.toolbar(removing:)` modifier 移到侧栏内容作用域，最终完整路由及 CUA 再次通过，无须替换导航容器或创建新的 WebView。

此次源码仅改 `NativeShellRoot.swift`（73 行）与 `ShellLayoutState.swift`（23 行），同步 UI §12.1 和本节 N15–N16；修改单元低于 80 行。没有新增依赖、合同、配置或前端／Rust 改动，未重复未受影响的前端／Rust 路由；文档无配置的自动语义检查，已按实际代码和窗口作结构化复核。

正常退出旧版后，最终新版运行于 PID 69135，留在无侧栏的首页。CUA 仅打开／关闭设置和既有项目并切换面板，没有编辑项目、配置或凭据。清理本次测试／编译缓存与生成 WebCanvas，仅保留授权运行的 app bundle；未提交、推送或创建 PR。实际视觉范围为 macOS 26.6.2 浅色宽窗口，深色、极窄窗口、VoiceOver、忙碌／失败页面交互及 macOS 27 运行时仍未实测。


### 编辑侧栏专注故事大纲（2026-10-04）

所有者指出编辑页侧栏顶部的品牌／首页和底部的设定集／素材库重复工具栏入口。本次仅删除这些重复区域及其不再使用的私有行视图，保留项目名称、故事大纲和隔离演示说明；首页返回、设定集和素材库继续由原生工具栏触发。属于可逆的呈现去重，沿用既有业务／生命周期回归并验证实际入口，不新增布局或实现镜像测试。以下风险矩阵在生产修改前记录。

| ID | 前置状态／动作与顺序 | 预期可观察结果 | 不变量、责任方与入口 | 验证与缺口 |
| --- | --- | --- | --- | --- |
| N17 | 打开项目／切换项目；展开或收起编辑侧栏 | 侧栏无品牌、首页、设定集或素材库重复区域；项目名称与大纲直接位于顶部，列表获得更多纵向空间 | NativeOutlineView 保留实际项目 identity、只读投影、busy 门禁和单一 React 编辑 owner；NativeShellRoot 的面板偏好与 WebView 生命周期不变 | 通过：大纲与真实 WebView 聚焦回归 4 tests／2 suites；最终编辑页 AX／截图确认重复区域已移除、项目标题与大纲从顶部开始且底部空间归列表；实际收起→首页→重开保留收起偏好，再展开。拖拽／重命名及切换另一用户项目未为呈现去重重复交互，身份／动作沿既有回归 |
| N18 | 编辑页使用工具栏“首页”“设定集”“素材库”；侧栏展开或收起 | 工具栏保留对应入口，设定集／素材库打开原 sheet，关闭仍回到当前项目；首页返回完整宽度片库 | NativeEditorToolbar 和原 application／sheet 状态拥有这些动作，删除侧栏不增加命令、导航状态或数据 writer；busy 禁用与失败链不变 | 通过：展开状态和最终收起状态下，工具栏设定集／素材库打开原 sheet→完成返回；首页返回全宽片库，重开仍可展开大纲。完整原生回归通过；忙碌／失败仅结构复核，相关业务合同沿既有隔离测试 |

不新增持久化、并发、重试或恢复路径；保留 N15–N16 的项目面板可用性与编辑显示偏好。早前侧栏品牌／首页／项目工具是历史布局证据，当前编辑侧栏以本节为准。

必要的完整原生路由复现既有生产生命周期测试的 `PW_CANVAS_NOT_READY`；该夹具仅等待首页投影／list 完成，未证明真实宿主已消费 ready 握手。本次在测试修改前扩展 N19 矩阵，随后按诊断收敛到下面的夹具修正；生产就绪、外观同步和业务行为均未改动。

| ID | 前置状态／动作与顺序 | 预期可观察结果 | 不变量、责任方与入口 | 验证与缺口 |
| --- | --- | --- | --- | --- |
| N19 | 生产夹具首次及重开挂载；首页投影到达但宿主尚未 ready；测试普通窗口被前台应用遮挡→临时窗口保持可见→真实握手完成→业务动作 | 就绪前只继续有界无业务探测；真正通过 ready 守卫后才打开／编辑／保存／重开；其他错误或 12 秒超时失败且输出非敏感窗口诊断 | 测试自有窗口的 `.floating`／一次置前和布局提供呈现前提；真实 WKWebView.navigationDelegate 的现有 coordinator 接受 protocolVersion=0 同会话探针，Web 版本校验在 handler／缓存／业务执行前返回 PW_INVALID_NATIVE_INTENT；不新增生产 API、不伪造握手、不重试业务动作，defer 仅清理本夹具窗口／临时数据 | RED：原完整与单项守卫拒绝；真实探针进一步复现 12 秒超时，诊断证实尺寸／当前屏幕与桌面正常，但窗口被遮挡。GREEN：仅临时集成窗口保持可见后，真实生产保存／关闭／重开 1 test／1 suite 通过，完整原生路由 118 tests／34 suites 通过。宿主失效／版本拒绝沿既有桥测试；未直接测量 WebKit rAF 暂停，也未新增故障注入 |

最终测试只在 `PW_CANVAS_NOT_READY` 时按既有 12 秒／30 毫秒继续等待；探针精确验证 `src/platform/nativeShell.ts` 的 `receiveIntent` 版本拒绝诊断。首次和重开都等待同一真实守卫，app.open/create/patch/quit/export 各业务调用不加重试。临时 `.floating` level、`layoutSubtreeIfNeeded()` 与 `orderFrontRegardless()` 仅在私有测试 Fixture.mount 中生效，结束关闭自有窗口；无 NSApp 激活／策略修改，生产窗口 level 不变。窗口遮挡诊断及修正后的真实握手通过支持测试呈现前提不足这一归因，与依赖可见帧的 ready 机制一致，但不声明已直接测得 rAF 暂停或生产握手缺陷。

失败及诊断证据：原完整 `/private/tmp/pw-editor-sidebar-outline-final.log`、原单项 `/private/tmp/pw-editor-sidebar-outline-production.log`、真实等待首次超时 `/private/tmp/pw-editor-sidebar-outline-production-green.log`；布局／普通置前及激活请求未解决遮挡（`/private/tmp/pw-editor-sidebar-outline-production-visible.log`、`/private/tmp/pw-editor-sidebar-outline-production-active.log`、`/private/tmp/pw-editor-sidebar-outline-production-ready.log`、`/private/tmp/pw-editor-sidebar-outline-production-front.log`）。宿主 regular、running、canBecomeKey 及当前桌面／屏幕诊断分别在 `/private/tmp/pw-editor-sidebar-outline-production-policy.log`、`/private/tmp/pw-editor-sidebar-outline-production-space.log`；这些无效激活试验均已撤回。一次兼容 API 试验因使用 Objective-C 名称而编译失败（`/private/tmp/pw-editor-sidebar-outline-production-handshake.log`），随后使用编译器指定 Swift 名称复查，最终仍撤回。先前单独记录的初始外观同步断言时序债务不由 N19 修复。

在授权工作树根先运行 `npm run check:size && npm run build:native-canvas && xcodebuild -project native/macos/PlotWeaveNative.xcodeproj -scheme PlotWeaveNative -destination 'platform=macOS' -derivedDataPath native/macos/build/DerivedData -only-testing:PlotWeaveNativeTests/NativeOutlineTests -only-testing:PlotWeaveNativeTests/ShellWebCanvasLifecycleTests test`，退出码 0，4 tests／2 suites（`/private/tmp/pw-editor-sidebar-outline-focused.log`）。夹具修正后以同一 xcodebuild 命令仅选择 `-only-testing:PlotWeaveNativeTests/NativeProductionLifecycleTests`，退出码 0，实际 1 test／1 suite、1.363 秒（`/private/tmp/pw-editor-sidebar-outline-production-visible-frame.log`）。最终执行完整规定路由 `npm run check:size && npm run build:native-canvas && xcodebuild -project native/macos/PlotWeaveNative.xcodeproj -scheme PlotWeaveNative -destination 'platform=macOS' -derivedDataPath native/macos/build/DerivedData test`，退出码 0：676 个维护文件、389 个画布模块及 118 tests／34 suites 全通过；日志 `/private/tmp/pw-editor-sidebar-outline-complete.log`。`git diff --check` 与 `codesign --verify --deep --strict` 通过。

本次修改 `NativeNavigationView.swift`（50 行）及必要的真实握手测试夹具 `NativeProductionLifecycleTests.swift`（148 行），同步 UI §12.1 与本节；各修改执行单元低于 80 行。没有新增依赖、生产 API、业务合同、前端／Rust／配置或布局文本测试；未重复未受影响的前端／Rust 路由。文档无配置的自动语义检查，已按实际代码、风险矩阵与窗口作结构化复核。

最终新版运行于 PID 11047，留在展开故事大纲的编辑页。CUA 仅打开既有项目、打开／关闭设定集和素材库、首页往返并切换侧栏，没有执行项目内容编辑、配置或凭据输入。清理本次编译／测试缓存及生成 WebCanvas，仅保留授权运行的 app bundle；没有提交、推送或创建 PR。实际视觉范围为 macOS 26.6.2 浅色宽窗口；深色、极窄窗口、VoiceOver、忙碌／失败页面交互及 macOS 27 运行时未实测。


### 排布入口集中到画布（2026-10-04）

所有者要求删除原生右上角的对齐／排布图标，由画布中央的工具条承接其功能。右上菜单共有自动排布与六方向对齐；六方向已经由画布调用同一图动作，本次把既有左下自动排布按钮及图标移入顶部居中工具条，删除原生重复菜单。生产编辑器共用的画布组件同时更新 Swift／Tauri／浏览器呈现；不改隔离 `#fixture` 演示，也不删除旧 native intent handler，保留其兼容合同。不新增排布算法、命令、持久化或异步业务重试。以下矩阵在生产修改前记录。

| ID | 前置状态／动作与顺序 | 预期可观察结果 | 不变量、责任方与入口 | 验证与缺口 |
| --- | --- | --- | --- | --- |
| N20 | 打开生产编辑页；原生右上菜单移除→使用顶部居中画布排布组 | 不再有右上排布菜单；居中组提供自动排布及原六方向对齐，左下不再重复自动排布 | CanvasAlignmentControls 只调用现有 graph.layout／graph.alignment；NativeEditorToolbar 只删呈现，原生兼容 handler 与单一文档 owner 保留，非编辑路由无新入口 | 通过：既有真实 EditorView 自动排布入口及位置／撤销测试先因缺少新语义组 RED，接线后 GREEN；最终 CUA AX／截图确认右上仅剩其他项目动作，中央“画布排布”含自动排布与六方向，左下无重复自动排布。未在用户项目实际点击排布，行为由真实 React 集成回归验证 |
| N21 | 空画布；非空画布但选择零／一个节点；选择至少两个节点；尺寸未完成 | 空图自动排布禁用；非空图不依赖选择，自动排布可用；六方向只在至少两个选中时可用；尺寸缺失保留原位置并反馈 | 两种动作禁用前提独立，由 doc.nodes 与 selectedCount 提供；useAutoLayout／useCanvasAlignment 在动作边界复核尺寸，不作部分提交 | 通过：真实装配验证非空零选择时自动排布可用、对齐禁用；空图自动排布禁用，少选与测量失败沿既有回归。最终实际非空编辑页 AX 显示自动排布可用、六方向因未多选而禁用；空图／多选／失败不再次修改用户项目，依自动回归与结构复核 |
| N22 | 实际整图自动排布／六方向对齐→防抖保存→撤销／重做；重复动作或计算失败 | 正常改位置且可恢复；失败或无位移不增历史、不丢内容；保存与画布落点一致 | React 图动作与历史／保存链拥有位置写入；对齐仅选中节点且只改对应轴，自动排布整图规则／视口适配不变；所有原生／画布入口共享 owner | 通过：六方向真实画布落点、未选节点／内容保留、保存及撤销重做；重复与尺寸失败不增历史；自动排布真实装配／hook／纯函数和 nativeEditorShell 合同均通过。完整前端 3032 tests、原生 118 tests 通过；保存失败、异步导航与退出沿原回归，未新增故障交互或状态 |

本次只迁移按钮调用入口，原有同步图动作、下一帧 fitView 和视口保存顺序保持；不增生命周期、请求或重试状态。UI 去重本身沿现有回归与实际窗口检验，仅修改既有自动排布行为测试以证明新入口仍能操作真实图和共享历史，更新原语义组断言，不新增镜像测试。


验证均在授权 `codex/swiftui-react-flow` 工作树根执行。RED：仅调整 `EditorView.test.tsx` 既有测试后执行 `npm test -- src/editor/EditorView.test.tsx`，退出码 1，2 项按预期因缺少“画布排布”可访问组失败、6 项通过（`/private/tmp/pw-canvas-layout-entry-red.log`）。完成迁移后聚焦 `npm test -- src/editor/EditorView.test.tsx src/editor/EditorCanvasRegion.alignment.test.tsx src/editor/useAutoLayout.test.tsx src/editor/autoLayout.test.ts src/editor/useCanvasAlignment.test.tsx src/editor/canvasAlignment.test.ts src/editor/nativeCanvas/nativeEditorShell.test.tsx`，退出码 0，7 文件／64 项通过（`/private/tmp/pw-canvas-layout-entry-focused.log`）。

完整前端规定路由 `npm run format:check && npm run lint && npm run check:size && npm run typecheck:strict && npm run build && npm test` 退出码 0：格式、lint、676 文件尺寸、严格类型和构建通过，208 文件／3032 项通过（`/private/tmp/pw-canvas-layout-entry-frontend.log`）。只读复核发现本次增长的测试 describe 闭包为 84 行，已把原测试数据常量移到模块级并加意图注释，使闭包缩为 72 行；没有改变测试语义。常量提取后先复查该文件 8 项，再重跑同一完整前端路由，全部通过（`/private/tmp/pw-canvas-layout-entry-frontend-final.log`）。

完整原生规定路由 `npm run check:size && npm run build:native-canvas && xcodebuild -project native/macos/PlotWeaveNative.xcodeproj -scheme PlotWeaveNative -destination 'platform=macOS' -derivedDataPath native/macos/build/DerivedData test` 退出码 0：676 个维护文件、389 个画布模块、118 tests／34 suites 全通过（`/private/tmp/pw-canvas-layout-entry-native.log`）。本次沿用 N19 已修正的临时真实窗口夹具，没有修改它或生产握手。最终 `git diff --check` 和 `codesign --verify --deep --strict` 通过；文档无配置的自动语义检查，已结构化核对 §3.6／§12.1、当前实现、矩阵与保留边界。

本次源码修改为 `NativeEditorToolbar.swift`（50 行）、`CanvasAlignmentControls.tsx`（116 行）、`EditorCanvasRegion.tsx`（163 行）；更新既有 `EditorView.test.tsx`（324 行）与 `EditorCanvasRegion.alignment.test.tsx`（348 行），同步 UI §3.6／§12.1 与本节。各修改执行单位低于 80 行，最长本次生产单位 55 行；私有图标直接移入中央工具条文件，未新增导出、模块循环、依赖、算法、生产命令或数据合同。未改 Rust，未重复 Cargo 路由；未提交、推送或创建 PR，因此未执行该类操作的 Sonar／覆盖率门禁或远端 CI。

旧版经正常退出冲刷后，最终新版运行于 PID 62983，停留在展开大纲的编辑页。CUA 仅打开既有项目并读取 AX／截图，没有点击排布／对齐、编辑项目内容或配置／凭据；真实功能执行使用隔离集成数据。清理本次生成的 dist、WebCanvas 与编译／测试缓存，保留已授权运行的 app bundle。视觉验证范围为 macOS 26.6.2 浅色宽窗口；深色、极窄窗口、VoiceOver、真实键盘／多选手势和 macOS 27 运行时未实测。共享生产编辑器的 Tauri／浏览器语义通过前端回归；未重新启动 Tauri 桌面窗口做视觉对照。


### 侧栏移除重复剧名（2026-10-04）

所有者要求移除故事大纲上方重复显示的当前剧名。此变更只调整 NativeNavigationView 的静态呈现：窗口标题继续显示当前项目名称，侧栏直接从故事大纲开始，保留原顶部间距和 keyed NativeOutlineView。属于可逆的低影响呈现去重，不新增布局文本／实现镜像测试；使用原生完整回归与实际窗口 AX／截图验证。以下矩阵在生产修改前记录。

| ID | 前置状态／动作与顺序 | 预期可观察结果 | 不变量、责任方与入口 | 验证与缺口 |
| --- | --- | --- | --- | --- |
| N23 | 打开项目且侧栏展开；当前项目名称变化或切换项目 | 侧栏仅以故事大纲为标题，窗口顶部仍显示当前剧名；对应项目的大纲正常显示 | NativeNavigationView 只删名称 Text，NativeOutlineView 仍按 projectId 定 identity；窗口标题与单一 React 文档 owner 不变 | 实际新版展开编辑页 AX／深色宽窗口截图已确认侧栏从故事大纲开始，剧名只留在窗口顶部；大纲合同及侧栏／WebView 聚焦回归通过。项目改名不重复编辑用户数据，标题仍由 NativeShellRoot.navigationTitle(application.projectName) 投影；完整原生路由结果见下文 |
| N24 | 收起／展开侧栏；编辑页往返首页或设置；busy／项目身份变化 | 大纲重开后仍无重复剧名；非编辑页继续隐藏侧栏，忙碌及过期操作继续被原门禁拦截 | NativeShellRoot 拥有路由和面板偏好，NativeNavigationView 的 route／projectId／busy 条件及大纲身份防护不变 | 实际收起→展开侧栏、首页→重开项目通过，编辑侧栏无重复剧名、首页隐藏侧栏；原有 route／projectId／busy／identity 门禁经只读复核未变。busy／错误和切换其他用户项目未新增实际交互，依原合同与下述完整路由结果 |

此改动没有增加状态、数据写入、并发、重试或恢复路径；原有大纲行、聚焦、拖放、错误提示和隔离演示警告均保留。六方向对齐仍需至少选中两个节点：先前截图的禁用状态符合该前提，随后实际窗口 AX 已显示六方向按钮可用；多选和原生选择桥接由既有实现／回归支持，本节不改排布逻辑。


验证在授权 `codex/swiftui-react-flow` 工作树根进行。聚焦命令 `npm run check:size && npm run build:native-canvas && xcodebuild -project native/macos/PlotWeaveNative.xcodeproj -scheme PlotWeaveNative -destination 'platform=macOS' -derivedDataPath native/macos/build/DerivedData -only-testing:PlotWeaveNativeTests/NativeOutlineTests -only-testing:PlotWeaveNativeTests/ShellWebCanvasLifecycleTests test` 退出码 0，4 tests／2 suites 通过（`/private/tmp/pw-sidebar-title-focused.log`）。

完整规定路由 `npm run check:size && npm run build:native-canvas && xcodebuild -project native/macos/PlotWeaveNative.xcodeproj -scheme PlotWeaveNative -destination 'platform=macOS' -derivedDataPath native/macos/build/DerivedData test` 首次退出码 65，118 项中只有 `NativeProductionLifecycleTests.nativeProjectEditFlushAndReloadUsesActualIndependentStorage` 未通过；其真实握手诊断报告临时窗口 visible=true、occluded=true，等待 ready 超时（`/private/tmp/pw-sidebar-title-native.log`），与 N19 的已记录呈现边界相同。本次没有修改生产握手或测试夹具；新版实际窗口可见并经检查后，以相同完整命令重跑，退出码 0，118 tests／34 suites 通过（2.960 秒，`/private/tmp/pw-sidebar-title-native-rerun.log`）。复查通过不宣称已修复测试遮挡边界。尺寸检查和 389 模块画布构建通过；最终 `git diff --check`、`codesign --verify --deep --strict` 通过。

本次只修改 `NativeNavigationView.swift`（43 行；修改执行单元均低于 80 行）及 UI §12.1／本节。未增加测试、依赖、状态、合同或其他源文件，未重复未改动的前端／Rust 完整路由。文档无配置的自动语义检查，已结构化核对当前代码、标题投影、矩阵与实际窗口。只读委派复核确认 keyed outline、busy／identity 门禁与窗口标题均保留，无 P1／P2。

最终新版运行于 PID 31835，实际 AX 确认左栏标题只有“故事大纲”，窗口顶部仍为“都市奇缘”。正常退出旧版冲刷既有编辑后，CUA 只打开项目、侧栏收展、首页往返并读取 AX／截图，没有编辑内容、输入配置或点击排布。视觉范围为 macOS 26.6.2 深色宽窗口；浅色／极窄／VoiceOver／macOS 27 运行时未重新实测。清理本次 WebCanvas、编译／测试缓存，仅保留已授权运行的 app bundle；未提交、推送或创建 PR，因此未运行该类 Git 操作的 Sonar／覆盖率门禁。


### 设定条目的明确编辑入口（2026-10-04）

所有者反馈设定集里的条目不可编辑。修复前 CUA 实测点击两个既有角色和一个地点均能打开原生名称／小传／备注输入，因此没有确认编辑命令或文本存储故障；空详情对应未选择条目，列表只呈现文字，编辑入口不明确。当前项目文档桶为空，不为目验创建用户数据。按现有功能修整呈现：角色、地点、文档各行增加显式编辑按钮与铅笔图标，整行命中打开右侧既有表单；行身份与选择标签统一使用现有实体 id。该可逆入口调整不新增布局／实现镜像测试，沿用真实编辑命令回归和 CUA 验证。以下矩阵在生产修改前记录。

| ID | 前置状态／动作与顺序 | 预期可观察结果 | 不变量、责任方与入口 | 验证与缺口 |
| --- | --- | --- | --- | --- |
| N25 | 已打开项目，设定集角色／地点／文档类别有条目；单击名称、行尾编辑图标或激活按钮 | 对应条目右侧展示既有可编辑字段，明确可操作名称；未选择时保留空态 | NativeProjectSettingsView 仅拥有类别与 selectedId；行 identity、tag、点击目标均为同一实体 id，不以名称或数组下标写入文档 | 通过：新版 CUA 单击角色名称打开对应名称／小传，点击另一角色行尾铅笔切换到正确字段；方向键向上切回原角色。地点行打开名称／备注；角色名称输入框可获得焦点并选中文字，未改值。文档桶为空，未创建用户条目，编辑合同依现有隔离回归；VoiceOver 和按钮空格激活未实测 |
| N26 | 已选择条目；切换类别、列表投影更新或条目消失；busy／项目切换 | 类别切换清空旧选择；同 id 投影更新保持当前表单；消失显示空态；忙碌或其他项目仍不可编辑 | 详情持续按当前 bucket 和稳定 id 查找，原表单 keyed kind+id、捕获 projectId、原 busy／identity 门禁及删除确认目标保留；数据 owner 仍为 React | 通过：角色→地点→文档→角色实际往返，每次清空旧选择并显示选择引导；再次选同角色打开原值。NativeFormsTests 的 idle／loaded owner 守卫和完整原生回归通过，稳定 id／表单 identity／busy 门禁经委派只读复核。未操作用户删除、改名或投影重排，相关失效目标合同沿既有回归，原生动态重排／busy 交互仍为验证缺口 |
| N27 | 右侧角色／地点／文档编辑→防抖保存→撤销／重做或重开；提交前目标已删除或保存失败 | 修改进入共享命令、历史和保存链；已删除目标拒绝，错误继续显示，原数据不被新呈现层替换 | NativeEntityForm／NativeTextField 和 editor.entityUpdate 完整保留，原生命令发送明确 projectId+kind+id；不新增文档副本、保存入口或自动重试 | 修整前 `npm test -- src/editor/nativeCanvas/nativeEditorShell.test.tsx src/editor/useSettingsActions.test.tsx src/editor/panels/SettingsList.detail.test.tsx src/editor/panels/LeftPanel.documents.test.tsx` 退出码 0，4 文件／54 项通过（`/private/tmp/pw-settings-edit-existing.log`）；真实用户文本未编辑；同批回归验证原生角色更新／连续字段编辑、共享历史与持久化，以及设定三类更新／失效目标／文档关联。Swift 全量 118 项通过，含实际独立存储保存／关闭／重开；本次未用真实用户数据实测设定字段的磁盘往返 |

此变更没有新增数据合同、持久化或并发状态；保留既有新增、删除确认、关系切换与错误反馈。原先 String tag 对 String? selection 的自动包含机制未被认定为根因；也不声明已复现框架选择故障。角色／地点／文档数据格式与引用规则保持，因此数据模型无需修改。


验证在授权 `codex/swiftui-react-flow` 工作树根执行。先运行上述既有前端行为回归（54 项），确认已存在的编辑、历史与保存链；本次属于可逆的呈现入口修整，没有新增行为状态或复现文本编辑缺陷，因此未制造布局／实现镜像的失败测试。生产修改后聚焦原生命令 `npm run check:size && npm run build:native-canvas && xcodebuild -project native/macos/PlotWeaveNative.xcodeproj -scheme PlotWeaveNative -destination 'platform=macOS' -derivedDataPath native/macos/build/DerivedData -only-testing:PlotWeaveNativeTests/NativeFormsTests -only-testing:PlotWeaveNativeTests/NativeApplicationStateTests -only-testing:PlotWeaveNativeTests/ShellWebCanvasLifecycleTests test` 退出码 0，8 tests／3 suites 通过（`/private/tmp/pw-settings-edit-entry-focused.log`）。

完整规定原生路由 `npm run check:size && npm run build:native-canvas && xcodebuild -project native/macos/PlotWeaveNative.xcodeproj -scheme PlotWeaveNative -destination 'platform=macOS' -derivedDataPath native/macos/build/DerivedData test` 首轮退出码 0：676 个维护文件尺寸检查、389 个画布模块、118 tests／34 suites 全通过（2.771 秒，`/private/tmp/pw-settings-edit-entry-native.log`）。本轮未触发 N19 的既有测试窗口遮挡边界，也没有修改夹具或生产握手；全量通过不代表该边界已解决。`git diff --check` 和 `codesign --verify --deep --strict` 通过。

本次生产源码仅改 `NativeProjectSettingsView.swift`（133 行），同步 UI §12.1 与本节 N25–N27。各修改执行单元低于 80 行；只读委派复核未发现 P1／P2。没有新增依赖、数据合同、保存入口、状态或其他源文件；未改前端／Rust，不重复其完整路由。文档无配置的自动语义检查，已按实际代码、命令合同、矩阵和最终窗口结构化复核。未提交、推送或创建 PR，因此未执行这些 Git 操作的 Sonar／覆盖率门禁。

旧版正常退出冲刷后，新版运行于 PID 90622，留在“林晚”的原生编辑表单，名称字段已获得焦点。CUA 仅选择既有条目、切换类别、方向键切换和选择现有字段文字，没有改写项目内容、配置或凭据。清理本次生成 WebCanvas 和编译／测试缓存，仅保留已授权运行的 app bundle。实际视觉范围为 macOS 26.6.2 深色宽窗口；浅色、极窄窗口、VoiceOver、按钮空格激活、原生实际文档条目和 macOS 27 运行时未实测，原因分别为本次呈现范围与当前项目无文档，保留明确验证缺口。


### AI 编剧控制集中到底部（2026-10-04）

所有者要求移除 AI 编剧面板中的重复“设置”按钮，把模型选择和“了解当前画布”移到最底部。此次为可逆的低影响呈现调整：顶部保留标题与新会话，中间为消息滚动区，底部依次为输入框、模型选择、画布上下文与发送／取消。应用设置沿标准应用菜单与 ⌘, 进入；既有 AI 命令、草稿与会话 owner、模型可用性及请求取消保持。使用既有真实行为回归和实际窗口验证，不新增布局／实现镜像测试。以下矩阵在生产修改前记录。

| ID | 前置状态／动作与顺序 | 预期可观察结果 | 不变量、责任方与入口 | 验证与缺口 |
| --- | --- | --- | --- | --- |
| N28 | 打开项目 AI 面板；消息滚动／面板收展；应用菜单或 ⌘, 打开设置再返回 | 顶部无重复设置或模型；输入框下方显示模型与了解当前画布，发送／取消保持可达；会话内容保留 | NativeAiView 仅重排现有视图；SwiftUI 业务 UI 消费同一 state.ai，React 保持单一会话和编辑 owner；设置沿原 app.settings 路由 | 通过：新版 AX／深色宽窗口截图确认标题行只有标题与新会话，输入框→模型→上下文／发送按底部顺序显示，消息未被控件遮挡；⌘,→设置→完成实际返回同一 AI 面板、原消息／模型／上下文均保留。极窄窗口及 VoiceOver 未实测 |
| N29 | 就绪且空闲；切换模型或画布上下文→后续发送；busy 或未配置 key | 选择使用原命令并显示现值；busy 模型禁用、不可用模型不可选；上下文默认开启，忙碌期间沿原规则可切换 | Picker／Toggle 的只读投影与原 Binding、ai.selectModel／ai.context 参数及捕获 projectId 完整保留，不增本地配置副本 | 通过：既有 nativeAiShell 三项，含模型紧接发送的生效顺序；新版 AX 显示底部原模型选项现值及选中的“了解当前画布”，设置往返后保留。委派复核原 Binding／busy／available 规则未变。没有为目验修改用户模型／上下文或发送付费请求，busy 模型禁用与实际上下文切换视觉保留缺口 |
| N30 | 草稿空白／未就绪；发送→busy→取消；迟到结果；会话加载／保存失败或失效项目 | 空白与未就绪仍禁用发送；busy 显示取消；迟到结果不追加，失效项目拒绝；错误仍可见，新会话须确认 | Draft／ready／busy、去空白守卫、清稿、⌘Return 与确认状态不变；React AI owner 管理请求、历史和持久化，Swift view 不新增请求或重试 | 既有 nativeAiShell 的持久化、旧项目拒绝、clear 确认与取消迟到结果回归通过；完整原生 118 项通过，含实际存储／关闭／重开与应用状态／错误守卫；新版空稿发送禁用且输入区保持可达，委派复核原发送／取消／确认参数未改。未编辑用户草稿、清空会话或调用真实模型，busy“取消请求”的实际视觉未实测 |

现有聚焦回归先在授权工作树根执行 `npm test -- src/editor/nativeCanvas/nativeAiShell.test.tsx`，退出码 0，1 文件／3 项通过，日志 `/private/tmp/pw-ai-footer-existing.log`。不增加状态、持久化、恢复、并发、重试或桥接合同；不需要修改数据模型。既有未配置模型／聊天记录读取失败提示和预览确认执行完整保留。


生产修改后在授权工作树根执行聚焦原生检查 `npm run check:size && npm run build:native-canvas && xcodebuild -project native/macos/PlotWeaveNative.xcodeproj -scheme PlotWeaveNative -destination 'platform=macOS' -derivedDataPath native/macos/build/DerivedData -only-testing:PlotWeaveNativeTests/NativeApplicationStateTests -only-testing:PlotWeaveNativeTests/ShellWebCanvasLifecycleTests test`，退出码 0，4 tests／2 suites 通过（`/private/tmp/pw-ai-footer-focused.log`）。完整规定路由 `npm run check:size && npm run build:native-canvas && xcodebuild -project native/macos/PlotWeaveNative.xcodeproj -scheme PlotWeaveNative -destination 'platform=macOS' -derivedDataPath native/macos/build/DerivedData test` 首轮退出码 0，676 个维护文件、389 个画布模块、118 tests／34 suites 全通过（2.683 秒，`/private/tmp/pw-ai-footer-native.log`）。本次没有修改生命周期夹具或生产握手，也不声明解决 N19 已记录的遮挡边界。最终 `git diff --check` 和 `codesign --verify --deep --strict` 通过。

源码仅改 `NativeAiView.swift`（183 行）；同步 UI §12.1 及本节 N28–N30。各修改执行单元低于 80 行，最长 composer 26 行；委派只读复核绑定、项目身份、模型可用性、上下文默认值、发送／取消与清空确认均保留，无 P1／P2。没有依赖、桥合同、服务、配置、前端或 Rust 改动，未重复未受影响的前端／Rust 完整路由。文档没有配置的自动语义检查，已按当前 SwiftUI 结构、原命令和实际窗口作结构化复核。未提交、推送或创建 PR，因此未运行这些 Git 操作的 Sonar／覆盖率门禁。

旧版正常退出冲刷后，新版运行于 PID 74513，保留既有项目消息，留在带底部控件的 AI 编剧面板。CUA 只打开项目／AI 面板、设置快捷键往返及读取 AX／截图，没有修改草稿、模型、上下文、项目内容、配置或凭据，也未发送模型请求或清空会话。清理本次生成 WebCanvas 和编译／测试缓存，仅保留已授权运行的 app bundle。实际视觉范围为 macOS 26.6.2 深色宽窗口；浅色、极窄、VoiceOver、中文输入法、busy 取消布局及 macOS 27 运行时未实测，不以回归通过替代这些边界。

### AI 消息采用 IM 气泡（2026-10-04）

所有者要求原生 AI 对话采用 IM 呈现，替换现有全宽消息列表卡。此次为可逆的低影响呈现调整：用户消息右对齐蓝色气泡，AI 回复左对齐系统语义背景气泡，去掉可见的重复说话者标题，正文辅助功能仍说明说话者；note 回执居中、次级显示并保留完整可选择文字。长文不截断，消息内容与改动预览独立呈现；底部输入、模型与画布上下文控件沿 N28–N30。复用既有会话／预览行为回归并检查真实窗口，不新增布局／实现镜像测试。以下矩阵在生产修改前记录。

| ID | 前置状态／动作与顺序 | 预期可观察结果 | 不变量、责任方与入口 | 验证与缺口 |
| --- | --- | --- | --- | --- |
| N31 | 用户／AI 短消息、长文或多行消息；收到 note 取消／成功／失败诊断 | 用户靠右、AI 靠左，气泡按内容收缩；长文换行可选择；note 居中且完整，不出现重复“你／AI”标题 | NativeAiEntryView 只读取原 entry.kind／role／text；note 优先于 role，正文原值不改写、不截断；可访问说话者只标注正文，不合并预览按钮 | 新版实际窗口确认“你好”靠右且自然收缩、长 AI 回复靠左完整换行，没有可见角色标题；鼠标三击末行后显示整行选中高亮，AX 保留说话者。note 以结构复核验证；实际会话没有 note，VoiceOver／不同主题与极窄窗口未实测 |
| N32 | 合法条目正文为空且有预览；正文与 pending／dismissed／executed／historical／uncommitted／失败卡组合；busy 或删除确认 | 空正文仍显示预览；dismissed 仅隐藏卡，正文保留；预览执行／忽略／确认与状态颜色不受气泡样式影响 | NativeAiPreview 持续位于 text 条件之外，不按 role 裁掉 card；同一 entryId、projectId、busy 与原 action owner／历史／保存守卫保留，不增执行入口 | 4 文件 64 项既有 AI 回归及 118 项原生测试通过；委派只读复核空正文、dismissed、角色、局部文字颜色和预览按钮／身份／状态边界保留，无 P1／P2。用户实际预览／取消／删除没有为样式目验执行，卡片各状态视觉保留缺口 |
| N33 | 原消息时间序列；面板收展、设置往返、滚动长回复；新消息追加或未就绪／会话读取失败 | 消息顺序与选择复制保持，消息区滚动且底部控件仍可达；当前线程不被布局重置，原错误继续可见 | 原 timeline／scrollTo latest、state.ai、session owner、draft 和错误门禁不变；呈现不增加请求、写入、重试、异步动画或持久化状态 | 实际设置快捷键往返后消息、模型与画布上下文保持，底部发送控件可达；原生生命周期与既有会话回归通过。没有制造新消息或修改真实会话，复制到剪贴板、busy、极窄、辅助技术与新增消息滚动未实测 |

不新增业务状态、存储合同、依赖或 Markdown 转换；消息原文仍由现有 Text 展示。预览支持 user／assistant 两种合法角色，note 的长错误不施加 lineLimit；执行回执与未落盘卡的持久化规则不变。本次不需要修改数据模型。


验证结果（工作目录均为当前 `codex/swiftui-react-flow` worktree）：

- `npm test -- src/editor/nativeCanvas/nativeAiShell.test.tsx src/editor/panels/AiThread.context.test.tsx src/editor/panels/aiThreadModel.test.ts src/ai/session.test.ts`：4 文件、64 项通过，覆盖会话、预览执行／保存、上下文与失败／取消／晚到回复边界。
- `npm run check:size && npm run build:native-canvas && xcodebuild -project native/macos/PlotWeaveNative.xcodeproj -scheme PlotWeaveNative -destination 'platform=macOS' -derivedDataPath native/macos/build/DerivedData -only-testing:PlotWeaveNativeTests/NativeApplicationStateTests -only-testing:PlotWeaveNativeTests/ShellWebCanvasLifecycleTests test`：聚焦 4 项通过。
- `npm run check:size && npm run build:native-canvas && xcodebuild -project native/macos/PlotWeaveNative.xcodeproj -scheme PlotWeaveNative -destination 'platform=macOS' -derivedDataPath native/macos/build/DerivedData test`：676 个维护文件检查、389 模块画布构建及 34 套件／118 项原生测试通过，`TEST SUCCEEDED`；本次未出现 N19 的生命周期超时。
- `git diff --check` 与 `codesign --verify --deep --strict native/macos/build/DerivedData/Build/Products/Debug/PlotWeaveNative.app`：通过。源码 `NativeAiView.swift` 为 203 行；新增 entry body 18 行、bubble 12 行，低于维护上限。同步 UI §12.1 与本节矩阵；文档没有配置的自动语义检查，已按源码、原会话契约及实际窗口结构化复核。

新版原生 app 已运行（PID 43620），保持既有项目／会话。CUA 只进行窗口查看、文本选择和设置往返，没有编辑配置／凭据／草稿／项目或发送模型请求、清空会话；没有改写用户剪贴板。鼠标文字选择已实际确认，CUA `selectText` 对非可编辑静态文字不支持设置选区，因此通过鼠标选择补验，不以该 AX 操作失败认定产品失败。此次仅改变原生呈现，没有前端／Rust 源码、配置、依赖、服务或数据模型改动，未重复这些未受影响路径的完整路由；未提交、推送或创建 PR，因此没有运行 Git 操作专用 Sonar／覆盖率门禁。

清理本次生成 WebCanvas 和编译／测试缓存，仅保留已授权运行的 app bundle。实际视觉范围是 macOS 26.6.2 深色宽窗口；浅色、极窄、VoiceOver、macOS 27 运行时和矩阵所列真实 note／卡片／busy 状态未实测。普通消息仍显示原文，不新增 Markdown 渲染；回归通过不替代这些人工视觉边界。


### 右侧栏拖宽与 AI 气泡对比度（2026-10-04）

所有者要求右侧栏支持横向调整，并增强 AI 回复气泡的辨识度。此次分类为可逆的低影响原生呈现调整：复用系统 inspector 的可变宽度，不新增拖动手势、布局存储、桥命令或可写会话状态；助手正文采用语义浅灰／深灰填充与细边线，描边不参与命中。依据 [Apple Inspector 官方示例](https://developer.apple.com/videos/play/wwdc2023/10161/)及当前 SDK 公开 API，宽度范围设置在稳定的 inspector 根；300／360／640 pt 为本项目最小／首次理想／最大选值，用户尺寸由系统管理。以下矩阵在生产修改前记录。

| ID | 前置状态／动作与顺序 | 预期可观察结果 | 不变量、责任方与入口 | 验证与缺口 |
| --- | --- | --- | --- | --- |
| N34 | 编辑页已显示 AI 或属性检查器；向左／右拖分隔线，触达尺寸边界；收起再展开，切换模式 | 侧栏连续变宽／变窄，正文重新换行，底部控件可达；两模式共享同一原生列，恢复可用宽度 | SwiftUI inspector 拥有宽度和分隔线；NativeInspectorView 填满可用区域，ShellLayoutState 继续只持有显示偏好；不生成会话或数据写入 | 实际 CUA 左右拖动通过：1673 pt 窗口分隔线从 1313 到 1134.5；超界拖动分别停在 1033／1373，即 640／300 pt 栏宽，正文重新换行且底部控件可达。AI／属性切换保持 400 pt；面板收展恢复可用宽度。4 项聚焦生命周期回归通过；跨启动尺寸记忆未验 |
| N35 | AI 长／短回复，用户消息，浅／深外观，增强对比度；选择文字，存在预览卡 | 助手气泡边缘和填充与侧栏清晰区分，文字完整换行；用户消息仍靠右，文字可选择，预览可操作 | NativeAiEntryView 只调整助手正文局部 fill／stroke，描边不截获输入；role／kind／text／card 身份、空正文卡片与错误颜色保持 | 深色实际截图确认助手灰底及边框清楚、正文完整，最小／较宽栏宽均可读；鼠标三击回复末行显示选区，描边未截获选择。4 文件 64 项 AI 回归及委派复核通过。实际卡片／note、浅色、增强对比度和 VoiceOver 未验，原语义规则保持 |
| N36 | 拖宽后打开设置／首页并返回；面板收展、窗体宽度变化；保存或加载失败 | 非编辑页面没有右栏；编辑返回显示偏好与会话保持；画布收到可用几何变化，原错误可见 | NativeShellRoot 保持同一 NavigationSplitView／WebCanvasSection，原 editorPanelsAvailable 与 .constant(false) 不变，不因尺寸创建新 WKWebView 或重试写入 | 新版启动首页没有右栏；设置页没有编辑栏，返回后消息、模型、画布上下文及最终 400 pt 栏宽保持。118 项原生完整测试通过，包含原 WK 身份／页面探针保持回归。960 pt 最小窗口、失败视觉与拖动期间实际 WK 实例没有直接观测，未制造用户数据失败 |

复用原生结构与既有生命周期／AI 行为回归，实际分隔线和气泡通过 CUA 验证；不新增只镜像尺寸常数、修饰符或颜色实现的测试。没有新的业务状态、异步操作、网络、存储或失败／重试入口，不改变 N31–N33 的会话和预览规则。


验证结果（当前 `codex/swiftui-react-flow` worktree）：

- `npm run check:size && npm run build:native-canvas && xcodebuild -project native/macos/PlotWeaveNative.xcodeproj -scheme PlotWeaveNative -destination 'platform=macOS' -derivedDataPath native/macos/build/DerivedData -only-testing:PlotWeaveNativeTests/ShellLayoutStateTests -only-testing:PlotWeaveNativeTests/ShellWebCanvasLifecycleTests test`：聚焦 4 项／2 套件通过。
- `npm test -- src/editor/nativeCanvas/nativeAiShell.test.tsx src/editor/panels/AiThread.context.test.tsx src/editor/panels/aiThreadModel.test.ts src/ai/session.test.ts`：4 文件／64 项既有 AI 回归通过。
- `npm run check:size && npm run build:native-canvas && xcodebuild -project native/macos/PlotWeaveNative.xcodeproj -scheme PlotWeaveNative -destination 'platform=macOS' -derivedDataPath native/macos/build/DerivedData test`：676 维护文件检查、389 画布模块构建、34 套件／118 项原生测试通过，`TEST SUCCEEDED`；本次未出现 N19 生命周期超时。
- `git diff --check` 和 `codesign --verify --deep --strict native/macos/build/DerivedData/Build/Products/Debug/PlotWeaveNative.app`：通过。只读委派复核无当前 P1／P2；修改源文件为 `NativeShellRoot.swift`（74 行）、`NativeInspectorView.swift`（50 行）、`NativeAiView.swift`（208 行），修改单元分别为 42／18／17 行，符合维护上限。UI §12.1 和 N34–N36 已同步；文档无配置的自动语义检查，已按源码、官方 API、回归及实际窗口结构化复核。

旧应用正常退出冲刷后，新版运行于 PID 92868，最终留在 400 pt 宽的 AI 面板。实际验证为 macOS 26.6.2 深色、1673 pt 宽窗口：拖宽／拖窄及边界、气泡辨识度、文字选择、AI／空属性模式切换、手动收展、设置往返与底部控件均已查看；未编辑草稿／模型／配置／凭据／图文档或发送请求、执行预览、清空会话。尺寸继续由系统管理，本机一次手动收展的初始 AX 观测采用 360 pt 理想宽度；不据此承诺所有收展或跨启动情形都会恢复用户拖动值。跨启动记忆、960 pt 最小窗口、浅色、增强对比度、VoiceOver、长消息滚动、真实卡片／note／busy 与 macOS 27 运行时保留验证缺口，不以非交互测试替代实际体验。

本次没有前端／Rust 源码、配置、桥、服务、依赖或数据模型改动，未重复未受影响路径的完整路由；没有提交、推送或创建 PR，未运行这些 Git 操作专用 Sonar／覆盖率门禁。清理本次生成 WebCanvas 和编译／测试缓存，只保留已授权运行的 app bundle；既有用户与其他任务改动保持。

## AI 回复 Markdown 呈现（2026-10-04）

所有者要求 AI 返回 Markdown 时正常显示格式。本轮只改变 Swift 原生消息正文的派生呈现，使用 Foundation 的 Markdown 解析结果和 SwiftUI 排版，不新增依赖。历史聊天与新回复共用入口；原始消息、会话身份、改动预览、执行／取消和保存协议保持。N31–N33 的“显示原文”是此前实现的历史记录，本轮助手正文支持下列格式。

| ID | 前置状态 | 动作／顺序 | 可观察结果 | 不变量及责任方／入口 | 验证及缺口 |
| --- | --- | --- | --- | --- | --- |
| N37 | 助手文本含段落、标题、加粗、斜体、删除线、列表、引用与代码 | 解析后按系统段落身份合并行内 runs，再排版；旧记录与新投影进入同一正文入口 | 格式标记不再裸露，块之间分离；嵌套列表及继续段落不重复编号；代码保留缩进和换行 | NativeMarkdownDocument 只派生内容；原始消息不变，不产生编辑／保存意图 | 7 项系统解析语义测试通过；现有历史回复的加粗、段落和列表实机验证通过 |
| N38 | 助手含链接、图片或 HTML；用户／回执含 Markdown 字符 | 原生呈现，不加载 HTML 或图片；仅 HTTP(S) 链接可交互；用户与回执按字面显示 | 正文完整，图片显示替代文字，HTML 为文本，用户／回执不被重新解释 | 原生正文无 Web 执行或媒体请求；控制与卡片保持原入口 | 解析后链接／图片／HTML 属性语义测试；用户／回执分支结构化审阅，真实外部链接不点击 |
| N39 | 表格等未支持块、无法解析或非空输入无可呈现字符 | 显式回退该消息的完整原文并显示格式诊断 | 内容不会因解析失败或未支持格式被丢弃 | NativeMarkdownDocument 拥有恢复策略；所有助手入口一致 | 表格、空替代文字图片及非空 fenced code 解析为空的恢复测试通过；系统解析抛错分支保留检查缺口 |
| N40 | 已有气泡／改动预览，侧栏宽度变化 | 重排正文、选择文字、切换 AI 与属性模式 | 气泡／换行／选择可用；预览确认独立于 Markdown 正文 | NativeAiEntryView 不新建会话或改变卡片规则；布局由系统列管理 | 64 项 AI 回归、125 项原生测试通过；既有回复在 300／360 pt 侧栏换行和正文选择实测通过；代码视图实际滚动、VoiceOver 和超长回复性能未验收 |

解析是同步、无 I/O 的显示派生，不引入异步状态、重试或新的保存竞争入口；其生命周期沿既有投影和消息 id，原始线程与文档仍由 React 单一会话所有者持有。范围暂不含 Markdown 表格排版、语法着色或远程图片展示。

实现与验证：

- `NativeMarkdownDocument` 用 Foundation `.full` 模式解析，按最内层块身份合并 attributed runs，保留行内属性与组合的列表／引用上下文；列表项身份集合避免继续段落重复编号。`NativeMarkdownText` 用 SwiftUI 原生文本和块布局呈现；`NativeAiEntryView` 仅将助手正文接入它，用户和 note 使用 `Text(verbatim:)`，改动预览仍独立。助手辅助功能容器显式保留 children，并带“AI 回复”标签，当前 AX 树可读取完整格式化正文。系统能力参考 [Foundation Markdown 源位置与行内属性](https://developer.apple.com/documentation/foundation/attributescopes/foundationattributes/markdownsourceposition)；系统解析结果仍需原生块排版，本轮使用本地 SDK 与合成输入验证了段落／列表／引用／代码的 presentation intents。
- 红灯：添加 `NativeMarkdownTests` 后聚焦 `xcodebuild … -only-testing:PlotWeaveNativeTests/NativeMarkdownTests test` 因缺少 `NativeMarkdownDocument` 编译失败（exit 65）。实现后 6 项聚焦测试通过；再补引用中的标题、hard break、代码字面标记与空代码块恢复，最终完整测试中 7 项 Markdown 测试全部通过。测试断言系统解析字符与属性语义，未读取版本源码／文档作文本断言。
- 最终原生路由：仓库根执行 `npm run check:size && npm run build:native-canvas && xcodebuild -project native/macos/PlotWeaveNative.xcodeproj -scheme PlotWeaveNative -destination 'platform=macOS' -derivedDataPath native/macos/build/DerivedData test`，exit 0，规模检查通过、125 测试／35 套件通过。Node 24.18.0；Vite 保留既有打包大小提示，Xcode 的非 macOS simulator 插件及 WebKit sandbox 系统诊断未使本次 macOS 检查失败。
- 既有会话与动作回归：`npm test -- src/editor/nativeCanvas/nativeAiShell.test.tsx src/editor/panels/AiThread.context.test.tsx src/editor/panels/aiThreadModel.test.ts src/ai/session.test.ts`，exit 0，4 文件／64 测试通过。源码变更限于 native 消息呈现，未改前端动作、保存、桥接或存储合同。
- 实机：正常退出旧构建并启动新构建，打开已有项目和 AI 对话；原回复中的 `**` 已按加粗显示，圆点和 1–4 编号各自换行并悬挂缩进。侧栏 360 → 300 pt 调整后全文仍可见，三击最后一段显示文字选择高亮；随后恢复操作前的约 537.5 pt 宽度。未发送消息、点击外部链接、清空会话或改动配置。
- 新源码与测试均在文件／执行单元规模约束内。文档无配置的自动语义检查，已结构化审阅支持范围、恢复路径、历史记录及 N37–N40 证据；补丁空白与应用签名验证通过。生成的画布目录与测试中间产物已清理，仅按已授权启动保留当前应用包；未提交／推送，未触发 Git 操作门禁。

剩余边界：表格显示原文；图片只显示非空替代文字，未加载图片本身；未做代码语法着色。代码空白与字面内容由语义测试覆盖，代码视图的实际横向滚动／跨块选择、标题／链接的 VoiceOver 导航、浅色视觉、系统解析抛错和超长回复性能未验收。付费模型或公网链接点击不属于这次显示验证，沿用既有服务验收缺口。

## 节点属性入口修复：状态与不变量（2026-10-04）

本次按用户截图修复对白节点属性按钮，并统一六种节点的共享线条齿轮。React 的面板状态负责目标与展示请求，SwiftUI 负责原生检查器显隐；请求是会话内只读投影，不进入文档、历史或持久化合同。

| 编号 | 前置状态 / 动作与顺序 | 可观察结果 | 不变量、所有者及入口 | 验证计划 / 缺口 |
| --- | --- | --- | --- | --- |
| N41 | AI 页已打开，普通选择 B，再点击 A 的节点齿轮 | 右栏切回 A 的原生属性，后续编辑作用于 A | `useEditorPanels` / 原生投影共同确定属性目标；齿轮与 `editor.nodeSettings` 共用动作；不写文档或新增撤销记录 | 生产 EditorView 回归：真实按钮、投影、序列化文档；原生窗口验证 |
| N42 | 属性栏被手动折叠；点击 A；再次折叠后再点击同一 A | 每次单击均展开 A，重复请求不关闭目标 | 每次原生属性动作产生瞬态请求序号；`NativeShellRoot` 仅消费当前项目有效请求 | Web 投影重复请求回归 + SwiftUI 窗口显隐回归 |
| N43 | 折叠检查器后普通投影更新；旧投影乱序到达或换项目后旧命令到达 | 保持折叠，旧请求不能打开或编辑旧目标 | 原生应用现有项目、页面会话及投影序号过滤继续生效；普通编辑、平移、保存不等于展开请求 | 原生窗口普通更新 / 乱序回归；既有应用身份测试与 Web 过期目标回归 |
| N44 | 浏览器 / Tauri 点击同一节点的属性按钮两次 | 原有内联面板打开后关闭；原生收展不重建 WKWebView | 宿主分支只改变 Swift 属性动作；共享图标保留原生 button 语义与可访问名称 | 既有面板 / 按钮测试、原生生命周期测试；运行窗口人工点验 |

网络、凭据、存储迁移与异步业务重试不适用于本次展示状态修复。

### 节点属性入口修复验证结果

- N41：生产 `nativeEditorShell.test.tsx` 从实际对白按钮验证 AI 页切回属性、目标优先于普通选择；后续属性改名只改变该对白，其他场景保持原值。展开前后内容版本及撤销状态保持，N41 通过。
- N42：重复齿轮和 `editor.nodeSettings` 均递增会话请求；生产文档序列化内容保持一致。`NativeShellNodeSettingsTests.explicitNodeRequestsReopenTheSameNativeInspector` 在真实 NSHostingView / WKWebView 上验证 A、B 与同一 B 新请求均展开；N42 通过。
- N43：Web 拒绝缺失节点与过期项目请求且保持目标／投影；原生窗口验证普通投影、乱序投影、跨项目过滤、路由及页面恢复不打开旧目标。页面恢复后新请求仍可展开，N43 通过；沿用既有应用状态身份过滤回归。
- N44：既有 `useEditorPanels.test.tsx` 验证浏览器内联同目标再点关闭，宿主识别测试覆盖 Tauri 优先分支；共享齿轮按钮可访问名称、键盘 button 语义和不冒泡测试通过。原生新窗口测试与既有生命周期测试确认 WKWebView 身份保持。实际 Tauri 窗口、VoiceOver、浅色视觉与截图中两个真实对白的人工点验未完成。

Red：生产 Web 测试明确观察到齿轮点击后 `aiOpen` 仍为 true，并缺少重复展开请求。原生真实窗口测试先编译成功，再观察同目标无法展开及恢复旧目标错误展开共五项预期失败。Green：三个 Web 回归及既有面板／按钮测试共 30 项通过；原生四项窗口回归由最终全量运行通过。

在授权 `codex/swiftui-react-flow` 工作树根执行以下完整路由检查，均成功：

```sh
npm run format:check && npm run lint && npm run check:size && npm run typecheck:strict && npm run build && npm test
npm run check:size && npm run build:native-canvas && xcodebuild -project native/macos/PlotWeaveNative.xcodeproj -scheme PlotWeaveNative -destination 'platform=macOS' -derivedDataPath native/macos/build/DerivedData test
```

前端 208 个文件 / 3035 项测试通过；原生 36 个 suite / 129 项测试通过。共享按钮最终格式检查、补丁空白检查与新应用包 `codesign --verify --deep --strict` 均通过。文档无配置自动语义检查，已结构化检查 §4.3、§12.1 与 N41–N44 的宿主边界及恢复行为；独立只读审查未发现本次新增 P1/P2。

构建后的界面自动化持续返回 `Sky Computer Use native pipe closed before response`，重建工具会话并重新绑定仍失败；因此未重启原有运行实例（当时 PID 45077），也未声称已完成实际按钮／图标视觉点验。仅保留已获启动授权的新 `native/macos/build/DerivedData/Build/Products/Debug/PlotWeaveNative.app` 供退出旧版后重新打开；其他生成画布资源与验证产物清理。未提交或推送，未触发 Git 操作门禁。

## 点击节点进入原生属性：状态与不变量（2026-10-05）

本次按用户的新决定替代上一节的原生齿轮入口：Swift 宿主隐藏六种节点上的共享设置按钮，普通点击节点直接打开对应属性；浏览器／Tauri 的内联设置入口保持。复用现有会话展示请求和 Swift 检查器，不新增文档字段、依赖或保存路径。

| 编号 | 前置状态 / 动作与顺序 | 可观察结果 | 不变量、所有者及入口 | 验证计划 / 缺口 |
| --- | --- | --- | --- | --- |
| N45 | AI 页或旧属性 A 已打开；普通点击 B 节点主体 | 右栏切为 B 属性，节点本身没有设置按钮 | ReactFlow 点击入口更新 `useEditorPanels` 的显式属性目标；六种节点共用 `NodeSettingsGear` 宿主判定；后续表单写入只作用于 B | 真实 EditorView 点击／投影／属性写入回归；共享按钮宿主分支回归 |
| N46 | 原生检查器折叠后点击同节点；随后大纲选择另一节点 | 每次点击可展开；大纲选择显示新目标并沿原有定位居中 | `editor.select` 与画布点击共用展示请求；内容版本、序列化文档及撤销栈不因展示动作改变 | 生产点击／native select 回归；既有真实原生窗口重复请求及 WebView 生命周期测试 |
| N47 | Meta／Control 多选、Shift 框选，输入框或连接端口点击；节点拖拽 | 保留框架选择／拖拽和连线语义，不把这些动作当作属性请求或踢出 AI | ReactFlow 仍拥有选择；普通点击不调用居中／单选定位；输入、端口与修饰键入口不触发展示请求 | 修饰键、输入／端口、真实拖拽回归；Web 键盘选择不触发点击，保留现有语义并记录边界 |
| N48 | 点空白画布；缺失节点／过期项目的 native select；普通投影或页面恢复 | 空白清理属性目标；过期操作拒绝，不展旧属性；AI／收起偏好不被普通投影覆盖 | 空白只关闭属性目标不递增请求；现有项目／会话／序号过滤继续生效，Swift 不持有可写文档副本 | 空白／失败操作与原生过滤／恢复回归通过；图标移除实际点验通过，属性切换实际点验受工具连接超时阻塞 |

网络、凭据、存储和异步业务重试不适用于本次点击与展示路径。

### N45–N48 验证结果

生产修改前，真实 `EditorView` 的节点点击和共享齿轮宿主测试出现 5 项预期缺失行为失败：点击仍停留 AI 页、属性目标未更新、重复展示请求未递增、Swift 节点仍显示设置按钮。随后普通节点点击接入既有 `toggleSettings`，大纲 `editor.select` 在校验目标后同步请求属性，Swift 共享齿轮返回空展示；浏览器／Tauri 行为保持。没有改 Swift 属性视图、文档字段或服务契约。

- N45：真实节点点击后的投影为目标节点，退出 AI；通过真实属性写入与导出确认只改目标，其他节点不受影响；共享按钮 Swift 隐藏与浏览器开关行为均通过。
- N46：重复点击、兼容 `editor.nodeSettings` 与大纲 `editor.select` 均更新展示请求，序列化文档、内容版本和撤销状态保持；既有 `NativeShellNodeSettingsTests` 的真实窗口折叠／同目标重开、旧序号过滤及 WebView 身份回归通过。
- N47：Meta／Control／Shift、可编辑标题输入框及连接端口点击不退出 AI 或请求属性。新增真实 React Flow 鼠标拖拽回归确认网格位置、导出位置与一步撤销一致，AI 页及请求序号保持。Web 键盘选择不触发 `onNodeClick`，按此次点击范围保留现有语义；未新增键盘自动展开能力。
- N48：空白点击清理目标且不切 AI、不新增展示请求；缺失节点和过期项目的 native select 拒绝且投影保持；原生乱序、旧项目、路由恢复及会话基线过滤回归通过。

检查均在 `codex/swiftui-react-flow` 的授权工作树执行（Node 24.18.0）：

```sh
npm test -- src/editor/nativeCanvas/nativeEditorShell.test.tsx src/editor/nodes/settings/NodeSettingsGear.test.tsx src/editor/EditorCanvasRegion.alignment.test.tsx src/editor/EditorView.test.tsx
npm run format:check && npm run lint && npm run check:size && npm run typecheck:strict && npm run build && npm test
npm test -- scripts/pre-push-install-watchdog.test.ts && npm test
npm run check:size && npm run build:native-canvas && xcodebuild -project native/macos/PlotWeaveNative.xcodeproj -scheme PlotWeaveNative -destination 'platform=macOS' -derivedDataPath native/macos/build/DerivedData test
```

聚焦 4 文件 / 52 项测试通过；完整前端格式、ESLint、文件大小、严格类型及构建通过。第一遍全测的现有 watchdog 用例「期限已发 TERM 后收到 absent」在监督进程存活断言失败；没有改或排除该脚本，单独重跑 5 项与随后全测 208 文件 / 3040 项均通过。原生 36 个 suite / 129 项测试通过；新包 `codesign --verify --deep --strict` 通过。独立只读审查未发现本次新增 P1/P2；文档无配置的自动语义检查，结构化核对 §4.3、§12.1 与此矩阵的入口、边界和历史语义，补丁空白与最终格式检查通过。

实际界面验证：所有者解锁后，正常退出旧实例并打开新构建；新实例 PID 77945 的「都市奇缘」画布 AX 树已确认全部节点设置按钮消失。随后点击 AI 工具栏时界面连接返回 `Sky Computer Use native pipe closed before response`，重新绑定、重置工具会话和测试完成后再次绑定仍返回 `timeoutReached`，未声称完成实际窗口的 AI → 节点属性切换和收起后再展开点验；这些路径由生产控制器与原生窗口自动测试覆盖。新应用继续运行，仅保留已获启动授权的 `native/macos/build/DerivedData/Build/Products/Debug/PlotWeaveNative.app`；清理其他生成资源与验证产物。未提交或推送，未触发 Git 操作门禁。
