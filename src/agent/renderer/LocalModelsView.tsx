// =============================================================================
// LocalModelsView — manage locally-served models (Ollama, LM Studio, and any
// OpenAI-compatible endpoint). Probes each server, shows what it's serving, and
// lets the user toggle / point / add providers. Saving + refreshing regenerates
// pi's models.json so these models appear in the picker alongside cloud ones.
// =============================================================================

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  ArrowsClockwise,
  CheckCircle,
  CircleDashed,
  Plus,
  Trash,
  CaretRight,
  CaretDown,
  HardDrives,
  Warning,
} from '@phosphor-icons/react'
import log from '../../renderer/lib/logger'
import type {
  LocalProviderConfig,
  LocalProviderKind,
  LocalProviderStatus,
} from '../../shared/types'

export function LocalModelsView() {
  const [config, setConfig] = useState<LocalProviderConfig[]>([])
  const [statuses, setStatuses] = useState<Record<string, LocalProviderStatus>>({})
  const [refreshing, setRefreshing] = useState(false)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)

  const indexStatuses = useCallback((list: LocalProviderStatus[]) => {
    const map: Record<string, LocalProviderStatus> = {}
    for (const s of list) map[s.id] = s
    setStatuses(map)
  }, [])

  const load = useCallback(async () => {
    try {
      const { config: cfg, statuses: st } = await window.electronAPI.localProvidersList()
      setConfig(cfg)
      indexStatuses(st)
    } catch (err) {
      log.warn('[LocalModelsView] list failed', err)
    }
  }, [indexStatuses])

  const refresh = useCallback(async () => {
    setRefreshing(true)
    try {
      const st = await window.electronAPI.localProvidersRefresh()
      indexStatuses(st)
    } catch (err) {
      log.warn('[LocalModelsView] refresh failed', err)
    } finally {
      setRefreshing(false)
    }
  }, [indexStatuses])

  // Load config first, then probe once so the user sees live status on open.
  useEffect(() => {
    void (async () => {
      await load()
      await refresh()
    })()
  }, [load, refresh])

  const handleSave = useCallback(async (next: LocalProviderConfig) => {
    setConfig((prev) => prev.map((p) => (p.id === next.id ? next : p)))
    try {
      await window.electronAPI.localProvidersSave(next)
      await refresh()
    } catch (err) {
      log.warn('[LocalModelsView] save failed', err)
      await load()
    }
  }, [refresh, load])

  const handleRemove = useCallback(async (id: string) => {
    if (!window.confirm('Remove this local provider?')) return
    try {
      await window.electronAPI.localProvidersRemove(id)
      await load()
      await refresh()
    } catch (err) {
      log.warn('[LocalModelsView] remove failed', err)
    }
  }, [load, refresh])

  const handleAdd = useCallback(async (next: LocalProviderConfig) => {
    try {
      await window.electronAPI.localProvidersSave(next)
      setAdding(false)
      await load()
      await refresh()
    } catch (err) {
      log.warn('[LocalModelsView] add failed', err)
    }
  }, [load, refresh])

  const totalModels = useMemo(
    () => Object.values(statuses).reduce((n, s) => n + (s.reachable ? s.models.length : 0), 0),
    [statuses],
  )

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="text-[11px] text-muted">
          {totalModels > 0
            ? `${totalModels} local model${totalModels === 1 ? '' : 's'} available`
            : 'Run a model locally and it shows up here.'}
        </div>
        <button
          onClick={refresh}
          disabled={refreshing}
          className="flex items-center gap-1 px-2 py-1 rounded-md text-muted hover:text-primary hover:bg-white/5 disabled:opacity-50 text-[11px]"
          title="Re-scan local servers"
        >
          <ArrowsClockwise size={12} className={refreshing ? 'animate-spin' : ''} />
          {refreshing ? 'Scanning…' : 'Rescan'}
        </button>
      </div>

      <div className="rounded-lg border border-white/5 bg-white/[0.02] overflow-hidden">
        {config.map((p) => (
          <ProviderRow
            key={p.id}
            config={p}
            status={statuses[p.id]}
            expanded={expanded === p.id}
            onToggleExpand={() => setExpanded((e) => (e === p.id ? null : p.id))}
            onSave={handleSave}
            onRemove={handleRemove}
          />
        ))}
      </div>

      {adding ? (
        <AddProviderForm onAdd={handleAdd} onCancel={() => setAdding(false)} existingIds={config.map((p) => p.id)} />
      ) : (
        <button
          onClick={() => setAdding(true)}
          className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md bg-white/5 hover:bg-white/10 text-primary text-[12px]"
        >
          <Plus size={12} /> Add OpenAI-compatible endpoint
        </button>
      )}

      <p className="text-[11px] text-muted/80 leading-relaxed">
        Pull models with <code className="text-agent-light">ollama pull llama3.1</code> or load one in
        LM Studio, then Rescan. Can&apos;t find a model locally? Connect{' '}
        <span className="text-primary">HuggingFace</span> under Providers to run it from the Hub.
      </p>
    </div>
  )
}

// -----------------------------------------------------------------------------
// Provider row
// -----------------------------------------------------------------------------

function ProviderRow({
  config,
  status,
  expanded,
  onToggleExpand,
  onSave,
  onRemove,
}: {
  config: LocalProviderConfig
  status?: LocalProviderStatus
  expanded: boolean
  onToggleExpand: () => void
  onSave: (next: LocalProviderConfig) => void
  onRemove: (id: string) => void
}) {
  const [url, setUrl] = useState(config.baseUrl)
  useEffect(() => { setUrl(config.baseUrl) }, [config.baseUrl])

  const reachable = status?.reachable === true
  const modelCount = reachable ? status?.models.length ?? 0 : 0

  return (
    <div className="border-b border-white/5 last:border-0">
      <div className="flex items-center gap-2 px-2.5 py-2">
        <button onClick={onToggleExpand} className="text-muted/60 hover:text-primary" aria-expanded={expanded}>
          {expanded ? <CaretDown size={10} /> : <CaretRight size={10} />}
        </button>
        <HardDrives size={13} className="text-agent-light/80 shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-[12.5px] text-primary truncate">{config.name}</span>
            {!config.builtin && (
              <span className="px-1.5 py-[1px] rounded text-[9px] uppercase tracking-wider text-muted bg-white/5">Custom</span>
            )}
          </div>
          <div className="text-[10.5px] text-muted/80 font-mono truncate">{config.baseUrl}</div>
        </div>
        <StatusPill enabled={config.enabled} status={status} modelCount={modelCount} />
        <Toggle
          on={config.enabled}
          onChange={(on) => onSave({ ...config, enabled: on })}
        />
      </div>

      {expanded && (
        <div className="px-3 pb-3 pt-1 space-y-2 bg-black/10 border-t border-white/5">
          <label className="block text-[10px] uppercase tracking-wider text-muted/70">Base URL</label>
          <div className="flex items-center gap-2">
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') onSave({ ...config, baseUrl: url.trim() }) }}
              spellCheck={false}
              className="flex-1 bg-surface-3 border border-white/10 rounded-md px-2 py-1.5 text-[12px] text-primary outline-none focus:border-agent/60 font-mono"
            />
            <button
              onClick={() => onSave({ ...config, baseUrl: url.trim() })}
              disabled={url.trim() === config.baseUrl || !url.trim()}
              className="shrink-0 px-2.5 py-1.5 rounded-md bg-agent hover:bg-agent-light disabled:opacity-40 text-white text-[12px]"
            >
              Save
            </button>
          </div>

          {status && !status.reachable && (
            <div className="flex items-start gap-1.5 text-[11px] text-amber-300/90">
              <Warning size={12} className="mt-[1px] shrink-0" />
              <span>Not reachable{status.error ? ` (${status.error})` : ''}. Is the server running?</span>
            </div>
          )}

          {reachable && modelCount > 0 && (
            <div className="space-y-1">
              <div className="text-[10px] uppercase tracking-wider text-muted/70">Serving</div>
              <div className="flex flex-wrap gap-1">
                {status!.models.map((m) => (
                  <span key={m.id} className="px-1.5 py-[2px] rounded text-[11px] font-mono text-primary bg-white/5">
                    {m.name ?? m.id}
                  </span>
                ))}
              </div>
            </div>
          )}

          {reachable && modelCount === 0 && (
            <div className="text-[11px] text-muted">Server reachable, but no models loaded yet.</div>
          )}

          {!config.builtin && (
            <button
              onClick={() => onRemove(config.id)}
              className="flex items-center gap-1 text-[11px] text-muted hover:text-rose-200"
            >
              <Trash size={11} /> Remove provider
            </button>
          )}
        </div>
      )}
    </div>
  )
}

function StatusPill({
  enabled,
  status,
  modelCount,
}: {
  enabled: boolean
  status?: LocalProviderStatus
  modelCount: number
}) {
  if (!enabled) return <span className="text-[10px] text-muted/60">Off</span>
  if (!status) return <CircleDashed size={11} className="text-muted/50 animate-pulse" />
  if (status.reachable) {
    return (
      <span className="inline-flex items-center gap-1 text-[10px] text-agent-light/90">
        <CheckCircle size={10} weight="fill" /> {modelCount}
      </span>
    )
  }
  return <CircleDashed size={11} className="text-muted/50" />
}

function Toggle({ on, onChange }: { on: boolean; onChange: (on: boolean) => void }) {
  return (
    <button
      role="switch"
      aria-checked={on}
      onClick={() => onChange(!on)}
      className={`shrink-0 w-8 h-[18px] rounded-full transition-colors relative ${on ? 'bg-agent' : 'bg-white/10'}`}
    >
      <span
        className={`absolute top-[2px] h-[14px] w-[14px] rounded-full bg-white transition-all ${on ? 'left-[16px]' : 'left-[2px]'}`}
      />
    </button>
  )
}

// -----------------------------------------------------------------------------
// Add custom provider
// -----------------------------------------------------------------------------

function AddProviderForm({
  onAdd,
  onCancel,
  existingIds,
}: {
  onAdd: (next: LocalProviderConfig) => void
  onCancel: () => void
  existingIds: string[]
}) {
  const [name, setName] = useState('')
  const [baseUrl, setBaseUrl] = useState('http://localhost:8000')
  const [kind, setKind] = useState<LocalProviderKind>('openai')
  const [error, setError] = useState<string | null>(null)

  const submit = () => {
    const trimmed = name.trim()
    if (!trimmed) { setError('Name is required'); return }
    if (!baseUrl.trim()) { setError('Base URL is required'); return }
    const id = trimmed.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    if (!id) { setError('Name must contain letters or numbers'); return }
    if (existingIds.includes(id)) { setError('A provider with this name already exists'); return }
    onAdd({ id, name: trimmed, kind, baseUrl: baseUrl.trim(), enabled: true, builtin: false })
  }

  return (
    <div className="rounded-lg border border-white/10 bg-white/[0.03] p-3 space-y-2">
      <div className="text-[12px] font-medium text-primary">Add endpoint</div>
      <div className="grid grid-cols-[1fr_auto] gap-2">
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Name (e.g. vLLM)"
          className="bg-surface-3 border border-white/10 rounded-md px-2 py-1.5 text-[12px] text-primary outline-none focus:border-agent/60"
        />
        <select
          value={kind}
          onChange={(e) => setKind(e.target.value as LocalProviderKind)}
          className="bg-surface-3 border border-white/10 rounded-md px-2 py-1.5 text-[12px] text-primary outline-none focus:border-agent/60"
        >
          <option value="openai">OpenAI-compatible</option>
          <option value="ollama">Ollama API</option>
        </select>
      </div>
      <input
        value={baseUrl}
        onChange={(e) => setBaseUrl(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') submit() }}
        placeholder="http://localhost:8000"
        spellCheck={false}
        className="w-full bg-surface-3 border border-white/10 rounded-md px-2 py-1.5 text-[12px] text-primary outline-none focus:border-agent/60 font-mono"
      />
      {error && <div className="text-[11px] text-rose-300">{error}</div>}
      <div className="flex items-center gap-2 justify-end">
        <button onClick={onCancel} className="px-2.5 py-1 rounded-md text-muted hover:text-primary text-[12px]">Cancel</button>
        <button onClick={submit} className="px-2.5 py-1 rounded-md bg-agent hover:bg-agent-light text-white text-[12px]">Add</button>
      </div>
    </div>
  )
}
