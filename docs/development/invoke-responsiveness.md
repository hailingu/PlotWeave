# 阻塞持久化命令的响应性验证（issue #138）

关联：[issue #138](https://github.com/hailingu/PlotWeave/issues/138)。范围是同步
Tauri 持久化命令的执行线程；不改 IPC 载荷、磁盘格式、事务协议或前端保存链。

## 状态与不变量矩阵

| 前置状态 | 操作与事件顺序 | 可观察结果 | 不变量与所有者／入口 | 验证 |
| --- | --- | --- | --- | --- |
| 资产库文件锁被占用 | 发起库写入，同时向原生主线程投递心跳，随后释放锁 | 心跳及时执行；写入只在解锁并落盘后完成 | 命令调度不阻塞主线程；库事务内核仍拥有完整锁区间，所有六个库命令共用 | 真实 Wry invoke + 受控 flock，记录修复前后延迟 |
| 项目操作锁被占用 | 发起保存，异步调用方继续工作；解锁后再读文件 | 等待期间文件未改；完成后读回新内容 | 项目内核拥有排他与原子写；create/save/list 的锁边界不变 | 阻塞调度 + 实际项目保存内核测试 |
| 项目保存成功／失败 | await 保存 A，再保存 B；非法载荷失败后重试 | 最后读回 B；失败不覆盖有效文件且原错误保留 | 前端保存链拥有先后关系，后端成功响应只在完整内核结束后给出 | IPC 保存／读回／拒绝／重试及既有保存链测试 |
| 库媒体读取与库写入竞争 | 发起媒体 URL 校验及库操作 | 共享库锁串行执行；主线程仍可响应；诊断按锁内顺序编号 | 库诊断序号与恢复发布仍归 diagnostics；媒体入口同样离开主线程 | Wry 并发命令与既有媒体／恢复测试 |
| 阻塞任务异常退出 | 调度任务 panic 或返回领域错误 | panic 转为明确 IPC 错误；领域错误原样上浮 | 调度层只拥有任务失败映射，不吞错误、不输出用户载荷 | 调度层异常测试 |
| 设置／会话有在途保存 | 后续快照等待前一次完成，失败后仍可冲刷 | 最终保存最新快照，失败可见 | `useSettingsSaver` 和项目／会话共享保存链拥有顺序；后端不提前确认 | 既有设置关闭冲刷、项目和会话保存链测试通过 |

独立并发命令没有新增 FIFO 承诺；有依赖的保存仍由调用方 await 串联。
同步内核内获取并释放锁，不跨 await 持有锁。已经开始的阻塞任务不因等待者
放弃结果而中断；此改动不增加取消或自动重试。进程崩溃恢复沿用既有原子写／
日志测试，不在调度层重复注入。Windows/Linux 原生交互尚无本仓库运行环境；
本轮原生延迟测量限于 macOS，不推断磁盘吞吐量或所有机器的帧率。

## 测量与结果

2026-09-19，macOS，Rust 1.95.0，Tauri 2.11.5。基线为 `fcc24d8` 的同步命令：
先仅提取原有 Builder 组合为 `app_builder`，供真实 Wry 测试复用生产注册表，
保持命令调度不变。测试在修改命令调度前因「阻塞文件锁等待不得占用 invoke
主线程」失败，原子落盘和保存拒绝／重试断言均已通过。

每个样本持有实际 `.library-op.lock` 400 ms，在分发约 30 ms 后向原生事件循环
投递心跳。下表为单次修复前／完整检查时的修复后观测（ms），不是分位数或
吞吐基准。回归阈值为主线程分发与心跳各小于 150 ms，明显小于持锁时间。

| 命令 | 修复前分发占用 | 修复后分发占用 | 修复前心跳延迟 | 修复后心跳延迟 |
| --- | ---: | ---: | ---: | ---: |
| `import_library_asset` | 423.275 | 0.061 | 391.523 | 0.023 |
| `get_asset_media_url` | 368.340 | 0.039 | 374.246 | 0.044 |
| `update_library_asset` | 415.434 | 0.095 | 381.493 | 0.067 |

矩阵对应的验证结果：

- `tests/invoke_responsiveness/macos.rs::contended`：锁竞争时主线程及时返回，
  命令没有提前报告成功，解锁后实际库索引可读回；通过。
- `store::commands::blocking_tests::slow_save_keeps_runtime_and_media_reads_responsive`：
  真实项目操作锁占用 500 ms，单线程异步运行时的计时器和实际媒体读取约
  26.393 ms 完成；期间项目仍为旧值，保存尚未完成，解锁后读回新值；通过。
- `check_project_saves`：真实 IPC 顺序保存、非法载荷拒绝、磁盘旧值保留及
  重试后读回；`check_project_assets`：导入、预检、复制、媒体 URL、删除；
  `check_other_persistence`：会话、设置、组和库删除。21 个迁移命令均实际
  经生产 handler 调用；密钥封装入口使用非法 provider 验证拒绝，不接触真实密钥。
- `check_library_overlap`：两个字段补丁和媒体 URL 校验并发竞争锁，最终两字段
  均保留，成功诊断序号不同；既有库恢复、媒体协议、原子写故障测试均通过。
- `blocking::tests::retains_operation_error_and_recovers_after_worker_panic`：领域错误
  原样保留，工作线程 panic 转为失败，下一任务正常完成；通过。

执行命令与结果：

- `src-tauri/`：`cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test`，
  全部通过：401 个单元测试、2 个媒体格式集成测试，以及 invoke 响应性和原生退出测试。
- 仓库根：`npm test -- src/projectStore/saveChain.test.ts src/projectStore.tauri.test.ts src/aiSessionStore.tauri.test.ts src/settings`，
  8 个文件、108 个测试通过，覆盖设置／项目／会话的顺序与失败冲刷。
- 文档无配置的自动验证命令；人工核对本矩阵与数据模型 §10.5、UI §3.1、
  实际命令注册及原有保存链，引用和行为描述一致。文件及新增函数未超规模上限。

验证缺口：这里测量的是原生事件循环响应，不是完整画布渲染帧率；受控项目
慢保存与媒体字节读取在真实内核层并发验证，未在 WebView 内自动拖动画布。
未在 Windows/Linux 或真实故障磁盘上采样。已有异步聊天命令的凭据读取当时
沿用原实现，本轮针对同步 invoke 入口；该剩余路径随后由
[issue #279](https://github.com/hailingu/PlotWeave/issues/279) 移交既有
阻塞调度（`prefs::chat_credential` 经 `blocking::run`），并以单线程异步
运行时上的受控延迟兄弟任务响应性测试单独验证。未新增崩溃恢复、取消或跨
进程排序保证。

生图产物落盘与校验（`llm_image_generate` 的目录准备、项目操作锁等待、
写入与 §9.3 预检）当时仍在异步命令内联执行，是本系列最后一段剩余路径，
由 [issue #310](https://github.com/hailingu/PlotWeave/issues/310) 以同一
`blocking::run` 调度移交（`persist_generated_asset`，落盘单元内核
`write_and_validate_generated_asset` 生产与测试共用）。锁内取消复验经托管
作业注册表在阻塞线程按 job id 查询（`ImageJobRegistry::writable`），
登记守卫生命周期保留在命令侧并显式持有至持久化完成，不提前释放登记；
命令 future 在持久化期间被丢弃（如运行时关闭，守卫先行 Drop 移除活动
条目）时，锁内复验因登记缺失同样拒绝写入（评审修复），已登记的取消
不因守卫释放被抹去。锁等待期间取消不落盘、项目删除与写入串行（已删
项目不被重建）语义不变。
行为验证：真实操作锁竞争（他者持锁 400 ms、32 个并发落盘单元）下兄弟
异步任务在锁仍被持有时推进（`imagegen::tests::
lock_contention_persist_leaves_async_workers_free`），另覆盖
`cancel_during_lock_wait_skips_disk_write` 与
`deleted_project_during_lock_wait_is_not_recreated`。保留限制：阻塞任务
不可取消（慢磁盘场景下写入仍在阻塞池完成，等待者放弃只丢弃结果不中断
工作）；未测量 worker 饥饿或 UI 帧率——兄弟任务推进为行为级断言，
不以「调用了 spawn_blocking」的 mock 代替。
