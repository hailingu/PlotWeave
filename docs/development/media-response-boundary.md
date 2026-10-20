# 媒体响应的文档隔离

## 任务与风险

[#654](https://github.com/hailingu/PlotWeave/issues/654) 的事实是媒体协议原样下发资产声明的 MIME。当前产品通过图片元素消费媒体，导航 owner 也有自己的边界；没有据此宣称当前 App 存在可利用路径。本次修复独立收紧响应层，使以后新增文档导航消费者时也不能获得脚本执行能力。

## 范围与资产

只修改 Swift `NativeMediaScheme` 和 Rust `media_protocol` 的响应头。持久化 `AssetRef.mime`、导入、共享词法契约、URL 形状、目录身份绑定、只读描述符、容量闸门和取消协议保持原状。合法的 `image/*`、`audio/*`、`video/*` 声明仍作为响应 MIME，其他类型及不规范声明回退为 `application/octet-stream`。

SVG 保留 `image/svg+xml`，因此单靠媒体类型前缀不能关闭其文档脚本能力。所有成功和错误响应都发送 `Content-Security-Policy: sandbox; script-src 'none'` 与 `X-Content-Type-Options: nosniff`；固定 404 文本及其 `text/plain; charset=utf-8` 保留。策略使用真正的强制响应头；按 [W3C CSP sandbox 规范](https://www.w3.org/TR/CSP3/#directive-sandbox)，该指令不能用 report-only 或 meta 替代。没有为媒体套用会阻止正常 SVG 内联样式的 `default-src 'none'`。

## 不变量与优先级

| 前置状态／动作                        | 可观察结果                                           | 所有者与跨转换不变量                                       | 验证                                                                          |
| ------------------------------------- | ---------------------------------------------------- | ---------------------------------------------------------- | ----------------------------------------------------------------------------- |
| 合法图片、音频或视频声明读取成功      | Content-Type 与声明相同；字节、长度、200 状态不变    | 响应层仅选择交付类型，不修改文档／索引                     | Native scheme 回调与 Rust 真实响应类型测试                                    |
| HTML、XHTML、PDF 或不规范声明读取成功 | 200 与原字节保留，Content-Type 降级为二进制流        | 任意非媒体类型不能主动作为文档声明下发；脏声明不能注入新头 | `responsePolicyPreservesMediaAndRestrictsDocuments`、Rust media response 用例 |
| 合法 SVG 被作为独立文档导航           | SVG 文档确实加载，内联样式有效，自己的脚本标记保持空 | 媒体响应的 sandbox／script-src 限制独立于外层导航消费者    | `svgDocumentCannotExecuteScripts`；同引擎无策略正向对照必须先执行脚本         |
| 同一 SVG 被普通图片元素消费           | 解码完成，naturalWidth／naturalHeight 为 8／8        | 不通过删除 SVG 类型来关闭文档能力；图片消费保持            | `styledSvgStillDecodesAsImage`；真实 WK 资源完成回执，无视觉快照              |
| 文件缺失或读取失败                    | 固定 404 文本与类型不变，策略头仍存在                | 不泄漏目录、用户内容或原始内部错误                         | 原有 404 脱敏回归与新增响应头断言                                             |
| 读取中止、替换或并发容量耗尽          | 沿既有取消／身份／闸门协议完成，原字节所有权不变     | 没有在描述符打开、读取和响应交付之间新增异步阶段           | 原有 scheme 停止／容量／身份绑定测试与完整原生、Rust 回归                     |

## 执行证据

先红：Rust 响应测试观察到 CSP 头缺失；原生响应测试同时观察到 HTML／XHTML／PDF 原样 MIME、CSP 与 nosniff 缺失。修正夹具的 WebKit 异步重载标签后，真实 WK 测试确认无策略正向对照可执行脚本，生产媒体响应导航到同一 SVG 也执行了脚本；普通 SVG 图片解码仍成功。最初的 Void 返回值夹具失败不计作产品安全证据。

本地与 CI 的最终结果以对应 PR 的 SHA、正常门禁记录及自动 dev CI 证据为准。只使用临时目录中的合成 SVG 和媒体字节，不访问用户数据、公网或真实服务。

## 已知限制

实际浏览器执行覆盖 macOS 的原生 WKURLSchemeHandler；Rust 验证其真实协议响应类型、响应头和受信文件读取，未另行启动历史 Tauri WebView 做浏览器执行验收。策略用于隔离媒体文档脚本，不宣称对未来任意新消费者、外部子资源策略或平台新增能力提供永久审计结论。

原生覆盖率保持 report-only／minnull，前端与 Rust 80% 门槛、CPU4 与 stress opt-in 均不变。未做真实 IME 验收；视觉快照及 VoiceOver 验收保持所有者已取消的范围。

## 后续门禁

按本轮串行流程完成自检、正常 commit／push、draft → ready、最新 head 的真实 review 与全部必需 CI。普通合并 dev 后核实远端修复、关闭 issue、只清理本任务分支与自有生成物、快进 dev，并观察自动 dev CI；完成之前不开始下一项。
