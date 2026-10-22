# 模型凭据与图片下载边界

## 任务与风险

[#653](https://github.com/hailingu/PlotWeave/issues/653) 收紧聊天与生图首跳凭据目的地；[#655](https://github.com/hailingu/PlotWeave/issues/655) 将 Rust 图片下载对齐当前原生策略，并消除验证 DNS 后由客户端再次解析的窗口。正常 Web 调用一直传当前 provider 地址；本次补齐后端自证边界，不宣称已发现实际密钥泄漏。

## 资产与范围

凭据只存在于后端请求内存。Swift `NativePreferences.providerCredential` 与 Rust `prefs::provider_credential` 从同一份受限设置快照取得唯一 provider 的地址和密文。IPC 继续接收 `baseUrl`，只用于与已保存目标核对；实际 POST 使用已保存目标。主机大小写、默认端口及末尾斜杠等价；路径、查询、协议和非默认端口差异拒绝。缺失、损坏、重复或无法读取配置时，不以调用方地址配合历史密钥继续请求；请恢复或重新保存设置后重试。

配置好的自建 HTTPS 和显式回环 HTTP provider 保留。Rust 的历史 Keychain 只读回退须先确认配置目标，原生继续不读旧 Tauri Keychain。密文格式、provider AAD、迁移、API 请求与取消响应形状不变。

## 优先级与不变量矩阵

| 前置状态／转换 | 可观察结果 | 所有者与跨转换不变量 | 验证 |
| --- | --- | --- | --- |
| 调用方更换 provider 的主机、路径、端口或协议 | 聊天／生图均拒绝，POST 次数为零 | 两端配置 owner：先核对持久化目标，再解密；实际目的地与密文来自同一快照 | `configuredProviderRejectsCallerDestinationOverride`、`mismatched_or_missing_configuration_never_opens_a_key` |
| 已保存自建 HTTPS 或显式回环 HTTP；调用方仅使用等价拼写 | 两种模型命令保留，实际 URL 使用已保存配置 | provider 传输原有逐跳复验、HTTPS 降级拒绝和跨源敏感头剥离继续有效 | `configuredProviderUsesPersistedDestination`、`canonical_equivalence_preserves_configured_target_and_secret`；既有 provider transport 回归 |
| 图片首跳或重定向目标为 HTTP、内嵌凭据、零端口或非公网字面量 | 发送该跳前拒绝 | Rust `imagegen/download.rs`：下载仅 HTTPS；provider 本地服务例外不扩展到下载 | 共享 `model-network.json`；降级和逐跳拒绝回归 |
| DNS 返回空集或任一非公网地址 | 整组拒绝，无部分放行 | 所有答案必须通过公网判定；不可取消 DNS 保留专用线程上限 2 和绝对作业截止时间 | `redirect_mixed_dns_answer_is_rejected_before_connecting`；既有 DNS 超时、繁忙及额度恢复回归 |
| 域名解析通过后建立连接，或进入下一跳 | 仅连接本跳已验证的地址；保留原 Host／SNI | 每跳新建无代理客户端，以 `resolve_to_addrs` 固定答案；禁用自动重定向，下一跳重新验证；不复用旧授权连接 | `pinned_dns_preserves_tls_identity_without_second_resolution_or_proxy`：真实双跳 TLS，验证解析 2 次、fallback 0 次、代理连接 0 次 |
| 固定地址的证书不受信任或主机名不匹配 | TLS 失败，HTTP 请求数为零 | 默认 TLS 信任与名称校验保持启用；测试根只加入单个测试客户端 | `pinned_tls_rejects_untrusted_certificate_and_wrong_hostname` |
| 下载返回大响应、错误状态、慢尾部或已过截止时间 | 保留 32 MiB 流式限读、阶段预算和既有错误优先级 | 连接地址变化不改变总预算、取消标记或最终项目提交屏障 | 原有下载和作业回归已迁移到真实本机 HTTPS；边界值及超限慢尾部断言保留 |

## 策略证据

`crates/plotweave-core/testdata/model-network.json` 是独立手工预期数据，Swift 与 Rust 各自验证。Rust 公网分类完整对齐 `NativeNetworkPolicy` 当前冻结的 IANA 2025-10-10 分配表，包括 IPv4 文档／基准测试网段、`192.0.0.9/.10` 例外、内嵌 IPv4、ISATAP 及 IPv6 分配边界。未来新增地址分配须同时修改两端及边界数据；本次不查询并更改该冻结策略。

Rust 使用锁定依赖 reqwest 0.12.28 的 `resolve_to_addrs`：只覆写连接解析，保留原 URL 身份；`no_proxy` 同时禁用自动系统代理与显式代理。每跳全量验证后新建客户端，不依赖代理绕过偏好或环境变量。代码不放宽证书验证。

## 执行结果与限制

原生聊天／生图覆盖地址的 8 个组合先红：POST 确实被调用，未按预期拒绝；Rust HTTPS 策略用例先红：HTTP 目标被放行。新增网络用例只访问自有临时回环 TLS 服务，证书与私钥运行时生成并随夹具清理，不修改系统信任、代理或用户数据。普通下载回归保留真实响应体、重定向、限读和预算路径。

本地集中回归通过：Rust 图片／作业 45 项、凭据绑定 2 项；原生完整 350 项／78 套件，App 报告 8387／9549 行、71／71 个文件、report-only。移除 `resolve_to_addrs` 的受控变异以“second DNS lookup forbidden”按预期失败，随后逐字恢复并转绿；严格 Clippy、Rust 两工作区路由检查通过。完整门禁结果以对应 PR 的提交 SHA、原生报告、Sonar 记录与 CI 为准。没有访问真实 provider、计费 API、外部 DNS 或公网 TLS 站点；本机 TLS 验证不能代替这些环境的验收。原生覆盖率继续 report-only，前端／Rust 的 80% 门槛不变；昂贵 stress 仍需 opt-in。真实 IME 未测，视觉快照与 VoiceOver 验收仍按所有者决定取消。

## 后续动作

按固定 issue 批次串行完成最新 head 的真实 review 与全部必需 CI；普通合并 dev 后核实远端包含修复，再关闭对应 issue、清理本任务分支并跟踪自动 dev CI。本组完成前不开始下一组。
