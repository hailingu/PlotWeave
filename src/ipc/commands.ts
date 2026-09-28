/**
 * Tauri IPC 命令名的单一事实源（前端侧，issue #394）：此前命令名以字符串
 * 字面量在 Rust `generate_handler!`（src-tauri/src/lib.rs）与前端各调用点
 * 两侧各自硬编码，重命名/下线命令在前端无编译期或静态检查信号，故障只在
 * 运行期暴露。本表把前端侧的命令名收敛为一处定义：
 *
 * - 键 = 命令名的 camelCase 引用名，按 Rust 注册模块分组；值 =
 *   `generate_handler!` 注册的命令名字符串，一一对应。
 * - 全部前端 invoke 系调用点一律引用 `IPC_COMMANDS.<key>`（具名导入，
 *   不走命名空间两级访问）；命令名字符串字面量只允许出现在本表与
 *   `generate_handler!` 两侧。
 * - 守卫见 commands.test.ts：常量集与注册集双向一致（不漏不多）、调用点
 *   禁用字面量、每个常量都有前端消费者。值变更等同契约变更（Rust 侧须
 *   同步），本表只做等值替换、不改任何命令名。
 * - 本模块是纯数据叶子：不导入任何 Tauri / 框架模块，静态导入不破坏
 *   浏览器预览（预览路径仍由各调用点的动态 `import('@tauri-apps/api/core')`
 *   守门）。命令语义契约见 docs/data-model/ 各主题（持久化 §10、资产
 *   §7、设置 §8.2、AI §12 等）。
 */
export const IPC_COMMANDS = {
  // ── store：项目与 AI 会话持久化（docs/data-model/persistence.md）──
  listProjects: 'list_projects',
  createProject: 'create_project',
  loadProject: 'load_project',
  loadAiSession: 'load_ai_session',
  saveProject: 'save_project',
  saveAiSession: 'save_ai_session',
  deleteProject: 'delete_project',
  copyProjectAssets: 'copy_project_assets',
  verifyProjectAssets: 'verify_project_assets',
  // ── prefs：应用设置与 provider 密钥（docs/data-model/provider-settings.md）──
  loadPrefs: 'load_prefs',
  savePrefs: 'save_prefs',
  setProviderKey: 'set_provider_key',
  llmChat: 'llm_chat',
  // ── library：个人资产库与编组（docs/data-model/assets.md §7.2）──
  listLibraryAssets: 'list_library_assets',
  importLibraryAsset: 'import_library_asset',
  updateLibraryAsset: 'update_library_asset',
  deleteLibraryAsset: 'delete_library_asset',
  upsertLibraryGroup: 'upsert_library_group',
  deleteLibraryGroup: 'delete_library_group',
  // ── media_protocol：pwmedia opaque URL（docs/data-model/assets.md §7.1）──
  getAssetMediaUrl: 'get_asset_media_url',
  // ── assets：项目资产管线（docs/data-model/assets.md §7.3/§9.3）──
  importProjectAssetFromLibrary: 'import_project_asset_from_library',
  validateProjectAsset: 'validate_project_asset',
  registerProjectAssetAlias: 'register_project_asset_alias',
  // ── imagegen：画布内 AI 图像生成（docs/data-model/ai-integration.md §13）──
  llmImageGenerate: 'llm_image_generate',
  llmImageCancel: 'llm_image_cancel',
  // ── lib.rs：退出冲刷屏障（issue #65）──
  appExit: 'app_exit',
  acknowledgeQuitListener: 'acknowledge_quit_listener',
} as const
