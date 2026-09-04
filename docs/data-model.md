# PlotWeave 数据模型设计

> 状态：v1（2026-08-28 定稿）
> 实施状态：本文是 v1 **目标契约**，不表示当前旧运行态已经完成切换。`ProjectDocument` v1 类型、`settings.documents`（连同 characters/locations/props）的无损归一化与序列化、§11 加载管线及回归测试全部落地前，现有运行态仍按 v0 处理，**不得写入或保存 `schemaVersion: 1`**；否则会把未被旧模型承载的字段静默丢弃后再错误盖章为已迁移。
> 本版相对草案的修订：ProjectDocument 补 `episodeTitles` 字段；§4.2 各 spec 字段对齐 UI 设计已实现的节点形态（场景卡 sceneNo/interior/weather、对白行 kind/side/vo、分支 options 入 spec）；§5 分支边不再持久化 label 拷贝；§6 Character/Location 字段对齐运行态实体（gradient/bio/note，长篇自由文本由 SettingsDocument 承载）；§11 明确归一化管线位于前端模型层，并登记 schemaVersion 0（旧扁平存储格式）→ 1 的迁移。
>
> 定稿评审修订（2026-08-29）：§9 补 `set_episode_title` 命令（集标题变更走命令通道）；`settings.documents` 补为 SettingsDocument 的持久化位置；§10.5 `load_project` 职责更正为信封级兼容（与 §11 分层一致）；分支边 `sourceHandle` 由数组下标（option-N）改为稳定选项 id（option-\<id\>），删除选项连带其连线进同一 `batch`，杜绝下标位移导致的静默改接。
>
> 二轮评审修订（2026-08-29）：§11.1 迁移链首环写明「补选项稳定 id → 改写旧式下标句柄 → 孤儿边隔离」的先后依赖（P1）；§9 设定文档命令显式化为 `upsert_document` / `delete_document`（含 inverse 捕获）；docs/ui-design.md §10 对照清单标记全部落地。
>
> 三轮评审修订（2026-08-29）：§9.3 inverse 改为 InverseCommand 判别联合，捕获表补 inverse.type 列；ui-design §4.2 端口描述收口 option-\<id\>。
>
> 四轮评审修订（2026-08-29）：§4.2 ShotRef 契约改为旧 `targetId` 引用目标（该字段后由六十四轮收紧为项目资产 `assetId`；§8.1 单一真相，显示名实时解析），label 降级为自由引用位兜底；ui-design §4.3 分支改名路由更正为 `update_node_spec`（标题由 spec.prompt 派生，不落 meta.label 镜像）。
>
> 五轮评审修订（2026-08-29）：§9.3 `connect_edge` 负载说明去掉 label（分支胶囊文案按 sourceHandle 派生）；ui-design §4.2 引用位描述统一为 `spec.refs`（删去不存在的 spec.params）；§7.3 写明项目复制的资产携带规则（索引随文档走，整目录拷贝随 §7.1 落地）。
>
> 六轮评审修订（2026-08-29）：§4.2 ShotRef 改为引用位/自由位互斥判别联合（当时为 `targetId` 与 label 不共存，六十四轮改为 `assetId`；迁移不得残留旧 label）；§9.3 命令信封改为判别相关的 GraphCommand，type 与 patch 异型组合在类型层不可表示；ui-design §4.2 节奏卡字段名对齐 `tone`、§7.4 集持久化改为已定稿的 episodeTitles。
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
> 三十五轮评审修订（2026-08-29）：§7.1 relPath 安全约束扩展到库索引入口——`library.json` 可被手工修改或损坏，读取（`list_library_assets`）时逐项应用同款根目录校验并隔离非法条目（不进内存索引、记录警告），mediaUrl 拼接与 `delete_library_asset` 只作用于通过校验的条目，不只约束新导入（该路径拼接方案后由六十一轮 opaque 协议取代）；§11.1 第 3 步补 `episodeTitles` 键值校验并覆盖所有版本文档——迁移链 ⑤ 的标题表归一化只对 v0 生效，v1 脏写/导入文档可携带零/负/小数键与非字符串值，须在通用归一化删除（正整数键、值去空白、空标题删键）；§9.3 `upsert_document` 补完整 SettingsDocument 运行时校验（JSON 边界已擦除 TS 类型），§11.1 第 3 步补 `settings.documents` 归一化——旧式字符串 relatedIds、未知 kind、缺失 id 的关联项删除并警告，形态不可修复的文档条目隔离。
> 三十六轮评审修订（2026-08-29）：§7.1 relPath 校验由词法规范化升级为真实路径包含判定——资产根与目标路径 canonicalize（解析符号链接）后判定包含，新增资产目标不存在时拒绝路径各级符号链接（词法合法的 `assets/link` 经符号链接仍逃逸资产根，词法检查防不住）；§11.1 ⑤ 与第 3 步收紧 episodeTitles 键为规范十进制正整数字符串且限安全整数范围——`"01"`/`"1e0"` 等非规范数字串与规范键折叠到同一集号会按属性序静默覆盖标题，转换只接受规范键、其余删除并警告。
> 三十七轮评审修订（2026-08-29）：§5 EdgeBase.targetHandle 与 SequenceEdge.sourceHandle 由可选 string 改为 never 禁写（静态类型与 connect_edge 边界契约一致，非法形状编译期即不可表示）；episodeNo 域统一收紧为安全整数（Number.isSafeInteger 且 > 0，§4.1/§9.3 create_node/update_node_meta/set_episode_title/§11.1 同域）——超出安全整数范围的集号作为对象键会与相邻集号折叠，命令写入后重载即被归一化删除；§9.3 补「目标缺失」通则——删除/更新类命令在边界要求目标存在（inverse 依赖 docBefore 捕获，目标缺失即拒绝；需吞掉过期命令时为不入栈的显式 no-op）；§11.1 第 3 步补键控实体桶 Record 键与值内嵌 id 一致性校验（所有版本）——不一致时以记录键为准改写值内 id（引用按键解析，改写保住既有引用且键天然唯一、不产生碰撞）。
> 三十八轮评审修订（2026-08-29）：SettingsDocument.relatedIds 补数组内 (kind, id) 唯一约束——§9.3 upsert_document 边界拒绝重复项，§11.1 第 3 步归一化保留首见、其余删除并警告（重复关联持久化会让反向索引/导航重复列出同一文档）；§9.3 set_episode_title 补 title 的 typeof string 前置校验——TS 类型在 JSON 边界已擦除，非字符串值直接 trim 抛异常、原样写入则重载即被归一化删除，须先验类型再去空白。
> 三十九轮评审修订（2026-08-29）：§9.3 补项目名校验口径（rename_project 命令边界、create_project、持久化层项目名校验三处共用）——先验 typeof string，去首尾空白后非空且 ≤ 100 字符，命令边界拒绝非法值并保存规范化结果（否则无效名称先入活动文档与撤销栈、随后持续保存失败）；inverse 捕获 docBefore 旧名原值。
> 四十轮评审修订（2026-08-29）：§7.1 资产根收紧为专用子目录（项目 `assets/`、库 `library/assets/`），relPath 基准与 canonical 包含判定的根同步收紧——以整个项目/库目录为根时 `"library.json"` 条目词法合法且 canonical 仍在根内，会让 delete_library_asset 的 remove_file 删除索引自身（P1）；§9.3 upsert_character 边界补实体形状校验（id/name 非空字符串、gradient 字符串、可选字段类型），§11.1 第 3 步对 characters/locations/props 做同域加载校验——必填字段异型隔离该条目、可选字段异型剥离字段（先于键与内嵌 id 一致性改写执行）；更正三十九轮项目名上限为按字符数 ≤ 64（与 src-tauri store.rs sanitize_name 实现一致，此前写的 100 与持久化层不符，会造成「重命名成功、保存持续失败」）。
> 四十一轮评审修订（2026-08-29）：§7.1 补 relPath 使用时校验（TOCTOU）——仅在列表入口过滤不足以兜底，delete_library_asset 重读磁盘索引后按其中 relPath 调 remove_file，索引可能在两次校验之间被替换；凡按 relPath 触达文件系统的入口（读取/拼接/删除）都在操作当时重新执行真实路径包含校验，或只消费本会话已验证的内存条目（P1；该替代方案后由六十一轮废止）；§11.1 第 3 步更正四十轮的校验顺序——键与内嵌 id 一致性修复先于各桶实体形状校验，内嵌 id 缺失/为空时以记录键补齐（键是引用解析的权威值，补齐可无歧义保住内容与全部既有引用），形状校验只判定其余字段（更正四十轮「形状校验先于键 id 改写」会把可由键补齐的条目误隔离的表述）。
> 四十二轮评审修订（2026-08-29）：§11.1 第 3 步键控桶修复补记录键非空前置——空键条目确定性重发新键（值内 id 随键同步），否则空身份会与 upsert 边界冲突并留下无法更新的实体/空 React key；补 `project.name` 加载归一化——非字符串/空白/超 64 字符时去空白、回退索引名、再回退「未命名项目」占位，保证活动文档名称始终可保存、rename_project inverse 捕获的旧名可经同一边界回放（§9.3 inverse 注释同步注明此前提）。
> 四十三轮评审修订（2026-08-29）：§11.1 第 3 步空键重发补「空键 → 新键」映射与同桶引用改写——每桶至多一个空键条目（JSON 键唯一），指向空串的引用字段（speaker、资产桶的 ShotRef.assetId/avatarAssetId 等；ShotRef 字段名以后续六十四轮为准）随重发改写到新 id 而非变悬空；仅映射歧义时保持悬空并警告（更正四十二轮「空键不可能承载合法引用」——脏写引用侧同样可出现空串）。
> 四十四轮评审修订（2026-08-29）：sceneNo/shotNo 域与 episodeNo 对齐为安全整数（Number.isSafeInteger 且 > 0，§4.2/§9.3/§11.1 同域）——超出安全整数范围的编号传入命令前即可能与相邻编号折叠，归一化亦无法事后修复；§7.3 补项目复制命名策略——`{源名} 副本`（冲突递增序号），拼接超 64 字符上限时先截断源名再拼后缀，保证复制总能通过项目名校验口径；§11.1 第 3 步补节点基础结构校验——id 缺失重发、ui 缺失/异型重置默认值、可选布局数值剥离、position 坐标非法等不可修复形态隔离该节点及其关联边，单个异型节点不阻断项目打开。
> 四十五轮评审修订（2026-08-29）：§11.1 第 2 步补容器级形状校验（所有版本、先于一切逐项规则）——graph/节点边数组/settings 各桶/assets.byId 异型时重置为对应空容器并警告，管线必须可遍历、单个脏字段不能让整个项目打不开；第 3 步空节点 id 重发补「空 id → 新 id」映射与边端点改写——空字符串可被脏写的 source/target 指向，唯一空 id 节点时映射明确、连线保留，多个空 id 节点映射歧义则指向空串的边按孤儿边隔离（更正四十四轮「无引用可指向缺失 id」对空串不成立的表述）；§9.3 create_node 边界同步拒绝空 node.id。
> 四十六轮评审修订（2026-08-29）：§11.1 第 2 步容器级校验补齐遗漏——`episodeTitles` 缺失/非 Record（null/数组等）重置为 `{}`、`assets` 父容器缺失/非对象补 `{ byId: {} }`，否则第 3 步的标题表键值遍历与资产索引校验在容器异型时仍会抛错。
> 四十七轮评审修订（2026-08-29）：边 id 补非空约束——§9.3 connect_edge 边界拒绝空 id（React Flow 以边 id 为 key，空 id 边无法可靠渲染/删除/撤销），§11.1 第 3 步为缺失/空边 id 重发新值；§11.1 第 2 步 Record 桶校验明确排除数组形态（数组同为对象，下标会被误当权威实体 id 改写内嵌 id、原有引用静默悬空）；补 viewport 双端校验——§9.3 update_viewport 边界拒绝非法变换，§11.1 第 3 步删除异型 viewport 字段回退 fitView（§3 缺省语义）。
> 四十八轮评审修订（2026-08-29）：§7.1 relPath 契约更正——基准回退为项目目录/library/ 目录（维持既有磁盘格式 assets/<文件>，四十轮把基准改为 assets 子目录会让存量库资产全部解析失效，P1），包含判定的根仍限定为专用 assets 子目录（控制文件不可达的结论不变）；真实路径包含判定分层到 Rust——webview 模型层无法解析本机符号链接，canonical 校验由 Rust 在 load_project/资产命令内执行、非法条目清单随加载结果返回供前端归一化消费（§11.1 引言与第 3 步同步）；§11.1 第 2 步补成员级异型过滤（节点/边数组中的 null/数组/标量、Record 桶中的非普通对象值先隔离，再做任何字段读取与改写）；⑤ v0 迁移空实体 id 重发补「空 id → 新 id」映射与同桶引用改写（数组可含多个空 id 实体，歧义时引用悬空警告）。
> 四十九轮评审修订（2026-08-29）：§11.1 ui 默认值补齐由第 3 步上移至第 2 步——成员过滤只排除外层非普通对象，普通节点的异型 ui 会在重置 ui.selected 时解引用失败；补齐必须先于重置（第 3 步基础结构条目改为引用，不再重复规定）。
> 五十轮评审修订（2026-08-29）：§11.1 第 2 步容器校验重排为父容器先于子容器（graph/settings/assets 先补齐，再校验 nodes/edges/各桶/byId/episodeTitles）——书面顺序先碰子容器仍会在父容器异型时解引用失败；§7.1 补资产根自身的符号链接拒绝——assets/ 或 library/assets/ 指向根外目录时 canonical 根与目标同在界外、包含判定形同虚设，须确认 canonical 资产根仍位于 canonical 基准目录之内。
> 五十一轮评审修订（2026-08-29）：§11.1 第 2 步成员过滤后补嵌套容器校验——节点 data/spec/meta/layout、边 data 异型即隔离，options/lines/refs 非数组置空，先于第 3 步读取 data.kind、迭代 options 的一切逐项修复（普通对象成员的异型内部容器此前直达第 3 步，在形状校验前先崩坏）；第 3 步空 id 歧义判定改为以修复前计数为准、先于通用重复 id 去重（节点 id 与 options 同款）——空串本身是「重复 id」，先去重会把多个空 id 折叠为一个、指向空串的连线被错接而非隔离。
> 五十二轮评审修订（2026-08-30）：§9.3 `connect_edge` 统一前置解析 source/target，任一端点不在活动图即拒绝，再做变体、句柄、类型、环与重复边校验；§11.1 第 2 步把 `project` 纳入父容器修复，并在任何成员读取前补齐 project 必填元数据；项目文档的嵌套列表校验扩至 `characterIds`/`relatedIds` 及所有对象列表成员，杜绝逐项遍历前解引用异型值。
> 五十三轮评审修订（2026-08-30）：§10.5/§11.1 缺失或异型 `schemaVersion` 改为先按互斥信封特征判型，版本与形状冲突或混合信封一律拒绝且不改写，v1 形状不得误走 v0 迁移；v0 逐项改写前新增旧路径容器、成员与嵌套列表安全预检，避免迁移先于通用容器校验解引用异型值；所有持久化 id 的“非空”口径统一为 `trim()` 后非空，加载时对空白 Record 键及同域内嵌 id 执行确定性重发与引用改写。
> 五十四轮评审修订（2026-08-30）：§10.2/§10.5 把 `updatedAt` 的权威盖戳收回 Rust 保存边界——每次保存尝试只取一次服务端时间、无条件覆盖调用方值，文档与索引共用该值并随成功回执返回；失败后重试同一序列化载荷仍重新盖戳，避免旧值、未来值或前端时钟漂移污染最近项目排序。
> 五十五轮评审修订（2026-08-30）：§9.3 `create_node` 在类型相关校验前新增 StoryNodeBase 完整外壳校验；§11.1 为缺失、非字符串与空白 id 统一规定重发顺序及非法引用处置；§7.1 把资产路径信任链上溯到 canonical 应用数据根，拒绝中间基准目录的符号链接逃逸；§10.2/§10.5 明确 `index.json` 是由项目文档重建的缓存，项目文档先提交，启动或列表读取前校正缓存以恢复跨文件中断。
> 五十六轮评审修订（2026-08-30）：§11.1 为现行迁移器已支持的 v0 内嵌设定引用增加优先兼容子步骤——旧 `data.characters`、`data.location` 与对象型 `speaker` 先复用/补建设定实体并改写为 id，再允许通用列表补缺；§5/§9.3/§11.1 补完整边判别联合运行时校验，未知 `data.kind` 在句柄、环、重复边与 inverse 处理前即拒绝或隔离。
> 五十七轮评审修订（2026-08-30）：§7.1/§9.3/§11.1 为 `AssetRef` 补完整运行时形状校验——命令边界拒绝异型 id/relPath/mime/source/createdAt，项目与库加载在键/id 修复后规范化可安全修复的 MIME 与时间戳表示，其余异型条目连同警告隔离。
> 五十八轮评审修订（2026-08-30）：§7.2/§10.5 将库边界从共享 `AssetRef` 扩展为完整 `LibraryAsset`/`AssetGroup` 校验——读取先安全归一化分类、标签与可选编组字段，所有写入口校验补丁并复验合并后的完整条目；补组增删改命令与「资产和组 kind 一致」不变量；§10.1 将库索引位置校正为与现行 Rust 及 relPath 基准一致的 `library/library.json`。
> 五十九轮评审修订（2026-08-30）：§6/§8.1/§9.3/§11.1 为文本提及中的角色 id 增加无歧义 ASCII 子值域与旧引用同步迁移；§10.2/§10.5 将 canonical 信任链提升为所有项目与应用控制文件读写前置条件，目录或文件符号链接逃逸时拒绝整个操作，而非只关闭资产区。
> 六十轮评审修订（2026-08-30）：§11.1 明确完整节点归一化与隔离先于任何边语义筛选和边图重建；成环、宿主唯一与逻辑重复判定仅消费最终活动节点及其候选边，避免已隔离节点污染合法边的去留。
> 六十一轮评审修订（2026-08-31）：§7.1/§10.2/§10.5 移除“缓存已验证 relPath 即可”的不安全替代方案；canonicalize 只作筛查与诊断，资产实际读写删除统一绑定受信资产根目录句柄并逐组件 no-follow，媒体访问改用由 Rust 同款解析的 opaque asset URL。
> 六十二轮评审修订（2026-08-31）：§7.2/§10.5 明确库资产文件与 `library.json` 的可恢复提交顺序——导入先落文件后提交索引，删除先原子提交去项索引后再删文件；失败至多留下可诊断、可清理的孤儿文件，不得留下仍被索引引用的缺失资产。
> 六十三轮评审修订（2026-08-31）：§11.1 迁移首环明确 v0 字符串分支选项先转换为 `{ id, label }`，并以转换前原始下标到最终稳定 id 的映射改写旧句柄；非法项不得压缩下标后把连线静默错接给后续选项。
> 六十四轮评审修订（2026-08-31）：§4.2/§8.1/§9.3/§11.1 将 ShotRef 引用目标收紧为项目资产 `assetId`，`kind` 只表达垫图/底图/音频用途并校验 MIME 家族；补旧草案 `targetId` 的无歧义兼容与跨命名空间禁止改写规则，ui-design 同步。
> 六十五轮评审修订（2026-08-31）：§7.1/§9.2/§9.3/§10.5 为 `set_asset` 补 Rust 实路径预检与 `save_project` 全量复验，原始 JSON 调用不得绕过；§7.1/§7.2/§10.1/§10.5 将库资产删除改为持久化日志驱动的身份绑定隔离事务，禁止索引提交后按原文件名直接 unlink。
> 六十六轮评审修订（2026-08-31）：§11.1 第 3 步空键/空白键重发的引用改写由「角色桶只改 speaker」扩为指向该桶的全部结构化引用——角色桶含 `speaker`/`SceneSpec.characterIds` 成员/`relatedIds` 中 character 项，地点桶含 `SceneSpec.locationId`/`relatedIds` 中 location 项，资产桶含 `avatarAssetId`/`ShotRef.assetId`，`relatedIds` 按 kind 对应桶改写、禁止跨命名空间；迁移链 ⑤ 的引用枚举同步补全，消除与同节「改写全部同桶引用」通则的矛盾。
> 六十七轮评审修订（2026-08-31）：§10.5 `save_project` 补完整项目信封校验——`project.id` 无条件以受信路径参数覆盖，`project.name` 按 §9.3 项目名校验口径拒绝非法值、采用规范化值，原始 IPC 调用方不得绕过 rename_project/create_project 的名称规则持久化分裂身份；§7.2 库删除恢复协议补冲突期条目隔离——身份冲突未解决前对应 assetId 在规范化索引与内存投影中标为冲突不可用，媒体协议与 relPath 打开拒绝为其服务，不再把占用原路径的后来文件当作原资产展示。
> 六十八轮评审修订（2026-08-31）：§9.1/§9.2/§9.4 区分「不进撤销栈」与「不持久化」两个维度——`transient` 收敛为手势过程帧语义，update_viewport 交互结束帧置脏随防抖落盘（§3 视口持久化契约）；§9.3/§9.4 补拖拽手势 inverse 捕获——正式 move_node 的逆操作取自手势开始时的原坐标，而非已被 transient 帧推进的 docBefore（否则 undo 只回到最后一个拖拽帧）；§10.5 `save_project` 信封校验扩为完整顶层形状——schemaVersion 严格等于当前支持版本，graph/settings 及其必需容器逐一判型，异型整次拒绝，杜绝落盘后由加载归一化清成空图的内容丢失。
> 六十九轮评审修订（2026-08-31）：§9.4/§10.2 更正 update_node_ui 的持久化语义——`ui.selected`/`expanded` 是 §3 明确不持久化的会话态，update_node_ui 不置脏不落盘（纯选择操作不再触发保存、不刷新 updatedAt 改变首页排序），serializeProject 输出统一重置会话态初值；§10.5 `save_project` 信封校验补全 ProjectDocument 完整顶层契约——episodeTitles 普通对象及键值域、project.createdAt/updatedAt 可解析 ISO 8601、可选 description 字符串、graph.viewport 形状，异型整次拒绝。
> 七十轮评审修订（2026-09-04）：§11.1 第 3 步空键改写域补 `ImageSpec.outputs.primary.assetId`（资产桶）——节点判别校验不再剥离空白 assetId（可能指向空键资产），交由空键重发改写：有映射改写到新 id、无映射的悬空空白剥离并警告（与 avatarAssetId/ShotRef.assetId 同口径）；§13 落地状态补生成结果写回为复合命令——资产入索引与 `outputs` 写回同栈撤销/重做（§7.3 库资产导入同构，撤销不留不可达索引条目）。
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
 * → meta.label 必填；branch/shot/image 标题由 spec.prompt / spec.shotNo
 * 派生或无标题（图片节点）→ 不落 label（§8.1.1 禁止镜像字段）。 */
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

/** 图片节点 meta（§13）：生成产物非叙事单元，无 label、无 episodeNo
 * （不进大纲分组）——两者均 never 禁写。 */
interface ImageMeta {
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
interface ImageDocNode extends StoryNodeBase {
  type: 'image'
  data: { spec: ImageSpec; meta: ImageMeta }
}

type StoryNode =
  | SceneDocNode
  | BeatDocNode
  | DialogueDocNode
  | BranchDocNode
  | ShotDocNode
  | ImageDocNode
```

节点数据只保留四个分区：渲染布局（`layout`）、会话状态（`ui`）、用户意图（`data.spec`）、元信息（`data.meta`）。画布没有执行引擎，因此不设输入缓存、产物、运行状态等分区——没有写者的字段不进模型（原则 5）。

「集」是逻辑分类而非实体：首版集 = 编号 + 大纲行内标题，标题存文档级 `episodeTitles: Record<number, string>`（键 = 集号），不建「集」实体表。

### 4.2 各类型 spec

节点里写的一切内容——梗概、台词、以及将来 AI 生成的 prompt——都是 `spec` 的字段，随 `project.json` 持久化，无需额外存储。

```ts
type NodeSpec = SceneSpec | BeatSpec | DialogueSpec | BranchSpec | ShotSpec | ImageSpec

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

/** 分镜卡引用位：引用位与自由位互斥（assetId / label 不共存——
 * 对侧成员以 never 禁写，混写形状在类型层不可表示）。
 * kind 只表示生成用途，不是目标命名空间；引用位一律指向本项目 assets.byId。
 * 引用位的唯一真相是 assetId（§8.1）——缩略图/媒体内容按项目资产实时解析，索引元数据变化不影响引用，
 * 被删按 §8.2.3 失效展示；落 label 即镜像字段（禁止，§8.1.1）。
 * id 非空且在 refs 数组内唯一（同 DialogueLine，§9.3/§11 校验）。
 * character/location 只接受 image/* 项目资产，audio 只接受 audio/* 项目资产。 */
type ShotRef =
  | { id: string; kind: 'character' | 'location' | 'audio'; assetId: string; label?: never }  // 项目资产引用位
  | { id: string; kind: 'character' | 'location' | 'audio'; label: string; assetId?: never }  // 自由位：手填文案
```

**图片节点（§13 文生图首版，生成侧媒体节点）**：自由摆放在画布上，不参与任何连线（sequence/branch/attach 端点均不得为 image——§5 端口归属与 §11.3 孤儿边规则同域拒绝）；生成操作由 `spec` 携带，产物落 `outputs` 槽位：

```ts
/** 图片节点 spec：文生图输入 + 产物槽位。
 * model 为 "providerId:modelId"（与 AppSettings 默认模型同构，空串 = 未选择，
 * 生成入口回退默认图像模型）；operation 不落字段——首版无引用输入、恒为
 * 文生图，图生图随 §13 引用边演进再评审。 */
interface ImageSpec {
  prompt: string               // 画面描述（生成输入）
  model: string
  size: string                 // 如 '1024x1536'（竖版贴短剧画幅）
  outputs: {
    primary?: GeneratedOutput  // 产物槽位：缺失 = 尚未生成
  }
}

/** 生成产物引用：只存项目资产 id（assets.byId 是唯一真相，§8.1 禁止镜像
 * 媒体字段）；宽高为演进占位（存在时须为正有限数，归一化剥离非法值）。 */
interface GeneratedOutput {
  assetId: string
  width?: number
  height?: number
}
```

产物媒体经 Rust `llm_image_generate` 原子落盘进项目 `assets/`（`source: 'generated'`），前端经 §9.3 `validate_project_asset` 预检后并入会话索引，再以 `update_node_spec` 写回 `outputs.primary`（走命令栈，可撤销）。生成完成写回前比对**输入签名**（prompt/model/size 规范化元组）：输入已前进即丢弃结果并横幅提示，媒体文件留存待延迟回收（§7.3）——旧输入的产物不得覆盖新编辑。

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

**JSON 边界的完整边判别校验**：TypeScript 联合在导入、Agent/MCP 与磁盘 JSON 边界均已擦除。`connect_edge` 必须先确认边及 `data` 为普通对象，`id`/`source`/`target` 满足 §8.1 的字符串 id 值域，`data.kind` 严格等于 `sequence`/`branch`/`attach` 之一，可选 `data.order` 存在时为有限数，再解析活动端点并按 kind 校验对应句柄形状（sequence 禁写 `sourceHandle`、branch 必须是可解析的 `option-<id>`、attach 必须是字面量 `shots`，三者均禁写 `targetHandle`）。加载时先完成 §11.1 的节点/列表/边 id 重发及可确定引用改写（包括空白节点 id 对边端点的改写），再要求 `source`/`target` 是合法字符串 id，并在解析端点前校验 `data.kind` 与 `order`；未知或非字符串 kind 立即连同警告隔离。已知 kind 的漏网边只允许执行不会改变连接语义的确定性修复——剥离匿名端口上的 `targetHandle`，以及 sequence 的 `sourceHandle`（均记录警告）——修复后仍无法形成对应变体（如 branch 缺少可解析的选项句柄、attach 句柄不是字面量 `shots`）则隔离，不得进入活动图。除加载专有的 id 重发、引用改写与上述确定性句柄剥离外，该安全外壳与判别校验必须先于端点解析、句柄语义、端点类型、成环、重复边和 inverse 处理，否则未知变体可能被渲染后又无法经 `connect_edge` inverse 恢复。

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

**角色 id 的文本语法子值域**：`Character.id` 除满足 §8.1 的共同值域外，还必须匹配 ASCII 正则 `^[A-Za-z0-9_-]{1,64}$`。这是持久化 @ 提及 token 的语法约束，不扩散到无需嵌入文本 token 的其他 id 域；角色创建、导入与 `upsert_character` 在命令边界拒绝不满足该子值域的 id。由此 `@[character:<id>]` 的 `<id>` 不含 `]`、换行、空白或其他分隔字符，可直接按下述固定语法无歧义扫描，无需依赖实现各异的转义器。

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

**AssetRef 的 JSON 边界完整校验**：导入、Agent/MCP、磁盘项目文档与 `library.json` 中的 TypeScript 形状均已擦除。进入活动索引前必须确认条目是普通对象；`id` 满足 §8.1 的字符串 id 值域，`relPath` 是非空字符串并满足下述路径安全约束，`mime` 是去首尾空白后由两个非 `*` RFC 9110 token 组成的具体 `type/subtype` ASCII 媒体类型（索引不保存参数，统一小写），`source` 严格等于 `upload` 或 `generated`，`createdAt` 是带显式 `Z` 或 UTC offset、可解析且表示有效时刻的 ISO 8601 字符串并统一落为 UTC `toISOString()`。`set_asset` 的纯模型校验对完整形状执行该规则；此外公开 dispatcher 必须在调用内部 reducer 前，经 Rust `validate_project_asset(projectId, asset)` 以受信项目/资产根句柄逐组件 no-follow 打开 `relPath`、确认目标是资产根内普通文件，并只采用 Rust 返回的规范化 AssetRef。形状或真实路径任一失败时不得进入活动文档、undo/redo 栈或脏标记；导入/生成、Agent/MCP、撤销/重做与 batch 同样不得绕过。`save_project` 在任何临时文件或时间戳写入前对 `assets.byId` 全量执行同一 Rust 实路径复验，防止预检后目录项被替换；失败整份拒绝且不更新索引。加载项目时，`assets.byId` 的 Record 键/id 先按 §11.1 的共同规则修复；加载资产库时，旧数组格式先按 §7.2 的兼容迁移转换为目标 Record，再执行同款键/id 修复。随后，合法但未规范化的 MIME 大小写/空白与带显式时区的时间戳表示可确定性规范化并警告，其余无法无歧义修复的条目隔离并警告，引用按 §8.2.3 标记悬空。库侧即使另有分类字段归一化，也必须执行这些共享字段规则，不能因 `relPath` 合法就跳过基础形状。

**relPath 安全约束**：relPath 必须是纯相对路径（禁止绝对路径），其**基准**为项目目录（项目资产）或 `library/` 目录（库资产）——维持既有磁盘格式（库条目写作 `assets/<文件>`），基准变更会让既有资产解析成 `library/assets/assets/<文件>` 而全部失效。解析目标必须位于**专用资产子目录**内（项目 `assets/`、库 `library/assets/`，§10.1），且不得进入保留的库隔离目录 `library/assets/.trash/`（该目录及其随机名称永不进入 AssetRef、媒体 URL 或孤儿候选）：控制文件（`project.json`/`library.json`/`index.json`）位于子目录之外——`"library.json"` 这类条目词法合法、解析后也在库目录内，但目标不在 `library/assets/` 内即非法，`delete_library_asset`/`remove_file` 之类的按路径操作由此永远触达不到索引自身；含 `..` 上跳段使解析目标越出子目录同样非法。词法规范化不足以兜底：资产目录内若存在指向根外的符号链接，`assets/link` 词法合法、不含 `..`，真实路径却已越界——因此校验以**真实路径包含关系**为准：对资产子目录与目标路径做 canonicalize（解析符号链接）后判定目标仍位于子目录之内，越界即非法；新增资产（目标文件尚不存在、无法 canonicalize）时拒绝路径各级中的符号链接，或对最近已存在祖先做 canonicalize 后拼接校验。**信任链必须从应用数据根逐级建立，不能把待校验的基准目录自身当作最外层锚**：先 canonicalize Tauri `app_data_dir` 作为受信根并确认 `projects/` 与 `library/` 的 canonical 路径仍位于该根内，再确认 `{projectId}/` 的 canonical 路径仍位于 canonical `projects/` 内，最后才确认项目 `assets/` 位于该项目目录内、`library/assets/` 位于 canonical `library/` 内；任一现存中间目录是指向其父级受信根外的符号链接，均拒绝整个对应资产区并记录警告。目录尚不存在时只能通过已验证且无符号链接的父目录创建，创建后重新 canonicalize 并复核逐级包含关系。由此即使项目目录与其 `assets/`、或 `library/` 与 `library/assets/` 一起指向同一外部树，也不能以“根与目标彼此包含”为由通过校验。**分层执行**：词法校验（纯相对、解析目标在子目录内）前端模型层可执行；上述逐级真实路径包含判定只能在可访问文件系统的 Rust 层执行——webview 模型层无法自行解析本机符号链接。Rust 在 `load_project` 与资产命令内对每个 relPath 做 canonical 校验并把非法条目清单随加载结果返回，前端归一化消费该清单隔离条目；库侧 `list_library_assets`/`delete_library_asset` 在 Rust 内同款校验。这是 §7.1「项目自包含」与备份/移动完整性的前提，也是信任边界校验（防解析或复制时逃逸资产根）：`set_asset` 命令边界拒绝非法值，归一化对脏数据隔离该索引项并记录警告（引用该资产的字段按 §8.2.3 悬空展示）。**库索引入口同款约束**：`library.json` 不走 §11.1 项目文档归一化（它不是 ProjectDocument），且可被手工修改或损坏——读取库索引（`list_library_assets`，§7.2 启动时全量载入）时对每个条目应用同款校验（含真实路径包含判定），非法条目不进内存索引并记录警告。仅在列表入口过滤不足以兜底：`delete_library_asset` 等操作会重读或消费索引中的 relPath，而目录项可能在列表校验之后、实际读删之前被替换（TOCTOU）。**canonicalize 只用于加载筛查、包含关系诊断与无句柄平台上的拒绝性兜底，绝不是后续文件 I/O 的授权凭据；缓存“本会话已验证”的 relPath 同样不构成授权，本文不再允许二者作为实际操作的替代方案。**凡按 relPath 触达项目或库资产文件的入口（导入、创建、读取、媒体响应、复制、移动、删除与清理）均由 Rust 在该次操作内从已验证的应用/项目/库父目录句柄出发，以 no-follow 语义打开并持有专用 `assets/` 根目录句柄；把词法校验后的 `assets/<子路径>` 去掉固定首段后，逐组件以相对目录句柄继续打开，拒绝空段、`.`/`..`、符号链接、非目录中间项及越界，整个句柄链保持到操作结束，不得在校验后退回原始绝对路径或字符串拼接路径。读取以最终父目录句柄相对 no-follow open，并在已打开句柄上确认普通文件后流式读取；删除不得只凭最终组件名称调用 `unlinkat`：no-follow 只能阻止跟随符号链接，不能证明该名称仍绑定此前打开的普通文件。库资产删除必须先按 §7.2 把经身份核验的目录项原子移入保留的私有隔离区，再提交索引；提交后只允许以仍绑定该已打开文件身份的平台原语清理隔离项，平台不能提供等价保证时保留隔离项并返回 `cleanupPending`，不得退化为按名称删除。创建/导入在句柄下排他创建随机临时文件并以句柄相对 rename 落位。Rust 文件系统适配层必须在各平台为路径解析、读取、创建与原子移动提供与 POSIX `openat`、Linux `openat2(RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS)` 同等的“根句柄绑定 + 逐组件不跟随”保证；普通 `unlinkat` 只约束删除发生在受信目录内，**不满足**库媒体的文件身份绑定清理，后者必须使用 §7.2 的更强平台原语或保留 `cleanupPending`。相应能力缺失时拒绝该阶段，不得降级为 check-then-use。媒体展示也不得把本机绝对路径或 relPath 交给前端 `mediaUrl` 拼接/通用文件协议：前端只获得含 scope + assetId 的 opaque asset URL，Rust 自定义协议处理器在**每次请求**重新从当前规范化索引解析 id，并通过上述句柄链读取后返回字节；索引内存快照可以减少 JSON 重读，但永远不能跳过这一步文件系统能力校验。由此目录项在列表后被替换也无法让任何项目或库入口触达资产根外文件。

控制文件不适用“只拒绝对应资产区”的降级：项目目录或库目录的任一级信任链失败时，必须按 §10.2 在任何控制文件 I/O 前拒绝整个项目或库操作；不能先读取 `project.json`/`library.json`，再仅把资产标为不可用。

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

- **完整库形状与加载归一化**：`library.json` 根值及目标格式的 `assets.byId`/`groups.byId` 必须是普通对象，桶成员也必须是普通对象；异型根拒绝读取，异型桶或成员隔离并警告，均不得在字段检查前解引用。键/id 按上文兼容迁移及 §8.1 共同规则一致化后，资产先执行 §7.1 的完整 `AssetRef` 校验，再校验 `name` 是去首尾空白后 1–128 字符的字符串、`kind` 严格属于声明联合、`tags` 是至多 16 项的数组且每项是去空白后 1–64 字符并在规范化后唯一；`view` 存在时必须是 `AssetView`，`groupId` 存在时必须是 §8.1 合法字符串 id。组同款校验 `name` 与 `kind`；合法 name 保存去空白后的值，必填 `name`/`kind` 或 AssetRef 字段异型时整个条目隔离。可选组织信息允许安全降级：加载时 `tags` 非数组重置为 `[]`；数组成员先去空白，异型/空白/超长/重复项删除，超过 16 个规范成员时只保留文档序前 16 项；非法 `view`/`groupId` 剥离，均警告。组条目隔离完成后再解析资产 `groupId`：目标组不存在或组与资产的 `kind` 不同即剥离该引用并警告，活动库内始终保持同组同类。
- **库写边界**：`import_library_asset`/`collect_library_asset` 对 meta 及构造出的完整 `LibraryAsset` 执行上述规则后才写索引。`update_library_asset` 要求 patch 是普通对象且仅含 `name`/`kind`/`view`/`groupId`/`tags`：字段一旦出现就先做运行时类型和值域校验，`view: null`/`groupId: null` 是唯一清除标记且落盘时删除对应可选字段，其他异型值拒绝；字符串保存规范化值，tags 须在输入时满足数组、成员和值域规则。补丁应用到当前条目后必须复验**完整合并结果**（含不可编辑的 AssetRef 字段及 groupId 存在性/kind 一致性），失败则整次命令不写盘，不能让本次未触及的旧脏字段继续落盘。组写入由 `upsert_library_group` 执行同款完整形状校验；修改组 kind 若会与任一成员资产冲突则拒绝。`delete_library_group` 要求组存在，并在同一次原子索引写入中删除该组、剥离成员资产的 `groupId`；因此不会留下悬空编组引用。每个库写命令在操作开始时必须通过 §10.2 的受信控制文件句柄读取当前索引并按本节完成归一化，再以该次读取结果作为唯一逻辑基线；会话内存快照只用于 UI 展示/缓存，不得作为写命令的权威输入，也不得把补丁直接套在重新读出的原始 JSON 上。最终索引经同目录 tmp 写入、文件内容 flush/fsync、原子 rename 与父目录 fsync 全部成功后才视为耐久提交并替换会话快照。这份由命令在操作开始时通过受信句柄读取并归一化的索引快照只代表本次操作的逻辑基线，不携带文件系统权限；任何由条目 relPath 引发的文件读写仍必须逐次执行 §7.1 的根目录句柄绑定与 no-follow 操作。
- **库文件/索引的可恢复提交协议**：`library/assets/` 文件与 `library.json` 的两个独立操作不构成事务，失败只能留下可诊断、不可被活动索引引用的隔离项/孤儿文件，不能留下“索引仍引用但媒体本体已不可恢复”的状态；下述 fsync 均包含目标平台的等价耐久屏障，无法提供时不得进入下一阶段。导入/收藏仍先通过 §7.1 完成临时文件写入、文件 flush/fsync、原子落位与资产父目录 fsync，确认可读后才耐久提交新增索引；索引失败只留下孤儿文件。删除若新索引中仍有其他条目引用同一已打开文件身份，则只提交去项索引，不移动或删除物理文件。否则采用身份绑定的隔离事务：① 通过受信句柄读取并归一化当前索引，逐组件 no-follow 打开待删普通文件、捕获平台稳定文件身份并保持文件/原父目录句柄；`.trash/` 缺失时只能在已验证资产根句柄下创建为应用私有目录并 fsync，且须确认与源文件同一文件系统（否则原子 rename 无法成立并在写日志前失败）；在 `library/asset-delete-journal.json` 以随机 transaction id 耐久记录 assetId、原 relPath、预期身份和未公开的 `assets/.trash/<随机名>`，日志原子提交与父目录 fsync 成功前不得移动文件。② 通过已持有的资产根、原父目录与 `.trash/` 目录句柄，把原目录项原子 rename 到隔离名并 fsync 两侧目录；随后 no-follow 打开隔离项并与步骤①身份比较。若 rename 窗口中目录项已被替换、身份不一致，则不得提交索引或删除隔离项；仅在原名仍空缺时用 no-replace rename 恢复，原名已被占用则保留隔离项与日志并报冲突，绝不覆盖后来文件。**身份冲突未解决期间的条目隔离**：凡因身份不符、路径占用或平台能力不足而保留日志的未完成事务，其对应 assetId 不得继续作为可用资产暴露——恢复/列表流程在规范化索引与内存投影中把该条目标为冲突不可用并随列表返回警告；标记期间媒体协议处理器与任何按 relPath 的打开拒绝为该 assetId 服务（原 relPath 可能已绑定后来文件，解析它会把占用者的替换文件当作原资产展示），也不得以该条目为源复制入项目或收藏；标记只随日志事务解决而解除——原名重新 no-replace 绑定预期身份、索引耐久提交去项或日志按恢复规则清除，不得靠重新列表静默消失。③ 隔离身份一致且耐久后才原子提交不含该条目的 `library.json` 并 fsync `library/`；提交失败时索引仍含该资产，恢复流程按日志把同一身份 no-replace 移回原位。④ 索引提交成功后，只能用绑定步骤①已打开身份的操作系统删除原语清理隔离项并 fsync `.trash/`；普通 `unlinkat(隔离名)`、再次 stat 后按名称 unlink 或任何 check-then-use 退化均禁止。平台没有身份绑定删除能力、删除/fsync 失败或进程中断时，保留隔离项并返回/记录 `cleanupPending`，索引不得回滚。启动及每次库列表/写入前先恢复日志：每条事务先重读规范化索引并按已打开身份复核其他活动条目；若其他条目已引用预期身份，不得移动或删除其当前目录项，隔离项存在时只按身份绑定能力清理该额外目录项、能力不足则保留 `cleanupPending`，隔离项不存在时可清除日志。没有其他活动引用且索引仍含 assetId 时：若隔离项尚未生成且原路径仍绑定预期身份，清除这条未开始事务；若隔离项身份一致，则只在原目标名空缺时 no-replace 回迁；其余缺失、身份不符或路径占用均保留日志、按上述冲突期隔离规则将条目标为冲突不可用并警告。索引已无 assetId 时，隔离项存在则只尝试身份绑定清理；隔离项已不存在且原路径不再绑定预期身份，视为清理已完成并清除日志；原路径仍绑定预期身份则重新执行身份核验隔离，不得按原名删除；能力不足均保留现场与 `cleanupPending`。日志根/条目异型、重复 transaction id、路径越出固定原资产位置或 `.trash/` 随机名单项时整份恢复进入只读告警态，所有库写入/删除暂停，不猜测路径、不移动或删除任何文件。事务完成且相关目录已 fsync 后才原子移除日志项；`.trash/` 永不参与 AssetRef 解析、媒体服务或普通孤儿扫描，显式清理也必须消费日志并遵守同一身份绑定规则。
- **分工**：`kind` 回答"是什么"，`view` 回答"哪个角度"，`groupId` 把同一主体的三视图绑成一组；`tags` 只用于前两者覆盖不了的自由维度（如「赛博朋克」「雨夜」）。能用结构化字段表达的不写成标签，避免同义标签发散。
- **迁移规则（`prop` → `wardrobe`）**：现实剧组服化道同属一个部门，旧 `prop`（道具）条目并入 `wardrobe`（服装/妆发/道具）；新增 `colorlight` 承载色彩脚本（color script）与光影氛围参考。
- **现行库索引兼容迁移**：当前已发布的 `library.json` 使用 `assets: LibraryAsset[]`/`groups: AssetGroup[]`，条目 `createdAt` 是 epoch 毫秒、`source` 缺失，且可选 `view`/`groupId` 用 `null` 表示。升级目标索引前先安全预检两个数组及普通对象成员，再复用 §11.1 的 v0 数组键化规则校验 id：重复 id 保留文档序首项、后续项重发本域未占用 id，缺失/非字符串/空白 id 同样重发，最后才键化为 `assets.byId`/`groups.byId`。组 id 重复时既有 `groupId` 引用本就解析到首项，不随后续项重发而改接；仅一个空白原 id 组时建立映射并同步改写精确匹配的 `groupId`，多个同值空白组则映射歧义，删除相关 `groupId` 并警告。当前库资产均由本地导入产生，缺失 `source` 确定性补为 `upload`，非负安全整数且能表示有效日期的毫秒时间戳转为 UTC ISO 8601，`null` 可选字段删除，旧 `prop` kind 按上条改写。完成这些兼容改写及 Record 键/id 引用同步后才按上一条顺序执行完整 `AssetGroup`、`LibraryAsset` 与跨条目 groupId/kind 校验；缺失/异型时间戳或显式未知 source 不得猜测，隔离条目并警告。不得把目标校验直接套在旧数组成员上，否则所有缺 source、数字时间戳的现有库资产都会被误删。
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
| 节点/设定 → 资产 | 角色头像 `avatarAssetId`、分镜 `refs[].assetId` | 明确命名空间的 assetId 字段（均指项目 `assets.byId`） | 引用计数（清理未引用资产时现算） |
| 节点 → 节点输入（未来媒体节点） | 视频节点的立绘输入 | `graph.edges` | 执行输入在解析时现算，不物化镜像 |

**持久化 id 的共同值域**：本文所有“id 非空”均指运行时值满足 `typeof id === 'string' && id.trim().length > 0`；只由空白字符组成的字符串与空串同属非法 id。命令边界须按此口径拒绝，加载归一化须在任何查表、去重或引用解析前按 §11.1 的确定性规则修复。该规则只判定有效性，不擅自 `trim()` 非空 id——id 是不透明标识，改变已有非空 id 必须同步改写其全部引用。嵌入文本语法的 `Character.id` 另受 §6 的安全字符集子值域约束。

细则：

1. **禁止镜像字段**：不设任何「引用的第二份拷贝」（如 inputs 镜像、边上冗余的引用标签副本）。派生信息需要时现算或重建，不持久化。
2. **文本 token 只存 id**：唯一合法语法为 `@[character:<id>]`，其中 `<id>` 必须完整匹配 §6 的 `[A-Za-z0-9_-]{1,64}`；解析器只把完整匹配 `@\[character:([A-Za-z0-9_-]{1,64})\]` 的片段识别为 token，前后相邻普通文本不属于 token。缺右括号、超长 payload、额外冒号或包含其他字符的近似片段一律保留为普通文本并记录加载警告，不做截断或猜测解码。token 不存名称快照；显示名永远按捕获 id 实时解析——改名不断引用，也无需回写任何文本。
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

单写者场景无需并发基线与路径级补丁。命令信封固定为六个字段：`id` / `type` / `actor`（变更来源：用户操作或 AI Agent，用于审计与 UI 标记，见十二节）/ `patch`（正向补丁）/ `inverse`（逆向补丁，执行时自动捕获）/ `timestamp`；另有可选的 `transient` 标记（瞬时 UI 命令，仅供拖拽/缩放等手势的过程帧使用：不进撤销栈、不置脏不落盘）。「不进撤销栈」与「不持久化」是两个独立维度——前者由 §9.4 按命令类型裁定，后者仅 transient 过程帧成立；需要持久化但不进栈的变更（如视口终帧）以非 transient 命令提交、按 §9.4 排除出栈，见 §9.4。

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
| 资产 | `set_asset` / `remove_asset` | set 为 upsert 语义（id 已存在 = 覆盖），但必须经公开 dispatcher 的 Rust 实路径预检后才交给内部 reducer；inverse 视新增/覆盖而定（见 9.3） |
| 视口 | `update_viewport` | 不进撤销栈；过程帧 transient 不落盘，交互结束帧置脏随防抖持久化（§9.4） |
| 批量 | `batch` | 一等命令，整批作为单个撤销单元；整批原子——预校验任一子命令失败即整批拒绝、零变更（见 9.3） |

### 9.3 命令数据模型

命令创建时只携带**变更意图**（目标值）；`inverse` 不由创建者填写，而是 `applyCommand` 执行时从变更前文档（docBefore）自动捕获。这保证 undo 数据永远与文档真实旧值一致，创建者不可能填错。

**文件系统依赖命令的入口约束**：Store 对 UI、Agent、MCP 与导入器只公开异步 `dispatchCommand`；纯 TS 的 `applyCommand` reducer 是模块私有实现，外部不得直接调用。dispatcher 遇到任意正向、撤销、重做或 batch 内的 `set_asset` 时，必须先把活动会话由 `load_project` 返回的受信 `projectId`（不得取自命令/Agent 负载）与完整 `AssetRef` 交给 Rust `validate_project_asset`，只将 Rust 原样返回的规范化 AssetRef 送入 reducer；真实路径预检失败时文档、undo/redo 栈与脏标记均保持不变。batch 在建立虚拟演进文档前完成全部 `set_asset` 预检，任一失败整批零变更；预检结果不得缓存或被另一条命令复用。`save_project` 仍按 §10.5 在每次落盘前复验完整 `assets.byId`，用于封住预检后文件被替换或删除的窗口；预检不是保存授权。

```ts
type Point = { x: number; y: number }
type Size = { width: number; height: number }
type Viewport = { x: number; y: number; zoom: number }
type NodeUi = StoryNode['ui']

/** 命令类型与负载形状的映射。 */
interface CommandPayloads {
  // ── 节点 ──
  // create_node 的负载来自 Agent/MCP/导入等 JSON 边界，先校验 node 为普通
  // 对象，并在读取 type/spec/meta 前校验 StoryNodeBase 完整外壳：data、
  // data.spec、data.meta、layout、layout.position、ui 均须为普通对象；
  // position.x/y 须为有限数；可选 size 存在时须为普通对象，且
  // width/height 须为正有限数；
  // 可选 zIndex 存在时须为有限数；ui.selected/ui.expanded 均须为 boolean。
  // 任一必需容器缺失、null、数组或字段异型都直接拒绝，不得让脏节点先进入
  // 活动图、等重载时才由 §11.1 隔离。外壳通过后再按 nodeType 做同款校验
  // （§4.1 判别联合）：
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
  // ShotRef 每项还须是普通对象且形成 §4.2 的完整判别联合：kind 只允许
  // character/location/audio，assetId 与 label 必须恰有一个；assetId 须为
  // 非空字符串并解析到当前项目活动 assets.byId，character/location 目标
  // MIME 必须为 image/*，audio 目标必须为 audio/*；label 分支只校验为
  // 字符串，不查资产。未知 kind、混写/漏写目标或 MIME 用途不符均拒绝。
  // 另校验 node.id 为 trim 后非空字符串且全局唯一：空白 id 会生成无标识
  // 的边端点与空 React key；id 已存在于活动图时拒绝执行——否则追加会产生
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
  // connect_edge 在命令边界先按 §5 校验安全外壳与判别字段：edge/data 须为
  // 普通对象，id/source/target 须为合法字符串 id，kind 仅允许
  // sequence/branch/attach，order 存在时须为有限数；未知 kind 或不属于任一
  // 变体的形状在端点解析、句柄、环、重复边与 inverse 处理前即拒绝。
  // 外壳合法后再把 edge.source 与 edge.target 解析为活动节点；任一端点不存在
  // 时，不分变体一律拒绝，且必须先于后续类型、句柄、环与重复边校验
  // （不可解出的连线留到加载才隔离会长期滞留活动图，并污染渲染、遍历与
  // 持久化）。两端点均存在后，branch 边的
  // source 须为分支节点、sourceHandle 中的选项 id 须存在于该节点 options；
  // attach 端点类型校验同理（§5），且目标
  // shot 已有入向 attach 边时拒绝（宿主唯一，§5）——更换宿主走
  // disconnect_edge + connect_edge 进同一 batch 的原子操作。
  // 另校验 edge.id 为 trim 后非空字符串且全局唯一（与 create_node 的
  // node.id 同款）：空白 id 会让 React Flow 以空 key 渲染、
  // disconnect_edge 与 inverse 无法按 id
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
  // 字符串（去首尾空白后非空）；Character.id 还须满足 §6 的
  // [A-Za-z0-9_-]{1,64} 文本 token 子值域；gradient 为字符串；可选字段
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
  // 而非删除条目，避免 undo 让既有引用悬空。命令边界按 §7.1 校验完整
  // AssetRef：asset 须为普通对象，id/relPath/mime/source/createdAt 均满足
  // 各自类型和值域并写入规范化结果；任一非法即拒绝，不能只校验 relPath。
  // 公开 dispatcher 在 reducer 读取 docBefore、捕获 inverse 或修改活动文档前，
  // 必须先经 Rust validate_project_asset 校验真实路径并采用其规范化返回值；
  // 原始 JSON 调用方不得直接触达内部 reducer，前端词法检查不能替代预检。
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
  // batch 含 set_asset 时，dispatcher 还须在本轮虚拟预校验前完成全部 Rust
  // 实路径预检；全部外部预检与纯模型预校验通过后才顺序执行并逐子捕获 inverse。
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
| `move_node` / `resize_node` / `update_viewport` | 同结构，`to` 换为 docBefore 中的旧值；**手势例外**：拖拽/缩放手势结束提交的正式 `move_node`/`resize_node`，inverse 的 `to` 取 dispatcher 在手势开始时捕获的原坐标，而非松手时的 docBefore（§9.4——transient 过程帧已把 docBefore 推进到最后一帧） | 同正向 |
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
- 拖拽中发 `move_node { transient: true }`（过程帧只更新内存文档，不置脏不落盘、不进栈），松手时补发一条正式命令进撤销栈。**正式命令的 inverse 不得按默认规则从 docBefore 捕获**——transient 帧已把文档推进到最后一帧拖拽位置，从 docBefore 捕获会让 undo 只回到最后一个拖拽帧（常与终点相同）而非拖拽起点；dispatcher 必须在手势开始时捕获并持有各被拖节点的原坐标，松手提交正式 `move_node`/`resize_node` 时以该原坐标显式填充 inverse，或把整个手势（transient 帧 + 正式命令）作为同一手势事务合并捕获一次 inverse。缩放（resize）手势同款。
- `update_node_ui`（选中、展开折叠）与 `update_viewport` 不进撤销栈，但二者语义不同：`update_node_ui` 只改 §4.1 的 `ui` 会话态（`selected`/`expanded`，§3 明确不持久化、加载时重置），**不置脏、不落盘**——纯选择操作不得触发防抖保存，否则会让 Rust 重新生成 `updatedAt`、错误改变首页最近项目排序；若未来出现真正需要持久化的 UI 字段，须为其定义独立命令，不得搭 update_node_ui 的便车。`update_viewport` 则必须最终落盘——`graph.viewport` 随项目持久化（§3），平移/缩放的过程帧发 `update_viewport { transient: true }`（只更新内存、不置脏不落盘），交互结束时补发一条非 transient 的 `update_viewport` 终帧：置脏并随 §10.5 防抖保存落盘，但按本条仍不进撤销栈。若全部视口变更都停留在 transient 帧，关闭项目时视口修改不会产生可保存的脏状态，重开只能得到旧视口或 fitView。

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
│   ├── library.json                   # 库索引：assets.byId（分类/视角/标签）+ groups.byId（编组）
│   ├── asset-delete-journal.json      # 库资产删除恢复日志（仅存在未完成事务时）
│   └── assets/
│       ├── {assetId}.png
│       └── .trash/                    # 随机名私有隔离区；禁止进入任何 AssetRef
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

- **控制文件信任链是所有 I/O 的前置条件**：Rust 先 canonicalize `app_data_dir` 为受信根；`projectId` 等路径分量先通过对应的文件名安全字符集校验，再参与拼接。对 `projects/`、`library/` 及目录化布局的 `projects/{projectId}/`，现存目录必须是实际目录且 canonical 路径逐级仍位于父级受信根内，任一级为符号链接（无论指向根内或根外）、非目录或无法验证都拒绝**整个对应操作**，不能只禁用其 `assets/`。缺失目录只能在已验证父目录下创建，创建后立即 canonicalize 复核。读取、创建、替换、删除或扫描 `project.json`、旧布局 `{projectId}.json`、`index.json`、`library/library.json`、`library/asset-delete-journal.json`、`settings.json` 及其临时文件前，使用 `symlink_metadata` 拒绝最终路径为符号链接，现存文件还须是普通文件且 canonical 后仍是已验证父目录的直接后代；目录扫描跳过并报告符号链接/越界项，绝不跟随。验证后保持父目录句柄打开，所有实际 open/create/rename/delete 均以平台等价的 no-follow、相对目录句柄语义执行，不得 canonicalize 后退回未经绑定的原字符串路径，避免检查与使用之间被替换。新临时文件以该目录句柄下的随机同目录名称排他创建，避免预置 `.tmp` 符号链接截获写入；最终 rename 前再次验证现存目标。该解析器由项目 list/create/load/save/delete/复制流程、布局迁移、索引校正及库/设置命令共用，验证失败时不得读取、写入、删除外部树中的文件，也不得先更新另一控制文件。
- **资产文件能力边界**：控制文件与资产文件共用“受信根句柄绑定、逐组件 no-follow、实际 I/O 不退回字符串路径”的底层解析器；控制文件按本节校验，项目/库资产的读、写、媒体响应与删除还必须执行 §7.1 的专用资产根规则。canonical 路径和已校验内存条目只能用于诊断或选择逻辑对象，不能代替实际文件句柄授权。
- 在目标文件的受信父目录句柄下排他创建随机同目录临时文件（如 `project.json.<随机值>.tmp`），写入并 flush 后以目录句柄相对 rename 覆盖 `project.json`（rename 原子，读者只见旧版或新版，不见半个文件）。`index.json` / `library.json` / `settings.json` 同样处理；不得使用可被提前布置的固定 `.tmp` 路径。
- `project.json` 是项目内容及合法 name/updatedAt 的权威真源，`index.json` 只是可丢弃、可重建的首页缓存；两个文件的独立 rename **不构成跨文件事务**。`create_project`/`save_project` 先原子提交项目文档，再以同一 name/updatedAt 更新索引。Rust 启动时、且最迟在每次 `list_projects()` 返回前，扫描项目文档（布局迁移期同时覆盖 §10.1 的旧路径回退），以受信路径 id 与文档中的合法 name/updatedAt 重建或校正索引：补缺失项、覆盖不一致项、移除已确认没有项目真源的陈旧项；缩略图等仅存于索引的展示字段只在对应项目仍存在时保留。文档元数据异型时不得把非法值写进索引：保留可用的合法索引回退，否则返回明确的损坏占位与诊断，留待 §11.1 加载归一化修复。校正后的列表直接从这份内存投影返回，并尝试以 tmp + flush + rename 回写索引；即使回写再次失败也不得返回已知陈旧的 name/updatedAt，须报告可恢复警告。由此在两次 rename 之间崩溃、索引写失败或索引损坏只会造成可恢复的缓存陈旧，不会让首页长期显示与项目文档不一致的名称或更新时间。
- 前端防抖 500ms 提交一次；失败回队重试；`flushPersist()` 在关闭窗口/切换项目前调用。重试可以复用同一份序列化载荷，但其中的 `project.updatedAt` 不具有权威性：每次 `save_project` 尝试都由 Rust 在保存边界重新生成时间，调用方不得通过预先盖戳或重放旧值决定本次保存时刻。序列化时节点 `ui` 会话态（`selected`/`expanded`）按 §3 不落盘——`serializeProject` 输出统一重置为加载初值（`selected: false`、`expanded: true`），内存中的选中态不进入载荷；`update_node_ui` 不置脏（§9.4），纯选择/折叠操作不触发防抖保存，也不会因此刷新 `updatedAt` 改变首页最近项目排序。

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

> 落地状态（2026-09-04）：已发布的实现收敛为扁平 `AppSettings { providers: ProviderConfig[]; defaultChat: string | null; defaultImage: string | null }`（"providerId:modelId"，§13 图像生成首版随 `defaultImage` 落地）；`ProviderDef`/`ModelDef` 的能力目录与 `selectedModels` 三段结构为目录化演进预留，引入时按下表 §10.5 命令边界对齐。

### 10.4 密钥管理

provider 的 API key 以**密文 `keyEnc`** 存于 provider 配置：Rust `seal` 模块 AES-256-GCM 加密（密钥 = 应用常数 + IOPlatformUUID + 随机盐，封装于 envelope），明文只在加密/请求的进程内存中出现；历史钥匙串数据保留只读回退，不再写入。

### 10.5 Rust 持久化命令（Tauri commands）

| 命令 | 职责 |
| --- | --- |
| `list_projects()` | 按 §10.2 先验证应用根、项目目录与每个候选控制文件，再扫描项目文档真源并与 `index.json` 缓存校正后返回内存投影；索引缺失、损坏或与文档的 id/name/updatedAt 不一致时重建并原子回写，不直接返回陈旧缓存 |
| `create_project(name)` | 按 §10.2 验证/创建项目目录及控制文件目标后，先原子写初始 `project.json`，再更新可重建索引；name 按 §9.3 项目名校验口径校验（与 rename_project 同规则），跨文件中断由 §10.2 校正恢复 |
| `load_project(projectId)` | 按 §10.2 验证完整目录/文件信任链后才读 `project.json`；项目基准目录或文件逃逸即拒绝整个加载。随后按 §11.1 第 0 步只做信封判型：旧扁平形状包装为 v0，缺失/异型版本号的 v1 形状标记为待修复 v1，混合/无法判定的信封或显式版本与形状冲突时拒绝且不改写；并随原始文档返回受信 `projectId` 与可用的索引元数据。v1 的 `project` 父容器或成员异型不得在 Rust 层整份拒绝，交由前端归一化修复；节点级 schemaVersion 迁移与归一化同样在前端模型层（见十一），Rust 不参与 |
| `save_project(projectId, doc)` | 按 §10.2 验证完整目录、目标与临时文件信任链后，先校验完整项目信封：确认 `doc.project` 是普通对象；`project.id` **无条件以受信路径参数 `projectId` 覆盖**——调用方自报的 id 不构成授权，不得把与路径参数不一致的 id 落盘（否则内存会话、项目真源与首页索引出现分裂身份）；`project.name` 按 §9.3 项目名校验口径校验（与 rename_project/create_project 同规则）——先验 typeof string，去首尾空白后非空且按字符数 ≤ 64，非法值整次拒绝（保存边界不替调用方修复，普通命令无法产生的名称不得经原始 IPC 持久化），合法时采用规范化后的值。信封其余必需顶层成员同款前置校验：`schemaVersion` 必须严格等于当前支持版本（1）——缺失、异型或未来版本号整次拒绝（缺失/异型版本落盘后下次加载按 §11.1 第 0 步标记待修复，未来版本则直接拒绝，均不得由保存产生）；`graph` 是普通对象且其 `nodes`/`edges` 均为数组，`settings` 是普通对象且其 `characters`/`locations`/`props`/`documents` 各桶均为普通对象——任一异型即整次拒绝，不得把 `graph: null`、异型 `settings` 之类的载荷落盘后靠 §11.1 归一化重置为空容器，把无法判型的损坏静默变成内容丢失。`episodeTitles` 必须是普通对象（非数组、非 `null`）且键值满足 §11.1 第 3 步的键值域（规范十进制正整数安全整数键、字符串值）——数组型标题表等异型落盘后下次加载会被重置为 `{}`，载荷中的标题静默丢失，保存边界同样直接拒绝。`project` 其余元数据同域校验：`createdAt` 与 `updatedAt` 均须为可解析的 ISO 8601 字符串（`updatedAt` 虽被本命令无条件覆盖，异型值仍整次拒绝——保存边界不接受形状不完整的信封）；可选 `description` 存在时须为字符串；`graph.viewport` 存在时须为普通对象且 `x`/`y` 为有限数值、`zoom` 为正有限数（§3 缺省语义只允许字段缺省，不允许异型值落盘）。再确认 `doc.assets`/`doc.assets.byId` 均为普通对象，再把每个键和值当作不可信输入执行 §7.1 完整形状、Record 键/id 一致性及 MIME/时间戳规范形式校验（保存边界不替调用方修复，非规范值直接拒绝，避免内存与落盘分叉），并逐项以受信项目资产根句柄 no-follow 打开当前 relPath、确认普通文件和真实路径包含关系；任一校验失败即在创建临时文件、生成保存时间或更新索引前拒绝整次保存，返回具体字段或 assetId 诊断，不得静默剥离。全部通过后，Rust 为本次尝试只取一次系统时间，**无条件覆盖**调用方携带的 `doc.project.updatedAt`（不信任旧值、未来值或前端时钟），再以排他创建的同目录临时文件 + flush + rename 原子替换 `project.json`；随后以规范化后的 name 与同一 updatedAt 更新可重建的 `index.json` 缓存，跨文件中断由 §10.2 的启动/列表校正恢复。成功回执返回权威 updatedAt，供前端刷新内存元数据而不触发新一轮脏写；失败重试重新执行信封与资产复验并取新时间，`serializeProject` 只负责结构序列化、不负责保存时刻盖戳 |
| `delete_project(projectId)` | 按 §10.2 验证完整目录/文件信任链后只删除受信项目控制文件/目录；目标缺失为幂等成功，符号链接或越界目标拒绝且不跟随 |
| `validate_project_asset(projectId, asset)` | `set_asset` 的只读 Rust 前置命令：projectId 只接受 dispatcher 当前受信活动会话值，不接受命令负载自报；先按 §7.1 校验完整 AssetRef 与词法 relPath，再从受信项目目录/资产根句柄逐组件 no-follow 打开目标，确认它是资产根内普通文件；返回本次规范化后的完整 AssetRef。不得缓存结果或把它视为保存授权；公开 dispatcher 只把本次返回值立即交给模块私有 reducer，失败时活动文档、历史栈与脏标记零变更 |
| `import_asset(projectId, file)` | 按 §7.1 从受信项目目录句柄打开 `assets/` 根，在其下排他创建临时文件并以句柄相对 rename 落位，返回 `AssetRef`；不得按拼接后的绝对目标路径写入 |
| `get_asset_media_url(scope, assetId)` | scope 只允许 `{ kind: 'project'; projectId: string }` 或 `{ kind: 'library' }`，不得接受目录/路径字符串；命令只返回含逻辑 scope + assetId 的 opaque URL，不返回本机路径。Rust 协议处理器在每次媒体请求时按 §7.1 验证 projectId、从当前规范化索引解析 relPath，并以受信资产根句柄逐组件 no-follow 打开、确认普通文件后流式响应 |
| `list_library_assets()` | 先按 §7.2 通过受信控制文件与资产目录句柄恢复 `asset-delete-journal.json` 中的未完成事务；存在无法安全自动恢复的身份冲突时保留现场并返回警告。随后读 `library.json`，迁移并完整归一化 LibraryAsset/AssetGroup 后返回资产库列表（含编组、`cleanupPending` 与其他警告） |
| `import_library_asset(file, meta)` | 按 §7.2 校验 meta 与完整构造结果后，按 §7.1 通过受信库资产根句柄安全拷贝，完成文件 flush/fsync、原子落位与资产父目录 fsync 后确认可读，再耐久提交新增索引；索引失败时只留下可诊断孤儿文件。meta 含 name/kind/view/groupId/tags |
| `update_library_asset(assetId, patch)` | 按 §7.2 校验白名单 patch 并复验完整合并结果后修改索引项：改名、改标签、改视角、换编组（只动索引不动文件） |
| `upsert_library_group(group)` | 按 §7.2 校验完整 AssetGroup 后新增/更新编组；kind 变更不得与成员资产冲突 |
| `delete_library_group(groupId)` | 要求组存在；原子删除组并剥离成员资产的 groupId，不留下悬空编组引用 |
| `delete_library_asset(assetId)` | 按 §7.2 从本次受信规范化索引解析 id：若新索引仍有其他条目引用同一已打开文件身份，仅耐久提交去项索引；否则先耐久写 `asset-delete-journal.json`，再把身份核验后的原目录项通过受信句柄原子移入 `assets/.trash/` 随机名并复核移动后身份，隔离与目录 fsync 成功后才提交去项索引。提交后只用绑定已打开身份的平台原语清理隔离项；普通按名称 unlink 禁止。身份冲突、平台能力不足、清理或 fsync 失败均按阶段回迁或返回 `cleanupPending`，由启动/列表/后续写入按日志恢复；不得回滚已提交索引，也不得覆盖原名处后来出现的文件 |
| `collect_library_asset(projectId, projectAssetId, meta)` | 按 §7.1 分别以受信项目/库资产根句柄 no-follow 读取与写入，把项目资产完成文件 flush/fsync、原子落位与资产父目录 fsync 后才耐久提交新增库索引（「收藏」）；索引失败只留下可诊断孤儿文件 |
| `get_settings()` / `update_settings(patch)` | 非敏感配置读写 |
| `set_provider_key(provider, key)` | 加密并返回 envelope 密文（由前端随 settings 落盘；解密走 `seal::open`，无独立读命令） |
| `llm_chat(messages, tools)` | LLM 请求代理：key 由 settings 密文在 Rust 内存解密，绕开 webview CORS（见 12.2） |
| `llm_image_generate(request)` | 文生图代理（§13 首版）：单对象载荷（projectId/jobId/provider 配置/model/prompt/size），key 解密同 `llm_chat`；请求 OpenAI 兼容 `/images/generations`（b64_json 优先，url 成员回退下载），产物按字节魔数定型 MIME（PNG/JPEG/WebP/GIF，provider 声称的 content-type 不作为依据）、过 32 MiB 上限后经原子写内核落盘进项目 `assets/`，返回 `source=generated` 的 AssetRef（前端经 `validate_project_asset` 预检后并入索引）。请求返回后与落盘前各查一次取消标志：协作式取消即放弃结果 |
| `llm_image_cancel(jobId)` | 协作式取消：登记取消标志；进行中的 `llm_image_generate` 会在检查点放弃结果（HTTP 请求本身不中断，由超时约束兜底） |

## 十一、加载与归一化

**v0 内嵌设定引用兼容子步骤（逻辑上属于第 0 步预检与第 1 步迁移 ④，优先于下文通用列表补缺）**：当前已发布的旧项目不只使用 `data.characterIds`/`locationId`/字符串 speaker；还可能把场景出场角色写成 `data.characters: Array<{ label, gradient? }>`、地点写成 `data.location: string`，把对白行 speaker 写成 `{ label, gradient? }`。迁移器必须在把缺失的 `characterIds` 补成空数组、校验新形态 speaker 或拆分节点四分区之前识别并保留这些字段：

- 预检确认 `data.characters` 为数组后只保留普通对象成员；每项 `label` 须为 trim 后非空字符串、可选 `gradient` 须为字符串，异型项删除并逐项警告，不得让成员字段读取先抛错。合法头像先在 v0 `settings.characters[]` 中确定性复用实体：优先同名同 gradient，再同名；仅当单字旧标签在兼容 gradient 的既有名称中唯一匹配前缀时才复用，零个或多个候选时新建本域唯一 id 的 Character（名称取 label，gradient 缺省取默认值）。把所得 id 与已有合法 `data.characterIds` 按原顺序合并去重后写入 `characterIds`，成功转换后才删除 `characters`；只有两种来源都不存在时才补 `[]`。
- `data.location` 为 trim 后非空字符串且没有合法 `locationId` 时，按完整名称复用 `settings.locations[]` 中的唯一实体，找不到则补建新 id 的 Location，再写入 `locationId`；已有合法 `locationId` 时以其为准并删除旧镜像，名称冲突记录警告。`location` 存在但非字符串或规范化后为空时删除并警告，不得覆盖合法 id。
- 对白 `data.lines[]` 的普通对象成员若 `kind === 'line'` 且 speaker 是普通对象，按头像同一 label/gradient 校验与复用/补建规则改写为角色 id；异型 speaker 删除并警告。非 line 成员携带 speaker 时按判别形状剥离并警告。对象型 speaker 在本转换完成前不得被当成“非字符串引用”清除。
- 本子步骤补建的角色/地点实体先进入 v0 设定数组，再由第 1 步 ⑤ 与原有实体一起做 id 校验、键化和引用一致性处理。由此实体与节点引用使用同一最终 id；通用预检中“缺失/非数组列表置空”的规则仅适用于上述旧字段也不存在或已确定无法恢复的情形，不能先清空再迁移。

上述确定性匹配只允许形状合法、名称经同一 `trim()` 规范化且 id 可安全读取的既有设定实体进入候选集；异型既有实体留给后续通用归一化隔离并警告，不得因兼容匹配读取其字段而中断迁移。新建实体的 id 必须避开本域已有键与已分配 id，规范化后的旧 label/location 同时作为比较值与新实体名称，避免空白差异制造重复实体。

`load_project` 返回后、交付画布前执行归一化管线，保证任何历史版本的文档都以当前形态进入会话。管线位于**前端模型层**（纯 TS，无框架依赖，与 §2 分层一致）——Rust 持久化层对节点/边结构不透明，只做第 0 步的信封判型与旧格式包装，并提供路径给定的受信 `projectId` 与索引元数据；不得仅因缺失 `schemaVersion` 就无条件按 v0 包装，也不得因 v1 的 `project` 父容器或成员异型而整份拒绝。文件系统信任边界仍由 Rust 层负责：任何项目控制文件 I/O 前先执行 §10.2 的目录/文件信任链校验；资产 relPath 的真实路径包含判定（canonicalize/符号链接解析）也只能由可访问文件系统的 Rust 层在 `load_project` 内执行，非法条目清单随加载结果返回，供第 3 步消费（§7.1 分层执行）。这两类检查不参与节点级模型迁移。

0. **信封判型与迁移前安全预检（先于任何迁移或逐项字段读取）**。根值不是普通对象时直接拒绝且不改写。v0 特征定义为：不存在 v1 专属顶层键 `project`/`graph`/`assets`，同时至少出现两个旧扁平特征键 `name`/`updated_at`/`nodes`/`edges`，且其中至少一个是 `nodes` 或 `edges`；v1 特征定义为：至少出现一个 v1 专属顶层键，且不存在旧扁平专属的顶层 `name`/`updated_at`/`nodes`/`edges`。v0 与 v1 专属键同时出现即为混合信封，拒绝加载并保留原文件。`schemaVersion` 为非负安全整数时由显式版本定族：0 只要未出现 v1 专属键即可进入 v0 预检（旧容器即使缺失或异型也由下段修复），1 只要未出现旧扁平专属键即可进入 v1 通用归一化（`project`/`graph`/`assets` 即使全部缺失也由第 2 步补齐），高于当前版本拒绝并提示升级；显式版本与相反家族专属键冲突时拒绝。版本字段存在且为 number、但负数、非安全整数或非有限值时直接拒绝，不得按形状降级；字符串值若是规范十进制整数且表示高于当前的版本也直接拒绝。仅当版本字段缺失，或其余无法表达受支持/未来版本的异型值出现时，才要求上述形状特征足以单独判型：唯一匹配 v0 时赋予迁移用的有效版本 0，唯一匹配 v1 时赋予待修复的有效版本 1，两组都不满足时拒绝，均记录警告。由此，丢失版本号但保持 v1 信封特征的文档会直接进入第 2 步，绝不读取顶层 `nodes`/`edges` 重新装配画布；显式 v1 的缺容器文档仍可按既有修复契约打开。

   判为 v0 后，迁移器在执行第 1 步前先按**旧路径**做安全预检：顶层 `nodes`/`edges` 非数组时重置为空数组，`settings` 非普通对象时重置为空对象，`settings.characters`/`settings.locations` 缺失或非数组时重置为空数组，`episodeTitles` 缺失或非普通 Record 时重置为空 Record，均记录无法机械恢复内容的警告；随后先过滤 `nodes`/`edges` 与设定数组中的非普通对象成员。仅对已确认是普通对象的 v0 节点读取 `type`/`data`：`data` 非普通对象时隔离该节点及其关联边；按节点类型检查旧扁平列表路径 `data.characterIds`/`data.lines`/`data.options`/`data.refs`。检查 scene 时必须先识别并保留可恢复的 `data.characters`/`data.location`，检查 dialogue 的 `data.lines` 普通对象成员时必须保留对象型 `speaker`，再执行本节开头的兼容子步骤；`characterIds` 缺失或非数组时，仅在没有可恢复 `characters` 来源时重置为空数组，否则延迟到兼容转换中合并/补齐。其余必填列表缺失或非数组时重置为空数组；`characterIds` 只保留字符串成员，`lines`/`refs` 只保留普通对象成员。`options` 在预检中必须保留原数组长度与成员位置，只按原始下标把成员分类为旧格式字符串、普通对象或非法项并记录警告；不得在第 1 步 ① 建立下标映射前过滤、压缩或重排，非法项到该步完成无映射标记后才删除。v0 边的 `data` 非普通对象时先重置为空对象，供第 1 步写入判别字段；迁移会读取或执行字符串操作的标量（如 `id`、`sourceHandle`、`type`、`className`）必须先做运行时类型检查，异型值只能按后续契约重发、隔离或保留警告，不得直接调用 `trim()`、前缀判断或正则方法。除此之外不得在本预检完成前解引用任何节点、边、设定实体或嵌套列表成员。预检只建立可安全遍历的迁移输入，不写回磁盘；完整迁移与 v1 通用归一化全部成功后才允许持久化。

1. 第 0 步完成后，`schemaVersion` 低于当前版本时按迁移链逐级升级；高于当前版本已在第 0 步拒绝。**迁移链首环**：schemaVersion 0（首版扁平存储格式：顶层 `name`/`updated_at`/`nodes`/`edges`/`settings`/`episodeTitles`，节点数据未分区、设定集为数组）→ 1（本文档结构）。首环包含四次改写与一次信封装配，改写全部发生在孤儿边隔离之前：① 逐个 branch 以转换前的 `data.options` 原始数组下标遍历并建立「原始下标 → 最终选项 id」映射：字符串成员先保留原文案转换为 `{ id: 新 id, label: 原字符串 }`；普通对象成员只有 `label` 为字符串时才保留，随后按本节共同 id 规则补发缺失/非法 id，并在同一数组内去重——v0 已存在的重复选项 id 保留首见项、后续项重发新 id；所有新 id 均须避开该节点全部原有合法 id 与本轮已分配 id。其余异型或 label 非字符串的成员删除并逐项警告，其原始下标不建立映射；**不得先压缩数组再用新下标建映射**，否则被删项后的旧 `option-N` 连线会静默改接到后一选项。`dialogue.lines`/`shot.refs` 等其余键控列表同阶段补稳定 id。上述选项对象化、id 补发与去重必须全部在 ② 之前完成：旧下标句柄按「原始下标 → 最终选项 id」定位；若字符串仍是标量，或重复 id 留到 ② 之后才去重，连线会被删除或静默改接；② 对每条以该 branch 为 source、且按第③项旧字段归类规则可确定归为 branch 的边，把规范的旧式 0 基下标句柄（`option-0`、`option-1`…）按该节点的映射改写为稳定 id 句柄（`option-<id>`）。下标越界、对应旧项已删除或句柄无法规范解析时不得改写，而须立即把该边加入迁移隔离集合并记录警告；第 3 步直接隔离，不得再把原字面量解释成稳定 `option-<id>`（否则它可能碰巧解析到 id 为同一数字串的其他选项），更不得猜测为压缩后下标；③ 把边的旧式运行态判别字段（`type: 'branch'`、`className: 'pw-edge-attach'/'pw-edge-sequence'`）按归类规则（§4.3 连线语义）改写为显式 `data.kind`，**并删除镜像的 `data.optionLabel`**（§5 禁止边上落 label，胶囊文案按改写后的稳定句柄重新派生）；④ 节点结构转换：先按本节开头的 v0 兼容子步骤把 `data.characters`/`data.location`/对象型 `speaker` 复用或补建为设定实体并改写成 id，成功后才删除旧字段；再把旧 React Flow 形状（顶层 `position`/`selected`、类型字段平铺于 `data`）拆入四分区（`layout`/`ui`/`data.spec`/`data.meta`），**名称型节点（scene/beat/dialogue）的旧 `data.name` 上移为 `meta.label`（必填）**，`ui.selected` 重置、`ui.expanded` 初始化为 `true`（旧节点无该字段）——v0 节点未经引用转换与四分区转换不得 stamped 为 v1。⑤ **信封装配**（文档级映射与缺省回退，经 Rust `wrap_legacy` + 前端 `serializeProject` 协作完成）：顶层 `name` → `project.name`；顶层 `updated_at`（epoch 毫秒）→ ISO 8601 → `project.updatedAt`，`createdAt` 缺省与 `updatedAt` 同刻；`project.id` 由项目文件名回填（信任边界校验）；`nodes`/`edges` 上移 `graph`，`viewport` 缺省不伪造（打开时 fitView）；`settings` 的嵌套数组键化：`settings.characters[]` / `settings.locations[]` → `Record<id, 实体>`（v0 的 `settings` 本身是对象，数组在成员上——勿把整个 settings 当数组转换），**键化前按 §8.1 的共同值域校验实体 id：重复 id 保留首见项、后续重发新 id（节点引用本就按 id 解析到首见项）；缺失、非字符串或 `trim()` 后为空的 id 均重发新 id 并记录警告**，避免直接键化时同键覆盖、设定内容静默丢失；对字符串型空白 id，以修复前原值为映射键建立「原 id → 新 id」映射并同步改写指向该桶的全部结构化引用（`characterIds` 成员、`speaker`、`locationId`、`relatedIds` 对应 kind 项的 `id` 等，与第 3 步空白键处理同款）——数组内某一原值仅对应一个实体时映射明确、引用随重发保留；同一原值对应多个实体时映射歧义，相关引用保持悬空并记录警告（键化完成后记录键均满足共同值域，第 3 步不会再补到这一步）；`props`/`documents` 补空桶；`episodeTitles` 归一化（字符串键 → 数字键的格式转换、去空标题——仅规范十进制正整数字符串键参与转换，非规范数字串如 `"01"`/`"1e0"` 不转换、连同非法键一并由第 3 步删除；键/值域校验由第 3 步对所有版本统一执行，见下），缺省 `{}`（v0 早于集标题功能的文件没有该字段）；`assets` 补 `{ byId: {} }`。⑤ 完成前文档不得 stamped 为 v1。
   **v0 角色 id 补充**：本步 ⑤ 对 `settings.characters[]` 键化前，除共同 id 规则外还必须立即执行下文“角色 id/token 专项修复”；先生成安全 id 并同步结构化引用与旧 token，再以最终 id 建 Record 键。不得先把含 `]`/换行等 id 的角色盖成 v1、留到后续扫描才处理。

2. 对第 0 步判定的 v1 文档与第 1 步迁移产物，先做当前信封的容器级形状校验（先于一切 v1 逐项规则；**父容器先于子容器**——父容器异型未补齐就访问子容器会直接解引用失败）：`project`/`graph`/`settings`/`assets` 缺失或为非普通对象（`null`/数组等）时，`project` 先补为可供逐字段归一化的空普通对象，其余分别补 `{ nodes: [], edges: [] }`/默认空桶/`{ byId: {} }`；父容器就位后再校验子容器——`graph.nodes`/`graph.edges` 非数组时重置为空数组，`settings.characters`/`locations`/`props`/`documents` 与 `assets.byId` 非普通键值对象（`null`、数组或其他异型——JavaScript 中数组同为对象，「非对象」检查不足以排除；数组形态会让下标 `"0"`/`"1"` 被当作权威实体 id 改写内嵌 id，原有引用静默悬空）时重置为对应空 Record，`episodeTitles` 缺失或非 Record（`null`/数组等）时重置为 `{}`——标题表容器不合法时第 3 步的键值遍历无从执行。异型容器的内容无法机械恢复，重置均记录警告，但管线必须可遍历、单个脏字段不能让整个项目打不开（§8.2.4）。容器就位后再过滤**成员级异型**——节点/边数组中的非普通对象成员（`null`/数组/标量）隔离并记录警告，Record 桶中的非普通对象值同款移除：任何字段读取与改写只针对普通对象成员，否则 `graph.nodes: [null]` 会在下一步重置 `ui.selected` 时解引用 `null`、`characters.c1 = null` 会在内嵌 id 修复时崩坏。成员过滤后接着校验**嵌套容器及其成员**（必须先于第 3 步一切逐项修复与遍历——第 3 步首条规则即读取 `data.kind`、迭代列表、按列表 id 去重，判别式、列表容器或成员异型时会在形状校验执行之前先解引用崩坏）：节点 `data`/`data.spec`/`data.meta`/`layout` 或边 `data` 缺失或为非普通对象时判别依据缺失、无法机械修复——隔离该节点（连同其关联边）/该边并记录警告；与节点类型对应的必填列表 `scene.spec.characterIds`、`dialogue.spec.lines`、`branch.spec.options`、`shot.spec.refs`，以及每个 `SettingsDocument.relatedIds` 缺失或非数组时重置为空数组并记录警告——列表可确定性置空、所属节点/实体保留，指向被清空选项的连线由第 3 步按孤儿边处理。列表容器就位后再过滤成员：`lines`/`options`/`refs`/`relatedIds` 中的非普通对象成员移除并警告，`characterIds` 中的非字符串成员移除并警告；普通对象成员的字段形状与字符串成员的值域仍由第 3 步按各自契约校验。所有父容器和嵌套列表安全后、读取 `project.name` 等成员前补齐项目必填元数据：`project.id` 缺失、非字符串、`trim()` 后为空或与 `load_project(projectId)` 的受信项目 id 不一致时，以受信 id 覆盖并记录警告；`project.name` 先校验为字符串，再去首尾空白，非字符串、规范化后为空或按字符数超过 64 时回退索引中的合法名称，再回退固定占位「未命名项目」并警告；`createdAt`/`updatedAt` 须为可解析的 ISO 8601 字符串，`updatedAt` 非法时优先采用索引中的合法时间、否则取本次加载时刻，`createdAt` 非法时采用修复后的 `updatedAt`，均记录警告；可选 `description` 存在但非字符串时剥离并警告。由此即使原始 `project` 为 `null`/数组/缺失也会在逐项规则前成为完整、可保存的信封。最后补齐节点 `ui` 默认值——`ui` 缺失/非对象或 `selected`/`expanded` 类型错误时重置为 `selected: false`、`expanded: true`（与迁移 ④ 初始化口径一致）并记录警告——再重置所有节点 `ui.selected = false`（顺序不能颠倒：普通对象节点的异型 `ui` 会在重置时直接解引用失败）。
3. 先执行下文“非法 id 与 Record 键的统一解释”中的全部 id 修复：节点/列表 id 重发及可确定引用改写先于边隔离，边 id 同步重发；**完成这些 id 修复后，先执行本段后列的全部节点判别联合、基础结构与可修复字段归一化规则；隔离无法机械修复的节点及其全部关联边，得到最终活动节点集。任何边的端点/kind/句柄解析、逻辑重复、attach 宿主唯一或剧情流成环判定都不得早于该阶段，也不得让已隔离节点或其关联边进入候选边集合**；随后在解析 `source`/`target`、读取节点类型或执行任何边语义前，按 §5 校验边的端点字符串值域及完整 `data.kind` 判别联合：未知/非字符串 kind、非法端点值或确定性句柄剥离后仍无法形成任一变体的边立即隔离并警告。随后才隔离孤儿边（source/target 节点已不存在；branch 边的 `sourceHandle` 指向的选项已不存在、kind/句柄矛盾（§5 保留字面量）、sequence/attach 边 source 为 branch 节点（§5 端口归属反向约束）、attach 边端点类型不合法——必须 scene → shot——、sequence/branch 边端点为 shot（§4.2 分镜卡不参与剧情流）同论）并记录警告——修复而非拒绝，单条坏数据不阻断加载（见 8.2.4）。已知 kind 的边携带 `targetHandle` 或 sequence 边携带 `sourceHandle` 时不隔离而剥离——匿名端口唯一（§5），剥离不改变连接语义，记录警告；该确定性剥离发生在完整变体判定内，绝不为未知 kind 猜测变体。剧情流边的自环与成环同款隔离：仅以最终活动节点之间、且已通过前述边形状/端点筛选的候选边按文档序逐边重建剧情流图，source 等于 target 的自环边、加入即闭合回路的 sequence/branch 边均按孤儿边隔离并警告（attach 垂直从属不参与环检测，§4.3）。节点 id 重复时保留文档序首个节点、后续同 id 节点重发新 id 并记录警告——按 id 的引用（边端点等）本就解析到首个节点，重发节点成为无连线孤儿节点（内容保留，由用户处置）。branch 节点 `options` 内出现重复 id 时同样修复：保留首见项，后续重复项重发新 id 并记录警告——v1 文档的连线按 id 解析，本就归属首见项，重发不产生改接（v0 迁移路径的重复 id 已在首环 ① 去重，不经此条）；其余键控列表（`dialogue.lines`、`shot.refs`）的重复 id 同款修复——它们不被边引用，重发纯为列表 key 去歧。边 id 重复时保留文档序首条、后续重复边重发新 id 并记录警告。同一 shot 存在多条入向 attach 边时保留文档序首条、其余按孤儿边隔离并警告（宿主场景唯一，见 §5 attach 宿主约束）。节点 `meta.episodeNo` 非法（非正整数、非有限值或超出安全整数范围，§9.3 命令边界同域）时删除该字段并记录警告——回退为未分集，不阻断加载。逻辑重复边（同 source/target/sourceHandle，§5）保留文档序首条、其余按孤儿边隔离并警告。**节点校验细则（逻辑上已按本步前置顺序执行，以下位置只展开规则，不表示晚于边图重建）**：按 §4.1 判别联合校验节点 `type` 与 `spec`/`meta` 的对应：never 禁写字段被携带（branch/shot 的 `label`、shot 的 `episodeNo`）时剥离该字段并警告；type 与 spec 形态错位（如 scene 携带 BranchSpec）、名称型节点缺必填 `meta.label` 等无法机械修复的异型节点，隔离该节点及其关联边并记录警告，不交付画布——JSON 边界已擦除 TypeScript 类型，此校验是 §9.3 create_node 边界校验在加载路径的对等兜底。节点基础结构（§4.1 StoryNodeBase 四分区的外壳）同款校验：节点 `id` 缺失或为空时重发新 id 并记录警告——缺失（undefined/null）的 id 无引用可指向，重发无副作用；**空字符串 id 可被脏写的边端点（`source: ''`/`target: ''`）指向**，重发时建立「空 id → 新 id」映射并同步改写边端点——仅一个空 id 节点时映射明确、连线保留；存在多个空 id 节点时映射歧义，指向空串的边按孤儿边隔离并警告——**歧义判定以修复前的空 id 数量为准、先于上文的通用重复 id 去重执行**：空串本身即「重复 id」，若先去重再判定，两个空 id 节点会被折叠为一个、指向空串的边被错误改接到首见节点而非隔离（与空选项 id 的歧义处理同款；更正四十四轮「无引用可指向缺失 id」对空串不成立的表述）；`ui` 的缺失/异型已在第 2 步重置 `selected` 前补齐默认值，本条不再重复；`layout.size` 等可选布局数值非法时剥离该字段并记录警告；`layout.position` 坐标非有限数值等无法机械修复的基础结构异型，隔离该节点及其关联边并记录警告、不交付画布——单个异型节点不阻断项目打开（§8.2.4），缺坐标/缺 ui 的节点会让依赖 StoryNodeBase 的画布渲染直接崩溃。非法 sceneNo/shotNo（非正整数、非有限值或超出安全整数范围，§9.3 同域）按文档序顺位重发为正整数并记录警告（场号/镜号可在场景面板修正）。键控列表（`branch.options`/`dialogue.lines`/`shot.refs`）中的空 id 重发新 id 并记录警告。重发空选项 id 时建立「空 id → 新 id」映射并同步改写该 branch 节点引出边的 `option-` 句柄——branch 内仅一个空 id 选项时映射明确、连线保留；同 branch 存在多个空 id 选项时映射歧义，无法归属的连线按孤儿边隔离——**歧义判定同样以修复前的空选项 id 数量为准、先于上文的 `options` 重复 id 去重执行**：空串同为「重复 id」，先去重会把多个空选项折叠为一个、误判映射明确，连线被错接到首见项而非隔离。本步内节点/列表修复先于边隔离判定，句柄解析针对修复后的 id。完成本步键/id 修复后，对 `assets.byId` 每个普通对象值执行 §7.1 的完整 AssetRef 形状校验：`relPath`/`mime`/`source`/`createdAt` 任一必填字段缺失、类型错误或值域非法即从活动索引隔离并警告；仅 MIME 的合法大小写/首尾空白与可解析时间戳的时区表示允许规范化后保留。relPath 词法层（绝对路径、解析目标越出资产子目录）由本步判定；真实路径包含判定（canonicalize/符号链接解析）消费 Rust `load_project` 随加载结果返回的非法条目清单——形状、词法或真实路径任一校验失败均移除该条目，其引用字段按 §8.2.3 悬空展示，项目自包含不因脏数据破坏。`episodeTitles` 键值校验对**所有版本**文档执行（迁移链 ⑤ 只做 v0 的字符串键 → 数字键格式转换，v1 文档不经迁移链，脏写/导入仍可携带非法键值）：键须为规范十进制正整数字符串且在安全整数范围（`Number.isSafeInteger`）内——零/负/小数/NaN/非数字串删除该键并记录警告（无法由 `set_episode_title` 产生也无大纲语义）；`"01"`、`"1e0"`、`" 1"` 等可折算为正整数但非规范书写的键同样删除并记录警告——它们与规范键（如 `"1"`）折叠到同一集号，转换时会按属性遍历序静默覆盖其中一个标题；超出安全整数范围的键删除并警告（`Record<number, string>` 索引精度不保）。值非字符串时删除该键并记录警告（大纲 UI 只消费字符串标题）；字符串值去首尾空白，空白后为空串的删除该键（与 `set_episode_title` 落盘口径一致）。键控实体桶（`settings.characters`/`locations`/`props`/`documents`、`assets.byId`）的 Record 键与值内嵌 id 一致性修复对**所有版本**执行，且**先于各桶的实体形状校验**（v0 数组键化在迁移链 ⑤ 按实体 id 建键、天然一致，但 v1 脏写/导入可产生 `characters.ch1.id === 'ch2'` 式分裂身份——引用按记录键解析，更新/删除按值内 id 定位，两者不一致时实体可显示却无法正确更新或删除）：**记录键本身先按 §8.1 的共同值域校验（`key.trim().length > 0`）**——空串或纯空白键条目确定性重发一个本桶未占用的新键（值内 id 随键同步为同一新 id）并记录警告（空身份与 upsert 边界的非空 id 约束冲突、空 React key 致 reconcile 错位）；重发时以完整原键建立「原键 → 新键」映射并同步改写指向该桶的**全部**结构化引用（均按精确等于原键匹配）：角色桶改写 `DialogueLine.speaker`、`SceneSpec.characterIds` 成员与 `SettingsDocument.relatedIds` 中 `kind: 'character'` 项的 `id`；地点桶改写 `SceneSpec.locationId` 与 `relatedIds` 中 `kind: 'location'` 项的 `id`；资产桶改写 `avatarAssetId` 与 `ShotRef.assetId`；props/documents 桶无被引用字段、无需改写；`relatedIds` 项须 kind 与目标桶对应才改写，不得因不同桶存在同字面 id 而跨命名空间改写——标准 JSON Record 中每个原键至多一个条目（JSON 键唯一），映射天然明确，引用随重发保留而非悬空；仅非标准解析保留重复键等歧义情形无法归属，相关引用保持悬空并记录警告（更正四十二轮「空键不可能承载合法引用」的表述——脏写的引用侧同样可以出现空串）；记录键合法时，内嵌 id 缺失、非字符串或 `trim()` 后为空均以记录键补齐、不一致时以记录键为准改写，均记录警告——键是引用解析的权威值，补齐/改写可无歧义地保住条目内容与全部既有引用；键在 Record 内天然唯一，新键又经未占用校验，改写后各值内 id 亦唯一，不产生碰撞。`project.name` 归一化对所有版本执行（§9.3 项目名校验口径的加载侧兜底——`load_project` 只反序列化文件，旧项目或手工修改可携带非法名称）：typeof 非 string、去首尾空白后为空或按字符数超过 64 时确定性修复——先去首尾空白，合法则采用规范化值；仍非法则回退为项目索引（`index.json`）中的名称，索引亦无合法名称时回退固定占位「未命名项目」，均记录警告。活动文档中的名称由此始终可保存，`rename_project` inverse 捕获的旧名才能经同一命令边界回放——否则撤销要么被边界拒绝，要么恢复一个 `save_project` 会拒绝的名称。`graph.viewport` 存在时校验其形状：非对象、`x`/`y` 非有限数值或 `zoom` 非正/非有限时删除该字段并记录警告——回退打开时 fitView（§3 缺省语义），无效变换不交给画布（否则可能出现空白或不可操作的视图）。`settings.documents` 逐项校验 SettingsDocument 判别形状（§6，JSON 边界已擦除 TS 类型）：`relatedIds` 关联项不符合 `{ kind: 'character' | 'location'; id: string }` 形状时删除该项并记录警告——旧式字符串项无法解析归属（跨桶同名歧义，§6）、未知 kind、缺失或空 id 同论；形状合法但 `(kind, id)` 重复的关联项保留首见、其余删除并记录警告（重复关联会让反向索引/导航重复列出同一文档）。文档条目本身 `title`/`body` 非字符串等无法机械修复的形态，从 `documents` 隔离该条目并记录警告（内嵌 id 已经一致性改写补齐，不在本条判定范围）——否则按 `{ kind, id }` 构建的反向索引、导航与失效引用展示无法解析。`settings.characters`/`locations`/`props` 逐项校验实体形状（与 §9.3 upsert 边界同域；内嵌 id 已经一致性改写补齐，本条只判定其余字段）：必填字段缺失或类型错误（name 非空字符串、Character.gradient 字符串）的条目无法机械修复——从桶中隔离并记录警告，既有引用按 §8.2.3 悬空展示（否则 `name: null` 之类的值会交付画布，消费方 trim/渲染在运行期崩溃）；可选字段（bio/note/description/avatarAssetId）存在但类型错误时剥离该字段并记录警告。

   **ShotRef 目标命名空间与旧字段兼容（本步节点联合校验的一部分）**：资产桶完成键/id 修复且通过完整 `AssetRef` 形状筛选后，先兼容尚未由当前实现持久化的旧草案字段 `targetId`，再按当前联合校验每个普通对象 `shot.refs` 成员。旧字段与 `assetId`/`label` 任一并存，或旧值不是符合 §8.1 共同值域的字符串时，该 ref 按歧义/异型成员隔离并警告。`kind === 'audio'` 的旧值依原契约视为项目资产 id：资产键若在本步重发则跟随同一明确映射，再改名为 `assetId`；映射后资产仍缺失也保留为悬空引用。`kind === 'character' | 'location'` 仅当旧值按资产键修复前后的身份唯一命中活动 `image/*` 项目资产，且按对应设定桶修复前后的身份均未命中实体时才改名；否则隔离并警告。成功转换后删除 `targetId`；迁移器不得把角色或地点实体 id 当成资产 id，也不得隐式追随 `Character.avatarAssetId`。兼容完成后校验当前联合：`id` 适用上文列表 id 规则；`kind` 必须是 `character | location | audio`；且必须恰有 `assetId` 或 `label` 之一。自由位的 `label` 必须是字符串；引用位的 `assetId` 必须是非空字符串并只按当前项目 `assets.byId` 解析，资产键重发时跟随资产桶映射，目标缺失时按 §8.2.3 保留为悬空引用并警告，不删除用户选择。目标存在时，`character`/`location` 必须对应 `image/*`，`audio` 必须对应 `audio/*`；MIME 用途不匹配时保留为不可用引用并警告，不得改按其他命名空间解释。两字段并存、两字段皆无、值类型错误或未知 kind 无法无歧义修复时，仅隔离该条 ref 并警告，不隔离整个 shot。这是 v1 发布前文档契约修正，当前实现仅持久化自由位 `label`，不提升 `schemaVersion`；兼容规则只保护旧草案或手工导入数据。

   **角色 id/token 专项修复（第 1 步 ⑤ 的 v0 数组键化与本步 Record 修复共用，先于第 5 步文本扫描）**：两条路径都必须同时应用 §6 的 `[A-Za-z0-9_-]{1,64}` 子值域。v0 数组以实体原 `id` 为迁移身份：非空字符串 id 若只违反该子值域，确定性重发本桶未占用的安全 id；先按既有重复规则决定首见实体的归属，再以修复前完整字符串建立明确映射。v1 Record 则以记录键为权威身份：键违反子值域时重发未占用的安全键并把值内 `id` 同步为新键；键已安全时，即使值内 `id` 不安全或不一致，也按上文共同规则以键覆盖值内 `id`，不得据值内字段另行重键。随后按权威旧身份 → 新身份映射同步改写 `characterIds`、dialogue `speaker`、`kind === 'character'` 的 `SettingsDocument.relatedIds` 等所有结构化角色引用。文本改写不能先用新 token 正则扫描——旧 id 可能含 `]` 或换行；迁移器须按已知旧身份构造完整字面量 `@[character:<旧 id>]`，以不插值正则的字面量匹配替换为新 token。某旧值归属首见实体时 token 同步指向该实体的新 id；无法唯一归属时原文保留并警告，不猜测目标。全部改写完成后活动角色 id 与新写 token 才统一满足固定语法。

   **非法 id 与 Record 键的统一解释（优先于本步上文仅写“缺失”“空串”或“空白”的旧例）**：§8.1 的共同值域是 `typeof id === 'string' && id.trim().length > 0`。对节点、边、键控列表项与 v0 设定数组实体，缺失或任意非字符串 id（number/boolean/null/对象/数组）均为非法，须在通用重复 id 去重前为每个实体独立重发本域未占用的字符串 id 并警告，**不得**用 `String(value)` 强转（否则数字 `7` 会与合法字符串 `"7"` 碰撞）。合法引用的值域本就只允许字符串，因此不为非字符串旧 id 建映射：边的非字符串 source/target 或其他非字符串引用按各自形状规则隔离/剥离/标记悬空；字符串句柄也不得猜测为某个非字符串选项 id，无法解析时按孤儿边隔离。字符串型空白 id 则以修复前的**完整原字符串**分组并建立「原 id → 新 id」映射；同一原值只对应一个实体时同步改写精确等于该原值的边端点、句柄或同域引用，同一原值对应多个实体时视为歧义并隔离相关连接或保留悬空警告。键控实体桶的 Record 键在 JSON 中天然是字符串，先执行 `key.trim().length > 0` 校验：空串或纯空白键均重发一个本桶未占用的新键，值内 id 同步为新键，并把精确等于旧键的同桶引用同步到新键；记录键合法时，内嵌 id 缺失、非字符串或 `trim()` 后为空均以记录键补齐，不一致时仍以记录键为准。不得把空白键直接采用为权威 id，也不得仅 `trim()` 后原地改键——后者可能与既有键碰撞且漏改引用。

   **图片节点归一化（§13 首版，第 3 步节点校验细则的 image 分支）**：`meta.label`/`meta.episodeNo` 按 never 禁写剥离（同 shot，§4.1 ImageMeta）；`spec.prompt`/`spec.model`/`spec.size` 为必填字符串（异型即形态错位、隔离节点）；`spec.outputs` 缺失或非普通对象时重置为空对象并警告（未生成产物是合法状态 `outputs: {}`，字段缺失属脏写）；`outputs.primary` 存在但非普通对象、`assetId` 非非空字符串时剥离整个 primary 并警告；可选 `width`/`height` 存在但非正有限数时剥离该字段。`primary.assetId` 只按本项目 `assets.byId` 解析，目标缺失保留为悬空引用并警告（§8.2.3 不删除用户选择，UI 按缺失占位展示）。剧情流边（sequence/branch）端点为 image 的按孤儿边隔离——图片节点不参与任何连线（§4.2）。

4. 标记（而非清除）悬空的设定引用与资产引用。
5. 仅按 §8.1.2 的固定正则扫描文本中的 @ 提及 token；近似但非法的 token 形片段保留为普通文本并警告，合法 token 的目标已不存在时标记为失效（token 本身保留）。
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
  - **落地状态（2026-09-04，首片）**：文生图已上线——图片节点 `image`（§4.2 ImageSpec：prompt/model/size + `outputs.primary`）经 `llm_image_generate` 代理产出 `source=generated` 项目资产，以**复合命令**写回（资产入索引与 `outputs` 同栈撤销/重做，§7.3 库资产导入同构）；输入签名守护（prompt/model/size 规范化元组）与协作式取消（`llm_image_cancel` 取消标志 + 检查点放弃）为进程内实现，发起端同步占位作业表（设置加载的异步间隙内双击不重复发起计费请求）。作业生命周期 = **编辑器挂载期**：不跨重启持久化（重启即丢失进行中作业，产物本身已落盘），亦不跨编辑器卸载——打开设置页 / 返回首页卸载编辑器时即对全部进行中作业发协作式取消（检查点放弃，防孤儿媒体与卸载后写回）；跨界面保留随「job 落盘与启动恢复」演进一并解决。**仍属演进**：图生图（引用输入走边与 `spec.operation` 推断）、视频节点、job 落盘与启动恢复、宽高/时长 metadata 回填、§10.3 目录化模型清单。
- **多端同步/协作/官方代付**：另起《服务端领域模型》文档；`schemaVersion` 迁移机制届时成为前后端契约的一部分。
- **跨项目搜索、资产去重**：评估 SQLite 索引层。
