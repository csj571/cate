# Path A — Cate + Odyssey Integration: Technical Design

*Keep pi as Cate's agent runtime. Add Odyssey as the local model **serving**
engine and **memory** store. Defer Multica.*

Status: **DESIGN — not yet implemented.** Last updated: 2026-06-05

> This spec is written to be implemented incrementally on top of the local-model
> bridge already merged in this branch (`src/agent/main/localProviders.ts`).
> Everything Cate-side is grounded in the current codebase. Everything
> Odyssey-side that I could not verify from source is collected in
> [§9 VERIFY](#9-things-to-verify-against-odyssey-source) — those are the only
> places a wrong assumption can cost rework, and each is isolated behind the
> `OdysseyClient` adapter.

---

## 1. The core insight: data plane vs. control plane

Odyssey is **not** a single endpoint. It's a FastAPI **control plane** on
`localhost:7000` (macOS: `7860`) whose "Cookbook" *spawns separate model
servers* (vLLM / llama.cpp / Ollama) — each an OpenAI-compatible server on its
**own** port, e.g. `localhost:8000/v1`.

That split is the whole integration:

| Plane | What it is | Who owns it in Cate | Status |
|---|---|---|---|
| **Data plane** | The agent sending completions to a served model at `localhost:<port>/v1` | `LocalProviderManager` → pi `models.json` | ✅ **Already built** (Phase 1) |
| **Control plane** | List / recommend / download / serve / stop models; semantic memory | New `OdysseyClient` (main) → `:7000` | ⬜ This spec |

The consequence: **the hard part of serving — making the agent actually use a
local model — is done.** What's left is a thin HTTP client to Odyssey's control
plane plus the glue that feeds served endpoints into the existing pipeline.

---

## 2. Architecture

```
┌────────────────────────── Cate (Electron) ──────────────────────────┐
│                                                                      │
│  Renderer                          Main process                      │
│  ┌─────────────────┐   IPC   ┌──────────────────────────────────┐   │
│  │ Local models /  │◄───────►│ OdysseyClient   (HTTP → :7000)    │   │
│  │ Cookbook panel  │         │   • health / connect              │   │
│  │ Memory panel    │         │   • cookbook: list/serve/stop     │   │
│  └─────────────────┘         │   • memory: search/write          │   │
│                              └───────────────┬──────────────────┘   │
│  ┌─────────────────┐                         │ registers served      │
│  │ ModelPicker     │◄──── getAvailableModels │ endpoints             │
│  └─────────────────┘                         ▼                       │
│                              ┌──────────────────────────────────┐    │
│  ┌─────────────────┐         │ LocalProviderManager (Phase 1)   │    │
│  │ pi agent (RPC)  │◄────────│   buildModelsJson → models.json  │    │
│  │  + memory tool  │         └──────────────────────────────────┘    │
│  └────────┬────────┘                                                 │
└───────────┼──────────────────────────────────────────────────────────┘
            │ OpenAI /v1 (data plane)        ▲ HTTP (control + memory)
            ▼                                │
   ┌──────────────────┐            ┌─────────┴─────────────────────────┐
   │ vLLM / llama.cpp │◄───spawns──│ Odyssey FastAPI  (localhost:7000) │
   │ localhost:8000/v1│            │  Cookbook · hwfit · ChromaDB mem  │
   └──────────────────┘            └───────────────────────────────────┘
```

**Principle:** Odyssey runs as its own process. Cate is a *client* of it, never
embeds it. This keeps the Python/Node boundary clean and means Odyssey can be
upgraded independently. Cate degrades gracefully when Odyssey isn't running —
the Phase 1 manual providers (Ollama, LM Studio) still work without it.

---

## 3. Component: `OdysseyClient` (main process)

New file: `src/agent/main/odyssey/odysseyClient.ts`. A typed HTTP client — the
**single place** any Odyssey route path appears, so VERIFY churn is localized.

```ts
// All paths below are PLACEHOLDERS pending source verification (see §9).
export interface OdysseyConfig {
  baseUrl: string          // default 'http://localhost:7000' (macOS 7860)
  enabled: boolean
  authToken?: string       // VERIFY: does the local API require a token?
}

export interface ServedModel {
  id: string               // e.g. 'qwen2.5-coder:7b'
  runtime: 'vllm' | 'llamacpp' | 'ollama' | string
  baseUrl: string          // the spawned server's OpenAI base, e.g. .../v1
  contextWindow?: number
  status: 'starting' | 'ready' | 'stopped' | 'error'
}

export interface CatalogModel {
  id: string
  sizeBytes?: number
  downloaded: boolean
  recommended?: boolean    // from hwfit
  fitsInVram?: boolean
}

export interface OdysseyClient {
  health(): Promise<{ ok: boolean; version?: string }>
  // Cookbook (serving + management)
  listCatalog(): Promise<CatalogModel[]>          // VERIFY route
  hardwareScan(): Promise<{ vramMb?: number; ramMb?: number; gpu?: string }>
  download(modelId: string, onProgress?: (p: number) => void): Promise<void>
  serve(modelId: string): Promise<ServedModel>    // returns the spawned /v1
  stop(modelId: string): Promise<void>
  listServed(): Promise<ServedModel[]>
  // Memory
  memorySearch(query: string, k?: number): Promise<MemoryHit[]>
  memoryWrite(text: string, meta?: Record<string, unknown>): Promise<void>
}
```

Implementation notes:
- Uses global `fetch` with `AbortController` timeouts, mirroring the probe
  pattern already in `localProviders.ts`.
- `serve()` may be **long-running** (model load). Model the lifecycle as
  `starting → ready`; poll `listServed()` or stream progress over an IPC event
  channel, the way `AUTH_OAUTH_EVENT` streams flow updates today.
- Stateless beyond config; Odyssey owns serving state.

---

## 4. Composing with the Phase 1 pipeline

The served model is just another local provider. Rather than duplicate the
models.json machinery, **inject Odyssey-served endpoints into the existing
`LocalProviderManager`.**

Extend `LocalProviderManager` with a *managed* (non-persisted, code-owned)
provider source alongside the user-configured one:

```ts
// localProviders.ts — additive
setManagedProviders(list: LocalProviderConfig[]): void   // called by OdysseyClient glue
```

- When Odyssey reports served models, the glue maps each to a
  `LocalProviderConfig` (`kind: 'openai'`, `baseUrl` = the served `/v1`,
  `builtin: false`, `enabled: true`) and calls `setManagedProviders([...])`.
- `refresh()` already probes any provider and `buildModelsJson()` already emits
  them — **no change to the generation path.** Managed providers simply join the
  config list before probing.
- On `serve`/`stop`, glue updates managed providers then calls
  `agentManager.syncLocalModelsToOpenSessions()` (already exists) so live agents
  see the new model.

Net: **one-click "Serve" in Cate → model appears in the picker** with zero
ModelPicker changes. This is the headline win and it reuses everything from
Phase 1.

---

## 5. Component: Memory tool for pi

Odyssey's ChromaDB + fastembed memory is exposed to the agent as **tools**, so
the model can recall and persist autonomously. Cate already installs pi
extensions on spawn (`installSubagentExtension`, `installPlanModeExtension` in
`agentManager.create()`); add a third:

- New `src/agent/main/odyssey/installMemoryExtension.ts`, following the existing
  install-extension pattern, dropping a pi extension into the workspace
  `.cate/pi-agent/` dir.
- The extension registers two tools:
  - `memory_search(query, k)` → HTTP `POST :7000` memory search → returns hits.
  - `memory_write(text, meta)` → HTTP `POST :7000` memory write.
- Gated on Odyssey being enabled + reachable; absent otherwise so the agent
  doesn't see dead tools (mirrors how Phase 1 omits unreachable providers).

Alternative considered: an **MCP server** instead of a pi extension. Odyssey
already ships `mcp_servers/`. If Odyssey exposes its memory as MCP, Cate could
register that server with pi directly and skip writing tools. **VERIFY** whether
Odyssey's memory is MCP-exposed; prefer reusing it over reimplementing.

---

## 6. IPC surface (additions)

Mirrors the `LOCAL_PROVIDERS_*` channels added in Phase 1.

```
ODYSSEY_STATUS      = 'odyssey:status'      // -> { enabled, reachable, version }
ODYSSEY_SET_CONFIG  = 'odyssey:setConfig'   // (OdysseyConfig) ->
ODYSSEY_CATALOG     = 'odyssey:catalog'     // -> CatalogModel[]
ODYSSEY_HW_SCAN     = 'odyssey:hwScan'      // -> hardware info
ODYSSEY_DOWNLOAD    = 'odyssey:download'    // (modelId) -> ; progress via event
ODYSSEY_SERVE       = 'odyssey:serve'       // (modelId) -> ServedModel
ODYSSEY_STOP        = 'odyssey:stop'        // (modelId) ->
ODYSSEY_LIST_SERVED = 'odyssey:listServed'  // -> ServedModel[]
ODYSSEY_EVENT       = 'odyssey:event'       // main -> renderer (serve/download progress)
```

Registered via a new `registerOdysseyHandlers(odysseyClient, localProviders,
agentManager)` in `src/main/index.ts`, next to
`registerLocalProviderHandlers`. Preload + `electron-api.d.ts` get matching
typed methods (same mechanics as Phase 1).

---

## 7. UI

- **Local models / Cookbook section** (extend the `LocalModelsView` from
  Phase 1): an "Odyssey" group showing connection status; when connected, a
  Cookbook browser — hardware-fit recommendations, download buttons with
  progress, and Serve/Stop toggles per model. Served models show "▶ Serving on
  :8000" and appear in the model picker automatically.
- **Connection setup**: base URL field (default `:7000`), enable toggle,
  health indicator. If Odyssey is down, an inline hint on how to start it.
- **Memory panel** (later sub-phase): a new panel type (`memory`) registered in
  `src/shared/panels.ts` + `src/renderer/panels/registry.ts` — browse, search,
  and forget memories via the same OdysseyClient.

---

## 8. Sequencing

Each sub-phase is independently shippable and demoable.

- **A0 — Connect** *(small)*: `OdysseyClient.health()`, config persistence,
  status UI. Deliverable: Cate shows "Odyssey: connected (v…)".
- **A1 — Serve** *(medium)* ⭐: Cookbook list + Serve/Stop, served endpoints
  injected into `LocalProviderManager`. **Deliverable: click Serve in Cate →
  chat with that model.** Highest value; leans entirely on Phase 1.
- **A2 — Manage** *(medium)*: hwfit recommendations + downloads with progress.
  The full Cookbook experience.
- **A3 — Memory tool** *(medium)*: pi memory extension (or MCP reuse). Agent
  gains cross-session recall backed by Odyssey's ChromaDB.
- **A4 — Memory panel** *(small–medium)*: browse/forget UI.

Recommended first build: **A0 + A1** — that's the "local models, one click,
hardware-optimized runtime" story end-to-end, with almost no new surface area
beyond the `OdysseyClient`.

---

## 9. Things to VERIFY against Odyssey source

These are the *only* load-bearing unknowns. All are isolated inside
`OdysseyClient` (§3), so resolving them is a localized edit, not a redesign.

1. **Exact route paths** on `:7000` for: catalog list, hardware scan, download
   (+ progress: SSE? polling?), serve, stop, list-served, memory search, memory
   write.
2. **Auth**: Odyssey has 2FA/admin roles. Does the *local* API require a token
   for these routes? If so, how is it obtained/stored? (`authToken` in config.)
3. **Served-port reporting**: when Cookbook serves a model, how does Cate learn
   the spawned server's port/baseUrl? Returned from `serve()`, or discovered via
   `list-served`? One model per port, or multiplexed?
4. **OpenAI compatibility specifics**: do served runtimes need
   `compat.supportsDeveloperRole=false` / `supportsReasoningEffort=false` (as
   Phase 1 assumes for local servers)? Any per-runtime quirks (vLLM vs
   llama.cpp)?
5. **Memory transport**: is memory exposed as plain HTTP, or as an MCP server
   under `mcp_servers/`? If MCP, register it with pi instead of writing tools
   (§5).
6. **Embeddings**: does memory write embed server-side (fastembed in Odyssey),
   or does Cate/pi need to supply embeddings? (Expect server-side.)
7. **Lifecycle ownership**: should Cate ever *start* Odyssey (spawn the Python
   app), or strictly detect-and-connect? v1 assumes detect-only.

---

## 10. Risks & non-goals

- **Risk: two sources of "local providers."** Phase 1 (manual) + Odyssey
  (managed) both feed `models.json`. Mitigation: the `setManagedProviders` seam
  keeps them in one list with clear precedence; managed entries are namespaced
  (`odyssey-*`).
- **Risk: serve latency / failure.** Model loads are slow and can OOM.
  Mitigation: explicit `starting/ready/error` lifecycle + streamed progress;
  never block agent spawn on it (Phase 1 already writes models.json from cache).
- **Risk: Odyssey API drift.** It's young and fast-moving. Mitigation: the
  adapter boundary + a thin contract; pin a known-good Odyssey version in docs.
- **Non-goal (v1):** Cate packaging/installing Odyssey, GPU setup, or managing
  its Python env. User runs Odyssey; Cate connects.
- **Non-goal:** Multica / multi-agent boards (deferred per Path A decision).

---

## 11. What's already done (this branch)

- `LocalProviderManager` — probe + discover + `models.json` generation for any
  OpenAI-compatible endpoint (`src/agent/main/localProviders.ts`, tested).
- Spawn-time + live-session models.json sync (`agentManager.ts`).
- IPC + preload + typed API + "Local models" settings UI.

→ This is the **data-plane consumer** Path A needs. The serve endpoint Odyssey
spawns plugs straight into it; A1 is mostly wiring `OdysseyClient.serve()` to
`setManagedProviders()`.
