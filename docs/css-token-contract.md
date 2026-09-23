# CSS 令牌静态契约

本页是 [PR #288](https://github.com/hailingu/PlotWeave/pull/288) 的支持范围与问题族矩阵入口，承接 [issue #278](https://github.com/hailingu/PlotWeave/issues/278)；分轮审查记录已从当前文档树移除，历史事实保留在 Git 中，不再各自定义当前范围。产品配色决策仍以 [UI 设计 §2.1](ui-design.md#21-三层结构) 和 §2.3、§2.6 为准。

修订 `f90cbf5` 修复审查 [5286363682](https://github.com/hailingu/PlotWeave/pull/288#pullrequestreview-5286363682) 的三个 P2 漏检。`99b0ba9` 修复其首轮后续审查 [5286571379](https://github.com/hailingu/PlotWeave/pull/288#pullrequestreview-5286571379)：根令牌嵌套样式规则漏检、含图像背景简写经长形重置后的误报，均为 F2 已承诺范围的新触发条件。`0516b47` 处理审查 [5286675799](https://github.com/hailingu/PlotWeave/pull/288#pullrequestreview-5286675799) 首次针对整理提交 `65be8cd`：图像长形误收颜色属于 F3 的 P2 缺陷；滤镜颜色检查是此前属性集合之外的 P3 范围扩展建议，记录边界、不扩充解析器。审查 [5286812629](https://github.com/hailingu/PlotWeave/pull/288#pullrequestreview-5286812629) 首次针对 `0516b47`，补充 F2-c 的透明色简写经颜色长形覆盖这一真实 P2 误报。最新审查 [5287145315](https://github.com/hailingu/PlotWeave/pull/288#pullrequestreview-5287145315) 首次针对 `50d63e0`，指出 F2 的子代组合器空白差异与条件组胜出源序两条新触发条件；均为既有简单选择器/层叠契约内的 P2 缺陷。review 轮次与预算规则不变。

## 支持、拒绝和保留边界

“支持”只保证下表列出的静态性质；“拒绝”表示入口会失败；“保留边界”表示该性质未被证明，不能把测试通过解释成浏览器渲染正确。不会把任意 CSS 都当作这个静态模型的输入语言。

| 问题族 | 支持的静态性质 | 明确拒绝 | 保留边界与理由 |
| --- | --- | --- | --- |
| F1 全局所有权 | 带 PostCSS `from` 的真实组件表逐表扫描；`tokens.css` 是全局定义源。检查选择器列表、媒体内无消费者的定义；简单组合器链终点为 `html`/`body`/`:root`，或全局链终点为通配的定义均受约束 | 组件全局定义 `TOKEN_GLOBAL_OUTSIDE_SOURCE`；`@property` 注册；根源中非 `:root` 的已识别文档选择器 `TOKEN_ROOT_SELECTOR_UNMODELED` | 完整选择器匹配、函数伪类/转义/命名空间以及跨文件局部级联未建模；全局限制是本表静态防线，不宣称覆盖所有可匹配 DOM 的表达式。无来源夹具只模拟独立级联 |
| F2 层叠取胜 | 外观 light/dark × 对比度 no-preference/more × 透明度 no-preference/reduce × 动效 no-preference/reduce；简单同元素/后代/子代、逗号分支，子代组合器可有或无空白；先最近定义元素，再重要性，再以实际胜出声明源序决定跨条件组取胜。根、局部、跨媒体组、黄金接线均按此适用规则 | 未建模媒体特性/值；根或局部定义的未知 at-rule；根相关样式规则嵌套 `TOKEN_ROOT_NESTING_UNMODELED`、组件内部嵌套；未建模 CSS-wide 自定义属性取值；黄金规则重复或条件化；黄金背景域外简写 `TOKEN_BACKGROUND_SHORTHAND_UNMODELED` | 完整特异性、DOM 祖先匹配、跨文件局部定义、继承前别名计算、级联层/作用域及运行时动画不由此模型证明；黄金背景仅支持单层至多一个颜色成分和一个图像成分（none/URL/渐变），颜色成分复用 F3 的完整颜色识别（含 transparent、具名色和 currentColor），不要求数值 RGBA 转换；未指定成分取 transparent/none；不以字符串前缀关系代替完整选择器算法 |
| F3 完整值校验 | 纯颜色属性完整顶层值及边框颜色列表；`-webkit-text-stroke` 的宽度/颜色；其余简写逐个消费完整顶层成分，颜色、图像、长度（0、px/em/rem/pt/ch/ex/vw/vh）和关键字不能掩盖未知词形。`background-image` 只接受非空图像/none 列表，`border-image-source` 只接受单个图像/none；图像限 URL 与 linear/radial/conic 渐变（含 repeating），SVG paint 只额外接受 URL | 空值、未知或残余词形（含连字符、下划线、引号、标点）、不相容纯颜色、图像长形上的颜色/尺寸/简写关键字、空图像列表项及 source 多项、非图像属性上的图像；无颜色/图像的尺寸或裸数值叶子 | 函数内部参数、完整简写的顺序/个数/互斥关系未建模。已识别顶层成分不等于整条浏览器文法合法；只支持当前静态成分集合，合法但域外语法也可能被拒绝 |
| F4 遮罩 alpha | `mask-image`/`-webkit-mask-image` 的单个 linear-gradient；静态 hex、rgb/rgba 与具名色、transparent；首末 alpha=0、内部 alpha=1 | 动态 `currentColor`、未知标识符/色标形式 `MASK_STOP_UNMODELED`；遮罩简写、边框遮罩和其他图像形式 `MASK_IMAGE_UNMODELED`；透明度不满足渐隐不变量 | 不解析元素计算色、继承/媒体动态色标、完整渐变位置/插值/多图层及像素。直接拒绝动态色标，不假定它不透明 |
| F5 引用与词法 | PostCSS `decl.value`；字符串/URL 不透明；选中主值或 fallback 的递归求值、环检测、逐环境/分支悬空检查；输出保留字面内容 | 无可用主值且无有效 fallback 的引用；值链过深；展示消费处不相容的选中值 | 不是完整 CSS tokenizer；转义标识符、任意函数语法和完整继承计算保留边界。环图保留备用路径依赖，不能与只检查选中消费路径混淆 |
| F6 发现、结构与配对 | glob 自动发现全部 src CSS，布局/动画/空表不设条数门槛；展示色及可达局部别名字面色禁用；例外绑定表/选择器/属性/值/条数并反向校验；8 个配对环境；危险底色颜色/图像成分各自层叠 | 非注册字面色、过期或扩大的例外；配对阈值不达标；危险前景或背景有效接线变化 | box-shadow 层级投影不在展示色禁用范围；#240 恒白危险前景及深色约 2.8:1、#262 品牌配对、#265 悬空引用和非文本对比度观察项沿用既有处置；不新增产品配色决策 |

展示色入口由 `isDisplayColorProp` 统一分类：`color`、标准 `-color` 长形（含厂商前缀）、`background`/`background-image`、`outline`、`text-decoration`、`text-emphasis`、`text-shadow`、`column-rule`、`fill`/`stroke`、`-webkit-text-stroke`、border 总体/四向/逻辑方向简写及颜色长形、`border-image`/`border-image-source`。标准属性名先按 ASCII 大小写归一，自定义属性名保持大小写敏感；`box-shadow`、`filter`/`backdrop-filter`（含厂商前缀）与遮罩不进入展示色字面值禁用，遮罩另走 F4。滤镜中的 `drop-shadow()` 颜色、变量类型与函数链未建模；全表发现不等于覆盖所有 CSS 属性。此处显式列出既有属性集合之外的边界，不把滤镜用例宣称为已验证。

结构分类与值校验是不同契约：结构禁止组件自行写展示色，类型检查只判解析后的值是否落在上述静态子集。颜色函数/渐变内部会做字面色扫描，但不会因此证明参数文法。

F2 上下文拒绝使用稳定错误码：根未知 at-rule 或根内嵌 at-rule 为 `TOKEN_ROOT_AT_RULE_UNMODELED`；根相关样式规则嵌套为 `TOKEN_ROOT_NESTING_UNMODELED`；组件规则内嵌规则/at-rule 为 `TOKEN_SHEET_NESTING_UNMODELED`；局部定义位于非 media 上下文为 `TOKEN_LOCAL_AT_RULE_UNMODELED`。这些检查在环境筛选前执行，失活分支不能隐藏未建模布局。

## 合并后的关键状态与不变量矩阵

每族以稳定编号关联测试分组；历史重复条目合并到同一不变量。所有者和入口必须一起复核，不能只修复当前报错的调用点。

| 编号 | 前置状态 | 动作/顺序 | 可观察结果 | 不变量、所有者与入口 | 测试或验证缺口 |
| --- | --- | --- | --- | --- | --- |
| F1-a | 新组件表无消费者；文档选择器包含组合器、列表或失活媒体 | 先验证来源/定义，再做声明、局部、接线、类型扫描 | 所有入口拒绝，不能依靠同表消费发现覆盖 | 全局定义所有权不随消费者位置/导入顺序变化；`assertGlobalTokenSource` → `sheetDecls`、`localDefinitions`、`danglingRefs`、`displayTypeErrors` | `sheetTokenContractFamilies.test.ts` F1 最小例、组合例；既有边界套件 |
| F1-b | 根源、组件局部定义、全局普通属性 | 相同入口扫描；根源中的非根选择器走根取值入口 | 保留合法局部/普通属性；根源文档组合器定义明确拒绝 | 定义源例外不能掩盖根解析遗漏；`tokenValuesOf`/`assertRootContexts` | F1 对照与根入口测试；完整复杂选择器为上表边界 |
| F2-a | 根、局部或黄金声明先重要后普通；局部定义跨活跃媒体组，某组后续普通声明晚于另一组重要声明 | 按环境筛选；同组先选实际胜出声明，跨组按胜出声明的源序与重要性取胜 | 后续普通声明不能把该组较早的重要赢家挪到另一组重要赢家之后；后续重要声明可移动赢家；仅活跃组参与 | 同一声明的优先级和源序在组内/跨组一致；`effectiveDefs` → `pickWinner` → `valueScopeIn`，根/黄金入口维持既有规则 | F2 跨入口及 `sheetTokensSemantics.test.ts` 两媒体重叠、先后重要性、失活对照与 fallback 恢复；完整特异性仍保留边界 |
| F2-b | 自身/近祖先/远祖先定义同名，最近定义失效；定义和消费者对子代组合器空白写法不同 | 对简单选择器规范化空白，再检查可达、计算距离、按最近元素选值，最后处理 fallback | `.parent > .child` 与 `.parent>.child .grand` 正确继承子代定义；兄弟、词头近似及不可达分支保持拒绝；近定义优先于远祖先重要声明 | 相同简单选择器的写法不影响可达性、距离和选中值；`selectorReaches`/`inheritanceDistance` → `scopeReaches`/`nearestDefinitions` → 接线与类型入口 | F2-b 正反例、选择器列表、最近定义/重要性组合及 fallback；函数伪类、转义和完整 DOM 匹配仍为既有边界 |
| F2-c | 危险背景为纯色、透明/具名/动态颜色成分、仅图像、图像+颜色或 none；长形前后交错，含重要性/大小写 | 先按各成分选胜出声明，再用 F3 完整颜色识别展开简写；未指定成分重置为 transparent/none | image:none 仅清图；color 长形仅换色；transparent 后接 danger 颜色长形得到 danger/none，反序或重要透明简写仍为 transparent/none，不误当危险底色 | 长形只覆盖自身成分，成分识别不得被 RGBA 数值求值能力限制；`backgroundPaint`/`winningDecl`/`completeColorAtom` | `sheetTokens.test.ts` F2-c 图像与透明色最小例、既有数值色对照、具名色/currentColor/函数色、顺序/重要性/图像组合及未知/重复成分拒绝；真实危险规则探针；完整背景文法与运行时色值计算仍不承诺 |
| F2-d | 根令牌内含嵌套样式规则，含 &、列表、多层或媒体中间层；可无直接令牌/消费者 | 在媒体筛选及值提取前检查自定义属性的整条规则祖先链 | 根相关嵌套声明报 TOKEN_ROOT_NESTING_UNMODELED，失活媒体也不能掩盖；平铺根和外层媒体根保留 | 不得以未解析嵌套覆盖的旧根值验证消费者；`assertRootContexts` → `tokenValuesOf`/真实 `tokenValues` | `sheetTokenContractFamilies.test.ts` F2-d 最小例、组合和正常对照；组件入口沿用既有 TOKEN_SHEET_NESTING_UNMODELED；不含根令牌的无关规则保持原范围 |
| F3-a | 未知连字符值、引号或残余词形，单独或与合法颜色/图像组合 | 原值/别名/选中 fallback 到达属性校验 | 拒绝整个值；不能空集合通过，也不能见一个颜色即通过 | 所有顶层成分必须完整识别；`colorTypeOk` → `displayTypeErrors` | F3 最小反例、合法对照、颜色/图像混合反例 |
| F3-b | 根别名/局部值/重要媒体值切换；消费点为选择器列表 | 先求胜出值，再检查实际选中路径 | 仅错误环境/分支报告；有效主值的未选 fallback 不误报 | 类型与接线共用求值，边界不能因入口不同失效 | F3 组合场景与既有纯色/图像/fallback 套件 |
| F3-c | 图像长形收到颜色别名、选中 fallback、混合成分、空列表项或多图层 | 变量/媒体/重要性求值后按消费属性检查完整列表 | 颜色等非图像成分拒绝；background-image 保留图像/none 多层，border-image-source 限单项；恢复合法变量后通过 | 消费属性决定成分类型与个数，不能继承 background 简写的颜色许可；`colorTypeOk` → `displayTypeErrors` → 真实 glob | `sheetTokenContractFamilies.test.ts` F3-c 最小反例、合法对照和组合；函数内部参数及完整 border-image 简写文法仍为上表边界 |
| F4-a | 透明前景，内部遮罩色标为 currentColor | `sheetDecls` → 遮罩分类 → alpha 校验 | 显式拒绝动态色标，不返回 [0,1,0] | alpha 只能由已建模静态值确定；`expectMaskFade`/`maskStopAlphas`/`stopAlpha` | F4 最小反例，含厂商前缀、媒体、大小写及未知词形 |
| F4-b | 合法静态渐隐、内部半透明、简写/非图像长形 | 通过相同遮罩入口 | 合法静态值通过；alpha 错误或域外图像失败；尺寸类跳过 | 分类、剖析、断言不能各有缺口 | 既有遮罩用例 + F4 静态具名色对照；动态计算色与像素未运行 |
| F5-a | 字符串/URL/注释混合真实引用；主值有效、缺失、initial、断链或循环 | PostCSS 解析，再构图/选路径/类型验证 | 不透明内容保留；选中路径恢复或报告；真实备用依赖仍入环图 | 词法边界与求值一致；`maskCssOpaque`、`allVarRefs`、`resolveChain`、引用/类型入口 | `sheetTokenReferences.test.ts` 及语义套件；PostCSS 注释误报的既有回归保留 |
| F6-a | 新 CSS、局部字面别名或例外改值/条数/属性 | 发现 → 可达消费闭包 → 结构/接线与例外反向检查 | 新表自动检查；未审计变化报错；失效例外须删除 | 覆盖和豁免不依赖偶然文件布局；真实 glob、`displayConsumedDefs` 和两张例外表 | `sheetTokens.test.ts`；真实 glob 临时探针，运行后删除 |
| F6-b | 浅深、more、降透明度及 hover 配对 | 固定令牌承载面对比度与黄金接线 | primary ≥4.5，secondary more ≥4.5；危险恒白按 #240 | 配对与产品已接受决策一致；配对/危险契约 | 8 环境既有测试；非文本对比度、#262/#265 仍按既有处置 |

无应用生命周期、并发、重试、持久化或数据模型变更，这些维度不适用。

## 独立依据与验证方法

期望值依据规范手工确定，不使用被测引擎生成预期结果：

- F1：[自定义属性继承](https://www.w3.org/TR/css-variables-1/#defining-variables) 与 [样式表导入](https://www.w3.org/TR/css-cascade-5/#at-import) 说明，另表定义在 body 的变量仍影响后代；所有权拒绝是项目为避免跨表模拟采用的约束。
- F2-b：[Selectors 4 子代组合器](https://www.w3.org/TR/selectors-4/#child-combinators) 允许 `>` 两侧空白省略；静态模型中同一简单链写法应有相同可达结果，兄弟组合器依然不是后代。
- F2-a：[Cascade 5 重要性与源序](https://www.w3.org/TR/css-cascade-5/#cascade-sort) 说明重要声明先于普通声明；同级冲突时比较声明自身出现顺序，不能按所在条件组的最后一条普通声明移动。
- F2：[级联顺序](https://www.w3.org/TR/css-cascade-5/#cascade-sort)、[继承](https://www.w3.org/TR/css-cascade-5/#inheriting) 与 [简写](https://www.w3.org/TR/css-cascade-5/#shorthand) 分别支撑重要性、指定/继承优先与长形独立覆盖。
- F2-d：[CSS Nesting 的 & 选择器](https://www.w3.org/TR/css-nesting-1/#nest-selector)（工作草案）解释嵌套声明为何仍能命中父规则元素；本契约采用拒绝方案。F2-c：[background 简写](https://www.w3.org/TR/css-backgrounds-3/#background) 将颜色/图像分别设置为指定值或初始值，后续长形只覆盖对应属性；手工预期不使用被测投影函数生成。[CSS Color 的 transparent](https://www.w3.org/TR/css-color-4/#transparent-color) 与 [currentcolor](https://www.w3.org/TR/css-color-4/#currentcolor-color) 均属于颜色类型；识别颜色成分不要求计算其最终 RGBA。黄金接线仍比较胜出成分的令牌字面接线，不把未覆盖的透明/动态色视为 danger。
- F3：[变量替换后的文法检查](https://www.w3.org/TR/css-variables-1/#invalid-variables) 说明，变量存在不代表消费属性合法；[值语法](https://www.w3.org/TR/css-values-4/#value-defs) 支撑完整成分识别。简写完整文法与函数内部参数仍按上表披露。
- F3-c：[background-image](https://www.w3.org/TR/css-backgrounds-3/#background-image) 的 `<bg-image>#`、`<bg-image> = <image> | none` 与 [border-image-source](https://www.w3.org/TR/css-backgrounds-3/#border-image-source) 的 `none | <image>` 独立确定长形类型、列表项及个数。图像函数参数不在本次证明范围。
- 滤镜边界：[drop-shadow()](https://www.w3.org/TR/filter-effects-1/#funcdef-filter-drop-shadow) 确实允许颜色，审查现象成立；[审查前的属性范围](https://github.com/hailingu/PlotWeave/blob/65be8cdc66ae656b5160bf388261f617150d0806/docs/css-token-contract.md#支持拒绝和保留边界) 已列明展示色集合，不包含滤镜。当前真实 CSS 仅使用 blur/none，无 drop-shadow；本次按既有 P3 范围扩展规则记录，不以无消费者推断未来安全。
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

## 审查 5287145315 的验证与处置

两条均为既有 F2 静态子集内的新 P2 触发条件。多轮遗漏的直接原因分别是可达性用原始选择器字符串前缀代替等价简单链判断，以及条件组排序跟随最后出现的声明而非真正胜出声明；此前对照覆盖了同写法和组内重要性，却未组合空白变体、最近定义、重叠媒体组及后续普通声明。修复仍限于已承诺的简单选择器与层叠范围，不扩展完整选择器引擎或预算。

- **F2-a 层叠**：`effectiveDefs` 在同选择器/条件组内只在新声明真正胜出时更新组顺序；较晚普通声明不能挪动较早的重要赢家，较晚同级或重要赢家仍按自身源序参与跨组取胜。对照含相反顺序、失活媒体、无效值 fallback 和另一活跃组恢复。
- **F2-b 可达性**：`selectorReaches` 与 `inheritanceDistance` 共用简单链规范化，将顶层 `>` 两侧可选空白归一；属性值/函数内部内容不改。覆盖同元素、子代/后代、伪类延续、最近定义覆盖远祖先重要值，以及兄弟、词头相似、选择器列表、属性引号内容的拒绝对照。
- **Red → Green**：仓库根目录、Node 24.18.0，先加 10 个问题族用例；`npm test -- src/styles/sheetTokenContractFamilies.test.ts` 为 8 项预期失败 / 83 项通过。修复后 `npm test -- src/styles` 为 398/398 通过。预期值由上方 Selectors 4 与 Cascade 5 规范独立确定，未声称浏览器/WebView 实测。
- **真实 glob**：临时 CSS 中 `.parent > .child` 定义的 `4px` 被 `.parent>.child .grand` 消费，完整 `sheetTokens.test.ts` 在 16 个环境报告类型不相容；重叠 dark/more 组的后位重要 `4px` 在 8 个匹配环境报告类型不相容，两次均为 1 失败 / 69 通过。合法组合对照 70/70 通过；初版对照没有给仅媒体内定义加 fallback，按既有 F5 接线规则正确报悬空，补齐后通过。临时 CSS 均已删除。
- **完整路由**：`npm run format:check && npm run lint && npm run typecheck:strict && npm run build` 均通过。首次 `npm test` 有 2239/2240 项通过，唯一失败为现有 `scripts/sonar-quality-gate.test.ts` 的 30 秒超时；单独重跑该文件 22/22 通过，再跑 `npm test` 为 152 文件 / 2240 项全通过。`git diff --check` 通过；文档无配置自动行为检查，已核对支持表、F2-a/F2-b 矩阵、设计 §2.1、测试和规范链接。提交/推送钩子仍须刷新前端/Rust 覆盖率并运行 Sonar，结果以 PR 当前修订为准。
- **结构与边界**：引擎 791 行、最长函数 32 行；问题族测试 407 行、最长回调不超过 60 行，满足 800/1800/80 硬上限。引擎已超过 600 行讨论阈值，本次只修改原有 F2 私有判定与排序，未增添模型维度；维护者下次实质修改时复核拆分。完整特异性、DOM 匹配、跨表局部级联、函数伪类/转义仍按支持表保留；Rust 源码、产品配色与治理预算不变。

以下为两个[原审查](https://github.com/hailingu/PlotWeave/pull/288#pullrequestreview-5287145315)线程的四字段回复草稿；本文不等于已在原线程发帖或标记 resolved。提交、完整路由、钩子和 CI 的结果以 PR 当前修订证据为准。

### [子代组合器空白差异](https://github.com/hailingu/PlotWeave/pull/288#discussion_r4079248605)

1. **处置** — 已在本次修订修复，真实 P2 可达性漏检。
2. **理由与变更** — `normalizeSimpleSelector` 对已支持简单链的顶层 `>` 空白做归一，`selectorReaches` 和 `inheritanceDistance` 共用；属性值不改，兄弟与词头相似选择器仍不可达。矩阵 F2-b 和设计 §2.1 已同步。
3. **验证** — 4 种空白写法、最近定义及负对照通过；Red 复现、Green 样式 398 项通过，真实 glob 在 16 环境点名 `4px`，依据 Selectors 4 子代组合器规则。
4. **后续** — 本条实现完成；完整 DOM/复杂选择器仍为已知边界，提交/推送门禁与原线程发布状态见 PR 验证记录。

### [跨条件组按赢家源序排序](https://github.com/hailingu/PlotWeave/pull/288#discussion_r4079248609)

1. **处置** — 已在本次修订修复，真实 P2 层叠取胜漏检。
2. **理由与变更** — `effectiveDefs` 只在组内声明取胜时移动该组；后续普通声明不改变较早重要赢家的位置，跨活跃组仍由赢家重要性和源序比较。矩阵 F2-a 和设计 §2.1 已同步。
3. **验证** — 两种顺序、后续重要对照、失活条件与无效值恢复通过；Red 复现、Green 样式 398 项通过，真实 glob 在匹配的 8 环境点名 `4px`，依据 Cascade 5 重要性/源序规则。
4. **后续** — 本条实现完成；完整特异性和复杂条件仍为已知边界，提交/推送门禁与原线程发布状态见 PR 验证记录。

## 审查 5286812629 的验证与处置

这是 `0516b47` 的首轮后续审查，一条真实 P2 误报，提供 transparent 颜色成分经长形覆盖的新触发条件；按既有 F2-c 修复，预算规则不变。根因是黄金投影用仅支持部分数值色的 `parsePaint` 判断颜色成分，而 F3 已能识别透明色、具名色和现代函数色，两个入口的颜色集合不一致。

- **变更与不变量**：黄金投影复用既有 `completeColorAtom`；保持单层、至多一个颜色/图像、未知与重复成分拒绝。只识别成分，不把 currentColor 转换为数值或扩大对比度/遮罩 alpha 的支持范围。颜色长形覆盖后保留图像；透明色最终胜出时仍保留 transparent，不能冒充 danger。矩阵直接更新 F2-c。
- **TDD**：仓库根目录、Node 24.18.0，`npm test -- src/styles/sheetTokens.test.ts` 新增 18 项，Red 为 12 失败 / 58 通过；既有 hex/令牌对照和拒绝边界直接通过。修复后 `npm test -- src/styles` 为 388/388 通过。覆盖透明色及大小写、具名色、currentColor、空格函数色、顺序/重要性、图像保留/清除和未知/重复成分。
- **真实入口**：临时修改 `.pw-dialog-danger`，分别以 transparent、currentColor 简写后接 `background-color: var(--danger)`，运行 `npm test -- src/styles/sheetTokens.test.ts` 均 70/70 通过；透明简写加 `!important` 后为 1 失败 / 69 通过，正确报告透明底色不符合 danger 接线。`editor.css` 按字节原样恢复。
- **完整路由**：`npm run format:check && npm run lint && npm run typecheck:strict && npm run build && npm test` 全通过，152 文件 / 2230 项；`git diff --check` 通过。临时探针已恢复，本次构建产物已删除。Rust 源码未改，Rust 变更路由不适用；Git 钩子仍刷新前端/Rust 覆盖率并运行 Sonar，最终门禁与提交证据记录在 PR。
- **结构复核**：值模块 247 行 / 最长函数 27 代码行，真实契约测试 1106/70；新回归分组均不超过 60 行，既有 70 行分组未增大，满足硬上限。真实测试超过 1000 行讨论阈值，保留原因是本轮更换一个已有分类调用并在同文件私有黄金投影旁增加对照，拆出私有投影会新增跨模块接口；风险为后续继续增长，由仓库维护者在下次实质修改时复核拆分。圈复杂度无配置工具，以 AST 函数跨度和控制流人工复核。
- **独立依据与缺口**：CSS Color 的 transparent/currentcolor 类型与 CSS Backgrounds 的简写展开/长形覆盖规则（链接见上方），期望手工确定。未新增浏览器/WebView 实测；完整背景文法、函数参数、运行时颜色和滤镜边界继续保留。文档无配置自动行为检查，已结构化核对代码、设计 §2.1、F2-c 矩阵、范围和规范。

以下为 [原线程](https://github.com/hailingu/PlotWeave/pull/288#discussion_r4078968642) 的待发布草稿；发布状态与本次提交编号以 PR 验证记录为准，本文不等于线程已回复或 resolved。

1. **处置** — 已在本次修订修复，真实 P2 误报，接受透明颜色成分这一新触发条件。
2. **理由与变更** — `isColorOnlyShorthand` 改用与 F3 相同的 `completeColorAtom`，取消用数值 RGBA 解析能力决定成分类型；transparent、具名色和已识别函数色经颜色长形覆盖后，图像成分仍正确提取为 none。currentColor 只分类，不求计算色；未覆盖的透明色或仍有图像的背景不会被视为 danger/none。
3. **验证** — 新增 18 项覆盖最小失败例、合法对照与相邻转换；Red 12 项预期失败，Green 样式 388 项、完整前端 2230 项通过；真实危险规则正反探针符合预期，独立依据为 CSS Color 与 CSS Backgrounds。
4. **后续** — 本条实现完成，完整文法及数值计算边界保留；提交/推送门禁与原线程发布状态见 PR 验证记录。

## 审查 5286675799 的验证与处置

本次将 40 个用例加入既有 F3 问题族的 F3-c 条目，未再建立分轮矩阵。两条意见先去重分类：图像长形是已承诺消费属性的真实 P2 类型漏检；滤镜现象成立，但属于此前明确属性集合之外的 P3 扩展建议，按现有策略记录、不修复，不改变 review 预算。

- **Red → Green**：仓库根目录、Node 24.18.0，`npm test -- src/styles/sheetTokenContractFamilies.test.ts` 修复前 24 失败 / 58 通过；失败覆盖颜色误收、空项漏检、source 多项和求值组合。修复后 `npm test -- src/styles` 为 370/370 通过。合法单项、多图层、URL/渐变内部逗号、整值 CSS-wide 关键字及 background 简写旧对照保留。
- **相邻入口**：`colorTypeOk` 的图像长形分支复用 `imageKind`，在不透明词法视图上仅切顶层逗号并保留空项；不再共用简写的颜色许可。`displayTypeErrors` 覆盖局部别名、根令牌、媒体重要性、选中/未选 fallback。完整 `border-image` 简写语法仍是既有边界，没有借长形修复宣称全语法校验。
- **真实 glob**：临时 CSS 让两个图像长形消费 `var(--text-primary)`，`npm test -- src/styles/sheetTokens.test.ts` 在 16 个环境逐一报告类型不相容（1 失败 / 51 通过）；替换为带逗号 URL、渐变及 none 的合法组合后 52/52 通过，探针已删除。
- **完整路由**：`npm run format:check && npm run lint && npm run typecheck:strict && npm run build && npm test` 全通过，152 文件 / 2212 项。首次检查与临时探针清理重叠，Prettier 报该文件 ENOENT；探针清理完成后从格式检查起完整重跑成功。未更改格式器或忽略规则，本次构建产物在完成前删除。
- **结构复核**：`git diff --check` 通过。值模块 247 行 / 最长函数 27 代码行，问题族测试 277/57，根引擎 767/32（仅一行说明更新，未增大）；均满足 800/1800/80 硬上限。引擎超讨论阈值的既有处置继续适用，无新增职责。文档无配置自动行为检查，已核对代码分类、设计 §2.1、统一范围、矩阵、规范和原线程草稿。
- **验证缺口**：独立依据采用上列 CSS Backgrounds 的两个长形文法，未新增浏览器/WebView 实测。滤镜颜色与函数链未验证，也不为这个边界添加“漏检应通过”的测试。Rust 源码未改，Rust 变更路由不适用；提交/推送仍由已启用钩子运行新鲜前端/Rust 覆盖率及 Sonar，最终证据绑定 PR 修订。

以下为原线程的四字段回复草稿；本文不会代替发帖或标记 resolved，发布状态与本次提交编号以 PR 验证记录为准。

### [图像长形误收颜色](https://github.com/hailingu/PlotWeave/pull/288#discussion_r4078873543)

1. **处置** — 已在本次修订修复，真实 P2 类型漏检。
2. **理由与变更** — `colorTypeOk` 在简写入口前调用 `imageValueOk`；`background-image` 仅接收非空图像/none 列表，`border-image-source` 限单项，颜色、尺寸和简写关键字均拒绝。继续复用 `imageKind` 与 `maskCssOpaque`，不把 URL/函数内部逗号当作图层边界。
3. **验证** — F3-c 的 40 个反例/对照/组合用例与真实 glob 探针覆盖两属性；Red 24 项预期失败，Green 样式 370 项、完整前端 2212 项通过；规范依据为 CSS Backgrounds 的长形文法。
4. **后续** — 本条实现完成；函数参数和完整简写文法继续保留边界，提交/推送门禁结果见 PR 验证记录。

### [滤镜 drop-shadow 颜色](https://github.com/hailingu/PlotWeave/pull/288#discussion_r4078873545)

1. **处置** — 不修改实现，记录为 P3 范围扩展建议；审查所述未扫描现象成立，不称为已修复或误报。
2. **理由与变更** — 审查前 `65be8cd` 的统一契约已列出 `isDisplayColorProp` 的有限属性集合，其中没有 filter/backdrop-filter。纳入 drop-shadow 需新增滤镜函数链及颜色类型契约；本轮依既有 P3 策略不扩展。现已在范围、设计与分类注释显式披露此边界。
3. **验证** — Filter Effects 规范确认 drop-shadow 接受颜色；`rg -n 'drop-shadow|backdrop-filter|(^|[ ;])filter\s*:' src --glob '*.css'` 显示真实样式仅有 blur/none。未测试或宣称滤镜颜色被保护；现有展示色套件保持通过。
4. **后续** — 若产品以后需要将滤镜纳入展示色治理，应单独定义函数链、颜色/长度、变量和 fallback 范围；本 PR 保留该边界，无待执行的滤镜代码修复。

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
