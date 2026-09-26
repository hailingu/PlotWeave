# CSS 令牌静态契约

本页是 [PR #288](https://github.com/hailingu/PlotWeave/pull/288) 的支持范围与问题族矩阵入口，承接 [issue #278](https://github.com/hailingu/PlotWeave/issues/278)；分轮审查记录已从当前文档树移除，历史事实保留在 Git 中，不再各自定义当前范围。产品配色决策仍以 [UI 设计 §2.1](ui-design.md#21-三层结构) 和 §2.3、§2.6 为准。

当前实施状态以 F1–F6 支持边界表与合并不变量矩阵为准；PR #288 后期八轮审查（5286363682–5287668653）的修复落点对应关系见文末「审查轮次索引」，更早十二轮的记录入口亦在该节，未解决边界见下方登记。

## 支持、拒绝和保留边界

“支持”只保证下表列出的静态性质；“拒绝”表示入口会失败；“保留边界”表示该性质未被证明，不能把测试通过解释成浏览器渲染正确。不会把任意 CSS 都当作这个静态模型的输入语言。

| 问题族 | 支持的静态性质 | 明确拒绝 | 保留边界与理由 |
| --- | --- | --- | --- |
| F1 全局所有权 | 带 PostCSS `from` 的真实组件表逐表扫描；`tokens.css` 是全局定义源。检查选择器列表、媒体内无消费者的定义；简单组合器链终点为 `html`/`body`/`:root`，或全局链终点为通配的定义均受约束 | 组件全局定义 `TOKEN_GLOBAL_OUTSIDE_SOURCE`；`@property` 注册；根源中非 `:root` 的已识别文档选择器 `TOKEN_ROOT_SELECTOR_UNMODELED` | 完整选择器匹配、函数伪类/转义/命名空间以及跨文件局部级联未建模；全局限制是本表静态防线，不宣称覆盖所有可匹配 DOM 的表达式。无来源夹具只模拟独立级联 |
| F2 层叠取胜 | 外观 light/dark × 对比度 no-preference/more × 透明度 no-preference/reduce × 动效 no-preference/reduce；简单同元素/后代/子代、逗号分支，子代组合器可有或无空白；先最近定义元素，再重要性，再以实际胜出声明源序决定跨条件组取胜。根、局部、跨媒体组、黄金接线均按此适用规则 | 未建模媒体特性/值；根或局部定义的未知 at-rule；根相关样式规则嵌套 `TOKEN_ROOT_NESTING_UNMODELED`、组件内部嵌套；未建模 CSS-wide 自定义属性取值；黄金规则重复或条件化；黄金背景域外简写 `TOKEN_BACKGROUND_SHORTHAND_UNMODELED` | 完整特异性、DOM 祖先匹配、跨文件局部定义、继承前别名计算、级联层/作用域及运行时动画不由此模型证明；黄金背景仅支持单层至多一个颜色成分和一个图像成分（none/URL/渐变），颜色成分复用 F3 的完整颜色识别（含 transparent、具名色和 currentColor），不要求数值 RGBA 转换；未指定成分取 transparent/none；不以字符串前缀关系代替完整选择器算法 |
| F3 完整值校验 | 纯颜色属性完整顶层值及边框颜色列表；`-webkit-text-stroke` 的宽度/颜色；其余简写逐个消费完整顶层成分，颜色、图像、长度（0、px/em/rem/pt/ch/ex/vw/vh）和关键字不能掩盖未知词形。`background-image` 只接受非空图像/none 列表，`border-image-source` 只接受单个图像/none，`border-image` 简写接受已识别图像成分或单独 none，不接受颜色或其他通用简写关键字；图像限 URL 与 linear/radial/conic 渐变（含 repeating），SVG paint 只额外接受 URL | 空值、未知或残余词形（含连字符、下划线、引号、标点）、不相容纯颜色、图像长形上的颜色/尺寸/简写关键字、空图像列表项及 source 多项、`border-image` 简写中的普通颜色、通用边框关键字或与图像混用的 none、非图像属性上的图像；无颜色/图像的尺寸或裸数值叶子 | 函数内部参数、完整简写的顺序/个数/互斥关系未建模。已识别顶层成分不等于整条浏览器文法合法；只支持当前静态成分集合，合法但域外语法也可能被拒绝 |
| F4 遮罩 alpha | `mask-image`/`-webkit-mask-image` 的单个完整且括号平衡的 linear-gradient；静态 hex、逗号/空格 RGB(A)（函数名 ASCII 大小写不敏感）与具名色、transparent；首末 alpha=0、内部 alpha=1 | 动态 `currentColor`、未知标识符/色标形式 `MASK_STOP_UNMODELED`；遮罩简写、边框遮罩、其他图像形式、多图层及渐变后的尾随内容 `MASK_IMAGE_UNMODELED`；透明度不满足渐隐不变量 | 不解析元素计算色、继承/媒体动态色标、完整 RGB 参数文法、渐变位置/插值及像素。多图层直接拒绝，不推断其合成后的 alpha |
| F5 引用与词法 | PostCSS `decl.value`；字符串/URL 不透明；`var()` 函数名按 ASCII 不区分大小写，未转义非 ASCII 自定义属性名完整保留且大小写敏感；选中主值或 fallback 的递归求值（依赖/fallback 嵌套链深 ≤ 32 层）、环检测、逐环境/分支悬空检查；同级并列引用以游标迭代消解，不递增链深、不受调用栈深度约束（issue #349）；输出保留字面内容 | 无可用主值且无有效 fallback 的引用，包括函数名大小写变体；依赖/fallback 嵌套链深超过 32 层；展示消费处不相容的选中值 | 不是完整 CSS tokenizer；转义函数/标识符、任意函数语法和完整继承计算保留边界。环图保留备用路径依赖，不能与只检查选中消费路径混淆。「完整保留」含名称末端 NBSP 等有效非 ASCII 码点（issue #289：各 var() 入口已统一按 CSS 空白集裁剪，JS `.trim()` 移除） |
| F6 发现、结构与配对 | glob 自动发现全部 src CSS，布局/动画/空表不设条数门槛；展示色及可达局部别名字面色禁用；例外绑定表/选择器/属性/值/条数并反向校验；8 个配对环境；危险底色颜色/图像成分各自层叠 | 非注册字面色、过期或扩大的例外；配对阈值不达标；危险前景或背景有效接线变化 | box-shadow 层级投影不在展示色禁用范围；#240 恒白危险前景及深色约 2.8:1 和非文本对比度观察项沿用既有处置（#262 品牌配对与 #265 悬空引用均已修复移出例外表：两处品牌底消费点统一 on-brand × edge-label-bg 配对，--fill-tertiary 四环境令牌定义）；不新增产品配色决策 |

展示色入口由 `isDisplayColorProp` 统一分类：`color`、标准 `-color` 长形（含厂商前缀）、`background`/`background-image`、`outline`、`text-decoration`、`text-emphasis`、`text-shadow`、`column-rule`、`fill`/`stroke`、`-webkit-text-stroke`、border 总体/四向/逻辑方向简写及颜色长形、`border-image`/`border-image-source`。标准属性名先按 ASCII 大小写归一，自定义属性名保持大小写敏感；`box-shadow`、`filter`/`backdrop-filter`（含厂商前缀）与遮罩不进入展示色字面值禁用，遮罩另走 F4。滤镜中的 `drop-shadow()` 颜色、变量类型与函数链未建模；全表发现不等于覆盖所有 CSS 属性。此处显式列出既有属性集合之外的边界，不把滤镜用例宣称为已验证。

结构分类与值校验是不同契约：结构禁止组件自行写展示色，类型检查只判解析后的值是否落在上述静态子集。颜色函数/渐变内部会做字面色扫描，但不会因此证明参数文法。

F2 上下文拒绝使用稳定错误码：根未知 at-rule 或根内嵌 at-rule 为 `TOKEN_ROOT_AT_RULE_UNMODELED`；根相关样式规则嵌套为 `TOKEN_ROOT_NESTING_UNMODELED`；组件规则内嵌规则/at-rule 为 `TOKEN_SHEET_NESTING_UNMODELED`；局部定义位于非 media 上下文为 `TOKEN_LOCAL_AT_RULE_UNMODELED`。这些检查在环境筛选前执行，失活分支不能隐藏未建模布局。

已知边界处置：[#290](https://github.com/hailingu/PlotWeave/issues/290)（带 fallback 的令牌在配色检查中被误拒绝）已修复——`resolveChain` 支持主值/fallback 选择（深度保护不变），配对与危险底色检查路径的 fallback 形态由引用测试与配对助手测试覆盖；[#289](https://github.com/hailingu/PlotWeave/issues/289)（非 ASCII 自定义属性名末端被误当空白裁剪）已修复——各 `var()` 求值入口统一按 CSS 空白集（空格/制表/换行/回车/换页）裁剪参数，不再使用 JS `.trim()`，名称按原始码点序列匹配（含末端 NBSP 等有效码点），由同名消解、异名悬空与 fallback 组合测试覆盖；[#349](https://github.com/hailingu/PlotWeave/issues/349)（大量同级 `var` 引用可使求值器栈溢出）已修复——`resolveDisplayValue` 的同级余串由递归改为一次掩码 + 游标线性推进（栈深恒定），同级不递增链深的 #290 语义与依赖/fallback 32 层预算保留，大同级列表与深依赖两个维度由引用回归测试覆盖；[#339](https://github.com/hailingu/PlotWeave/issues/339)（NBSP 包围的取值被误判为 CSS-wide 关键字）已修复——保证无效判定（`isGuaranteedInvalid`）与展示色类型检查入口（`colorTypeOk`）的关键字/空值分类统一改用 CSS 空白集裁剪（`trimCssWhitespace` 下沉至 `cssValueSyntax` 共享，求值与类型入口不分叉），简写层/颜色列表的顶层切分（`splitCssSpace`/`splitCssComma`）同样按 CSS 空白集裁剪成分并补齐回车/换页分隔符（`postcss.list` 的成分裁剪用 JS `.trim()`，会把 NBSP 包围的标识符折算回关键字或完整颜色成分），`\u00a0unset` 按普通标识符原样消解、颜色语义照常拒绝非法值，类型诊断按同一空白语义呈现值，由 `resolveChain` 与共享显示值路径的 NBSP 回归（含普通空白/大小写对照）覆盖。当前无未解决的已登记边界。

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
| F3-d | `border-image` 简写收到颜色别名、通用边框关键字或与图像混用的 none，经根/局部/媒体选中；背景简写收到同一颜色 | 变量求值后按属性判定已识别颜色与通用关键字，再检查剩余顶层成分 | border-image 拒绝颜色、solid 等通用边框关键字和 image+none，保留单图像、单独 none 与整值 CSS-wide；background 的合法颜色保持通过 | 图像边框没有颜色源，通用关键字集合不能跨属性兜底；`shorthandLayerOk` → `colorTypeOk` → `displayTypeErrors`/真实 glob | F3-d 最小失败、合法对照与选中 fallback/媒体组合；border-image 完整 slice/width/repeat 文法仍为已知边界 |
| F4-a | 透明前景，内部遮罩色标为 currentColor | `sheetDecls` → 遮罩分类 → alpha 校验 | 显式拒绝动态色标，不返回 [0,1,0] | alpha 只能由已建模静态值确定；`expectMaskFade`/`maskStopAlphas`/`stopAlpha` | F4 最小反例，含厂商前缀、媒体、大小写及未知词形 |
| F4-b | 合法静态渐隐、内部半透明、完整渐变后尾随垃圾或第二层、括号不平衡、简写/非图像长形 | 先验证整个值恰为一个平衡 linear-gradient，再剖析色标并断言 alpha | 合法静态值通过；尾随、多层或括号错误报 `MASK_IMAGE_UNMODELED`，alpha 错误与域外图像失败；尺寸类跳过 | 分类、剖析、断言不能各有缺口；`expectMaskFade` → `maskStopAlphas`/真实 glob | F4 完整值最小反例、合法嵌套函数与厂商前缀组合；完整渐变位置语法、动态计算色与像素未运行 |
| F4-c | 单层合法遮罩的内部色标使用 `RGB`/`RgBa` 逗号或空格语法，或含半透明 alpha | 渐变与色标函数按 ASCII 不区分大小写分类，再分别解析两种 RGB 语法并断言 alpha | 大小写变体与小写合法色标同样通过；半透明内部色标仍失败 | 函数名写法不得改变静态 alpha 判定；`parsePaint`/`stopAlpha` → `maskStopAlphas` → `expectMaskFade`/真实 glob | `sheetTokens.test.ts` 正反例先失败后通过；真实 glob 合法 83/83、半透明 1 失败/82 通过；完整 RGB 参数文法与 WebView 像素仍保留边界 |
| F5-a | 字符串/URL/注释混合真实引用；主值有效、缺失、initial、断链或循环 | PostCSS 解析，再构图/选路径/类型验证 | 不透明内容保留；选中路径恢复或报告；真实备用依赖仍入环图 | 词法边界与求值一致；`maskCssOpaque`、`allVarRefs`、`resolveChain`、引用/类型入口 | `sheetTokenReferences.test.ts` 及语义套件；PostCSS 注释误报的既有回归保留；NBSP 包围的关键字取值不误判为保证无效或合法关键字（issue #339：`resolveChain` 与共享显示值路径回归，普通 CSS 空白/大小写对照保留） |
| F5-b | 函数名为 `VAR`/混合大小写、属性名 `--Foo`/`--foo` 并存；引用位于普通声明、根/局部别名、选中或未选 fallback、字符串/URL | 保持原值和偏移，仅以 ASCII 不区分大小写识别函数名；按原样查找自定义属性名，再构图、选择主值或 fallback 并作类型/悬空检查 | 缺失的真实引用被点名；合法别名与选中 fallback 正确求值；未选路径不误报，字符串/URL 不构成引用；大小写不同的属性名不互认 | 函数识别在 `variableStart`、`allVarRefs`、`resolveChain`、`unresolvedValueRefs`、`resolveDisplayValue` 间一致，属性名始终区分大小写；`sheetTokensEngine.ts` 的引用入口负责 | `sheetTokenReferences.test.ts` 红灯 8 项/绿灯 35 项、真实 glob 正反探针及样式 431 项；CSS 转义函数名与完整 tokenizer 保留边界；带 fallback 的引用消解已由 `resolveChain` 支持并由单元与配对测试覆盖（issue #290） |
| F5-c | 未转义非 ASCII 自定义属性名用于展示色局部别名、间接别名、备用引用或普通接线；相邻标识符内含 `var(` 或 `URL(` 字样 | 在不透明内容外按已支持标识符边界提取完整引用名，保留原样并沿可达定义闭包、求值和类型入口传播；CSS 空白分隔与非 ASCII 名称码点不混淆 | 字面展示色别名进入结构禁用；合法令牌/选中备用值通过；缺失名被点名；字符串/真实 URL 不误认，更长的非 ASCII 函数名不误遮蔽内部引用 | `maskCssOpaque` 的 URL 边界与 `allVarRefs`、`variableStart`/`resolveChain` 对未转义非 ASCII 标识符一致；`displayConsumedDefs`、`unresolvedRefsIn` 和类型入口不能分叉 | 两文件定点测试先 6 项失败后通过；真实 glob 字面别名 1 失败/82 通过、合法别名 83/83；提交前复核新加 `前URL(var(--missing))` 用例先失败后通过，最终样式 446/446；转义标识符和完整 tokenizer 保留边界；非 ASCII 名称末端裁剪已由 CSS 空白集裁剪修复（issue #289） |
| F5-d | 单值含大量同级并列 `var()` 引用（栈深极端宽度），或依赖/fallback 嵌套接近与超过 32 层预算 | 同级余串一次掩码 + 游标线性推进，栈深恒定；依赖/fallback 嵌套递归受深度上限约束 | 大同级列表正常消解、不栈溢出；超预算深依赖链按「链过深或悬空」拒绝；同级引用不消耗链深预算（#290 语义保留） | 宽度与深度两维度互不串扰；`resolveDisplayValue`（经 `maskCssOpaque` 与 `balancedCloseFrom`，括号配对与 `colorTokenOf` 同源不分叉）是唯一求值所有者 | `sheetTokenReferences.test.ts` issue #349 两条回归：8000 同级引用消解（实现前 RangeError 复现）与 40 层依赖链拒绝；同级计数的既有 33 引用测试保留 |
| F6-a | 新 CSS、局部字面别名或例外改值/条数/属性 | 发现 → 可达消费闭包 → 结构/接线与例外反向检查 | 新表自动检查；未审计变化报错；失效例外须删除 | 覆盖和豁免不依赖偶然文件布局；真实 glob、`displayConsumedDefs` 和两张例外表 | `sheetTokens.test.ts`；真实 glob 临时探针，运行后删除 |
| F6-b | 浅深、more、降透明度及 hover 配对 | 固定令牌承载面对比度与黄金接线 | primary ≥4.5，secondary more ≥4.5；错误横幅 fg/bg 四环境 ≥4.5 且接线绑定消费点（换任一声明接线即失败，issue #318）；危险恒白按 #240 | 配对与产品已接受决策一致；配对/危险契约 | 8 环境既有测试；非文本对比度仍按既有处置（#262/#265 已修复移出例外表，品牌底消费点配对由 sheetTokens BRAND_RULES 黄金接线与 more 配对采样持有） |

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
- F3-d：[border-image 简写](https://www.w3.org/TR/css-backgrounds-3/#border-image) 由图像源、切片、宽度、外扩和重复成分组成；普通 `<color>` 不在该文法内。这里仅拒绝已识别颜色成分，不宣称完整简写文法校验。
- F5-b：[CSS Syntax 的语法匹配](https://www.w3.org/TR/css-syntax-3/) 默认按 ASCII 不区分大小写，因此 `VAR(` 与 `var(` 匹配同一函数；[CSS Variables 的自定义属性名](https://www.w3.org/TR/css-variables-1/#defining-variables) 则只有码点序列相同才相等。手工据此确定正反例，不从被测匹配器反推预期。
- F5-c：[CSS Syntax 3 的 ident 码点分类](https://www.w3.org/TR/css-syntax-3/) 将非 ASCII 码点纳入标识符，CSS 空白仅为空格、制表符、换行、回车与换页；[CSS Variables 1](https://www.w3.org/TR/css-variables-1/#defining-variables) 规定自定义属性名按原始码点序列匹配。因此未转义的 `--前景`、`--café` 等须完整保留，`前URL(` 也不能按独立 `URL(` 函数遮蔽内容；转义标识符仍按上表留界。
- 滤镜边界：[drop-shadow()](https://www.w3.org/TR/filter-effects-1/#funcdef-filter-drop-shadow) 确实允许颜色，审查现象成立；[审查前的属性范围](https://github.com/hailingu/PlotWeave/blob/65be8cdc66ae656b5160bf388261f617150d0806/docs/css-token-contract.md#支持拒绝和保留边界) 已列明展示色集合，不包含滤镜。当前真实 CSS 仅使用 blur/none，无 drop-shadow；本次按既有 P3 范围扩展规则记录，不以无消费者推断未来安全。
- F4：[currentColor](https://www.w3.org/TR/css-color-4/#currentcolor-color) 取同一元素的 color；transparent 的 alpha 为 0。动态色标必须求值或拒绝，本 PR 采用拒绝。
- F4-b：[mask-image](https://www.w3.org/TR/css-masking-1/#the-mask-image) 的值可以是多图层列表；本契约只接受其中的单个完整 linear-gradient，尾随内容或额外图层不能被剖析器忽略。
- F4-c：[CSS Syntax 3](https://www.w3.org/TR/css-syntax-3/) 的语法匹配默认 ASCII 不区分大小写，故已支持的 `rgb()`/`rgba()` 色标不能仅因函数名写成 `RGB()`/`RgBa()` 而改变 alpha 判定。
- F5 的环、主值/fallback、词法不透明依据 [CSS Variables](https://www.w3.org/TR/css-variables-1/#cycles) 与 PostCSS 实际解析入口；F6 的阈值及配色例外依据 UI 设计 §2.3、§2.6，产品阈值不由实现反推。

## 审查轮次索引（历史归档）

PR #288 的审查按轮处理：本页不再保留分轮叙述、运行记录或线程回复草稿，各轮的验证过程与门禁证据属于对应 Git 修订与 PR 历史运行记录；各审查线程的回复与 resolved 状态以 GitHub 原线程为准——本页删除回复草稿既不表示相应线程已回复或已解决，也不表示未回复。

下表为后期八轮（各轮曾是本页内联章节）的审查链接、针对修订与修复落点。更早的十二轮处理记录为独立文件，已按仓库所有者要求从文档树删除，仅在[整理前的 Git 修订](https://github.com/hailingu/PlotWeave/tree/99b0ba9eca558a4e3e4ac721cee8a627d59a534f/docs/reviews)保留。以下清单是**基准提交索引**——各条括注的是该轮被审修订，不是修复落点；多数轮次的最终修复提交未在归档文件中固定，当前树无法逐轮解析，需沿 PR #288 提交历史与归档文件内部叙述查阅：[5275666509](https://github.com/hailingu/PlotWeave/pull/288#pullrequestreview-5275666509)（基准 `7a0f8e0`）、[5275978899](https://github.com/hailingu/PlotWeave/pull/288#pullrequestreview-5275978899)（基准 `039d78d`，修复 `16f4b54`）、[5277799858](https://github.com/hailingu/PlotWeave/pull/288#pullrequestreview-5277799858)（基准 `1978ea6`）、[5279748560](https://github.com/hailingu/PlotWeave/pull/288#pullrequestreview-5279748560)（基准 `21fd2ac`）、[5280077466](https://github.com/hailingu/PlotWeave/pull/288#pullrequestreview-5280077466)（基准 `40a63a6`）、[5280334884](https://github.com/hailingu/PlotWeave/pull/288#pullrequestreview-5280334884)（基准 `7e3a2e5`；`sheetTokenReferences.test.ts` 头注引用本轮）、[5280542926](https://github.com/hailingu/PlotWeave/pull/288#pullrequestreview-5280542926)（基准 `6bf4c78`）、[5280837519](https://github.com/hailingu/PlotWeave/pull/288#pullrequestreview-5280837519)（基准 `9df32c9`）、[5285788301](https://github.com/hailingu/PlotWeave/pull/288#pullrequestreview-5285788301)（基准 `0b80601`）、[5285927947](https://github.com/hailingu/PlotWeave/pull/288#pullrequestreview-5285927947)（基准 `06924ed`）、[5286056434](https://github.com/hailingu/PlotWeave/pull/288#pullrequestreview-5286056434)（基准 `d775389`）、[5286221158](https://github.com/hailingu/PlotWeave/pull/288#pullrequestreview-5286221158)（基准 `8d53a7f`，修复 `e67dd51`）。

| 后期八轮审查（固定链接） | 问题族与要点（均已并入上方矩阵；括注为修复落点） |
| --- | --- |
| [5286363682](https://github.com/hailingu/PlotWeave/pull/288#pullrequestreview-5286363682)（首轮） | F1 文档级选择器所有权（`TOKEN_GLOBAL_OUTSIDE_SOURCE`）；F3 完整顶层成分校验；F4 动态色标显式拒绝（修复 `f90cbf5`） |
| [5286571379](https://github.com/hailingu/PlotWeave/pull/288#pullrequestreview-5286571379) | F2-d 根嵌套拒绝（`TOKEN_ROOT_NESTING_UNMODELED`）；F2-c 含图像简写的成分提取与长形重置（修复 `99b0ba9`） |
| [5286675799](https://github.com/hailingu/PlotWeave/pull/288#pullrequestreview-5286675799) | F3-c 图像长形类型与列表个数；滤镜颜色记录为 P3 保留边界、不建模（针对整理提交 `65be8cd`，修复落地 `0516b47`） |
| [5286812629](https://github.com/hailingu/PlotWeave/pull/288#pullrequestreview-5286812629) | F2-c 颜色成分识别统一 `completeColorAtom`：transparent/具名色/currentColor 经颜色长形覆盖后不冒充 danger（针对 `0516b47`，修复 `50d63e0`） |
| [5287145315](https://github.com/hailingu/PlotWeave/pull/288#pullrequestreview-5287145315) | F2-b 简单链空白归一；F2-a 跨条件组按胜出声明源序（针对 `50d63e0`，修复 `682e3ff`） |
| [5287311461](https://github.com/hailingu/PlotWeave/pull/288#pullrequestreview-5287311461) | F4-b 遮罩完整值校验与色标下标；F3-d border-image 拒绝颜色与通用关键字（修复 `a21d3e5`） |
| [5287535185](https://github.com/hailingu/PlotWeave/pull/288#pullrequestreview-5287535185) | F5-b `var()` 函数名 ASCII 大小写变体、自定义属性名原样匹配（修复 `8456bdb`） |
| [5287668653](https://github.com/hailingu/PlotWeave/pull/288#pullrequestreview-5287668653) | F5-c 未转义非 ASCII 自定义属性名词法；F4-c 遮罩 RGB 函数名大小写（针对 `8456bdb`，修复 `c2b1528`） |

review 轮次与预算规则不变。
