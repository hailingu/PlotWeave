# PlotWeave 数据模型设计

> 状态：v1（2026-08-28 定稿）
> 本版相对草案的修订：ProjectDocument 补 `episodeTitles` 字段；§4.2 各 spec 字段对齐 UI 设计已实现的节点形态（场景卡 sceneNo/interior/weather、对白行 kind/side/vo、分支 options 入 spec）；§5 分支边不再持久化 label 拷贝；§6 Character/Location 字段对齐运行态实体（gradient/bio/note，长篇自由文本由 SettingsDocument 承载）；§11 明确归一化管线位于前端模型层，并登记 schemaVersion 0（旧扁平存储格式）→ 1 的迁移。
>
> 定稿评审修订（2026-08-29）：§9 补 `set_episode_title` 命令（集标题变更走命令通道）；`settings.documents` 补为 SettingsDocument 的持久化位置；§10.5 `load_project` 职责更正为信封级兼容（与 §11 分层一致）；分支边 `sourceHandle` 由数组下标（option-N）改为稳定选项 id（option-\<id\>），删除选项连带其连线进同一 `batch`，杜绝下标位移导致的静默改接。
>
> 二轮评审修订（2026-08-29）：§11.1 迁移链首环写明「补选项稳定 id → 改写旧式下标句柄 → 孤儿边隔离」的先后依赖（P1）；§9 设定文档命令显式化为 `upsert_document` / `delete_document`（含 inverse 捕获）；docs/ui-design.md §10 对照清单标记全部落地。
>
> 三轮评审修订（2026-08-29）：§9.3 inverse 改为 InverseCommand 判别联合，捕获表补 inverse.type 列；ui-design §4.2 端口描述收口 option-\<id\>。
>
> 四轮评审修订（2026-08-29）：§4.2 ShotRef 契约改为 targetId 引用目标（§8.1 单一真相，显示名实时解析），label 降级为自由引用位兜底；ui-design §4.3 分支改名路由更正为 `update_node_spec`（标题由 spec.prompt 派生，不落 meta.label 镜像）。
>
> 五轮评审修订（2026-08-29）：§9.3 `connect_edge` 负载说明去掉 label（分支胶囊文案按 sourceHandle 派生）；ui-design §4.2 引用位描述统一为 `spec.refs`（删去不存在的 spec.params）；§7.3 写明项目复制的资产携带规则（索引随文档走，整目录拷贝随 §7.1 落地）。
>
> 六轮评审修订（2026-08-29）：§4.2 ShotRef 改为引用位/自由位互斥判别联合（targetId 与 label 不共存，迁移不得残留旧 label）；§9.3 命令信封改为判别相关的 GraphCommand，type 与 patch 异型组合在类型层不可表示；ui-design §4.2 节奏卡字段名对齐 `tone`、§7.4 集持久化改为已定稿的 episodeTitles。
>
> 七轮评审修订（2026-08-29）：ShotRef 对侧成员补 never 禁写（混写形状彻底不可表示）；GraphCommand 收敛为单一判别联合名（GraphCommandOf\<K\> 供已知类型提取）；§9 补 `rename_project` 命令（payload + inverse 捕获旧名）；ui-design §4.3 注明分镜卡无内联改名（镜号标题由 spec.shotNo 派生，面板内编辑）。
>
> 八轮评审修订（2026-08-29）：§11.1 迁移链首环补第三步——旧式边判别字段（type/className）改写为显式 data.kind；§9.3 batch.commands 放宽为 `Array<GraphCommand | InverseCommand>`（batch 的 undo 是子命令 inverse 的逆序数组，须可赋值）；§10.5 `save_project` 索引同步扩为 name/updatedAt（rename_project 的索引一致性在此发生）。
>
> 九轮评审修订（2026-08-29）：§11.1 首环改写步骤补全——③ 明确删除镜像的 data.optionLabel（改写后按稳定句柄重新派生）、④ 节点结构转换（旧 React Flow 形状拆入四分区，未转换不得 stamped 为 v1）；ui-design §3.2 项目卡片的分集信息数据源改为已定稿的 episodeTitles/episodeNo，卡片展示归 UI 迭代项。
>
> 十轮评审修订（2026-08-29）：§11.1 首环补 ⑤ 信封装配——文档级映射（name/updated_at/节点边上移/settings 数组键化）与缺省回退（id 回填、createdAt 同刻、viewport 不伪造、props/documents/assets 空桶）明文化，Rust `wrap_legacy` 与前端 `serializeProject` 的分工注记。
>
> 十一轮评审修订（2026-08-29）：§3 `graph.viewport` 改为可选字段（缺省 = 从未保存过视口，打开 fitView——与迁移装配及实现一致，v0 迁移件不再结构性无效）；§7.3 项目复制明文要求替换 `project.id`（持久化层强制 id = 目标路径 id）并取新创建时间；ui-design §4.2/§4.3 场景面板补内外景（interior）/天气（weather）两个用户可编辑字段。
>
> 十二轮评审修订（2026-08-29）：§5 StoryEdge 改为按 kind 判别的三变体联合，branch 变体必填 `sourceHandle`（无镜像 label 后唯一的文案解析依据，缺句柄非法）；§8.2.2 选项级联收敛到命令层——applyCommand 内置检测被移除选项并断开其出口边，不依赖调用方拼装 batch。
>
> 十三轮评审修订（2026-08-29）：§11.1 ⑤ 信封装配补 `episodeTitles` 归一化与缺省 `{}`（v0 早于集标题功能的文件没有该字段）；§9.3 inverse 表为选项级联的 `update_node_spec` 定义 `batch` 型 inverse（旧 spec 补丁 + 被级联边的 connect_edge）；§5 `AttachEdge.sourceHandle` 收紧为必填字面量 `'shots'`（§4.3 attach 仅从该端口发起）。
>
> 十四轮评审修订（2026-08-29）：§11.1 ④ 明确 `ui.expanded` 初始化为 `true`（旧节点无该字段）；§5 补句柄保留字面量规则——`shots` 为 attach 专属，kind/句柄矛盾者命令层拒绝、归一化隔离；ui-design §4.3 节奏卡面板字段更正为「名称 + 基调」（内容即节点标题 meta.label，BeatSpec 无正文字段）。
>
> 十五轮评审修订（2026-08-29）：§10.1 补存储布局迁移——明确文档 schema 迁移与文件布局迁移是两条独立的轴，目录化落地时必须布局迁移或路径回退（防既有项目消失）；§5/§11.3 补 attach 端点类型约束（必须 scene → shot，命令层拒绝、归一化隔离）。
>
> 十六轮评审修订（2026-08-29）：§11.1 ⑤ settings 转换表述更正为嵌套数组键化（settings.characters[]/locations[] → Record，v0 的 settings 本身是对象）；§9.3 batch 收敛回完整信封（正向 ForwardBatch.commands: GraphCommand[]），batch 的 inverse 用独立的 InverseBatch 负载（InverseCommand[]，applyCommand 内部构造、不经命令通道）；§5 保留句柄扩至 option-\<id\>（branch 专属，sequence 边携带即矛盾）。
>
> 十七轮评审修订（2026-08-29）：§4.1 StoryNode 改为按 type 判别的五变体联合——scene/beat/dialogue 的 meta.label 必填（名称型节点显示并编辑名称），branch/shot 用无 label 的 DerivedMeta（标题派生，禁止镜像）；spec 随类型同步判别相关。
>
> 十八轮评审修订（2026-08-29）：§11.1 ④ 明确名称型节点的旧 data.name 上移为必填 meta.label；§9.3 update_node_spec/meta 的 set 增加按解析节点类型的校验契约（spec 字段须属该类型、label 仅名称型节点可写）；inverse 表 update_node_* 的 inverse.type 更正为「同正向，级联例外为 batch」。
>
> 十九轮评审修订（2026-08-29）：§4.1 DerivedMeta 补 `label?: never`（结构性禁写镜像标题）；分镜卡改用独立的 ShotMeta——无 episodeNo（随宿主场景分集，§3.5）、无 label，两者均 never 禁写；Agent/导入边界的同不变量校验由 §9.3 update 校验契约承接。
>
> 二十轮评审修订（2026-08-29）：§5/§11.3 补剧情流端点约束——sequence/branch 边任一端点为 shot 即非法（分镜卡不参与横向剧情流），命令层拒绝、归一化隔离；§9.3 update 校验契约补 meta 字段相关性——episodeNo 不可用于 shot。
>
> 二十一轮评审修订（2026-08-29）：§9.3 `update_node_meta.set` 由交集改为联合（`Partial<LabeledMeta> | Partial<DerivedMeta>`）——交集的 never 可选属性使改名补丁类型上不可成立；运行时裁决仍按解析出的节点类型拒绝 branch/shot 的 label 与 shot 的 episodeNo。
>
> 二十二轮评审修订（2026-08-29）：§10.5 `save_project` 明文要求以同一时刻盖戳 `doc.project.updatedAt` 与索引 updatedAt（文档时间戳不因保存而滞留）；§9.3 `set_episode_title` 增加命令边界校验——episodeNo 须为正整数、title 落盘前去空白（与 §11.1 归一化口径一致）。
>
> 二十三轮评审修订（2026-08-29）：§9.3 create_node 补命令边界校验（spec 属类型、label 仅名称型、shot 无 episodeNo，与 update 同款）；connect_edge 补端点解析校验（branch source 须为分支节点且选项 id 存在于 options）；ui-design §4.3 场景面板补场次（sceneNo）控件——插入/重排后可修正编号。
>
> 二十四轮评审修订（2026-08-29）：§9.3 create_node 边界补 node.id 唯一性校验——id 已存在于活动图即拒绝（防止歧义节点及 inverse 误删既有节点），必要时由命令边界分配新 id；inverse 捕获规则更正 set_asset 的逆操作——覆盖已有 id 时 inverse 为恢复旧 AssetRef 的 set_asset（而非 remove_asset，避免 undo 删除条目使既有引用悬空），remove_asset 仅用于新增情形。
>
> 二十五轮评审修订（2026-08-29）：§4.2 BranchSpec.options 明确选项 id 数组内唯一；§9.3 create_node/update_node_spec 命令边界补同款校验（重复 id 映射同一 option-\<id\> 句柄致 label 解析歧义，且删除其一不触发移除识别、级联会把既有连线静默改接到剩余同 id 选项）；§11.1 归一化第 3 步补加载期修复——重复 id 保留首见项、后续重复项重发新 id（既有连线本就解析到首见项，不产生改接）。
>
> 二十六轮评审修订（2026-08-29）：§11.1 首环 ① 补选项 id 去重并置于 ② 下标句柄改写之前——否则按旧下标指向后一重复项的连线会先改写为重复 id 句柄、再随去重被静默改接到首见项（更正二十五轮「重发不改接」在迁移路径上不成立的表述，第 3 步修复条同步限定为 v1 脏数据路径）；§5/§9.3/§11.1 补 attach 边宿主唯一约束——一个 shot 至多一条入向 attach 边（分集归属与下挂布局的唯一依据），命令层拒绝第二条，换宿主为「断开 + 重连」同 batch 原子操作，归一化保留文档序首条、其余隔离；§4.1/§9.3/§11.1 补 episodeNo 正整数域校验（与 set_episode_title 同域）——create_node/update_node_meta 边界拒绝零/负/小数/非有限值，归一化删除非法字段回退未分集。
>
> 二十七轮评审修订（2026-08-29）：§9.3 connect_edge 边界补 edge.id 全局唯一校验（与 create_node 的 node.id 同款——否则产生歧义边且 disconnect_edge inverse 误删既有同 id 边）；键控列表 id 唯一性由 branch.options 扩至全部——§4.2 DialogueLine.id 与 ShotRef.id 声明数组内唯一（列表 key 用 id，重复会令删除/重排 reconcile 到错误项），create_node/update_node_spec 同款校验；§11.1 归一化第 3 步补 lines/refs 重复 id 与重复边 id 的修复（均保留文档序首条、后续重发新 id 并警告——边 id 不被数据引用，重发无副作用）。
>
> 二十八轮评审修订（2026-08-29）：§4.3 环检测由「仅交互层」更正为两层——connect_edge 命令边界复核自环/剧情流成环（sequence/branch 传递闭包；attach 不参与），Agent/导入绕过 isValidConnection 时 DAG 不变量不失守；§11.1 第 3 步补自环/成环边隔离（按文档序重建剧情流图，闭合回路者隔离）与重复节点 id 修复（保留文档序首个、后续重发新 id——按 id 引用本就解析到首见项，重发节点成无连线孤儿由用户处置）；§9.2/§9.3 补 batch 原子性契约——applyCommand 先按子命令顺序在虚拟演进文档上逐一预校验，任一失败即整批拒绝、零变更（杜绝半批残留，如换宿主 batch 的 connect 子命令被拒后 shot 成孤儿），全部通过后顺序执行并逐子捕获 inverse。
>
> 二十九轮评审修订（2026-08-29）：§5 补端口归属反向约束——source 为 branch 节点的边必须是 branch 变体且携带合法 option-\<id\> 句柄（branch 节点无匿名 output 端口，sequence/attach 从 branch 发出即绕过选项语义），命令层拒绝、归一化按孤儿边隔离；targetHandle 收紧为必须省略（各节点仅一个匿名 target 端口，实现中 Handle 无 id），命令层拒绝携带任意值的边，归一化剥离该字段并警告（端口匿名唯一，剥离不改变连接语义）；§9.3 connect_edge 边界校验同步补这两条。
>
> 三十轮评审修订（2026-08-29）：匿名端口句柄规则由 targetHandle 扩至 sequence 边 sourceHandle——scene/beat/dialogue 的剧情流出口同为匿名 output 端口（Handle 无 id），携带任意值即非法（命令层拒绝、归一化剥离），保留字面量规则中 sequence 携带 shots/option-\<id\> 的两条矛盾形态被本条吸收；§9.3 update_node_spec/meta 补 `unset?: string[]` 清除语义——JSON 无法传输 undefined，省略属性只表示不修改，清除可选字段（episodeNo 回退未分集、locationId 解除引用）须走 unset；unset 与 set 同名、必选字段、不存在字段一律拒绝；inverse 捕获规则同步——被清除字段的旧值进 inverse 的 set，被 set 新增的字段进 inverse 的 unset。
>
> 三十一轮评审修订（2026-08-29）：§5/§9.3 connect_edge 补逻辑重复边拒绝——同（source, target, sourceHandle）的边全局唯一（新 edge.id 不改变重复本质，重叠连线令遍历/统计重复计数；交互层与 AI 路径已有同款检查，命令边界兜底），§11.1 第 3 步保留文档序首条、其余隔离；§11.1 第 3 步补节点判别形状校验（§4.1 联合在加载路径的对等兜底——JSON 边界已擦除类型）：never 禁写字段被携带（branch/shot 的 label、shot 的 episodeNo）剥离并警告；type 与 spec 形态错位、名称型节点缺必填 meta.label 等无法机械修复的异型节点，连同关联边隔离并警告，不交付画布。
>
> 三十二轮评审修订（2026-08-29）：§4.2 sceneNo/shotNo 补正整数域（Number.isInteger 且 > 0——场号/镜号进卡片标题与导出排序，非有限值经 JSON 序列化变 null），§9.3 create_node/update_node_spec 边界同款校验，§11.1 第 3 步对非法存量值按文档序顺位重发并警告；键控列表 id 校验由「唯一」扩为「非空且唯一」（空选项 id 会生成无标识的 option- 句柄、空 React key 致 reconcile 错位），命令边界拒绝、归一化重发新 id（指向空 id 的 option- 句柄随重发失效，按孤儿边隔离）；第 3 步明确节点/列表修复先于边隔离判定。
>
> 三十三轮评审修订（2026-08-29）：§11.1 首环 ⑤ settings 键化前补实体 id 校验——v0 characters[]/locations[] 的重复 id 保留首见项、后续重发新 id（节点引用本就解析到首见项），空 id 重发，均记录警告（避免直接键化时同键覆盖、设定静默丢失）；第 3 步空选项 id 修复细化（修正三十二轮「一律随孤儿边隔离」的过严口径）——重发时建立「空 id → 新 id」映射并同步改写该 branch 引出边的 option- 句柄，仅当同 branch 存在多个空 id 选项、映射歧义时才隔离相关连线。
>
> 三十四轮评审修订（2026-08-29）：§7.1 AssetRef.relPath 补安全约束——纯相对路径、规范化后不得越出资产根（防解析/复制逃逸与破坏项目自包含），set_asset 命令边界拒绝非法值，归一化隔离越界索引项并警告；§6 SettingsDocument.relatedIds 由裸 id 数组改为 `{ kind, id }` 显式成对——character 与 location 是独立 id 空间、跨桶同名使裸 id 无法解析归属（反向索引/导航/删除态渲染会不一致）。
> 三十五轮评审修订（2026-08-29）：§7.1 relPath 安全约束扩展到库索引入口——`library.json` 可被手工修改或损坏，读取（`list_library_assets`）时逐项应用同款根目录校验并隔离非法条目（不进内存索引、记录警告），mediaUrl 拼接与 `delete_library_asset` 只作用于通过校验的条目，不只约束新导入；§11.1 第 3 步补 `episodeTitles` 键值校验并覆盖所有版本文档——迁移链 ⑤ 的标题表归一化只对 v0 生效，v1 脏写/导入文档可携带零/负/小数键与非字符串值，须在通用归一化删除（正整数键、值去空白、空标题删键）；§9.3 `upsert_document` 补完整 SettingsDocument 运行时校验（JSON 边界已擦除 TS 类型），§11.1 第 3 步补 `settings.documents` 归一化——旧式字符串 relatedIds、未知 kind、缺失 id 的关联项删除并警告，形态不可修复的文档条目隔离。
> 三十六轮评审修订（2026-08-29）：§7.1 relPath 校验由词法规范化升级为真实路径包含判定——资产根与目标路径 canonicalize（解析符号链接）后判定包含，新增资产目标不存在时拒绝路径各级符号链接（词法合法的 `assets/link` 经符号链接仍逃逸资产根，词法检查防不住）；§11.1 ⑤ 与第 3 步收紧 episodeTitles 键为规范十进制正整数字符串且限安全整数范围——`"01"`/`"1e0"` 等非规范数字串与规范键折叠到同一集号会按属性序静默覆盖标题，转换只接受规范键、其余删除并警告。
> 三十七轮评审修订（2026-08-29）：§5 EdgeBase.targetHandle 与 SequenceEdge.sourceHandle 由可选 string 改为 never 禁写（静态类型与 connect_edge 边界契约一致，非法形状编译期即不可表示）；episodeNo 域统一收紧为安全整数（Number.isSafeInteger 且 > 0，§4.1/§9.3 create_node/update_node_meta/set_episode_title/§11.1 同域）——超出安全整数范围的集号作为对象键会与相邻集号折叠，命令写入后重载即被归一化删除；§9.3 补「目标缺失」通则——删除/更新类命令在边界要求目标存在（inverse 依赖 docBefore 捕获，目标缺失即拒绝；需吞掉过期命令时为不入栈的显式 no-op）；§11.1 第 3 步补键控实体桶 Record 键与值内嵌 id 一致性校验（所有版本）——不一致时以记录键为准改写值内 id（引用按键解析，改写保住既有引用且键天然唯一、不产生碰撞）。
> 三十八轮评审修订（2026-08-29）：SettingsDocument.relatedIds 补数组内 (kind, id) 唯一约束——§9.3 upsert_document 边界拒绝重复项，§11.1 第 3 步归一化保留首见、其余删除并警告（重复关联持久化会让反向索引/导航重复列出同一文档）；§9.3 set_episode_title 补 title 的 typeof string 前置校验——TS 类型在 JSON 边界已擦除，非字符串值直接 trim 抛异常、原样写入则重载即被归一化删除，须先验类型再去空白。
> 三十九轮评审修订（2026-08-29）：§9.3 补项目名校验口径（rename_project 命令边界、create_project、持久化层项目名校验三处共用）——先验 typeof string，去首尾空白后非空且 ≤ 100 字符，命令边界拒绝非法值并保存规范化结果（否则无效名称先入活动文档与撤销栈、随后持续保存失败）；inverse 捕获 docBefore 旧名原值。
> 四十轮评审修订（2026-08-29）：§7.1 资产根收紧为专用子目录（项目 `assets/`、库 `library/assets/`），relPath 基准与 canonical 包含判定的根同步收紧——以整个项目/库目录为根时 `"library.json"` 条目词法合法且 canonical 仍在根内，会让 delete_library_asset 的 remove_file 删除索引自身（P1）；§9.3 upsert_character 边界补实体形状校验（id/name 非空字符串、gradient 字符串、可选字段类型），§11.1 第 3 步对 characters/locations/props 做同域加载校验——必填字段异型隔离该条目、可选字段异型剥离字段（先于键与内嵌 id 一致性改写执行）；更正三十九轮项目名上限为按字符数 ≤ 64（与 src-tauri store.rs sanitize_name 实现一致，此前写的 100 与持久化层不符，会造成「重命名成功、保存持续失败」）。
> 四十一轮评审修订（2026-08-29）：§7.1 补 relPath 使用时校验（TOCTOU）——仅在列表入口过滤不足以兜底，delete_library_asset 重读磁盘索引后按其中 relPath 调 remove_file，索引可能在两次校验之间被替换；凡按 relPath 触达文件系统的入口（读取/拼接/删除）都在操作当时重新执行真实路径包含校验，或只消费本会话已验证的内存条目（P1）；§11.1 第 3 步更正四十轮的校验顺序——键与内嵌 id 一致性修复先于各桶实体形状校验，内嵌 id 缺失/为空时以记录键补齐（键是引用解析的权威值，补齐可无歧义保住内容与全部既有引用），形状校验只判定其余字段（更正四十轮「形状校验先于键 id 改写」会把可由键补齐的条目误隔离的表述）。
> 四十二轮评审修订（2026-08-29）：§11.1 第 3 步键控桶修复补记录键非空前置——空键条目确定性重发新键（值内 id 随键同步），否则空身份会与 upsert 边界冲突并留下无法更新的实体/空 React key；补 `project.name` 加载归一化——非字符串/空白/超 64 字符时去空白、回退索引名、再回退「未命名项目」占位，保证活动文档名称始终可保存、rename_project inverse 捕获的旧名可经同一边界回放（§9.3 inverse 注释同步注明此前提）。
> 四十三轮评审修订（2026-08-29）：§11.1 第 3 步空键重发补「空键 → 新键」映射与同桶引用改写——每桶至多一个空键条目（JSON 键唯一），指向空串的引用字段（speaker/ShotRef.targetId/avatarAssetId 等）随重发改写到新 id 而非变悬空；仅映射歧义时保持悬空并警告（更正四十二轮「空键不可能承载合法引用」——脏写引用侧同样可出现空串）。
> 四十四轮评审修订（2026-08-29）：sceneNo/shotNo 域与 episodeNo 对齐为安全整数（Number.isSafeInteger 且 > 0，§4.2/§9.3/§11.1 同域）——超出安全整数范围的编号传入命令前即可能与相邻编号折叠，归一化亦无法事后修复；§7.3 补项目复制命名策略——`{源名} 副本`（冲突递增序号），拼接超 64 字符上限时先截断源名再拼后缀，保证复制总能通过项目名校验口径；§11.1 第 3 步补节点基础结构校验——id 缺失重发、ui 缺失/异型重置默认值、可选布局数值剥离、position 坐标非法等不可修复形态隔离该节点及其关联边，单个异型节点不阻断项目打开。
> 四十五轮评审修订（2026-08-29）：§11.1 第 2 步补容器级形状校验（所有版本、先于一切逐项规则）——graph/节点边数组/settings 各桶/assets.byId 异型时重置为对应空容器并警告，管线必须可遍历、单个脏字段不能让整个项目打不开；第 3 步空节点 id 重发补「空 id → 新 id」映射与边端点改写——空字符串可被脏写的 source/target 指向，唯一空 id 节点时映射明确、连线保留，多个空 id 节点映射歧义则指向空串的边按孤儿边隔离（更正四十四轮「无引用可指向缺失 id」对空串不成立的表述）；§9.3 create_node 边界同步拒绝空 node.id。
> 四十六轮评审修订（2026-08-29）：§11.1 第 2 步容器级校验补齐遗漏——`episodeTitles` 缺失/非 Record（null/数组等）重置为 `{}`、`assets` 父容器缺失/非对象补 `{ byId: {} }`，否则第 3 步的标题表键值遍历与资产索引校验在容器异型时仍会抛错。
> 四十七轮评审修订（2026-08-29）：边 id 补非空约束——§9.3 connect_edge 边界拒绝空 id（React Flow 以边 id 为 key，空 id 边无法可靠渲染/删除/撤销），§11.1 第 3 步为缺失/空边 id 重发新值；§11.1 第 2 步 Record 桶校验明确排除数组形态（数组同为对象，下标会被误当权威实体 id 改写内嵌 id、原有引用静默悬空）；补 viewport 双端校验——§9.3 update_viewport 边界拒绝非法变换，§11.1 第 3 步删除异型 viewport 字段回退 fitView（§3 缺省语义）。
> 四十八轮评审修订（2026-08-29）：§7.1 relPath 契约更正——基准回退为项目目录/library/ 目录（维持既有磁盘格式 assets/<文件>，四十轮把基准改为 assets 子目录会让存量库资产全部解析失效，P1），包含判定的根仍限定为专用 assets 子目录（控制文件不可达的结论不变）；真实路径包含判定分层到 Rust——webview 模型层无法解析本机符号链接，canonical 校验由 Rust 在 load_project/资产命令内执行、非法条目清单随加载结果返回供前端归一化消费（§11.1 引言与第 3 步同步）；§11.1 第 2 步补成员级异型过滤（节点/边数组中的 null/数组/标量、Record 桶中的非普通对象值先隔离，再做任何字段读取与改写）；⑤ v0 迁移空实体 id 重发补「空 id → 新 id」映射与同桶引用改写（数组可含多个空 id 实体，歧义时引用悬空警告）。
> 四十九轮评审修订（2026-08-29）：§11.1 ui 默认值补齐由第 3 步上移至第 2 步——成员过滤只排除外层非普通对象，普通节点的异型 ui 会在重置 ui.selected 时解引用失败；补齐必须先于重置（第 3 步基础结构条目改为引用，不再重复规定）。
> 适用范围：画布文档模型、设定与资产模型、命令与撤销、本地存储体系、AI Agent 交互。
> 明确不在范围内：用户体系、租户、余额/计费。PlotWeave 是单用户 BYOK 桌面工具；若未来出现此类需求，另起《服务端领域模型》文档。

## 一、设计背景与原则

PlotWeave 是 Tauri + React Flow + Rust 的单用户桌面工具：创作者在画布上把剧本、场景、角色与剧情分支组织为节点图。模型配置走 BYOK——用户自己在客户端里配置 provider（base URL + API key），无服务端、无计费。

全部模型设计从五条原则推出，后文每个决策都能回溯到其中之一：

1. **单一文档真源**：一个项目的画布数据收敛为一份带 `schemaVersion` 的 JSON 文档。备份、导出、版本兼容都只围绕这一份文件。
2. **数据按职责分区**：渲染布局、会话状态、用户意图、元信息分开存放，互不污染。
3. **一切变更走命令**：状态修改有唯一入口，撤销/重做、持久化、AI 操作画布都建立在这条通道上。
4. **资产文件化**：媒体内容落盘为文件，文档内只存引用。
5. **不为不存在的问题付费**：单写者桌面场景不引入并发仲裁、协同合并、任务编排等机制。

## 二、总体分层

```
React 组件层（节点组件、设定面板、资产库面板）
   ↓ 交互意图
Store 桥接层（useGraphStore hook）
   ↓ 命令（GraphCommand）
模型层（纯 TypeScript，无框架依赖）
   ProjectDocument ← GraphStore（applyCommand / undo / redo / 防抖持久化回调）
   ↓ invoke
Rust 持久化层（Tauri commands：文件读写、资产导入、设置与密钥、LLM 代理）
```

两条约束贯穿所有层：

- 模型层是纯 TS：不可变更新，对外暴露只读快照。便于单测，也便于未来需要时平移到 Rust。
- 画布状态的唯一真源是 GraphStore；React Flow 只作渲染与交互层，不持有业务状态。

下文顺序：先定义数据本身（三~七）与引用规则（八），再定义变更机制（九：命令与撤销），然后是落地（十：存储；十一：加载归一化），最后是建立在命令通道之上的 AI 能力（十二）与演进方向（十三）。

## 三、ProjectDocument

一个项目一份文档，序列化为 `project.json`：

```ts
/** 项目文档：画布数据的序列化真源。 */
interface ProjectDocument {
  schemaVersion: 1
  project: {
    id: string            // 目录名，创建时生成的 UUID
    name: string
    description?: string
    createdAt: string     // ISO 8601
    updatedAt: string
  }
  graph: {
    nodes: StoryNode[]    // 见第四节
    edges: StoryEdge[]    // 见第五节
    viewport?: { x: number; y: number; zoom: number }  // 单用户场景直接随文档持久化；缺省 = 从未保存过视口（打开时 fitView）
  }
  settings: {             // 设定集：节点通过 id 引用，见第六节
    characters: Record<string, Character>
    locations: Record<string, Location>
    props: Record<string, PropItem>
    documents: Record<string, SettingsDocument>  // 长篇自由文本条目（小传/世界观/术语表）
  }
  episodeTitles: Record<number, string>  // 集标题表：键 = 集号（见 4.1，不建「集」实体表）
  assets: {
    byId: Record<string, AssetRef>  // 项目资产索引；文件本体在项目 assets/ 目录，见第七节
  }
}
```

文档**不**持久化会话态：撤销/重做栈、选中态（`ui.selected` 加载时重置）、拖拽中的临时位置。这些留在内存，随会话结束消失。

## 四、节点模型

### 4.1 通用结构

```ts
/** 画布节点：叙事单元，四分区（layout/ui/spec/meta）。
 * type 与 data.spec/meta 判别相关：scene/beat/dialogue 显示并编辑名称
 * → meta.label 必填；branch/shot 标题由 spec.prompt / spec.shotNo 派生
 * → 不落 label（§8.1.1 禁止镜像字段）。 */
interface StoryNodeBase {
  id: string
  layout: {                          // 渲染布局
    position: { x: number; y: number }
    size?: { width: number; height: number }
    zIndex?: number
  }
  ui: {                              // 会话态，加载时重置
    selected: boolean
    expanded: boolean                // 首版节点无折叠形态，恒 true；保留字段为演进占位
  }
}

/** 名称型节点 meta：label 必填（卡片头部/大纲/Agent 摘要的显示与编辑目标）。 */
interface LabeledMeta {
  label: string
  episodeNo?: number             // 集归属（大纲分组的唯一依据）；正整数且为安全整数（Number.isSafeInteger 且 > 0——超出安全整数范围的集号作为对象键会与相邻集号折叠，命令写入后重载即被 §11.1 删除；与 set_episode_title/§11.1 归一化同域）
  createdAt?: string             // 首版运行态不维护时间戳，落盘可省略；保留字段为演进占位
  updatedAt?: string
}

/** 派生标题节点 meta：无 label（branch 专属；label?: never 禁写，
 * 结构上杜绝可变对象/spread 携带镜像标题，§8.1.1）。 */
interface DerivedMeta {
  label?: never
  episodeNo?: number             // 同 LabeledMeta：正整数域
  createdAt?: string
  updatedAt?: string
}

/** 分镜卡 meta：无 episodeNo（分镜卡随宿主场景分集，§4.1/§3.5）、
 * 无 label（镜号由 shotNo 派生）——两者均 never 禁写。 */
interface ShotMeta {
  label?: never
  episodeNo?: never
  createdAt?: string
  updatedAt?: string
}

interface SceneDocNode extends StoryNodeBase {
  type: 'scene'
  data: { spec: SceneSpec; meta: LabeledMeta }
}
interface BeatDocNode extends StoryNodeBase {
  type: 'beat'
  data: { spec: BeatSpec; meta: LabeledMeta }
}
interface DialogueDocNode extends StoryNodeBase {
  type: 'dialogue'
  data: { spec: DialogueSpec; meta: LabeledMeta }
}
interface BranchDocNode extends StoryNodeBase {
  type: 'branch'
  data: { spec: BranchSpec; meta: DerivedMeta }
}
interface ShotDocNode extends StoryNodeBase {
  type: 'shot'
  data: { spec: ShotSpec; meta: ShotMeta }
}

type StoryNode = SceneDocNode | BeatDocNode | DialogueDocNode | BranchDocNode | ShotDocNode
```

节点数据只保留四个分区：渲染布局（`layout`）、会话状态（`ui`）、用户意图（`data.spec`）、元信息（`data.meta`）。画布没有执行引擎，因此不设输入缓存、产物、运行状态等分区——没有写者的字段不进模型（原则 5）。

「集」是逻辑分类而非实体：首版集 = 编号 + 大纲行内标题，标题存文档级 `episodeTitles: Record<number, string>`（键 = 集号），不建「集」实体表。

### 4.2 各类型 spec

节点里写的一切内容——梗概、台词、以及将来 AI 生成的 prompt——都是 `spec` 的字段，随 `project.json` 持久化，无需额外存储。

```ts
type NodeSpec = SceneSpec | BeatSpec | DialogueSpec | BranchSpec | ShotSpec

/** 场景：一个时空单元的叙事容器（UI 形态 = 索引卡，字段对齐 ui-design §4.2）。 */
interface SceneSpec {
  sceneNo: number            // 剧本场景头编号，展示为 SCENE 03；正整数且为安全整数（Number.isSafeInteger 且 > 0，命令边界与归一化均校验，§9.3/§11）
  interior: boolean          // 内景/外景徽标
  locationId?: string        // 引用 settings.locations
  time?: string              // 自由文本，如「夜·雨」
  weather?: string           // 天气，自由文本
  synopsis: string           // 场景梗概
  characterIds: string[]     // 出场角色，引用 settings.characters
}

/** 桥段：场景内的情节拍点（转折、反转、高潮）。承载节奏而非内容，不设正文。 */
interface BeatSpec {
  tone: string               // 情绪基调（UI 设计文中的 emotionalTone），如「压抑」「爆发」
}

/** 对白：一段角色对话。 */
interface DialogueSpec {
  lines: DialogueLine[]
}

/** 对白的一行：角色台词或居中动作行；id 为稳定标识（列表 key 不用数组下标）
 * 且非空、数组内唯一（命令边界与归一化均校验，§9.3/§11）——重复或空 id 作
 * React key 会让删除/重排 reconcile 到错误行。 */
interface DialogueLine {
  id: string
  kind: 'line' | 'action'
  text: string
  speaker?: string           // kind='line' 时的说话人，引用 settings.characters
  side?: 'left' | 'right'    // 气泡左右侧
  vo?: boolean               // 画外音（VO 徽标）
}

/** 分支：剧情分岔点。选项存在 spec 里（端口/胶囊渲染的唯一真相）；
 * 出口连线经 sourceHandle（option-<选项 id>）指向选项，label 由选项派生，边上不落拷贝（见第五节）。 */
interface BranchSpec {
  prompt: string             // 分岔事由，如「女主是否发现真相」
  options: Array<{ id: string; label: string }>  // id 为稳定标识，非空且数组内唯一（命令边界与归一化均校验，§9.3/§11）；sourceHandle 按 id 定位（option-<id>），删选项不位移其他连线
}

/** 分镜卡（生成侧）：一张卡 = 一个镜头及其 AI 燃料。
 * 画布一等节点类型，经 attach 边垂直下挂在索引卡正下方（见 4.3），
 * 不参与横向剧情流；首版为结构占位，拖拽引用与渲染联动随演进评审。 */
interface ShotSpec {
  shotNo: number             // 镜号；正整数且为安全整数（同 sceneNo 域——参与导出排序，非有限值经 JSON 序列化变 null，超出安全整数范围的编号在传入命令前即可能与相邻编号折叠为同一 IEEE-754 数值）
  size: string               // 景别（特写 / 中景 / 全景…）
  picture: string            // 画面描述
  prompt: string             // 镜头 Prompt（AI 视频模型的直接输入）
  refs: ShotRef[]            // 引用位：角色垫图 / 场景底图 / 音频
}

/** 分镜卡引用位：引用位与自由位互斥（targetId / label 不共存——
 * 对侧成员以 never 禁写，混写形状在类型层不可表示）。
 * 引用位的唯一真相是 targetId（§8.1）——显示名按 id 实时解析，改名不断引用，
 * 被删按 §8.2.3 失效展示；落 label 即镜像字段（禁止，§8.1.1）。
 * id 非空且在 refs 数组内唯一（同 DialogueLine，§9.3/§11 校验）。
 * 项目资产（§7.1）落地后 audio 引用目标为 assets.byId 资产 id。 */
type ShotRef =
  | { id: string; kind: 'character' | 'location' | 'audio'; targetId: string; label?: never }  // 引用位
  | { id: string; kind: 'character' | 'location' | 'audio'; label: string; targetId?: never }  // 自由位：手填文案
```

### 4.3 端口与连接

直接使用 React Flow 多 handle：

- `scene` / `beat` / `dialogue`：`input`（target）+ `output`（source）各一个。
- `branch`：一个 `input`（target）+ 多个出口 source handle（`option-<选项 id>`，动态增删；用稳定 id 而非数组下标，删除任一选项不影响其余出口的连线归属）。
- `scene`：额外带底部 source handle（`shots`），经 attach 边垂直下挂分镜卡——**横向 = 剧情顺序，垂直 = 派生从属**（一对多合法，attach 不参与剧情流环检测）。
- 连接校验做两层：前端交互层（`isValidConnection`）即时反馈；命令层（`connect_edge` 边界，§9.3）对同一不变量复核——禁止自环、禁止剧情流成环（sequence/branch 的 BFS 传递闭包检查；attach 垂直从属不参与）——Agent/导入绕过交互层直达命令通道，剧情流 DAG 不变量不能在命令层失守；漏网成环边由归一化隔离（§11.1 第 3 步）。

## 五、边模型

```ts
/** 剧情连线：按 data.kind 判别的三种变体。
 * branch 变体必须携带 sourceHandle（option-<选项 id>）——边上无镜像 label 后
 * 胶囊文案的唯一解析依据，缺句柄的 branch 边非法（归一化按孤儿边隔离）。 */
interface EdgeBase {
  id: string
  source: string
  target: string
  targetHandle?: never                    // 禁写（never，同 §4.1 DerivedMeta.label——必须省略的形状在类型层不可表示，静态类型与 connect_edge 边界契约一致）：各节点仅一个匿名 target 端口（Handle 无 id），JSON 边界漏入的值即非法（§5 端口归属反向约束）
}

interface SequenceEdge extends EdgeBase {
  sourceHandle?: never                        // 禁写（never）：剧情流出口为匿名 output 端口（Handle 无 id），JSON 边界漏入的值即非法（§5 端口归属反向约束）
  data: { kind: 'sequence'; order?: number }  // order = 同一 source 多出口的排列顺序
}

interface BranchEdge extends EdgeBase {
  sourceHandle: string                        // 必填：option-<选项 id>
  data: { kind: 'branch'; order?: number }
}

interface AttachEdge extends EdgeBase {
  sourceHandle: 'shots'                       // 必填字面量：索引卡底部端口（§4.3，attach 仅从该端口发起，防误绑横向出口）
  data: { kind: 'attach'; order?: number }
}

type StoryEdge = SequenceEdge | BranchEdge | AttachEdge
```

- `sequence`：剧情顺序流，无 label。
- `branch`：从 branch 节点出口引出；**边上不存 label 拷贝**——胶囊文案按 `sourceHandle`（`option-<选项 id>`）解析分支节点 `spec.options` 中同 id 选项的 label 派生（§8.1.1 禁止镜像字段）；多结局用多条 branch 边指向不同子图表达。
- `attach`：索引卡底部端口 → 分镜卡顶部端口的派生从属边（垂直下挂），无 label，不参与剧情流环检测。**宿主唯一**：一个 shot 至多一条入向 attach 边——宿主场景是分镜卡分集归属（§3.5）与下挂布局的唯一依据，多宿主会让归属随边序漂移；更换宿主为原子操作（`disconnect_edge` 旧边 + `connect_edge` 新边进同一 `batch`），而非直接加第二条边。

**句柄保留字面量**：`shots` 为 attach 变体专属（§4.3 attach 仅从索引卡底部端口发起）；`option-<id>` 句柄为 branch 变体专属（§8.1.1 无镜像 label 后的文案解析依据）。`sequence`/`branch` 边携带 `shots` 句柄、`sequence` 边携带 `option-<id>` 句柄、`attach` 边携带非 `shots` 句柄，均属 kind/句柄矛盾——命令层校验拒绝，漏网者由归一化按孤儿边隔离（§11.3）。attach 边另受**端点类型约束**：必须 `scene → shot`（非 scene 源或非 shot 目标同样命令层拒绝、归一化隔离），否则分镜计数与下挂布局会被脏数据污染；并受**宿主唯一约束**：目标 shot 已有入向 attach 边时命令层拒绝第二条（更换宿主走「断开 + 重连」同 `batch` 的原子操作），漏网者归一化保留文档序首条、其余按孤儿边隔离（§11.1 第 3 步）。

**端口归属反向约束**：branch 节点没有匿名 output 端口（§4.3 出口只有 `option-<id>`）——source 为 branch 节点的边必须是 branch 变体且携带合法选项句柄，`sequence`/`attach` 边从 branch 发出即绕过选项语义，命令层拒绝、归一化按孤儿边隔离。匿名端口句柄必须省略：各节点仅一个匿名 target 端口，scene/beat/dialogue 的剧情流出口同为匿名 output 端口（实现中 Handle 均无 id）——`targetHandle` 与 sequence 边的 `sourceHandle` 携带任意值都无法绑定到真实端口，命令层拒绝；归一化剥离该字段并记录警告（端口匿名唯一，剥离不改变连接语义，无需隔离）。此前句柄保留字面量规则中 sequence 携带 `shots`/`option-<id>` 的两条矛盾形态被本条吸收（更严：任何值均非法）。**逻辑重复边**：同（source, target, sourceHandle）的边全局唯一——重复边产生重叠连线并令遍历/统计重复计数，命令层拒绝，漏网者归一化保留文档序首条、其余按孤儿边隔离（§11.1 第 3 步）。

**剧情流端点约束**：分镜卡不参与横向剧情流（§4.2，只经 attach 垂直下挂）——`sequence`/`branch` 边的任一端点为 shot 节点即非法：命令层校验拒绝，漏网者由归一化按孤儿边隔离。

## 六、设定集（settings）

角色/地点/道具是项目级实体，节点只存 id 引用——改一处人设，所有引用它的节点同时生效：

```ts
interface Character {
  id: string
  name: string
  gradient: string            // 头像配色渐变（设定集头像与节点头像串共用）
  bio?: string                // 一句小传；长篇人设/世界观走 SettingsDocument
  avatarAssetId?: string      // 引用 assets.byId（项目资产落地后启用）
}
interface Location { id: string; name: string; note?: string }
interface PropItem { id: string; name: string; description?: string }

/** 文档条目（写作原料）：人物小传 / 世界观 / 术语表等自由文本，持久化于
 * ProjectDocument.settings.documents；与结构化条目双向关联（如小传挂在角色名下）；
 * 全文进入 AI 上下文快照的按需读取范围。 */
interface SettingsDocument {
  id: string
  title: string
  body: string
  relatedIds: Array<{ kind: 'character' | 'location'; id: string }>  // 关联的设定条目：kind + id 显式成对——character 与 location 是两个独立 id 空间，字符串可能跨桶同名，裸 id 无法解析归属；数组内按 (kind, id) 唯一——重复项使命令边界拒绝、归一化去重（§9.3/§11.1），否则反向索引/导航会把同一文档重复列出
}
```

**悬空引用规则**：设定被删除时不级联改节点（避免静默丢数据），节点侧按「引用失效」样式展示（如灰色角标），由用户决定替换或清除。只做检测与展示，不引入级联状态机（原则 5）。

## 七、资产模型

### 7.1 两个作用域

- **项目资产**：归属于某个项目，文件存于项目目录内，`project.json` 的 `assets.byId` 只索引本项目资产。项目是**自包含**的——导出、备份、移动项目目录不会丢失任何引用。
- **个人资产库**：跨项目复用的素材（角色立绘、参考图、常用模板），存于应用级 `library/` 目录，由独立的 `library.json` 索引，不进任何 ProjectDocument。

两个作用域共享同一个引用结构：

```ts
/** 资产引用：媒体本体是文件，文档只存引用。 */
interface AssetRef {
  id: string
  relPath: string            // 项目资产相对项目目录；库资产相对 library/ 目录（维持既有磁盘格式：库条目写作 assets/<文件>——变更基准会让既有资产全部解析失效）。解析目标必须落在专用资产子目录内，安全约束见下
  mime: string
  source: 'upload' | 'generated'
  createdAt: string
}
```

**relPath 安全约束**：relPath 必须是纯相对路径（禁止绝对路径），其**基准**为项目目录（项目资产）或 `library/` 目录（库资产）——维持既有磁盘格式（库条目写作 `assets/<文件>`），基准变更会让既有资产解析成 `library/assets/assets/<文件>` 而全部失效。解析目标必须位于**专用资产子目录**内（项目 `assets/`、库 `library/assets/`，§10.1）：控制文件（`project.json`/`library.json`/`index.json`）位于子目录之外——`"library.json"` 这类条目词法合法、解析后也在库目录内，但目标不在 `library/assets/` 内即非法，`delete_library_asset`/`remove_file` 之类的按路径操作由此永远触达不到索引自身；含 `..` 上跳段使解析目标越出子目录同样非法。词法规范化不足以兜底：资产目录内若存在指向根外的符号链接，`assets/link` 词法合法、不含 `..`，真实路径却已越界——因此校验以**真实路径包含关系**为准：对资产子目录与目标路径做 canonicalize（解析符号链接）后判定目标仍位于子目录之内，越界即非法；新增资产（目标文件尚不存在、无法 canonicalize）时拒绝路径各级中的符号链接，或对最近已存在祖先做 canonicalize 后拼接校验。**分层执行**：词法校验（纯相对、解析目标在子目录内）前端模型层可执行；真实路径包含判定只能在可访问文件系统的 Rust 层执行——webview 模型层无法自行解析本机符号链接。Rust 在 `load_project` 与资产命令内对每个 relPath 做 canonical 校验并把非法条目清单随加载结果返回，前端归一化消费该清单隔离条目；库侧 `list_library_assets`/`delete_library_asset` 在 Rust 内同款校验。这是 §7.1「项目自包含」与备份/移动完整性的前提，也是信任边界校验（防解析或复制时逃逸资产根）：`set_asset` 命令边界拒绝非法值，归一化对脏数据隔离该索引项并记录警告（引用该资产的字段按 §8.2.3 悬空展示）。**库索引入口同款约束**：`library.json` 不走 §11.1 项目文档归一化（它不是 ProjectDocument），且可被手工修改或损坏——读取库索引（`list_library_assets`，§7.2 启动时全量载入）时对每个条目应用同款校验（含真实路径包含判定），非法条目不进内存索引并记录警告。仅在列表入口过滤不足以兜底：`delete_library_asset` 等操作会**重读磁盘索引**、按其中的 relPath 直接调 `remove_file`，而索引可能在列表校验之后、删除之前被替换（TOCTOU）——因此凡按 relPath 触达文件系统的入口（读取、mediaUrl 拼接、删除）都在**操作当时**重新执行真实路径包含校验，校验通过才放行；或者命令只消费本会话已通过校验的内存条目、绝不重读磁盘取路径。二者必居其一，项目侧按 relPath 的文件操作同论。由此库侧没有能触达越界路径的入口，而不只是约束新导入的资产。

### 7.2 库资产的分类与编组

资产库要回答"我有哪些人物/场景/道具的哪些视图"，扁平标签不足以表达（"三视图"是结构而非标签），因此采用结构化分类 + 编组 + 自由标签三层：

```ts
/** 资产视角：三视图/多角度/表情/定妆等结构化分类。 */
type AssetView = 'front' | 'side' | 'back' | 'three_quarter' | 'top' | 'expression' | 'turnout' | 'other'

/** 个人资产库索引项：在 AssetRef 之上带分类与组织信息。 */
interface LibraryAsset extends AssetRef {
  name: string
  kind: 'character' | 'location' | 'wardrobe' | 'colorlight' | 'reference' | 'other'  // 角色设定/场景设定/服化道/色彩光影/风格参考/其他
  view?: AssetView           // 视角；三视图即同一 group 下 front/side/back 各一张
  groupId?: string           // 同一主体的多视图编组，引用 library.json 的 groups
  tags: string[]             // 自由标签，补充 kind/view 表达不了的维度
}

/** 资产组：同一主体（如某角色）的多张视图/变体的集合。 */
interface AssetGroup {
  id: string
  name: string               // 如「女主·林晚」
  kind: LibraryAsset['kind']
}
```

- **分工**：`kind` 回答"是什么"，`view` 回答"哪个角度"，`groupId` 把同一主体的三视图绑成一组；`tags` 只用于前两者覆盖不了的自由维度（如「赛博朋克」「雨夜」）。能用结构化字段表达的不写成标签，避免同义标签发散。
- **迁移规则（`prop` → `wardrobe`）**：现实剧组服化道同属一个部门，旧 `prop`（道具）条目并入 `wardrobe`（服装/妆发/道具）；新增 `colorlight` 承载色彩脚本（color script）与光影氛围参考。
- **绑定方式**：分类信息写在 `library.json` 索引项里、以资产 id 为键；改标签、换组、改视角只更新索引，不动媒体文件。
- **快速读取**：`library.json` 启动时全量载入内存（桌面量级，数千条索引项仅数百 KB），列表页筛选/搜索全走内存过滤，媒体文件懒加载。规模失控时再迁 SQLite（见十三）。

### 7.3 流转规则

- **库资产进入项目 = 拷贝**：把库素材放上画布或设为角色头像时，文件拷入项目 `assets/` 并生成项目级 AssetRef（新 id）。项目不持有对库文件的引用，因此库侧可随时清理而不产生项目内的悬空引用。
- **AI 生成结果（未来接入）必须落盘后再引用**：厂商临时 URL 不得出现在文档里——临时链接会过期，直接引用会导致画布内容日后无法打开。生成结果默认落项目资产，用户可显式「收藏到资产库」。
- **延迟回收**：删除引用资产的节点/设定时不立即删文件，由后续「清理未引用资产」命令统一回收（首版可只做手动触发）。
- **项目复制 = 文档级复制**：复制件的 `project.id` 必须替换为目标项目的新 id（持久化层强制 id = 目标路径 id，禁止沿用源 id），创建时间取复制时刻；资产索引随文档原样带走（与 `avatarAssetId` 等
  引用字段保持一致解析，§8.1）；媒体文件的整目录拷贝（project.json + assets/）
  随 §7.1 项目资产落地时升级为 Rust 侧原子复制——届时复制件的 relPath 指向
  自己目录内的新文件。§7.1 落地前应用不管理媒体文件，不存在「索引在而文件不在
  自己目录」的中间态。**复制命名策略保证不超上限**：新名 = `{源名} 副本`（已存在
  则 ` 副本 2`、` 副本 3`…），拼接结果按字符数超过 64（§9.3 项目名校验口径）时先
  截断源名至可容纳后缀再拼接——直接追加后缀会让接近上限的合法源名复制即被
  持久化层拒绝，复制操作必须总能成功。

## 八、引用模型与联动规则

节点、设定、资产之间的引用是画布最容易出错的区域。本节定义引用的分类、唯一真相归属与联动规则。核心只有一条：**每个引用事实只存一处，其余全部是派生视图**。

### 8.1 引用类型与真相归属

| 引用类型 | 例子 | 唯一真相 | 派生物（不持久化） |
| --- | --- | --- | --- |
| 剧情流向 | 场景 → 对白 | `graph.edges` | 无 |
| 节点 → 设定 | 场景的 `characterIds` | spec 字段（id 数组） | 反向索引（「谁引用了这个角色」） |
| 文本内 @ 提及 | 对白文本里的 @角色 | 文本 token（只存 id） | 提及列表、高亮、反向索引——**不落边** |
| 节点/设定 → 资产 | 角色头像 `avatarAssetId` | assetId 字段 | 引用计数（清理未引用资产时现算） |
| 节点 → 节点输入（未来媒体节点） | 视频节点的立绘输入 | `graph.edges` | 执行输入在解析时现算，不物化镜像 |

细则：

1. **禁止镜像字段**：不设任何「引用的第二份拷贝」（如 inputs 镜像、边上冗余的引用标签副本）。派生信息需要时现算或重建，不持久化。
2. **文本 token 只存 id**：`@[character:{id}]` 形式，不存名称快照；显示名永远按 id 实时解析——改名不断引用，也无需回写任何文本。
3. **反向索引由模型层维护**：GraphStore 在每次 `applyCommand` 后增量重建「被引用方 → 引用方列表」索引，供「查看引用」「删除前确认」使用。索引是内存派生物，不进文档，不依赖任何组件的挂载状态。

### 8.2 生命周期联动规则

引用的建立、断开、悬空处理全部收敛到命令层（第九节），UI 只是发起者：

1. **建立**：连线 = `connect_edge`；@ 提及 = 编辑 spec 文本（`update_node_spec`）。引用关系随文本天然一致，不存在单独的「同步」步骤。
2. **断开 ≠ 删除**：断开连线只移除该边，不触碰对方的 spec/文本。删除节点连带删边，且节点与连带边进同一 `batch`——inverse 完整恢复两者（见 9.3），撤销后引用关系原样回来。删除分支选项同理：其引出的 branch 边由 **applyCommand 内置级联**一并删除——`update_node_spec` 收窄 `branch.options` 时，命令层自动检测被移除的选项 id 并在同一撤销单元内断开其出口边，**不依赖调用方自行拼装 batch**（Agent 走通用 `update_node_spec` 工具同样受保护）；inverse 同时恢复选项与被断开的边。
3. **删除被引用方**：不级联清理引用方（避免静默丢数据）。引用按「失效」展示（灰色角标/删除线），由用户决定替换或清除。
4. **加载修复而非拒绝**：归一化管线（第十一节）对悬空引用统一标记；孤儿边隔离并记录警告——单条坏数据不得导致整个项目加载失败。

### 8.3 为什么这样设计（失效模式对照）

引用系统的典型故障全部来自「同一事实多份拷贝 + 操作只更新部分副本」：

- 文本存一份、边存一份、镜像字段再存一份，编辑路径只更新其中一两个 → 各副本互相矛盾；
- 副本间的同步逻辑挂在组件生命周期上，组件卸载（节点收起/切换项目）同步即停止 → 引用残留或丢失；
- 删除节点清了边却忘了文本里的提及，或撤销删除只恢复节点不恢复连带边 → 引用关系永久错乱。

本节三条规则分别消灭这三类故障：没有副本就没有不一致（8.1）；派生重建在模型层，不依赖组件生死（8.1.3）；删除/撤销的级联在命令层一次完成（8.2.2）。

## 九、命令与撤销

数据与引用规则定义完毕，本节定义它们的唯一变更入口（原则 3）。

### 9.1 命令结构

单写者场景无需并发基线与路径级补丁。命令信封固定为六个字段：`id` / `type` / `actor`（变更来源：用户操作或 AI Agent，用于审计与 UI 标记，见十二节）/ `patch`（正向补丁）/ `inverse`（逆向补丁，执行时自动捕获）/ `timestamp`；另有可选的 `transient` 标记（瞬时 UI 命令：不落盘、不进撤销栈）。

`patch` 的具体形状由 `type` 决定，完整定义见 9.3。

### 9.2 命令清单

| 类别 | 命令 | 说明 |
| --- | --- | --- |
| 节点 | `create_node` / `delete_node` / `move_node` / `resize_node` | delete 连带删除关联边，inverse 一并恢复 |
| 节点数据 | `update_node_spec` / `update_node_meta` / `update_node_ui` | |
| 连接 | `connect_edge` / `disconnect_edge` | |
| 设定 | `upsert_character` / `delete_character`（地点、道具同构） |
| 设定文档 | `upsert_document` / `delete_document` | | |
| 集标题 | `set_episode_title` | title 为空串 = 删除该集的标题键 |
| 项目 | `rename_project` | 改 `project.name`；name 在命令边界按 §9.3 项目名校验口径校验并保存规范化结果，索引同步由持久化层负责 |
| 资产 | `set_asset` / `remove_asset` | set 为 upsert 语义（id 已存在 = 覆盖），inverse 视新增/覆盖而定（见 9.3） |
| 视口 | `update_viewport` | transient，不进撤销栈 |
| 批量 | `batch` | 一等命令，整批作为单个撤销单元；整批原子——预校验任一子命令失败即整批拒绝、零变更（见 9.3） |

### 9.3 命令数据模型

命令创建时只携带**变更意图**（目标值）；`inverse` 不由创建者填写，而是 `applyCommand` 执行时从变更前文档（docBefore）自动捕获。这保证 undo 数据永远与文档真实旧值一致，创建者不可能填错。

```ts
type Point = { x: number; y: number }
type Size = { width: number; height: number }
type Viewport = { x: number; y: number; zoom: number }
type NodeUi = StoryNode['ui']

/** 命令类型与负载形状的映射。 */
interface CommandPayloads {
  // ── 节点 ──
  // create_node 在命令边界按 nodeType 做同款校验（§4.1 判别联合）：
  // spec 须属于该类型；meta.label 仅名称型节点；shot 不得携带 episodeNo；
  // 非 shot 节点的 episodeNo 须为正整数且为安全整数（Number.isSafeInteger
  // 且 > 0，与 set_episode_title 同域——零/负/小数/非有限值产生的大纲分组
  // 没有合法的集标题命令可对应，非有限值经 JSON 序列化不稳定，超出安全
  // 整数范围的集号作为 episodeTitles 对象键会与相邻集号折叠）。
  // branch 节点的 spec.options 内选项 id 不得重复——重复 id 映射到同一
  // option-<id> 句柄，label 解析歧义，且删除其一不被识别为移除，级联会把
  // 既有连线静默改接到剩余同 id 选项上。其余键控列表同域校验：
  // dialogue.lines 的 DialogueLine.id、shot.refs 的 ShotRef.id 均须非空且
  // 数组内唯一（列表 key 用 id，重复或空 id 会让删除/重排 reconcile 到
  // 错误项；空选项 id 还会生成无标识的 option- 句柄）。
  // 另校验 node.id 非空且全局唯一：空 id 会生成无标识的边端点与空
  // React key；id 已存在于活动图时拒绝执行——否则追加会产生
  // 同 id 的歧义节点，且生成的 delete_node inverse 会把既有节点一并抹掉。
  // 导入器/Agent 须自行保证 id 新鲜；必要时由命令边界分配新 id 后再应用。
  // spec 数值域：sceneNo/shotNo 须为正整数且为安全整数（Number.isSafeInteger
  // 且 > 0——场号/镜号进卡片标题与导出排序，非有限值经 JSON 序列化变 null，
  // 超出安全整数范围的编号会与相邻编号折叠，导致重复编号与排序错误）。
  create_node: { node: StoryNode }              // 完整节点，含初始 layout/spec/meta
  delete_node: { nodeId: string }               // inverse 捕获被删节点 + 连带边
  move_node: { nodeId: string; to: Point }
  resize_node: { nodeId: string; to: Size }
  // ── 节点数据（set 为部分对象，只写变更字段）──
  // applyCommand 按解析出的节点类型校验 set：spec 字段须属于该类型的 Spec；
  // meta 字段同样按类型相关——label 仅名称型节点（scene/beat/dialogue）可写
  // （branch/shot 写 label 即镜像字段）；episodeNo 不可用于 shot（随宿主场景
  // 分集，§3.5），可用于其余类型但须为正整数（与 create_node 同域）。
  // 异型 set 拒绝执行。branch 的 options 补丁同样校验选项 id
  // 非空且数组内唯一；dialogue.lines / shot.refs 补丁同款（与 create_node
  // 同域，理由见其注释）。sceneNo/shotNo 补丁同样校验正整数域
  // （与 create_node 同域）。
  // update_node_meta 的 set 是联合而非交集：改名走 LabeledMeta 分支，
  // branch/shot 的 meta 编辑走 DerivedMeta 分支——交集会因 never 可选属性
  // 让改名补丁（{ label: '新名称' }）在类型上不可能成立。
  // 清除语义：unset 列出要删除的可选字段（如 episodeNo 回退未分集、
  // scene 的 locationId 解除引用）——JSON 无法传输 undefined，省略属性
  // 只表示「不修改」，清除必须走 unset。unset 与 set 同名字段、字段为必选
  // 或不存在（类型上无此键）一律拒绝；unset 空数组与省略等价。
  update_node_spec: { nodeId: string; set: Partial<NodeSpec>; unset?: string[] }
  update_node_meta: { nodeId: string; set: Partial<LabeledMeta> | Partial<DerivedMeta>; unset?: string[] }
  update_node_ui: { nodeId: string; set: Partial<NodeUi> }
  // ── 连接 ──
  // connect_edge 在命令边界解析端点校验：branch 边的 source 须为分支节点、
  // sourceHandle 中的选项 id 须存在于该节点 options（不可解出的连线留到
  // 加载才隔离会长期滞留活动图）；attach 端点类型校验同理（§5），且目标
  // shot 已有入向 attach 边时拒绝（宿主唯一，§5）——更换宿主走
  // disconnect_edge + connect_edge 进同一 batch 的原子操作。
  // 另校验 edge.id 非空且全局唯一（与 create_node 的 node.id 同款）：空 id
  // 会让 React Flow 以空 key 渲染、disconnect_edge 与 inverse 无法按 id
  // 定位；id 已存在于活动图即拒绝——否则产生同 id 的歧义边，且生成的
  // disconnect_edge inverse 会把既有同 id 边一并误删。剧情流边（sequence/branch）另须保持 DAG：
  // 自环与成环（BFS 传递闭包）在命令层同样拒绝——Agent/导入绕过交互层
  // isValidConnection 直达本边界（§4.3 两层校验）。
  // 端口归属反向校验：source 为 branch 节点的边必须是 branch 变体并携带
  // 合法 option-<id> 句柄——branch 节点没有匿名 output 端口（§4.3），
  // sequence/attach 从 branch 发出即绕过选项语义；targetHandle 必须省略，
  // sequence 边的 sourceHandle 同样必须省略（剧情流出口为匿名 output
  // 端口，Handle 无 id）——匿名端口句柄携带任意值即拒绝。
  // 另拒绝逻辑重复边：同（source, target, sourceHandle）的边已存在于活动图
  // 即拒绝——新 edge.id 不改变重复本质，重叠连线会令遍历与统计重复计数
  // （交互层与 AI 路径已有同款检查，本边界为兜底）。
  connect_edge: { edge: StoryEdge }             // 完整边，含 data.kind；branch 边不落 label（胶囊文案按 sourceHandle 派生，§5）
  disconnect_edge: { edgeId: string }           // inverse 捕获被删边
  // ── 设定（地点、道具同构，略）──
  // 命令边界校验实体形状（TS 类型在 JSON 边界已擦除）：id/name 为非空
  // 字符串（去首尾空白后非空）；Character.gradient 为字符串；可选字段
  // （bio/note/description/avatarAssetId）存在时须为字符串——异型即拒绝，
  // 否则 name: null 之类的值会持久化并使消费方（trim/渲染）在运行期崩溃。
  upsert_character: { character: Character }    // id 已存在 = 更新，否则 = 新增
  delete_character: { characterId: string }     // inverse 捕获被删实体
  // ── 设定文档（SettingsDocument，§6）──
  // 命令边界校验完整文档形状（TS 类型在 JSON 边界已擦除，Agent/MCP/导入
  // 均可提交异型负载）：id 非空；title/body 为字符串；relatedIds 每项须为
  // { kind: 'character' | 'location'; id: string }——旧式字符串项、未知
  // kind、缺失或空 id 即拒绝（跨桶同名使裸 id 无法解析归属，§6）；
  // 数组内 (kind, id) 重复即拒绝（重复关联会持久化并让反向索引/导航
  // 重复列出同一文档）。
  upsert_document: { document: SettingsDocument }  // id 已存在 = 更新，否则 = 新增
  delete_document: { documentId: string }          // inverse 捕获被删文档
  // ── 集标题 ──
  // episodeNo 必须为正整数且为安全整数（Number.isSafeInteger 且 > 0，与
  // §11.1 归一化口径一致——零/负/小数/非有限/超出安全整数范围的值在命令
  // 边界拒绝，防止写入后重载即被归一化删除）；title 先校验 typeof 为
  // string（TS 类型在 JSON 边界已擦除，非字符串值直接 trim 会抛异常、
  // 原样写入则重载即被归一化删除），再去首尾空白，空串 = 删除该键
  set_episode_title: { episodeNo: number; title: string }
  // ── 项目 ──
  // 项目名校验口径（rename_project 命令边界、create_project、持久化层的
  // 项目名/id 校验三处共用，与 src-tauri store.rs sanitize_name 一致）：
  // 先校验 typeof 为 string（TS 类型在 JSON 边界已擦除），去首尾空白后
  // 非空且按字符数 ≤ 64 字符。命令边界拒绝非法值并保存去空白后的规范化
  // 结果——否则无效名称先写入活动文档与撤销栈、随后持续保存失败，非
  // 字符串值还会破坏按字符串消费名称的 UI。
  // inverse 捕获 docBefore 中的旧名原值（不经规范化——§11.1 已保证
  // 活动文档中的名称合法可保存，inverse 才可经本边界回放）。
  rename_project: { name: string }
  // ── 资产 ──
  // set_asset 语义同 upsert：id 不存在 = 新增，已存在 = 覆盖；inverse 视
  // 新增/覆盖分别捕获（见下方 inverse 捕获规则），覆盖时恢复旧 AssetRef
  // 而非删除条目，避免 undo 让既有引用悬空。asset.relPath 受 §7.1 安全
  // 约束：绝对路径或规范化后越出资产根（含 .. 上跳）即拒绝。
  set_asset: { asset: AssetRef }
  remove_asset: { assetId: string }             // 只移除索引，不删文件（见 7.3）；assetId 不存在时按「目标缺失」通则拒绝（inverse 无从捕获，见下方 inverse 捕获规则）
  // ── 视口 ──
  // to 的 x/y 须为有限数值、zoom 为正且有限——非法变换在边界拒绝（与
  // §11.1 第 3 步 viewport 归一化同域），避免 Agent/导入写入无效视口。
  update_viewport: { to: Viewport }
  // ── 批量 ──
  // 原子性契约：applyCommand 对 batch 先按子命令顺序在「虚拟演进文档」上
  // 逐一预校验（每条子命令的边界校验都针对前序子命令应用后的文档形态）；
  // 任一子命令失败即整批拒绝、零变更——不允许顺序执行后中途失败留下半批
  // 结果（如换宿主 batch 的 connect 子命令因 edge.id 冲突被拒而 shot 成孤儿）。
  // 预校验全部通过后顺序执行并逐子捕获 inverse。
  batch: { commands: GraphCommand[] }           // 正向：完整命令信封（id/actor/timestamp 齐备，§9.1 审计契约）
}

type CommandType = keyof CommandPayloads

/** inverse 的类型安全形状：自带类型标签，patch 形状随标签走。
 * 多命令复合的 undo（如 delete_node 的连带边恢复）统一用 batch 承载。
 * batch 的 inverse 负载是 **InverseBatch**（子命令 inverse 的逆序数组），
 * 不是正向的 ForwardBatch——undo 操作由 applyCommand 内部构造，
 * 不经命令通道，无 id/actor/timestamp（§9.1 元数据契约只约束正向命令）。 */
type InversePatchOf<K extends CommandType> = K extends 'batch'
  ? { commands: InverseCommand[] }
  : CommandPayloads[K]

type InverseCommand = {
  [K in CommandType]: { type: K; patch: InversePatchOf<K> }
}[CommandType]

/** 类型化的命令信封：type 与 patch 必须同源于同一个 K（判别相关）。
 * inverse 是「另一条命令」（类型常与正向不同：upsert_character 新增的
 * inverse 是 delete_character），故为 InverseCommand 而非 CommandPayloads[T]。 */
interface GraphCommandBase {
  id: string
  actor: 'user' | 'agent'
  /** 执行时自动捕获的逆向命令；命令创建者不传。 */
  inverse?: InverseCommand
  transient?: boolean
  timestamp: number
}

/** 命令信封（数组/存储/传输/Agent 产出的默认形状）：type 与 patch 判别相关——
 * 裸 `type: K` 与异型 patch 的组合（如 delete_node 配 remove_asset 负载）
 * 在类型层即不可表示。 */
type GraphCommand = GraphCommandBase & {
  [K in CommandType]: { type: K; patch: CommandPayloads[K] }
}[CommandType]

/** 已知具体类型时的提取（applyCommand 逐类型分发）。 */
type GraphCommandOf<K extends CommandType> = Extract<GraphCommand, { type: K }>
```

**inverse 捕获规则**（applyCommand 内置，逐类型固定；inverse 的 type 按「捕获到的实际逆操作」取值）：

依赖既有实体的命令（`delete_node` / `disconnect_edge` / `delete_character` / `delete_document` / `remove_asset` / `update_node_*` 等删除与更新类）在命令边界**要求目标存在**：目标缺失时拒绝执行并返回错误——inverse 依赖从 docBefore 捕获旧实体，目标缺失时 inverse 无法生成，实施者只剩报错、制造不可撤销的历史项或伪造数据三条歧路，故统一取第一条。若某调用方（如 Agent 持过期快照重放）需要吞掉此类失败，语义为**不入栈的 no-op**：不产生 undo 历史项、不触发持久化变更标记，且必须显式选择该语义而非默认行为。

| 命令 | inverse 内容 | inverse.type |
| --- | --- | --- |
| `create_node` | 等效 `delete_node { nodeId }` | `delete_node` |
| `delete_node` | 等效 `create_node { node }` + 每条连带边的 `connect_edge`，进同一 `batch` | `batch` |
| `move_node` / `resize_node` / `update_viewport` | 同结构，`to` 换为 docBefore 中的旧值 | 同正向 |
| `update_node_*` | 同结构，`set` 只含被覆盖与被清除字段的旧值；被 `set` 新增（原先不存在）的字段进 inverse 的 `unset` | 同正向；**唯一例外**：触发选项级联的 `update_node_spec`（§8.2.2）→ inverse 为 `batch`——旧 spec 补丁 + 每条被级联删除边的 `connect_edge`，整体恢复 |
| `connect_edge` / `disconnect_edge` | 互逆，边数据取自 docBefore | 对偶命令 |
| `upsert_character` | 新增 → `delete_character`；更新 → 旧实体整体 | 视新增/更新而定 |
| `delete_character` | 等效 `upsert_character { character: 旧实体 }` | `upsert_character` |
| `upsert_document` | 新增 → `delete_document`；更新 → 旧文档整体 | 视新增/更新而定 |
| `delete_document` | 等效 `upsert_document { document: 旧文档 }` | `upsert_document` |
| `set_episode_title` | 同结构，title 换为旧值；原来无该键 → inverse 为空串（即删除） | `set_episode_title` |
| `rename_project` | 同结构，name 换为 docBefore 中的旧名 | `rename_project` |
| `set_asset` | 新增 → `remove_asset { assetId }`；覆盖已有 id → `set_asset { asset: docBefore 中的旧 AssetRef }`（恢复旧值，而非删除条目） | 视新增/覆盖而定 |
| `remove_asset` | 等效 `set_asset { asset: docBefore 中的旧 AssetRef }` | `set_asset` |
| `batch` | 子命令 inverse 的**逆序**数组，进同一 `batch` | `batch` |

### 9.4 撤销规则

- 撤销/重做栈仅存于会话，不持久化；上限 50 条。
- 拖拽中发 `move_node { transient: true }`，松手时补发一条正式命令进撤销栈。
- `update_node_ui`（选中、展开折叠）与 `update_viewport` 不进撤销栈。

## 十、本地存储体系

命令产出的文档变更，经防抖持久化回调落到以下布局。

### 10.1 目录布局

```
应用数据目录/                           # Tauri app_data_dir，禁止硬编码路径
├── projects/
│   └── {projectId}/
│       ├── project.json               # ProjectDocument
│       └── assets/                    # 项目资产（自包含）
│           ├── {assetId}.png
│           └── {assetId}.mp4
├── library/                           # 个人资产库（跨项目复用）
│   └── assets/
│       └── {assetId}.png
├── library.json                       # 库索引：assets.byId（分类/视角/标签）+ groups.byId（编组）
├── index.json                         # 项目索引：首页列表元数据（id/名称/缩略图/updatedAt）
└── settings.json                      # AppSettings：provider 配置与模型选择（不含 API key）
```

**存储布局迁移（独立于文档 schema 迁移的轴）**：文档 `schemaVersion` 迁移（§11.1）只转换文档内容，不涉及文件位置。当前实现（v0 与 v1 文档）均以扁平 `projects/{id}.json` 存储——上文目录布局中的每项目子目录、`assets/` 与 `index.json` 随 §7.1 项目资产落地。届时**必须**三选一，防止既有项目在首页消失：

- **布局迁移**：启动时发现旧扁平文件 → 建目录搬移为 `{id}/project.json` → 写入 `index.json`，迁移原子完成（失败回滚到扁平布局）；
- **路径回退**：目录化后 `list_projects`/`load_project` 仍兼容发现扁平旧文件（只读兼容，首次保存时搬移）；
- 或两者结合（推荐：启动迁移 + 兜底回退）。

布局迁移未实现前，§10.1 的 `index.json`/每项目目录不应成为 `list_projects` 的唯一数据源。

### 10.2 写入安全

单写者场景**不需要**文件锁、版本号等并发机制；但需要防崩溃截断——写到一半进程被杀、断电、磁盘满，会留下截断的 JSON，导致整个项目无法打开。因此：

- 写 `project.json.tmp`，flush 后 rename 覆盖 `project.json`（rename 原子，读者只见旧版或新版，不见半个文件）。`index.json` / `library.json` / `settings.json` 同样处理。
- 前端防抖 500ms 提交一次；失败回队重试；`flushPersist()` 在关闭窗口/切换项目前调用。

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

### 10.4 密钥管理

provider 的 API key 以**密文 `keyEnc`** 存于 provider 配置：Rust `seal` 模块 AES-256-GCM 加密（密钥 = 应用常数 + IOPlatformUUID + 随机盐，封装于 envelope），明文只在加密/请求的进程内存中出现；历史钥匙串数据保留只读回退，不再写入。

### 10.5 Rust 持久化命令（Tauri commands）

| 命令 | 职责 |
| --- | --- |
| `list_projects()` | 读 `index.json`，返回项目列表 |
| `create_project(name)` | 建目录 + 初始 `project.json` + 更新索引；name 按 §9.3 项目名校验口径校验（与 rename_project 同规则） |
| `load_project(projectId)` | 读 `project.json`；信封级兼容（旧扁平格式包装为 v0 信封）。节点级 schemaVersion 迁移与归一化在前端模型层（见十一），Rust 不参与 |
| `save_project(projectId, doc)` | tmp + rename 原子写；`doc.project.updatedAt` 以本次保存时刻盖戳（与写入索引的 updatedAt 同值，前端 serializeProject 盖戳、Rust 校验非空）+ 更新索引的 name/updatedAt（重命名后索引同步在此发生） |
| `import_asset(projectId, file)` | 拷贝入项目 `assets/`，返回 `AssetRef` |
| `list_library_assets()` | 读 `library.json`，返回资产库列表（含编组） |
| `import_library_asset(file, meta)` | 拷贝入 `library/assets/` + 更新库索引，meta 含 name/kind/view/groupId/tags |
| `update_library_asset(assetId, patch)` | 修改索引项：改名、改标签、改视角、换编组（只动索引不动文件） |
| `delete_library_asset(assetId)` | 删库文件 + 索引项（不影响已拷入项目的副本） |
| `collect_library_asset(projectId, projectAssetId, meta)` | 把项目资产拷贝入资产库（「收藏」） |
| `get_settings()` / `update_settings(patch)` | 非敏感配置读写 |
| `set_provider_key(provider, key)` | 加密并返回 envelope 密文（由前端随 settings 落盘；解密走 `seal::open`，无独立读命令） |
| `llm_chat(messages, tools)` | LLM 请求代理：key 由 settings 密文在 Rust 内存解密，绕开 webview CORS（见 12.2） |

## 十一、加载与归一化

`load_project` 返回后、交付画布前执行归一化管线，保证任何历史版本的文档都以当前形态进入会话。管线位于**前端模型层**（纯 TS，无框架依赖，与 §2 分层一致）——Rust 持久化层对节点/边结构不透明，只做信封透传与项目名/id 校验；信封级兼容（旧扁平格式缺 `schemaVersion` 时包装为 v0 信封）由 Rust 在 `load_project` 内完成。唯一例外是资产 relPath 的真实路径包含判定（canonicalize/符号链接解析）——只能由可访问文件系统的 Rust 层在 `load_project` 内执行，非法条目清单随加载结果返回，供第 3 步消费（§7.1 分层执行）。

1. `schemaVersion` 低于当前版本时按迁移链逐级升级；高于当前版本时拒绝并提示升级应用。**迁移链首环**：schemaVersion 0（首版扁平存储格式：顶层 `name`/`updated_at`/`nodes`/`edges`/`settings`/`episodeTitles`，节点数据未分区、设定集为数组）→ 1（本文档结构）。首环包含四次改写与一次信封装配，改写全部发生在孤儿边隔离之前：① 补列表项稳定 id（`branch.options` 等），**并在同一数组内去重——v0 已存在的重复选项 id 在此重发新 id**（必须在 ② 之前完成：旧下标句柄按「下标 → 选项」定位，若重复 id 留到 ② 之后才去重，指向后一重复项的连线会先被改写为重复 id 的句柄、再随去重被静默改接到首见项）；② 把分支边的旧式下标句柄（`option-0`、`option-1`…）按「下标 → 迁移后选项 id」改写为稳定 id 句柄（`option-<id>`）——必须在补 id（含去重）之后，否则旧连线会在加载时被误隔离，无法解析的越界下标原样保留，交由第 3 步隔离并警告；③ 把边的旧式运行态判别字段（`type: 'branch'`、`className: 'pw-edge-attach'/'pw-edge-sequence'`）按归类规则（§4.3 连线语义）改写为显式 `data.kind`，**并删除镜像的 `data.optionLabel`**（§5 禁止边上落 label，胶囊文案按改写后的稳定句柄重新派生）；④ 节点结构转换：旧 React Flow 形状（顶层 `position`/`selected`、类型字段平铺于 `data`）拆入四分区（`layout`/`ui`/`data.spec`/`data.meta`），**名称型节点（scene/beat/dialogue）的旧 `data.name` 上移为 `meta.label`（必填）**，`ui.selected` 重置、`ui.expanded` 初始化为 `true`（旧节点无该字段）——v0 节点未经此转换不得 stamped 为 v1。⑤ **信封装配**（文档级映射与缺省回退，经 Rust `wrap_legacy` + 前端 `serializeProject` 协作完成）：顶层 `name` → `project.name`；顶层 `updated_at`（epoch 毫秒）→ ISO 8601 → `project.updatedAt`，`createdAt` 缺省与 `updatedAt` 同刻；`project.id` 由项目文件名回填（信任边界校验）；`nodes`/`edges` 上移 `graph`，`viewport` 缺省不伪造（打开时 fitView）；`settings` 的嵌套数组键化：`settings.characters[]` / `settings.locations[]` → `Record<id, 实体>`（v0 的 `settings` 本身是对象，数组在成员上——勿把整个 settings 当数组转换），**键化前校验实体 id：重复 id 保留首见项、后续重发新 id（节点引用本就按 id 解析到首见项），空 id 重发新 id——均记录警告**，避免直接键化时同键覆盖、设定内容静默丢失；空 id 重发时建立「空 id → 新 id」映射并同步改写同桶引用（`characterIds`、`speaker` 等，与第 3 步空键处理同款）——数组内仅一个空 id 实体时映射明确、引用随重发保留；多个空 id 实体映射歧义，相关引用保持悬空并记录警告（键化完成后记录键已非空，第 3 步的空键改写不会补到这一步）；`props`/`documents` 补空桶；`episodeTitles` 归一化（字符串键 → 数字键的格式转换、去空标题——仅规范十进制正整数字符串键参与转换，非规范数字串如 `"01"`/`"1e0"` 不转换、连同非法键一并由第 3 步删除；键/值域校验由第 3 步对所有版本统一执行，见下），缺省 `{}`（v0 早于集标题功能的文件没有该字段）；`assets` 补 `{ byId: {} }`。⑤ 完成前文档不得 stamped 为 v1。
2. 先做容器级形状校验（所有版本，先于一切逐项规则）：`graph` 缺失或非对象时补 `{ nodes: [], edges: [] }`；`graph.nodes`/`graph.edges` 非数组时重置为空数组；`settings` 缺失或非对象时补默认空桶，`settings.characters`/`locations`/`props`/`documents` 与 `assets.byId` 非普通键值对象（`null`、数组或其他异型——JavaScript 中数组同为对象，「非对象」检查不足以排除；数组形态会让下标 `"0"`/`"1"` 被当作权威实体 id 改写内嵌 id，原有引用静默悬空）时重置为对应空 Record；`assets` 父容器缺失或非对象时补 `{ byId: {} }`，`episodeTitles` 缺失或非 Record（`null`/数组等）时重置为 `{}`——标题表容器不合法时第 3 步的键值遍历无从执行。异型容器的内容无法机械恢复，重置均记录警告，但管线必须可遍历、单个脏字段不能让整个项目打不开（§8.2.4）。容器就位后再过滤**成员级异型**——节点/边数组中的非普通对象成员（`null`/数组/标量）隔离并记录警告，Record 桶中的非普通对象值同款移除：任何字段读取与改写只针对普通对象成员，否则 `graph.nodes: [null]` 会在下一步重置 `ui.selected` 时解引用 `null`、`characters.c1 = null` 会在内嵌 id 修复时崩坏。成员过滤后，先补齐节点 `ui` 默认值——`ui` 缺失/非对象或 `selected`/`expanded` 类型错误时重置为 `selected: false`、`expanded: true`（与迁移 ④ 初始化口径一致）并记录警告——再重置所有节点 `ui.selected = false`（顺序不能颠倒：普通对象节点的异型 `ui` 会在重置时直接解引用失败）。
3. 隔离孤儿边（source/target 节点已不存在；branch 边的 `sourceHandle` 指向的选项已不存在、kind/句柄矛盾（§5 保留字面量）、sequence/attach 边 source 为 branch 节点（§5 端口归属反向约束）、attach 边端点类型不合法——必须 scene → shot——、sequence/branch 边端点为 shot（§4.2 分镜卡不参与剧情流）同论）并记录警告——修复而非拒绝，单条坏数据不阻断加载（见 8.2.4）。边携带 `targetHandle` 或 sequence 边携带 `sourceHandle` 时不隔离而剥离——匿名端口唯一（§5），剥离不改变连接语义，记录警告。剧情流边的自环与成环同款隔离：按文档序逐边重建剧情流图，source 等于 target 的自环边、加入即闭合回路的 sequence/branch 边均按孤儿边隔离并警告（attach 垂直从属不参与环检测，§4.3）。节点 id 重复时保留文档序首个节点、后续同 id 节点重发新 id 并记录警告——按 id 的引用（边端点等）本就解析到首个节点，重发节点成为无连线孤儿节点（内容保留，由用户处置）。branch 节点 `options` 内出现重复 id 时同样修复：保留首见项，后续重复项重发新 id 并记录警告——v1 文档的连线按 id 解析，本就归属首见项，重发不产生改接（v0 迁移路径的重复 id 已在首环 ① 去重，不经此条）；其余键控列表（`dialogue.lines`、`shot.refs`）的重复 id 同款修复——它们不被边引用，重发纯为列表 key 去歧。边 id 缺失或为空时重发新 id 并记录警告（边 id 不被数据引用，仅命令与 inverse 使用，重发无副作用；React Flow 以边 id 为 key，空 id 的边无法可靠渲染、删除或撤销）；边 id 重复时保留文档序首条、后续重复边重发新 id 并记录警告。同一 shot 存在多条入向 attach 边时保留文档序首条、其余按孤儿边隔离并警告（宿主场景唯一，见 §5 attach 宿主约束）。节点 `meta.episodeNo` 非法（非正整数、非有限值或超出安全整数范围，§9.3 命令边界同域）时删除该字段并记录警告——回退为未分集，不阻断加载。逻辑重复边（同 source/target/sourceHandle，§5）保留文档序首条、其余按孤儿边隔离并警告。按 §4.1 判别联合校验节点 `type` 与 `spec`/`meta` 的对应：never 禁写字段被携带（branch/shot 的 `label`、shot 的 `episodeNo`）时剥离该字段并警告；type 与 spec 形态错位（如 scene 携带 BranchSpec）、名称型节点缺必填 `meta.label` 等无法机械修复的异型节点，隔离该节点及其关联边并记录警告，不交付画布——JSON 边界已擦除 TypeScript 类型，此校验是 §9.3 create_node 边界校验在加载路径的对等兜底。节点基础结构（§4.1 StoryNodeBase 四分区的外壳）同款校验：节点 `id` 缺失或为空时重发新 id 并记录警告——缺失（undefined/null）的 id 无引用可指向，重发无副作用；**空字符串 id 可被脏写的边端点（`source: ''`/`target: ''`）指向**，重发时建立「空 id → 新 id」映射并同步改写边端点——仅一个空 id 节点时映射明确、连线保留；存在多个空 id 节点时映射歧义，指向空串的边按孤儿边隔离并警告（与空选项 id 的歧义处理同款；更正四十四轮「无引用可指向缺失 id」对空串不成立的表述）；`ui` 的缺失/异型已在第 2 步重置 `selected` 前补齐默认值，本条不再重复；`layout.size` 等可选布局数值非法时剥离该字段并记录警告；`layout.position` 坐标非有限数值等无法机械修复的基础结构异型，隔离该节点及其关联边并记录警告、不交付画布——单个异型节点不阻断项目打开（§8.2.4），缺坐标/缺 ui 的节点会让依赖 StoryNodeBase 的画布渲染直接崩溃。非法 sceneNo/shotNo（非正整数、非有限值或超出安全整数范围，§9.3 同域）按文档序顺位重发为正整数并记录警告（场号/镜号可在场景面板修正）。键控列表（`branch.options`/`dialogue.lines`/`shot.refs`）中的空 id 重发新 id 并记录警告。重发空选项 id 时建立「空 id → 新 id」映射并同步改写该 branch 节点引出边的 `option-` 句柄——branch 内仅一个空 id 选项时映射明确、连线保留；同 branch 存在多个空 id 选项时映射歧义，无法归属的连线按孤儿边隔离。本步内节点/列表修复先于边隔离判定，句柄解析针对修复后的 id。资产索引逐项校验 relPath（§7.1 安全约束）：词法层（绝对路径、解析目标越出资产子目录）由本步判定；真实路径包含判定（canonicalize/符号链接解析）消费 Rust `load_project` 随加载结果返回的非法条目清单——两类非法条目均从 `assets.byId` 移除并记录警告，其引用字段按 §8.2.3 悬空展示，项目自包含不因脏路径破坏。`episodeTitles` 键值校验对**所有版本**文档执行（迁移链 ⑤ 只做 v0 的字符串键 → 数字键格式转换，v1 文档不经迁移链，脏写/导入仍可携带非法键值）：键须为规范十进制正整数字符串且在安全整数范围（`Number.isSafeInteger`）内——零/负/小数/NaN/非数字串删除该键并记录警告（无法由 `set_episode_title` 产生也无大纲语义）；`"01"`、`"1e0"`、`" 1"` 等可折算为正整数但非规范书写的键同样删除并记录警告——它们与规范键（如 `"1"`）折叠到同一集号，转换时会按属性遍历序静默覆盖其中一个标题；超出安全整数范围的键删除并警告（`Record<number, string>` 索引精度不保）。值非字符串时删除该键并记录警告（大纲 UI 只消费字符串标题）；字符串值去首尾空白，空白后为空串的删除该键（与 `set_episode_title` 落盘口径一致）。键控实体桶（`settings.characters`/`locations`/`props`/`documents`、`assets.byId`）的 Record 键与值内嵌 id 一致性修复对**所有版本**执行，且**先于各桶的实体形状校验**（v0 数组键化在迁移链 ⑤ 按实体 id 建键、天然一致，但 v1 脏写/导入可产生 `characters.ch1.id === 'ch2'` 式分裂身份——引用按记录键解析，更新/删除按值内 id 定位，两者不一致时实体可显示却无法正确更新或删除）：**记录键本身先校验非空**——空键条目确定性重发新键（值内 id 随键同步为同一新 id）并记录警告（空身份与 upsert 边界的非空 id 约束冲突、空 React key 致 reconcile 错位）；重发时建立「空键 → 新键」映射并同步改写指向空串的同桶引用字段（如角色的 speaker、ShotRef.targetId、avatarAssetId）——每桶至多一个空键条目（JSON 键唯一），映射天然明确，引用随重发保留而非悬空；仅非标准解析保留重复空键等歧义情形无法归属，相关引用保持悬空并记录警告（更正四十二轮「空键不可能承载合法引用」的表述——脏写的引用侧同样可以出现空串）；键合法时，内嵌 id 缺失或为空以记录键补齐、不一致时以记录键为准改写，均记录警告——键是引用解析的权威值，补齐/改写可无歧义地保住条目内容与全部既有引用；键在 Record 内天然唯一，改写后各值内 id 亦唯一，不产生碰撞。`project.name` 归一化对所有版本执行（§9.3 项目名校验口径的加载侧兜底——`load_project` 只反序列化文件，旧项目或手工修改可携带非法名称）：typeof 非 string、去首尾空白后为空或按字符数超过 64 时确定性修复——先去首尾空白，合法则采用规范化值；仍非法则回退为项目索引（`index.json`）中的名称，索引亦无合法名称时回退固定占位「未命名项目」，均记录警告。活动文档中的名称由此始终可保存，`rename_project` inverse 捕获的旧名才能经同一命令边界回放——否则撤销要么被边界拒绝，要么恢复一个 `save_project` 会拒绝的名称。`graph.viewport` 存在时校验其形状：非对象、`x`/`y` 非有限数值或 `zoom` 非正/非有限时删除该字段并记录警告——回退打开时 fitView（§3 缺省语义），无效变换不交给画布（否则可能出现空白或不可操作的视图）。`settings.documents` 逐项校验 SettingsDocument 判别形状（§6，JSON 边界已擦除 TS 类型）：`relatedIds` 关联项不符合 `{ kind: 'character' | 'location'; id: string }` 形状时删除该项并记录警告——旧式字符串项无法解析归属（跨桶同名歧义，§6）、未知 kind、缺失或空 id 同论；形状合法但 `(kind, id)` 重复的关联项保留首见、其余删除并记录警告（重复关联会让反向索引/导航重复列出同一文档）。文档条目本身 `title`/`body` 非字符串等无法机械修复的形态，从 `documents` 隔离该条目并记录警告（内嵌 id 已经一致性改写补齐，不在本条判定范围）——否则按 `{ kind, id }` 构建的反向索引、导航与失效引用展示无法解析。`settings.characters`/`locations`/`props` 逐项校验实体形状（与 §9.3 upsert 边界同域；内嵌 id 已经一致性改写补齐，本条只判定其余字段）：必填字段缺失或类型错误（name 非空字符串、Character.gradient 字符串）的条目无法机械修复——从桶中隔离并记录警告，既有引用按 §8.2.3 悬空展示（否则 `name: null` 之类的值会交付画布，消费方 trim/渲染在运行期崩溃）；可选字段（bio/note/description/avatarAssetId）存在但类型错误时剥离该字段并记录警告。
4. 标记（而非清除）悬空的设定引用与资产引用。
5. 扫描文本中的 @ 提及 token，目标已不存在的标记为失效（token 本身保留，见 8.1.2）。
6. 重建 id 生成器的计数基线，防止新 id 与存量冲突（当前 id = 类型前缀 + 时间戳 + 随机尾，天然无计数基线；本条为将来引入计数式 id 时的保留动作）。

## 十二、AI Agent 交互

用户通过对话让 AI 操作画布——创建/删除节点、修改 spec、连线、批量调整剧情结构。这一能力完全建立在第九节的命令通道上。

### 12.1 核心决策：Agent 是命令的另一个生产者

Agent 不直接触碰文档状态，只产出 `GraphCommand`（`actor: 'agent'`），经同一条 applyCommand 链路执行。由此免费获得：

- 撤销/重做天然覆盖 AI 操作，误操作一键回滚；
- 持久化、归一化、悬空引用检测不需要为 Agent 写第二套；
- `actor` 字段为审计与 UI 标记（「此改动来自 AI」）提供依据。

### 12.2 应用内 Agent（首版）

不引入 Agent 编排框架。画布操作是「读快照 → 发一批结构化命令」的低轮次任务，朴素的 tool-calling 循环足够：

```
用户对话 → [系统提示 + 画布快照摘要 + 工具 schema] → LLM（BYOK，OpenAI 兼容 tool calling）
        → 解析 tool_calls → 映射为 GraphCommand 批量执行 → 结果摘要回喂 →（需要时再一轮）
```

- **工具集 = 命令清单的封装**：读工具 `get_graph_snapshot` / `get_node`；写工具 `create_node` / `delete_node` / `update_node_spec` / `connect_edge` / `disconnect_edge` / `batch`。
- **快照摘要而非全量**：大项目全量 JSON 会超出上下文，默认只给压缩视图（节点 id/type/label/连接关系），详情由模型用读工具按需拉取。
- **调用路径**：前端驱动循环；LLM 请求经 Rust command `llm_chat` 代理发出——API key 以密文随 settings 落盘、在 Rust 内存解密，前端不持有明文，同时绕开 webview 的 CORS 限制。
- **可控性**：Agent 的写操作执行前弹批量预览（涉及哪些节点、什么变更），用户确认后才进命令通道；undo 始终兜底。

### 12.3 MCP 暴露（可选，后置）

同一套工具可经 MCP server（Rust 侧实现，stdio/HTTP）暴露给外部 LLM 客户端，让外部 Agent 操作画布。因为工具即命令，MCP 只是命令通道的第二个入口，边际成本低；但它依赖用户自行运行外部客户端，属于高级玩法，不替代产品内 Agent。触发条件：有明确的「在外部 Agent 工作流中编排 PlotWeave」需求时再做。

## 十三、后续演进预留

以下方向发生时需要修订本文档或另起文档：

- **画布内 AI 生成**（文生图/AI 编剧）：新增媒体节点类型（图片节点、视频节点，如角色立绘、场景概念图），建模遵循三分原则——**引用类输入走边**（如图生视频的立绘引用），**参数类配置走 `spec.params`**（尺寸/时长/seed），**操作类型由 `spec.operation` + 输入证据推断**（有参考图 → 图生图，无需用户显式选择）；产物是 `outputs` 里的 AssetRef 槽位（`primary` / `poster` / `preview`，附宽高、时长等 metadata）。节点的 prompt、模型选择作为 `data.spec` 字段随 `project.json` 持久化，无需额外存储；需要新增的是 job 状态机（落盘 + 启动恢复）与输入签名（防旧结果覆盖新编辑），进程内以 tokio task + 取消令牌实现。
- **多端同步/协作/官方代付**：另起《服务端领域模型》文档；`schemaVersion` 迁移机制届时成为前后端契约的一部分。
- **跨项目搜索、资产去重**：评估 SQLite 索引层。
