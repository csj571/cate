// =============================================================================
// LocalProviderManager — local model serving for the embedded pi agent.
//
// Cate can talk to models running entirely on the user's machine: Ollama,
// LM Studio, vLLM, llama.cpp, LiteLLM — anything exposing an OpenAI-compatible
// /v1. pi discovers custom models from a models.json in its agent dir
// (PI_CODING_AGENT_DIR/models.json). We don't make the user hand-write that
// file: we probe each configured server, enumerate the models it's serving,
// and generate models.json so those models show up in the picker like any
// cloud provider.
//
// Probing happens off the agent-spawn path. We keep the last-built models.json
// (and probe statuses) cached on disk; create() writes the cached file into the
// workspace synchronously, and an explicit refresh() re-probes and pushes fresh
// models into live workspaces. That keeps agent startup network-free.
//
// The config and cache are global (a local server isn't project-specific),
// living next to the shared auth.json under userData.
// =============================================================================

import fsp from 'fs/promises'
import path from 'path'
import log from '../../main/logger'
import { localProvidersConfigPath, workspaceModelsPath } from './agentDir'
import type {
  LocalDiscoveredModel,
  LocalProviderConfig,
  LocalProviderStatus,
} from '../../shared/types'

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit tests)
// ---------------------------------------------------------------------------

/** Strip a trailing `/v1` and any trailing slashes so callers can append the
 *  endpoint they need. Accepts either `http://host:port` or
 *  `http://host:port/v1` — both normalise to the bare root. */
export function normalizeBaseUrl(raw: string): string {
  let url = raw.trim().replace(/\/+$/, '')
  if (/\/v1$/i.test(url)) url = url.slice(0, -3).replace(/\/+$/, '')
  return url
}

/** The OpenAI-compatible chat base pi should call. */
export function chatBaseUrl(root: string): string {
  return `${normalizeBaseUrl(root)}/v1`
}

/** Parse Ollama's `GET /api/tags` payload into discovered models. */
export function parseOllamaTags(payload: unknown): LocalDiscoveredModel[] {
  const models = (payload as { models?: unknown })?.models
  if (!Array.isArray(models)) return []
  const out: LocalDiscoveredModel[] = []
  for (const m of models) {
    const name = (m as { name?: unknown; model?: unknown })?.name ?? (m as { model?: unknown })?.model
    if (typeof name !== 'string' || !name) continue
    const ctx = (m as { details?: { context_length?: unknown } })?.details?.context_length
    out.push({
      id: name,
      name,
      contextWindow: typeof ctx === 'number' ? ctx : undefined,
    })
  }
  return out
}

/** Parse an OpenAI-compatible `GET /v1/models` payload (LM Studio, vLLM, …). */
export function parseOpenAiModels(payload: unknown): LocalDiscoveredModel[] {
  const data = (payload as { data?: unknown })?.data
  if (!Array.isArray(data)) return []
  const out: LocalDiscoveredModel[] = []
  for (const m of data) {
    const id = (m as { id?: unknown })?.id
    if (typeof id !== 'string' || !id) continue
    out.push({ id, name: id })
  }
  return out
}

/** Default context window when a server doesn't advertise one. Conservative so
 *  pi never over-feeds a small local model. */
const DEFAULT_CONTEXT_WINDOW = 8192
const DEFAULT_MAX_TOKENS = 4096

/** Shape of one provider entry in pi's models.json. */
interface PiModelsJsonProvider {
  baseUrl: string
  api: 'openai-completions'
  apiKey: string
  compat: { supportsDeveloperRole: boolean; supportsReasoningEffort: boolean }
  models: Array<{
    id: string
    name: string
    reasoning: boolean
    input: string[]
    contextWindow: number
    maxTokens: number
    cost: { input: number; output: number; cacheRead: number; cacheWrite: number }
  }>
}

export interface PiModelsJson {
  providers: Record<string, PiModelsJsonProvider>
}

/** Build pi's models.json from probe statuses. Providers that are unreachable
 *  or serving no models are omitted so pi never sees an empty provider. */
export function buildModelsJson(
  configs: LocalProviderConfig[],
  statuses: Map<string, LocalProviderStatus>,
): PiModelsJson {
  const providers: Record<string, PiModelsJsonProvider> = {}
  for (const cfg of configs) {
    if (!cfg.enabled) continue
    const status = statuses.get(cfg.id)
    if (!status || !status.reachable || status.models.length === 0) continue
    providers[cfg.id] = {
      baseUrl: chatBaseUrl(cfg.baseUrl),
      api: 'openai-completions',
      // Local servers ignore the key but pi's openai-completions transport
      // still wants a non-empty string.
      apiKey: 'local',
      compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
      models: status.models.map((m) => ({
        id: m.id,
        name: m.name ?? m.id,
        reasoning: false,
        input: ['text'],
        contextWindow: m.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
        maxTokens: DEFAULT_MAX_TOKENS,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      })),
    }
  }
  return { providers }
}

// ---------------------------------------------------------------------------
// Built-in defaults
// ---------------------------------------------------------------------------

const DEFAULT_PROVIDERS: LocalProviderConfig[] = [
  { id: 'ollama', name: 'Ollama', kind: 'ollama', baseUrl: 'http://localhost:11434', enabled: true, builtin: true },
  { id: 'lmstudio', name: 'LM Studio', kind: 'openai', baseUrl: 'http://localhost:1234', enabled: true, builtin: true },
]

/** Merge persisted overrides onto the built-in defaults, preserving order and
 *  appending any user-added custom providers. */
function mergeWithDefaults(saved: LocalProviderConfig[]): LocalProviderConfig[] {
  const byId = new Map(saved.map((p) => [p.id, p]))
  const out: LocalProviderConfig[] = []
  for (const def of DEFAULT_PROVIDERS) {
    const override = byId.get(def.id)
    out.push(override ? { ...def, ...override, builtin: true } : { ...def })
    byId.delete(def.id)
  }
  for (const custom of saved) {
    if (byId.has(custom.id)) out.push({ ...custom, builtin: false })
  }
  return out
}

// ---------------------------------------------------------------------------
// Probe
// ---------------------------------------------------------------------------

const PROBE_TIMEOUT_MS = 2500

async function fetchJson(url: string, timeoutMs = PROBE_TIMEOUT_MS): Promise<unknown> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, { signal: controller.signal })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return await res.json()
  } finally {
    clearTimeout(timer)
  }
}

/** Probe a single provider: hit its discovery endpoint and enumerate models. */
export async function probeProvider(cfg: LocalProviderConfig): Promise<LocalProviderStatus> {
  const root = normalizeBaseUrl(cfg.baseUrl)
  try {
    if (cfg.kind === 'ollama') {
      const payload = await fetchJson(`${root}/api/tags`)
      return { id: cfg.id, reachable: true, models: parseOllamaTags(payload) }
    }
    const payload = await fetchJson(`${root}/v1/models`)
    return { id: cfg.id, reachable: true, models: parseOpenAiModels(payload) }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    // Connection refused just means the server isn't running — not an error
    // worth logging loudly, but we surface it to the UI.
    return { id: cfg.id, reachable: false, models: [], error: message }
  }
}

// ---------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------

export class LocalProviderManager {
  private statuses = new Map<string, LocalProviderStatus>()
  private cachedModelsJson: PiModelsJson = { providers: {} }
  private loaded = false

  /** Fired after a refresh so AgentManager can push fresh models into live
   *  workspaces. */
  private onChange: (() => void) | null = null
  setOnChange(fn: () => void): void { this.onChange = fn }

  private async readConfig(): Promise<LocalProviderConfig[]> {
    try {
      const raw = await fsp.readFile(localProvidersConfigPath(), 'utf-8')
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) return mergeWithDefaults(parsed as LocalProviderConfig[])
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
        log.warn('[localProviders] failed to read config: %O', err)
      }
    }
    return mergeWithDefaults([])
  }

  private async writeConfig(configs: LocalProviderConfig[]): Promise<void> {
    const p = localProvidersConfigPath()
    await fsp.mkdir(path.dirname(p), { recursive: true })
    await fsp.writeFile(p, JSON.stringify(configs, null, 2), 'utf-8')
  }

  /** Current provider config (defaults merged with saved overrides). */
  async list(): Promise<LocalProviderConfig[]> {
    return this.readConfig()
  }

  /** Last known probe statuses (does not re-probe). */
  getStatuses(): LocalProviderStatus[] {
    return Array.from(this.statuses.values())
  }

  /** Upsert a provider (add a custom one or edit a built-in's url/enabled). */
  async save(config: LocalProviderConfig): Promise<void> {
    const configs = await this.readConfig()
    const idx = configs.findIndex((p) => p.id === config.id)
    if (idx >= 0) configs[idx] = { ...configs[idx], ...config }
    else configs.push({ ...config, builtin: false })
    await this.writeConfig(configs)
  }

  /** Remove a custom provider. Built-ins can be disabled but never removed. */
  async remove(id: string): Promise<void> {
    const configs = await this.readConfig()
    const target = configs.find((p) => p.id === id)
    if (!target || target.builtin) return
    await this.writeConfig(configs.filter((p) => p.id !== id))
    this.statuses.delete(id)
  }

  /** Probe every enabled provider, rebuild the cached models.json, and notify
   *  listeners so live workspaces can be refreshed. Returns the statuses. */
  async refresh(): Promise<LocalProviderStatus[]> {
    const configs = await this.readConfig()
    const enabled = configs.filter((p) => p.enabled)
    const results = await Promise.all(enabled.map((p) => probeProvider(p)))
    this.statuses = new Map(results.map((s) => [s.id, s]))
    this.cachedModelsJson = buildModelsJson(configs, this.statuses)
    this.loaded = true
    try { this.onChange?.() } catch (err) { log.warn('[localProviders] onChange failed: %O', err) }
    return results
  }

  /** Write the cached models.json into a workspace's agent dir so the pi
   *  process there exposes local models. Network-free; safe on the spawn path.
   *  Lazily runs a first refresh if we've never probed. */
  async writeModelsJson(cwd: string): Promise<void> {
    if (!this.loaded) {
      // First spawn of the session — probe once so the file isn't empty. This
      // is the one place a spawn may wait on localhost probes (tightly capped).
      try { await this.refresh() } catch (err) { log.warn('[localProviders] initial refresh failed: %O', err) }
    }
    const p = workspaceModelsPath(cwd)
    try {
      await fsp.mkdir(path.dirname(p), { recursive: true })
      await fsp.writeFile(p, JSON.stringify(this.cachedModelsJson, null, 2), 'utf-8')
    } catch (err) {
      log.warn('[localProviders] failed to write models.json for %s: %O', cwd, err)
    }
  }
}

// Single shared instance — one main process per app.
export const localProviderManager = new LocalProviderManager()
