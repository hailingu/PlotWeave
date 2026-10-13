# PlotWeave 设计与实现质量评估

本文是对 PlotWeave 设计与实现质量的评估记录：给出分维度评分、综合评级与每条结论的证据。它不是工程门禁，不新增规范或契约。缺陷结论供排期参考；已有所有者决策的事项不因本记录而重新成为扣分项。

- **评估基线**：`refactor/retire-v0-flat-format` @ `8c8d6559945d085de21037a68f6984e2c0fe2383`（`8c8d655`）。上一轮记录的基线是 `dev` @ `2c12805`（当时综合 9.5 / A+）。其间 **54 个提交**，约 402 个文件变更（+36367 / −14179），主要内容是 SwiftUI/AppKit 原生壳合入、v0 扁平格式退役，以及 Rust 模块图守卫子系统退役。
- **评估性质**：只读审阅。核对了仓库结构、数据模型与功能补齐文档、开放 issue，以及前端、持久化、原生壳和门禁的代码。**未修改产品源代码，未提交，未推送。** 本轮**没有**重跑 Prettier、ESLint、`npm test`、`cargo test`、`xcodebuild` 或 Sonar，因此不引用过期覆盖率，也不把上一轮的负载敏感失败当作本轮新证据。
- **证据强度**：文件行数、`git` / `gh` 状态和本文件引用的设计文档由本次直接核对。持久化原子写、原生退出屏障、下载门禁和前端模块图守卫的行级行为来自同一次只读代码核对；正文只采用与现行文档或开放 issue 一致的结论。
- **会话初评修正**：同一次评估的口头初评曾给 **8.7 / A-**。写入本记录前核对了已关闭的 [#518](https://github.com/hailingu/PlotWeave/issues/518)：所有者明确三栈并存是刻意设计，**不作为缺陷或评分扣分项**。门禁的单一完整成本也是已记录决策，不另扣。`normalizeAssets` / `normalizeContainers` 中关于「保存被拒」的注释描述的是已落地的隔离和回退，不是仍开放的丢稿缺陷。密钥迁移失败只记日志、但密钥仍可打开，属于失败后保持旧信封，也不按缺陷扣分。修正后综合分为 **9.2 / A**。

## 一、评分口径

9 个维度、10 分制。评级带：A+ 9.5–10.0、A 9.0–9.4、A- 8.5–8.9、B+ 8.0–8.4、B 7.5–7.9、B- 7.0–7.4、C+ 6.5–6.9、C 6.0–6.4、C- 5.5–5.9、D 4.0–5.4、E < 4.0。

综合分按权重加权，权重偏向用户可感知的数据与原生路径，不是九项平均。扣分只计有真实证据、且在正常使用或已记录脏数据下可达的问题。下列事项不计扣分：

- 同用户替换 `projects/` 树，以及非 Unix 身份缺口（仓库威胁模型已排除）。
- [#518](https://github.com/hailingu/PlotWeave/issues/518) 已关闭的三栈并存，包括因此存在的双份下载策略。具体策略错误仍可单独扣分；当前没有未修的这类错误，[#528](https://github.com/hailingu/PlotWeave/issues/528) 已关闭。
- 门禁不做快速通道、以及 CI 不跑本机 Sonar。二者都是已写明的执行约束，不是未披露缺口。
- 不支持 Windows。这是平台选择，不是缺陷。
- [#519](https://github.com/hailingu/PlotWeave/issues/519) 的 v0 小数 `updated_at` 排序差异。已知边界，且本分支正在让该格式直接被拒绝。
- 上一轮对 Rust `module_graph` 子系统的 **−0.3**。该扣分写的是「仍是全仓修复密度最高的构件，且本窗口继续增长：31 文件 / 7,260 行」。这在本基线不成立：[#524](https://github.com/hailingu/PlotWeave/issues/524) 已关闭，`dc10b3c` 删除了这套 Rust 守卫；`crates/`、`src-tauri/` 和 `scripts/` 中不再有 `module_graph` 源文件。那 11 个 issue 是已退役守卫的历史，不是现行构件的缺陷密度。留下的是前端 [moduleGraph.test.ts](../src/moduleGraph.test.ts)，算架构守卫，不计为扣分。

## 二、综合结果

| 维度 | 权重 | 评分 | 评级 |
| --- | ---: | ---: | --- |
| 架构与模块边界 | 12% | 10.0 | A+ |
| 数据模型与持久化 | 16% | 9.4 | A |
| 前端实现 | 12% | 9.0 | A |
| 原生壳实现 | 14% | 8.7 | A- |
| 安全与信任边界 | 10% | 9.6 | A+ |
| 测试与验证 | 12% | 8.9 | A- |
| 工程门禁与流程 | 8% | 9.3 | A |
| 文档与设计同步 | 8% | 9.5 | A+ |
| 产品完成度与可交付性 | 8% | 8.0 | B+ |
| **综合** | **100%** | **9.2** | **A** |

加权计算：10.0×0.12 + 9.4×0.16 + 9.0×0.12 + 8.7×0.14 + 9.6×0.10 + 8.9×0.12 + 9.3×0.08 + 9.5×0.08 + 8.0×0.08 = 9.174，按一位小数记为 **9.2**。

相对上一轮 9.5 的下降，来自已经合入的原生路径还带着未关的 P2 和未完成的验收，不是来自 Tauri/Rust 编辑器内核变差。上一轮 `module_graph` 的 −0.3 予以撤回，不进入本轮任何维度。

## 三、直接核对的规模

分析版本上的 `wc -l`：

| 对象 | 结果 |
| --- | --- |
| 非测试 `src/**/*.ts(x)` | 约 38,105 行；最大文件 `src/App.tsx` **798** |
| 接近上限的其他前端生产文件 | `sheetTokensEngine.ts` 775，`AssetsPanel.tsx` 762，`batchFold.ts` 742 |
| 原生生产 Swift（`native/macos/App`，不含测试） | 约 8,709 行；最大文件 `NativeSettingsView.swift` 407 |
| 前端测试文件 | 205 |
| `scripts/sonar-quality-gate.sh` | 300 |
| `docs/development/quality-gate-*.md` | 合计 2,380 |

开放跟踪：评估当时开放 issue 16 个、开放 PR 1 个（[#533](https://github.com/hailingu/PlotWeave/pull/533)）。本记录随后新增 [#543](https://github.com/hailingu/PlotWeave/issues/543)、[#544](https://github.com/hailingu/PlotWeave/issues/544)、[#545](https://github.com/hailingu/PlotWeave/issues/545)。

## 四、分维度结论

### 4.1 架构与模块边界 — 10.0 / A+

前端模块图测试同时约束运行时图、编译期图和模型层纯度。编辑器把文档、持久化、画布动作和 AI 拆开。原生侧的退出屏障、项目存储 actor 和 WKWebView 桥是分开的。`#524` 去掉了重复的 Rust 模块图守卫，只留一套 TypeScript 守卫。

三栈并存和「原生宿主再进入 App」的装配路径增加阅读成本。 [#518](https://github.com/hailingu/PlotWeave/issues/518) 的关闭说明把这种并存排除在扣分之外，因此本维度不另扣，也不另开 issue。壳层文件贴着行数上限的问题计在前端实现，不在这里重复计。

### 4.2 数据模型与持久化 — 9.4 / A

Rust/Tauri 写路径会拒绝路径型文件名和符号链接，独占创建临时文件，同步后再改名，并同步父目录。保存前拒绝非当前 schema。v0 扁平格式在 core 分类和前端 `parseProject` 都会被拒绝，原文件保留。前端保存链串行化，并有过期保存抑制测试。

资产归一化和时间戳修复会把无法通过保存边界的脏值隔离或回退。相关注释说明的是这道防线的理由，不是仍会「能编辑、不能落盘」的开放缺陷。rename 成功后父目录同步失败会报错、且新文档可能已经落盘；这是文档和测试共同编码的语义，不按丢稿扣分。

扣分：

- **−0.4** Swift 路径还没有与实现声明同级的系统 fsync 故障注入。见 [persistence.md](data-model/persistence.md) 的验证缺口，跟踪为 [#543](https://github.com/hailingu/PlotWeave/issues/543)。这是证据缺口，不是已观察到的丢稿。
- **−0.2** 撤销栈和保存链各自有测试，但没有一条直接断言「保存进行中撤销之后，磁盘等于撤销后的状态」。没有因此声称存在丢稿。

### 4.3 前端实现 — 9.0 / A

用户可见失败多数会到达界面：首页分开打开失败、动作失败和列表失败；保存失败保留脏标记；退出保存失败会取消系统退出。非测试代码没有 `as any`、`@ts-expect-error` 或 `eslint-disable`。历史栈用修订号挡住过期的异步 redo。`#522` 已清掉多余类型逃生口，剩下的 `as unknown` 位于未信任输入和 JSON 边界，不另扣。

扣分：

- **−0.6** `src/App.tsx` 为 798 行，下一次实质修改就会顶破 800 行上限。跟踪为 [#545](https://github.com/hailingu/PlotWeave/issues/545)。
- **−0.4** `sheetTokensEngine.ts`、`AssetsPanel.tsx`、`batchFold.ts` 都超过 740 行。它们仍低于硬上限，工程标准也不要求只因越过复查阈值就机械拆分，所以不单独建 issue。余量已经变薄。

### 4.4 原生壳实现 — 8.7 / A-

结构清楚，生产 Swift 文件都远低于 800 行。退出会等 Web flush；投递失败会取消退出，而不是直接关掉。桥会拒绝过期会话。设置页的 provider key 草稿不落盘。抽查的 Swift 测试断言的是会话替换、下载地址和桥回复，不是源码散文。

临时文件清理失败和 `pw1:` 密钥迁移失败只记日志。清理失败不改变已提交文档；迁移失败时旧信封保持不变，密钥仍然打开。二者都不建 issue。

扣分：

- **−0.7** [#529](https://github.com/hailingu/PlotWeave/issues/529)：已接纳的图库多文件导入尚未落定，系统退出仍可能被批准。issue 写明这是静态接线核实，尚未独立抓到物理丢文件；扣的是退出资格，不是已证实的数据损坏。
- **−0.6** [#527](https://github.com/hailingu/PlotWeave/issues/527)：设置字段从 A 改到 B 再改回 A 时，迟到的旧投影可以覆盖较新草稿。窄时序，且尚未用真实输入法复现；代码比较缺口已经核对，后续键入和退出保存可能以旧值为底。

### 4.5 安全与信任边界 — 9.6 / A+

图像下载只接受 HTTPS，要求 DNS 答案为公网地址，按跳重验重定向，并连接到已校验的字面地址。`#528` 已把 IPv6 门收紧到已分配前缀。诊断会涂掉密钥、query 和 fragment。项目路径拒绝符号链接和穿越。

扣分：

- **−0.4** [#521](https://github.com/hailingu/PlotWeave/issues/521) 仍开放：生产路径的 `unwrap` / `expect` 把 JSON 和锁不变量交给 panic。仓库标为 P3。对脏文件来说，崩溃好过静默损坏，但仍不是领域错误。

[#520](https://github.com/hailingu/PlotWeave/issues/520) 的同用户恶意软件场景与威胁模型重叠，不扣分，也不新开 issue。

### 4.6 测试与验证 — 8.9 / A-

抽查到的编辑器、归一化、Rust 存储和 Swift 桥测试断言可观察结果：拒绝穿越和符号链接、撤销重做、协议超时、保存链的失败重试。前端测试文件 205 个。本轮没有重跑套件，所以这里不报通过数或覆盖率。

扣分：

- **−0.6** [#529](https://github.com/hailingu/PlotWeave/issues/529) 和 [#527](https://github.com/hailingu/PlotWeave/issues/527) 都写明尚未用真实 Quit 或输入法独立复现。现有自动化没有挡住这两条 P2。Swift fsync 故障注入同样缺失，见 [#543](https://github.com/hailingu/PlotWeave/issues/543)；不在持久化维度之外重复计权。
- **−0.3** [#525](https://github.com/hailingu/PlotWeave/issues/525) 与 [#534](https://github.com/hailingu/PlotWeave/issues/534)–[#542](https://github.com/hailingu/PlotWeave/issues/542) 记录了成串的测试复制和 `App.test.tsx` 余量。这是维护债务，不是行为错误，不新开同类 issue。
- **−0.2** 无障碍自动化明确不覆盖色彩对比度、真实 WebView 和屏幕阅读器。披露是诚实的。对比度本身已有关闭的 [#351](https://github.com/hailingu/PlotWeave/issues/351)，不重新打开。

### 4.7 工程门禁与流程 — 9.3 / A

本地门禁会跑格式、零警告 lint、规模、严格类型、覆盖率下限和 Sonar 新代码。`git am` 等未覆盖的提交路径写在门禁文档中，push 仍按每个 ref 再闸一次。CI 跑格式、lint、类型、规模、前端测试、Rust 和原生 Xcode 测试，不跑本机 Sonar，原因是托管 runner 到不了本机服务。

这些都是已记录的设计，不扣分。小扣 **−0.7** 只给维护成本本身：门禁脚本 300 行，门禁文档族 2,380 行。它防得住回归，也让失败模式多于产品行为。不建「简化门禁」issue，因为那会推翻已记录的成本决策。

### 4.8 文档与设计同步 — 9.5 / A+

数据模型已写明 Swift 拥有原生存储、v0 被拒绝，以及提交后目录同步失败不回滚。README 没有把源码归档说成安装包，并写了输入法、VoiceOver 和性能尚未验收。功能补齐记录没有把首次拖动说成已修复。上一版评估记录把 `2c12805` 和 9.5 / A+ 写成当前结论；本文件替换它，这项过期不留在现行扣分里。

扣分：

- **−0.5** README 的「已实现」必须和同一页的「尚未验收」以及 [#523](https://github.com/hailingu/PlotWeave/issues/523) 连读，才不会被理解成原生迁移已经可交付。措辞本身不是独立缺陷，不建 issue。

### 4.9 产品完成度与可交付性 — 8.0 / B+

画布、分支、设定、导出、对齐吸附和 AI 出图在源码与测试中是真能力。短板是创作者还拿不到安装包，以及原生壳的实机验收没有完成。

扣分：

- **−1.0** v0.2.0 只有源码归档，没有签名、公证和安装验收。README 与发布说明已经披露。这是发行状态，不是未跟踪的代码缺陷，不建 issue。
- **−0.6** [#523](https://github.com/hailingu/PlotWeave/issues/523)：视觉、输入法、VoiceOver 和性能验收证据仍缺，迁移不能宣布完成。
- **−0.4** 首次拖动停顿已被用户实机反馈，并且在若干项目内副作用修好之后仍被记为未消除。它不是「还没测量」，而是已观察到的未通过项。跟踪为 [#544](https://github.com/hailingu/PlotWeave/issues/544)，不并进 #523 的验收清单。

## 五、本轮新建与故意不建的 issue

新建：

| Issue | 原因 |
| --- | --- |
| [#544](https://github.com/hailingu/PlotWeave/issues/544) | 已观察到的首次拖动停顿，没有独立缺陷单 |
| [#545](https://github.com/hailingu/PlotWeave/issues/545) | `App.tsx` 只剩 2 行余量，下一次实质修改会被规模守卫挡住 |
| [#543](https://github.com/hailingu/PlotWeave/issues/543) | 原生保存已是现行路径，但系统 fsync 故障注入仍未验收 |

故意不建：

- [#527](https://github.com/hailingu/PlotWeave/issues/527)、[#529](https://github.com/hailingu/PlotWeave/issues/529)、[#523](https://github.com/hailingu/PlotWeave/issues/523)、[#521](https://github.com/hailingu/PlotWeave/issues/521)、[#525](https://github.com/hailingu/PlotWeave/issues/525)、[#534](https://github.com/hailingu/PlotWeave/issues/534)–[#542](https://github.com/hailingu/PlotWeave/issues/542) 已经开放。
- 三栈并存、门禁成本、CI 不跑 Sonar、不提供 Windows 构建，都是已记录决策。
- 归一化注释、临时文件清理日志和密钥迁移失败日志，核对后不是开放缺陷。
- 740 行以上但未到上限的生产文件，不按「接近上限就必须拆」建单。

## 六、未运行的检查

`docs/**` 没有配置独立的自动化检查。本记录是文档替换，没有产品代码变更，因此没有运行 Scope Routing 中的前端、Rust 或原生测试命令。若要把本文件纳入提交，仍须走仓库既有的提交门禁；那不是本评估已经完成的验证。
