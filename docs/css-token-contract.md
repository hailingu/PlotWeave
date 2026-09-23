# CSS 令牌静态契约

本页是 [PR #288](https://github.com/hailingu/PlotWeave/pull/288) 的支持范围与问题族矩阵入口，承接 [issue #278](https://github.com/hailingu/PlotWeave/issues/278)；分轮审查记录已从当前文档树移除，历史事实保留在 Git 中，不再各自定义当前范围。产品配色决策仍以 [UI 设计 §2.1](ui-design.md#21-三层结构) 和 §2.3、§2.6 为准。

上一修订 `f90cbf5` 修复审查 [5286363682](https://github.com/hailingu/PlotWeave/pull/288#pullrequestreview-5286363682) 的三个 P2 漏检。本次处理其首轮后续审查 [5286571379](https://github.com/hailingu/PlotWeave/pull/288#pullrequestreview-5286571379)：根令牌嵌套样式规则漏检、含图像背景简写经长形重置后的误报，均为 F2 已承诺范围的新触发条件。review 轮次与预算规则不变。

## 支持、拒绝和保留边界

“支持”只保证下表列出的静态性质；“拒绝”表示入口会失败；“保留边界”表示该性质未被证明，不能把测试通过解释成浏览器渲染正确。不会把任意 CSS 都当作这个静态模型的输入语言。

| 问题族 | 支持的静态性质 | 明确拒绝 | 保留边界与理由 |
| --- | --- | --- | --- |
| F1 全局所有权 | 带 PostCSS `from` 的真实组件表逐表扫描；`tokens.css` 是全局定义源。检查选择器列表、媒体内无消费者的定义；简单组合器链终点为 `html`/`body`/`:root`，或全局链终点为通配的定义均受约束 | 组件全局定义 `TOKEN_GLOBAL_OUTSIDE_SOURCE`；`@property` 注册；根源中非 `:root` 的已识别文档选择器 `TOKEN_ROOT_SELECTOR_UNMODELED` | 完整选择器匹配、函数伪类/转义/命名空间以及跨文件局部级联未建模；全局限制是本表静态防线，不宣称覆盖所有可匹配 DOM 的表达式。无来源夹具只模拟独立级联 |
| F2 层叠取胜 | 外观 light/dark × 对比度 no-preference/more × 透明度 no-preference/reduce × 动效 no-preference/reduce；简单同元素/后代/子代、逗号分支；先最近定义元素，再重要性，再源序。根、局部、跨媒体组、黄金接线均按此适用规则 | 未建模媒体特性/值；根或局部定义的未知 at-rule；根相关样式规则嵌套 `TOKEN_ROOT_NESTING_UNMODELED`、组件内部嵌套；未建模 CSS-wide 自定义属性取值；黄金规则重复或条件化；黄金背景域外简写 `TOKEN_BACKGROUND_SHORTHAND_UNMODELED` | 完整特异性、DOM 祖先匹配、跨文件局部定义、继承前别名计算、级联层/作用域及运行时动画不由此模型证明；黄金背景仅支持单层至多一个颜色成分和一个图像成分（none/URL/渐变），未指定成分取 transparent/none；不以字符串前缀关系代替完整选择器算法 |
| F3 完整值校验 | 纯颜色属性完整顶层值及边框颜色列表；`-webkit-text-stroke` 的宽度/颜色；其余简写逐个消费完整顶层成分，颜色、图像、长度（0、px/em/rem/pt/ch/ex/vw/vh）和关键字不能掩盖未知词形。图像限背景/边框图像，SVG paint 只额外接受 URL | 空值、未知或残余词形（含连字符、下划线、引号、标点）、不相容纯颜色、非图像属性上的图像；无颜色/图像的尺寸或裸数值叶子 | 函数内部参数、完整简写的顺序/个数/互斥关系未建模。已识别顶层成分不等于整条浏览器文法合法；只支持当前静态成分集合，合法但域外语法也可能被拒绝 |
| F4 遮罩 alpha | `mask-image`/`-webkit-mask-image` 的单个 linear-gradient；静态 hex、rgb/rgba 与具名色、transparent；首末 alpha=0、内部 alpha=1 | 动态 `currentColor`、未知标识符/色标形式 `MASK_STOP_UNMODELED`；遮罩简写、边框遮罩和其他图像形式 `MASK_IMAGE_UNMODELED`；透明度不满足渐隐不变量 | 不解析元素计算色、继承/媒体动态色标、完整渐变位置/插值/多图层及像素。直接拒绝动态色标，不假定它不透明 |
| F5 引用与词法 | PostCSS `decl.value`；字符串/URL 不透明；选中主值或 fallback 的递归求值、环检测、逐环境/分支悬空检查；输出保留字面内容 | 无可用主值且无有效 fallback 的引用；值链过深；展示消费处不相容的选中值 | 不是完整 CSS tokenizer；转义标识符、任意函数语法和完整继承计算保留边界。环图保留备用路径依赖，不能与只检查选中消费路径混淆 |
| F6 发现、结构与配对 | glob 自动发现全部 src CSS，布局/动画/空表不设条数门槛；展示色及可达局部别名字面色禁用；例外绑定表/选择器/属性/值/条数并反向校验；8 个配对环境；危险底色颜色/图像成分各自层叠 | 非注册字面色、过期或扩大的例外；配对阈值不达标；危险前景或背景有效接线变化 | box-shadow 层级投影不在展示色禁用范围；#240 恒白危险前景及深色约 2.8:1、#262 品牌配对、#265 悬空引用和非文本对比度观察项沿用既有处置；不新增产品配色决策 |

展示色入口由 `isDisplayColorProp` 统一分类：`color`、标准 `-color` 长形（含厂商前缀）、`background`/`background-image`、`outline`、`text-decoration`、`text-emphasis`、`text-shadow`、`column-rule`、`fill`/`stroke`、`-webkit-text-stroke`、border 总体/四向/逻辑方向简写及颜色长形、`border-image`/`border-image-source`。标准属性名先按 ASCII 大小写归一，自定义属性名保持大小写敏感；box-shadow 与遮罩不进入展示色字面值禁用，遮罩另走 F4。

结构分类与值校验是不同契约：结构禁止组件自行写展示色，类型检查只判解析后的值是否落在上述静态子集。颜色函数/渐变内部会做字面色扫描，但不会因此证明参数文法。

F2 上下文拒绝使用稳定错误码：根未知 at-rule 或根内嵌 at-rule 为 `TOKEN_ROOT_AT_RULE_UNMODELED`；根相关样式规则嵌套为 `TOKEN_ROOT_NESTING_UNMODELED`；组件规则内嵌规则/at-rule 为 `TOKEN_SHEET_NESTING_UNMODELED`；局部定义位于非 media 上下文为 `TOKEN_LOCAL_AT_RULE_UNMODELED`。这些检查在环境筛选前执行，失活分支不能隐藏未建模布局。

## 合并后的关键状态与不变量矩阵

每族以稳定编号关联测试分组；历史重复条目合并到同一不变量。所有者和入口必须一起复核，不能只修复当前报错的调用点。

| 编号 | 前置状态 | 动作/顺序 | 可观察结果 | 不变量、所有者与入口 | 测试或验证缺口 |
| --- | --- | --- | --- | --- | --- |
| F1-a | 新组件表无消费者；文档选择器包含组合器、列表或失活媒体 | 先验证来源/定义，再做声明、局部、接线、类型扫描 | 所有入口拒绝，不能依靠同表消费发现覆盖 | 全局定义所有权不随消费者位置/导入顺序变化；`assertGlobalTokenSource` → `sheetDecls`、`localDefinitions`、`danglingRefs`、`displayTypeErrors` | `sheetTokenContractFamilies.test.ts` F1 最小例、组合例；既有边界套件 |
| F1-b | 根源、组件局部定义、全局普通属性 | 相同入口扫描；根源中的非根选择器走根取值入口 | 保留合法局部/普通属性；根源文档组合器定义明确拒绝 | 定义源例外不能掩盖根解析遗漏；`tokenValuesOf`/`assertRootContexts` | F1 对照与根入口测试；完整复杂选择器为上表边界 |
| F2-a | 根、局部或黄金声明先重要后普通；局部定义跨活跃媒体组 | 按环境筛选，再按同元素重要性与源序选胜 | 重要值在每个入口胜出；交换顺序不使普通值获胜 | 重要性规则在全部拥有者一致；`applyRootDecl`、`pickWinner`、`winningDecl` | F2 跨入口对照；`sheetTokensSemantics.test.ts` 根/局部/跨组/黄金用例 |
| F2-b | 自身/近祖先/远祖先定义同名，最近定义失效 | 先最近元素，后同元素级联，再 fallback | 自身优先于祖先重要性；有效回退恢复、无效回退报错 | 失败不能借被遮蔽值恢复；`nearestDefinitions` → `valueScopeIn` → `displayValueIn`/`unresolvedRefsIn` | 既有继承、逐选择器、fallback 用例；完整 DOM 继承未验证 |
| F2-c | 危险背景为纯色、仅图像、图像+颜色或 none；颜色/图像长形前后交错，含重要性/大小写 | 先按各成分选胜出声明，再展开所选简写；未指定成分重置为 transparent/none | image:none 仅清除图像并保留简写颜色；color 长形仅换色并保留图像；重要简写不被普通长形覆盖 | 长形只覆盖自身成分；`backgroundPaint`/`winningDecl` | `sheetTokens.test.ts` F2-c 既有用例及图像+颜色最小例、合法对照、顺序/重要性组合；黄金接线只投影单层颜色/图像成分，完整背景文法和其他长形不承诺，域外简写显式拒绝 |
| F2-d | 根令牌内含嵌套样式规则，含 &、列表、多层或媒体中间层；可无直接令牌/消费者 | 在媒体筛选及值提取前检查自定义属性的整条规则祖先链 | 根相关嵌套声明报 TOKEN_ROOT_NESTING_UNMODELED，失活媒体也不能掩盖；平铺根和外层媒体根保留 | 不得以未解析嵌套覆盖的旧根值验证消费者；`assertRootContexts` → `tokenValuesOf`/真实 `tokenValues` | `sheetTokenContractFamilies.test.ts` F2-d 最小例、组合和正常对照；组件入口沿用既有 TOKEN_SHEET_NESTING_UNMODELED；不含根令牌的无关规则保持原范围 |
| F3-a | 未知连字符值、引号或残余词形，单独或与合法颜色/图像组合 | 原值/别名/选中 fallback 到达属性校验 | 拒绝整个值；不能空集合通过，也不能见一个颜色即通过 | 所有顶层成分必须完整识别；`colorTypeOk` → `displayTypeErrors` | F3 最小反例、合法对照、颜色/图像混合反例 |
| F3-b | 根别名/局部值/重要媒体值切换；消费点为选择器列表 | 先求胜出值，再检查实际选中路径 | 仅错误环境/分支报告；有效主值的未选 fallback 不误报 | 类型与接线共用求值，边界不能因入口不同失效 | F3 组合场景与既有纯色/图像/fallback 套件 |
| F4-a | 透明前景，内部遮罩色标为 currentColor | `sheetDecls` → 遮罩分类 → alpha 校验 | 显式拒绝动态色标，不返回 [0,1,0] | alpha 只能由已建模静态值确定；`expectMaskFade`/`maskStopAlphas`/`stopAlpha` | F4 最小反例，含厂商前缀、媒体、大小写及未知词形 |
| F4-b | 合法静态渐隐、内部半透明、简写/非图像长形 | 通过相同遮罩入口 | 合法静态值通过；alpha 错误或域外图像失败；尺寸类跳过 | 分类、剖析、断言不能各有缺口 | 既有遮罩用例 + F4 静态具名色对照；动态计算色与像素未运行 |
| F5-a | 字符串/URL/注释混合真实引用；主值有效、缺失、initial、断链或循环 | PostCSS 解析，再构图/选路径/类型验证 | 不透明内容保留；选中路径恢复或报告；真实备用依赖仍入环图 | 词法边界与求值一致；`maskCssOpaque`、`allVarRefs`、`resolveChain`、引用/类型入口 | `sheetTokenReferences.test.ts` 及语义套件；PostCSS 注释误报的既有回归保留 |
| F6-a | 新 CSS、局部字面别名或例外改值/条数/属性 | 发现 → 可达消费闭包 → 结构/接线与例外反向检查 | 新表自动检查；未审计变化报错；失效例外须删除 | 覆盖和豁免不依赖偶然文件布局；真实 glob、`displayConsumedDefs` 和两张例外表 | `sheetTokens.test.ts`；真实 glob 临时探针，运行后删除 |
| F6-b | 浅深、more、降透明度及 hover 配对 | 固定令牌承载面对比度与黄金接线 | primary ≥4.5，secondary more ≥4.5；危险恒白按 #240 | 配对与产品已接受决策一致；配对/危险契约 | 8 环境既有测试；非文本对比度、#262/#265 仍按既有处置 |

无应用生命周期、并发、重试、持久化或数据模型变更，这些维度不适用。

## 独立依据与验证方法

期望值依据规范手工确定，不使用被测引擎生成预期结果：

- F1：[自定义属性继承](https://www.w3.org/TR/css-variables-1/#defining-variables) 与 [样式表导入](https://www.w3.org/TR/css-cascade-5/#at-import) 说明，另表定义在 body 的变量仍影响后代；所有权拒绝是项目为避免跨表模拟采用的约束。
- F2：[级联顺序](https://www.w3.org/TR/css-cascade-5/#cascade-sort)、[继承](https://www.w3.org/TR/css-cascade-5/#inheriting) 与 [简写](https://www.w3.org/TR/css-cascade-5/#shorthand) 分别支撑重要性、指定/继承优先与长形独立覆盖。
- F2-d：[CSS Nesting 的 & 选择器](https://www.w3.org/TR/css-nesting-1/#nest-selector)（工作草案）解释嵌套声明为何仍能命中父规则元素；本契约采用拒绝方案。F2-c：[background 简写](https://www.w3.org/TR/css-backgrounds-3/#background) 将颜色/图像分别设置为指定值或初始值，后续长形只覆盖对应属性；手工预期不使用被测投影函数生成。
- F3：[变量替换后的文法检查](https://www.w3.org/TR/css-variables-1/#invalid-variables) 说明，变量存在不代表消费属性合法；[值语法](https://www.w3.org/TR/css-values-4/#value-defs) 支撑完整成分识别。简写完整文法与函数内部参数仍按上表披露。
- F4：[currentColor](https://www.w3.org/TR/css-color-4/#currentcolor-color) 取同一元素的 color；transparent 的 alpha 为 0。动态色标必须求值或拒绝，本 PR 采用拒绝。
- F5 的环、主值/fallback、词法不透明依据 [CSS Variables](https://www.w3.org/TR/css-variables-1/#cycles) 与 PostCSS 实际解析入口；F6 的阈值及配色例外依据 UI 设计 §2.3、§2.6，产品阈值不由实现反推。

`f90cbf5` 红绿记录（Node 24.18.0，仓库根目录；本次验证另记）：

- `npm test -- src/styles`：Red 为 25 失败 / 282 通过。F1 文档覆盖 10 项、F3 词形与组合 11 项、F4 动态/未知色标 4 项均因预期漏检失败；F2 跨入口对照直接通过，未虚构该路径的新缺陷。
- 第一次 Green 检查保住了合法对照：既有 `filled double-circle` 暴露关键字集合遗漏，补入完整关键词后 `npm test -- src/styles` 为 307/307 通过。原先该词恰好依靠连字符漏扫描通过，本次按完整语法成分识别。
- 浏览器计算样式探针尝试被 Browser Use 的本地文件 URL 安全策略阻止，未执行、未绕过；临时 HTML 已删除。独立依据采用上列 W3C 规范与手工预期值，不声称浏览器或 WebView 实测通过。
- 真实 glob：逐次创建 `src/styles/review-5286363682-probe.css`，执行 `npm test -- src/styles/sheetTokens.test.ts`。F1 无消费者 `html > body` 报 `TOKEN_GLOBAL_OUTSIDE_SOURCE`；F3 别名 `not-a-color` 被真实类型扫描点名；F4 透明 color + currentColor 遮罩报 `MASK_STOP_UNMODELED`。三次均预期失败，探针已删除。
- 完整路由：`npm run format:check && npm run lint && npm run typecheck:strict && npm run build && npm test` 通过，152 文件 / 2149 项；构建产物 `dist/` 在完成前删除。首次验证发现 ES 目标不支持 `Array.at`/`replaceAll`，已改用索引/正则替换，未修改目标库或依赖。
- `git diff --check` 通过。文件/最长函数代码行：值模块 229/26、引擎 745/32、真实契约测试 960/70、语义测试 954/70、边界测试 319/58、新问题族测试 176/57；均满足 800/1800/80 硬上限。F6 原有长测试分组按全表扫描与闭包/反向校验拆开，断言保留。引擎超过 600 行讨论阈值，保留原因是本轮仅更换两个既有入口共享的文档选择器判定，没有扩展完整层叠职责；由仓库维护者在下一次修改该引擎时复核。既有 70 行分组为同一契约的并列案例，未扩张。圈复杂度未配置工具，以函数跨度和控制流人工复核。
- 文档路径没有配置自动行为检查；已结构化核对统一矩阵、设计 §2.1、代码头注、错误码、历史记录映射和外部规范依据。数据模型、产品配色、review 预算及治理文件不变。Rust 源码未改，Rust 变更路由不适用；提交/推送钩子仍须生成新鲜前端/Rust 覆盖率并通过 Sonar，结果以 PR 当前修订的验证记录为准。

## 审查 5286571379 的验证与处置

两条均为真实 P2 契约缺陷，触发条件不同于前轮，不是重复意见；本轮是 `f90cbf5` 的首次后续审查，没有调整预算或把完整 CSS 文法纳入范围。所有测试追加至上面的 F2-c/F2-d，不另建分轮矩阵。

- **F2-d**：根嵌套最小例、无直接根声明、选择器列表、重要性、多层嵌套、媒体位于规则内/外/中间层共 8 个反例，在 light/dark 两环境均显式拒绝；平铺根/外层媒体、无关局部嵌套与根下普通属性保持原范围。真实 `tokens.css` 注入 `:root { & { --text-primary: 4px } }` 时，全表测试报 `TOKEN_ROOT_NESTING_UNMODELED`，原文件已原样恢复。
- **F2-c**：5 个图像+颜色经长形清图的合法场景，7 个纯色/none/初始重置/颜色覆盖/重要性/源序对照，2 个域外输入拒绝；既有图像保留断言更新为真正独立的图像成分。图像成分分类复用 `cssColorContract.imageKind`，没有复制图像语法。真实危险规则注入 `url(a.png) var(--danger)` 后追加 `background-image: none` 时全表通过；不追加重置时仍因图像存在失败，原文件已原样恢复。
- **Red → Green**：`npm test -- src/styles/sheetTokenContractFamilies.test.ts src/styles/sheetTokens.test.ts` 修复前 21 失败 / 73 通过，失败包含 20 个新增反例和 1 个既有图像分量预期；新增测试总计 23 项。修复后 `npm test -- src/styles` 为 330/330 通过。
- **完整路由**：Node 24.18.0，仓库根目录执行 `npm run format:check && npm run lint && npm run typecheck:strict && npm run build && npm test` 全通过，152 文件 / 2172 项。`git diff --check` 通过；临时探针已恢复，本次 `dist/` 在完成前删除。Git 门禁最终结果记录于 PR 当前修订。
- **结构复核**：值模块 229 行、根引擎 767 行、真实契约测试 1041 行、问题族测试 207 行；最长函数分别为 26/32/70/57 代码行，符合硬上限。引擎和真实测试超过 600/1000 行讨论阈值，根预检仍归根取值入口，背景投影与真实黄金断言共同演进；本次保留内聚文件以避免把测试私有能力变成跨模块接口，风险为继续增长。补偿为 F2-c/F2-d 与真实入口探针；责任人为仓库维护者，下次实质修改对应文件时复核拆分。既有 70 行分组未扩张；圈复杂度无配置工具，以 AST 函数跨度和控制流人工复核。
- **缺口**：无新增浏览器/WebView 实测，独立预期使用上列 Nesting 工作草案与 Backgrounds 规范。完整背景文法、函数参数、复杂选择器仍按支持表保留；产品配色、数据模型及治理预算不变。文档没有自动行为检查，已结构化复核范围、矩阵、设计和错误码。

以下两条为待发布回复草稿；修复已随 `99b0ba9` 推送，提交/推送门禁及 [CI #109](https://github.com/hailingu/PlotWeave/actions/runs/35815107384) 均通过。未获线程发帖指令，尚未回复或标记 resolved。

### [根令牌原生嵌套](https://github.com/hailingu/PlotWeave/pull/288#discussion_r4078777166)

1. **处置** — 已由 `99b0ba9` 修复并推送，真实 P2 缺陷，接受新的根嵌套触发证据。
2. **理由与变更** — `assertRootNesting` 在环境筛选前沿自定义属性完整规则祖先链识别根相关嵌套，报 `TOKEN_ROOT_NESTING_UNMODELED`；不再把最近的 `&` 当作与根无关的规则而返回旧值。组件原有拒绝边界不变。
3. **验证** — F2-d 8 个反例先失败后通过，两环境、正常对照及真实 tokens.css 注入均符合预期；样式 330 项、完整前端 2172 项通过。
4. **后续** — 本条实现完成；保持不支持完整 CSS 嵌套解析的边界，提交与发布状态以最终 PR 记录为准。

### [含图像简写的颜色成分](https://github.com/hailingu/PlotWeave/pull/288#discussion_r4078777172)

1. **处置** — 已由 `99b0ba9` 修复并推送，真实 P2 误报，接受图像随后被长形重置的新触发条件。
2. **理由与变更** — `backgroundPaint` 分别选胜出声明，`shorthandPaint` 从已建模单层简写提取颜色和图像并补齐初始值；保留重要性、源序和另一成分。域外简写明确报错，不以部分提取放行。
3. **验证** — F2-c 14 个新场景及既有回归通过；真实危险规则清图时通过、保留图像时失败。规范依据为 CSS Backgrounds 的简写展开规则；完整前端 2172 项通过。
4. **后续** — 本条实现完成；多层和完整背景文法仍保留边界，提交与发布状态以最终 PR 记录为准。

## 历史证据

12 份分轮审查记录已归并到 F1–F6，按仓库所有者要求删除当前文件；原始记录可从 [整理前的 Git 修订](https://github.com/hailingu/PlotWeave/tree/99b0ba9eca558a4e3e4ac721cee8a627d59a534f/docs/reviews) 查阅。当前测试与设计只引用本页的契约和矩阵，避免继续维护多份状态说明。此次整理只删除历史记录并更新引用，没有改变代码行为或 review 预算；没有为文档删除制造行为测试，按文档路由结构化复核，并因测试注释路径更新运行前端路由。

## 审查 5286363682 的线程回复草稿

以下为原线程的待发布处置，发布前需绑定修复提交和最终门禁证据；文档记录不等于已在 GitHub 线程回复。

### [文档级组合器覆盖](https://github.com/hailingu/PlotWeave/pull/288#discussion_r4078604751)

1. **处置** — 已由 `f90cbf5` 修复并推送，真实 P2 漏检。
2. **理由与变更** — `isDocumentTokenSelector` 按简单链终点判断文档级覆盖，组件所有权和根选择器预检共用；`html > body`、列表/媒体及全局通配链不能依靠无消费者漏过。完整复杂选择器仍为明确保留边界。
3. **验证** — F1 的 10 个反例先失败后通过；四个组件扫描入口、根取值入口和合法局部/全局普通属性对照均覆盖；真实 glob 探针拒绝。
4. **后续** — 本条实现完成；提交、门禁和原线程发布状态以最终 PR 记录为准。

### [未知连字符值](https://github.com/hailingu/PlotWeave/pull/288#discussion_r4078604755)

1. **处置** — 已由 `f90cbf5` 修复并推送，真实 P2 漏检。
2. **理由与变更** — `colorTypeOk` 对简写逐个检查完整顶层成分，取消空匹配集合通过和发现任一颜色/图像即通过；合法连字符关键字显式识别。函数内部参数和完整简写顺序/互斥保留边界，不宣称完成浏览器文法验证。
3. **验证** — F3 的 11 个反例/组合先失败后通过；未知值单独或混入颜色/图像、根/局部/媒体/重要性/选中 fallback 均覆盖；合法对照与真实 glob 探针通过预期判断。
4. **后续** — 本条实现完成；提交、门禁和原线程发布状态以最终 PR 记录为准。

### [currentColor 遮罩透明度](https://github.com/hailingu/PlotWeave/pull/288#discussion_r4078604758)

1. **处置** — 已由 `f90cbf5` 修复并推送，真实 P2 漏检，采用明确拒绝动态色标的方案。
2. **理由与变更** — `stopAlpha` 只对静态具名色返回 1；`currentColor`、系统色、未知标识符均报 `MASK_STOP_UNMODELED`。静态颜色名单与结构探测共用 `isNamedColor`，不复制颜色表。
3. **验证** — F4 的 4 个反例先失败后通过；厂商前缀、媒体、大小写及静态正反例保留；真实 glob 拒绝。独立预期来自 CSS Color 4；浏览器探针被安全策略阻止，未声称像素验证。
4. **后续** — 本条实现完成；动态计算色/完整渐变文法仍为披露边界，提交、门禁和原线程发布状态以最终 PR 记录为准。
