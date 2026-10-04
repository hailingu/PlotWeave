# 数据模型设计：历轮评审修订记录

> 性质：历史归档。本文是[数据模型设计](data-model.md)定稿过程中历轮评审修订的逐轮记录（含 v1 相对草案的初版差异），自正文头部移入独立档案（issue #236）；内容原样保留，整理时不改写设计。现行契约以[数据模型主题正文](data-model/README.md)为准，旧章节由[迁移对照](data-model.md)定位；已关闭 issue 的逐项结论与合并依据见[设计同步记录](design-sync.md)。
> 轮次说明：以下记录按原归档顺序保留（其中八十八至九十一轮以 91、90、89、88 的倒序排列在八十七轮之后），属历史事实，不作重排。

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
> 七十一轮评审修订（2026-09-04）：§10.5 `llm_image_generate` 请求体不携带 `response_format`——GPT Image 系（gpt-image-1 等）不接受该参数（携带即 400 unsupported parameter，主路径在生成前失败）且总是返回 base64，DALL·E 系默认 url 响应由既有 url 成员回退下载兜住；§13 重新生成时旧产物若不再被任何其他节点引用（图片 `outputs.primary` / 分镜 `refs` 扫描）则随同一复合命令移出索引（undo 恢复、媒体文件留存待延迟回收），仍被引用或已不在索引则不动。
> 七十二轮评审修订（2026-09-04）：§13 旧产物回收的引用扫描补第三个引用位——角色 `avatarAssetId`（`settings.characters`）：上一轮扫描只覆盖图片 `outputs.primary` 与分镜 `refs`，会误删仍作角色头像的旧产物致悬空；三处引用位齐备后方可移出索引。
> 七十三轮评审修订（2026-09-04）：§13/§10.5 `llm_image_generate` 把 §9.3 预检（形状 + 实路径复验）并入命令内、落盘后返回前完成——前端不再二次 `validate_project_asset` IPC，生成后到返回前的校验窗口不再跨命令边界；落盘后无取消检查点（放弃只制造孤儿），该窗口卸载丢结果登记为已知边界，跨卸载保留随 job 落盘恢复演进；设置页图像默认模型候选沿用共享模型清单（无能力维度），加用途引导文案，按用途过滤随 §10.3 目录化模型清单演进。
> 七十四轮评审修订（2026-09-04）：§12/§13 AI 命令通道对图片节点显式拒绝——`checkFieldKeys` 对无字段白名单条目的类型由「放行」改为「整批拒绝」（`暂不支持 AI 命令修改`）：此前 update_node 目标为 image 时任意 patch 畅通（`{"patch":{"prompt":{}}}` 直抵画布，快照 `prompt.slice` 崩溃、畸形 outputs 落盘重开被静默修复）。图片节点维持首版边界：AI 快照只读可见、不创建/不修改。
> 七十五轮评审修订（2026-09-04）：§13 作业生命周期补「宿主节点删除」维度——running 作业的宿主图片节点被删即协作式取消（Rust 未过检查点即放弃）并清作业表；`runStart` 在设置加载返回后、提交生成前复核宿主仍在，不为已删节点发起计费请求；删除可撤销，undo 复活节点后作业已清、需重新生成。
> 七十六轮评审修订（2026-09-04）：§13 旧产物回收的索引查找改自有属性检查（`hasOwnProperty`）——悬空 `primary.assetId` 按 §8.2.3 保留，其值可能是 `__proto__`/`constructor` 等原型链键名，普通对象桶的继承值不得被当成 AssetRef 回收（误回收会在 undo 注入畸形条目阻塞保存）；与图片节点渲染侧的按 id 解析同口径。
> 七十七轮评审修订（2026-09-04）：§13 三处收口——① `runStart` 在设置加载返回后先过 `jobAlive` 身份复核再写状态/提交：被取消作业的迟到分支不得覆盖接替作业的 running（否则接替作业的已付费结果被误判丢弃），`clearJob` 改同步镜像清理（同一事件循环内「取消→重启」不被 running 守卫误挡）；② `llm_image_generate` 响应体流式限读（主响应 64 MiB 文本上限、url 回退 32 MiB 字节上限，超限即中止不落半截）——大小上限在物化前生效，恶意/异常 provider 的超大响应不再能耗尽内存；③ 删除图片节点时其产物若不再被幸存节点/角色头像引用则随同一删除命令移出索引（`doomedImageAssets` 判定与重新生成回收同口径，undo 恢复）。
> 七十八轮评审修订（2026-09-04）：§13 图片节点工厂的默认尺寸对齐声明契约——`1024x1536` 竖版短剧画幅（`IMAGE_SIZES` 的默认推荐档），此前工厂误发 `1024x1024` 方图，用户不动尺寸直接生成会产出付费方图；§10.5 `llm_image_generate` 命令行同步第七十三轮后的实现事实（§9.3 预检在命令内、前端单次 IPC、响应体流式限读），消除与 §13 正文的矛盾。
> 七十九轮评审修订（2026-09-04）：§8.2 设置页关闭语义收口——「完成」按钮 await 冲刷（清防抖 + 落盘未保存快照）完成后再回调 onClose，界面切换不早于落盘（编辑器重挂读到的必是已落盘设置）；卸载路径保留 fire-and-forget 兜底冲刷（非常规关闭不丢编辑）。产物媒体失败态补 `<img>` onError——URL 解析成功但浏览器解码失败（如过魔数检查的截断 PNG）同样转入「产物媒体无法读取」占位。
> 八十轮评审修订（2026-09-04）：§8.2 关闭语义再收口——关闭冲刷在 await 未保存快照之外**同时 await 在途的 save promise**（防抖已触发、IPC 未返回的窗口同样不得早切换/丢编辑）；冲刷失败时保留快照、页面保持打开并显示可重试错误（不再静默关页丢编辑）。实现拆分：设置页「编辑即保存」状态族抽为 `useSettingsSaver`，节点删除（连线 + 产物回收复合命令）抽为 `useNodeDeletion`——两处宿主组件回到函数祖父基线内。
> 八十一轮评审修订（2026-09-04）：三处收口——① §8.2 在途 save 迟到失败只在无更新快照时回填（不覆盖用户随后的新编辑），关闭冲刷对在途 save 的迟到失败不阻断（其快照已按序回填，由 pending 落盘统一收口）；② §9.3 资产目录创建改「总是尝试 + 容忍 AlreadyExists + 归类校验兜底」——并发首次落盘的 create_dir 竞态不再丢弃已付费结果；③ §12/§13 AI `delete_node` 对图片节点整批拒绝（与 create/update 同口径：批量模拟删除路径不走 deleteNodesByIds、会绕过产物回收留下永久索引的不可达资产）。
> 八十二轮修订（2026-09-16，[issue #140](https://github.com/hailingu/PlotWeave/issues/140)）：§12 AI 入站命令的**列表成员**执行成员级自有键白名单（`lines` 行成员 id/kind/text/speaker/side/vo、`options` 对象成员 id/label、`refs` 引用位成员 id/kind/assetId/label、`relatedIds` 成员 kind/id）——与各 itemObject schema 的 `additionalProperties: false` 同口径（此前协议已声明、校验器只查已知字段形状，未知自有键随成员 spread 进文档）；违反按下标与键名点名、整批零变更。此收紧只作用于 AI 入站通道；加载归一化的成员级政策（未知字段随成员原样保留，前向兼容保真）不变——两层按「入站从严、落盘保真」区分。
> 八十三轮修订（2026-09-19，[issue #148](https://github.com/hailingu/PlotWeave/issues/148)）：§10.2 补崩溃遗留随机临时文件的顺带清扫策略——归属可辨（`.{目标名}.{id}.tmp` 命名协议；id 段按 PR #217 评审收紧为生成器唯一产出形状 `p-<小写十六进制>-<小写十六进制>`，目标名按第二轮评审收紧为各目录原子写目标白名单）+ 超龄且不活动（24h 宽限期，且清扫与本目录原子写经进程内操作锁串行——第三轮评审补挂起恢复/时钟前跳窗口；库侧由既有库操作锁覆盖）+ no-follow 归类为普通文件三条件同时成立才移除，随 `list_projects`/`list_library_assets` 执行且 fail-soft 不阻断列表；遗留临时文件只删除不读取，不充当恢复副本。`projects/{id}/` 会话目录、`projects/{id}/assets/`、应用根设置临时文件与跨进程并发实例不在本轮范围，按记录边界留待后续。
> 八十四轮修订（2026-09-19，[issue #149](https://github.com/hailingu/PlotWeave/issues/149)）：§10.4 补失败诊断的脱敏边界——凡经 `Display` 到达前端的 reqwest 错误一律把本次请求 URL 替换为脱敏形态（query/userinfo/fragment 剥离，路径与错误类别保留）；状态错误摘录先把本次 API key 替换为 `***`、请求 URL 替换为脱敏形态，再截断 200 字符。精确子串替换不覆盖 URL 的其它拼写形态与 key 局部片段，按记录边界。
> 八十五轮修订（2026-09-19，[issue #145](https://github.com/hailingu/PlotWeave/issues/145)）：共享 Mutex 的中毒后行为统一为**可验证恢复**——库操作锁（§7.2）与 projects 操作锁（§10.2）不守卫内存状态、磁盘一致性分别由日志可恢复提交协议与原子写协议独立保证；项目媒体登记表、生成取消表与媒体读取闸门（§13/§10.5）是纯内存建议性状态，单项 infallible 操作不留结构损坏。全部锁站点经统一内核恢复并留结构化诊断，不传播 panic、不静默忽略；取消登记真实生效才报成功。规范条目见 docs/development/rust-standard.md。
> 八十六轮修订（2026-09-19，[issue #141](https://github.com/hailingu/PlotWeave/issues/141)）：§10.5 `llm_image_generate` 补作业总时间预算 600s（自命令进入起算）——provider 凭据读取（阻塞线程池）、生成 POST（含响应体读取）与 url 回退下载链的逐跳 DNS 解析、请求、响应体读取的等待上界均为作业剩余预算，预算耗尽按阶段（读取凭据/生成请求/解析图像主机/下载图像/读取图像）给出诊断并放弃，不发出可能计费的请求、产物不写回；逐跳 120s 与生成 POST 300s 客户端上限保留为单阶段兜底。阻塞任务（凭据读取、DNS 解析）无法取消，超时只是放弃等待，任务返回后结果被丢弃、不持锁；其中 DNS 解析被隔离在严格并发上限（2）的专用线程边界内，不占用 Tokio 阻塞池、不遗留无限后台任务，额度随解析线程返回归还（可恢复）。
> 八十七轮修订（2026-09-19，[issue #143](https://github.com/hailingu/PlotWeave/issues/143)）：§10.5 `llm_image_cancel` 的取消状态改为应用托管的有界注册表（Tauri managed state）——活动作业入口登记、RAII 守卫全出口清理（根治错误路径遗留标记）；未知/已结束 id 的取消进 64 容量 FIFO 墓碑（去重、不无界增长），登记时消费使预取消语义生效。复用墓碑窗口内的 id 按预取消语义继承取消（前端 uid 唯一发号，正常路径不触发），按记录边界。
> 九十一轮修订（2026-09-19，[issue #229](https://github.com/hailingu/PlotWeave/issues/229)）：前端程序判定不再依赖中文 IPC 文案——① §10.5 `load_project` 的「项目不存在」出口在文案前携带稳定机器码前缀 `[project_not_found] `（与 issue #144 保留的 `Result<_, String>` 出口契约兼容），空库播种按码分支；其余类别不带码，无码/未知错误一律保守视为「存在但不可读」，绝不以示例覆盖；码不上屏，前端展示层（issue #98 横幅）剥离前缀。② §7.2 `cleanupPending` 条目由字符串改为结构化 `{ kind, message }`：`kind` 为机器可读分类（`routine` = 索引已提交的待释放项，可附 .trash 清理指引；`evidence` = 冲突/待核对的证据保留项，绝不附删除指引），由后端生产点给出；前端按 kind 分区呈现，不经文案推导——展示措辞/本地化调整不改变分类；未知/缺失 kind 与裸字符串（旧形态/脏数据）fail-safe 归证据类，缺/空 message 的条目丢弃。八十八轮「未识别形态归证据类」的 fail-safe 方向不变，识别依据由文案前缀改为 kind 字段。
> 九十轮修订（2026-09-20，[issue #142](https://github.com/hailingu/PlotWeave/issues/142)）：图库缩略图读取失败建立局部状态与显式重试——`useLibraryAssetList.refreshUrl` 不再静默吞错（按资产记录失败文案），`AssetThumb` 失败态显示「⚠ 重试」占位并支持点击重试（成功后清除错误显示图像）；观察器回调稳定化（useCallback）+ 按资产在途去重，普通父渲染不反复重建观察器/重发请求，失败态不观察（重试走显式入口）。详见 ui-design §8.1 媒体访问条目。
> 八十九轮修订（2026-09-20，[issue #159](https://github.com/hailingu/PlotWeave/issues/159)）：§10.2 退出屏障的初始化失败边界补齐——useExitFlush 的动态模块加载、close/quit 监听注册与 acknowledge_quit_listener 任一失败不再产生未处理拒绝；部分完成的屏障**保留至组件卸载**（PR #225 评审修订：回收已就绪的 close 屏障会让用户按指引点关闭时绕过冲刷直关窗口、丢失未落盘编辑——effect cleanup 统一回收），失败转为可见诊断（横幅明示阶段与指引：重试退出或重启），已缓冲的退出请求不静默丢弃。issue #65 的启动间隙缓冲语义不变。
> 八十八轮修订（2026-09-19，[issue #135](https://github.com/hailingu/PlotWeave/issues/135)）：§7.2 `cleanupPending` 的呈现由仅控制台改为经既有恢复诊断通道对用户可见（ui-design §8.1 异常反馈）——按快照显示待清理计数、影响（磁盘空间未释放，不误报为已回收）与恢复指引；内容随列表/导入/更新/删除/组命令返回整体替换，空状态不显示。呈现按语义分两类（PR #222 评审修订）：索引已提交的待释放项附清理指引；冲突/待核对类（身份异常/不符/被占用、`indexUncertain`）仅提示保留现场、不附删除指引（分类 fail-safe，未识别形态归入此类）。身份校验、fail-closed 与按日志恢复的既有行为不变，不新增自动物理删除。
