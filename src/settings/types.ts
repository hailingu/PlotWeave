/**
 * 应用设置模型（docs/ui-design.md §8.2 修订）。
 * - Provider 分段：内置适配器（OpenAI 兼容 / 火山引擎 Ark）+ 自定义；
 *   每 provider 配 Base URL、启用开关、模型清单与默认模型。
 * - API key 不入钥匙串：Rust `set_provider_key` 加密（AES-256-GCM 绑定
 *   本机）后返回密文 envelope，存于 provider 的 `keyEnc`，随设置落盘；
 *   解密只在 Rust 发起 LLM 请求时进行，明文不回前端。
 * - 三层过滤（内置目录 → provider 已配置 → 未禁用）在 normalize 中计算，
 *   供默认模型下拉与 AI 面板共用。
 */

/** 单个 provider 的配置（keyEnc 为加密 envelope，不含明文）。 */
export interface ProviderConfig {
  id: string
  label: string
  /** OpenAI 兼容 Base URL（不含 /chat/completions）。 */
  baseUrl: string
  enabled: boolean
  /** 该 provider 下可选的模型 id 列表（用户维护）。 */
  models: string[]
  /** API key 密文（`pw1:` envelope；缺省 = 未配置）。 */
  keyEnc?: string
}

/** 应用设置（settings.json 结构）。 */
export interface AppSettings {
  providers: ProviderConfig[]
  /** 默认对话模型："providerId:modelId"。 */
  defaultChat: string | null
}

/** 内置 provider 目录（§8.2：内置适配器列表）。 */
export const BUILTIN_PROVIDERS: ProviderConfig[] = [
  {
    id: 'openai',
    label: 'OpenAI 兼容',
    baseUrl: 'https://api.openai.com/v1',
    enabled: true,
    models: ['gpt-4o-mini', 'gpt-4o'],
  },
  {
    id: 'volcengine-ark',
    label: '火山引擎 Ark',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    enabled: true,
    models: [],
  },
]

/** 兜底：无任何配置时的默认设置。 */
export function defaultSettings(): AppSettings {
  return {
    providers: BUILTIN_PROVIDERS.map((p) => ({ ...p, models: [...p.models] })),
    defaultChat: null,
  }
}

/** 旧文件/缺失字段合并为完整设置；内置 provider 缺席时补回。
 * keyEnc 随 provider 配置透传（非字符串/空串丢弃）。 */
export function normalizeSettings(raw: unknown): AppSettings {
  const obj = (typeof raw === 'object' && raw !== null ? raw : {}) as Partial<AppSettings>
  const stored = Array.isArray(obj.providers) ? obj.providers : []
  const keyEncOf = (found: unknown): string | undefined => {
    const v = (found as { keyEnc?: unknown } | null)?.keyEnc
    return typeof v === 'string' && v.startsWith('pw1:') ? v : undefined
  }
  const providers = BUILTIN_PROVIDERS.map((builtin) => {
    const found = stored.find((p) => p?.id === builtin.id)
    if (!found) return { ...builtin, models: [...builtin.models] }
    return {
      ...builtin,
      baseUrl: typeof found.baseUrl === 'string' && found.baseUrl ? found.baseUrl : builtin.baseUrl,
      enabled: found.enabled !== false,
      models: Array.isArray(found.models) ? found.models.filter((m) => typeof m === 'string') : [],
      keyEnc: keyEncOf(found),
    }
  })
  // 自定义 provider（内置之外）
  for (const p of stored) {
    if (p && typeof p.id === 'string' && !BUILTIN_PROVIDERS.some((b) => b.id === p.id)) {
      providers.push({
        id: p.id,
        label: typeof p.label === 'string' && p.label ? p.label : p.id,
        baseUrl: typeof p.baseUrl === 'string' ? p.baseUrl : '',
        enabled: p.enabled !== false,
        models: Array.isArray(p.models) ? p.models.filter((m) => typeof m === 'string') : [],
        keyEnc: keyEncOf(p),
      })
    }
  }
  return {
    providers,
    defaultChat: typeof obj.defaultChat === 'string' ? obj.defaultChat : null,
  }
}

/** 解析默认对话模型 "providerId:modelId"；无效或未配置返回 null。 */
export function resolveChatModel(settings: AppSettings): {
  provider: ProviderConfig
  model: string
} | null {
  if (!settings.defaultChat) return null
  const sep = settings.defaultChat.indexOf(':')
  if (sep <= 0) return null
  const providerId = settings.defaultChat.slice(0, sep)
  const model = settings.defaultChat.slice(sep + 1)
  const provider = settings.providers.find((p) => p.id === providerId)
  if (!provider || !provider.enabled || !provider.baseUrl || !provider.models.includes(model)) {
    return null
  }
  return { provider, model }
}

/** 可用对话模型条目（AI 面板选择器用，§6）。 */
export interface ChatModelOption {
  /** "providerId:modelId"，与 defaultChat 同构。 */
  key: string
  providerId: string
  providerLabel: string
  model: string
}

/**
 * 三层过滤的可用模型枚举（§6 模型选择器）：模型在 provider 清单中 →
 * provider 启用且 Base URL 就绪；第三层（API key 已配置）依赖钥匙串
 * 异步查询，由调用方按 providerId 叠加置灰。
 */
export function listChatModels(settings: AppSettings): ChatModelOption[] {
  const out: ChatModelOption[] = []
  for (const p of settings.providers) {
    if (!p.enabled || !p.baseUrl) continue
    for (const m of p.models) {
      out.push({ key: `${p.id}:${m}`, providerId: p.id, providerLabel: p.label, model: m })
    }
  }
  return out
}
