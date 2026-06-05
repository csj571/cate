# Cate → Local-First AI Workspace: Pivot Roadmap

*A phased plan to evolve Cate from a spatial coding canvas into an Odysseus-style,
local-first AI workspace — without throwing away what makes Cate distinct.*

Last updated: 2026-06-05

---

## TL;DR

PewDiePie's **Odysseus** (launched May 31, 2026) is a free, MIT-licensed,
self-hosted AI workspace: chat + agents + tools + **local model serving** +
deep research + persistent memory + productivity tools (email/calendar/notes),
all running on your own hardware. It's a Python/FastAPI backend with a vanilla-JS
PWA frontend.

Cate is an Electron + React + TypeScript **spatial canvas** with editor/terminal/
browser/git panels and — crucially — an already-built agent system (`src/agent/`,
~8.8k LOC) that spawns `pi-coding-agent` over RPC and supports **17 model
providers** through a modular auth layer.

**The thesis:** Cate already owns the two hardest parts of an AI workspace — a
decoupled agent runtime and multi-provider model auth. The pivot is mostly
*adding capabilities* (local serving, memory, research, productivity) and
*re-centering the UX* around AI — not a rewrite. And Cate's spatial canvas is a
genuine differentiator: Odysseus is a conventional chat UI; Cate can be the AI
workspace where conversations, agents, research, and tools live as spatial nodes.

---

## Feature gap analysis

| Odysseus pillar | Cate today | Gap size |
|---|---|---|
| Multi-provider chat | ✅ `agentStore` + `ChatThread` + 17 providers | **None** |
| Autonomous agents + tools | ✅ pi agent loop, tools, skills, extensions | **None** |
| Session management | ✅ `.jsonl` sessions, list/fork/switch | **Small** (presets, naming) |
| **Local model serving** (Ollama/llama.cpp/vLLM) | ❌ cloud providers only | **Medium** |
| **Persistent vector memory** | ⚠️ raw transcript only, no recall | **Large** |
| **Deep research** (multi-step web) | ⚠️ passive BrowserPanel, no automation | **Large** |
| Web search tool | ❌ | **Small–Medium** |
| **Model management / Cookbook** | ❌ | **Medium** |
| Email (IMAP/SMTP) + triage | ❌ | **Large** |
| Calendar (CalDAV) | ❌ | **Large** |
| Notes / tasks / reminders | ⚠️ EditorPanel only | **Medium** |
| Document RAG / file vision | ⚠️ DocumentPanel preview only | **Medium** |
| Chat-first positioning | ❌ canvas is the star | **Medium** (UX) |
| Self-host / privacy framing | ✅ already a local desktop app | **None** (just messaging) |

---

## Guiding principles

1. **Don't fight the architecture.** pi runs in a subprocess and owns the agent
   loop. New AI capabilities should land as (a) new pi *providers*, (b) pi
   *tools/extensions*, or (c) new Cate *panels* — not core rewrites.
2. **Keep the canvas as the differentiator.** Add a chat-first *mode*, don't
   delete the spatial workspace. Make panels first-class outputs of agent work
   (research → BrowserPanels, code → EditorPanels, runs → TerminalPanels).
3. **Local-first is the headline.** The single most defining Odysseus feature is
   running models on your own hardware. Phase 1 targets it first because it's the
   biggest "wow" for the smallest lift, given the auth layer already exists.
4. **Ship vertically.** Each phase is independently demoable and mergeable.

---

## Phase 0 — Positioning & scaffolding *(0.5 wk)*

**Goal:** Decide the product shape and lay non-code groundwork.

- Decide the name/identity (Cate stays? sub-brand?) and the one-line pitch:
  *"A local-first AI workspace on an infinite canvas."*
- Define the privacy story: what stays on-device, what (if anything) leaves.
- Add a `workspaceMode` concept to `appStore` (`'canvas' | 'chat'`) — a toggle,
  not a fork. No behavior yet; just the switch and persisted preference.

**Touches:** `src/renderer/stores/appStore.ts`, `src/shared/types.ts`.
**Risk:** Low. **Exit criteria:** A roadmap everyone agrees on + a mode flag.

---

## Phase 1 — Local model serving *(1–1.5 wk)* ⭐ highest impact

**Goal:** Talk to a model running entirely on the user's machine.

Ollama, llama.cpp's server, and vLLM all expose OpenAI-compatible HTTP APIs.
pi/pi-ai already speak that shape, so this is primarily *wiring a provider* plus
a connection UI — not building an inference engine.

- Add a **local provider** to the auth layer. `authManager.ts` currently has
  `BUILTIN_API_KEY_PROVIDERS` (lines ~92–120); add an `ollama` /
  `local-openai` provider whose "credential" is a base URL (default
  `http://localhost:11434/v1`) rather than an API key.
- Surface locally-installed models in the `ModelPicker` by querying the local
  endpoint's `/api/tags` (Ollama) or `/v1/models` (OpenAI-compat).
- Add a **server-status indicator**: is Ollama/llama.cpp reachable? offer a
  one-click "start server" via the existing pty (`agentManager.bash()`).
- Persist the chosen local endpoint in workspace config.

**Touches:** `src/agent/main/authManager.ts`, `src/agent/main/agentManager.ts`
(`getAvailableModels`), `src/agent/renderer/ModelPicker.tsx`,
`src/shared/types.ts` (provider descriptor for base-URL kind),
`src/agent/main/ipcAuth.ts`.
**Risk:** Medium — pi-ai must accept a custom base URL for an OpenAI-compatible
provider; verify the RPC supports per-provider `baseURL` config. If not, this
becomes a small upstream pi change.
**Exit criteria:** Pull a model with `ollama pull`, pick it in Cate, chat — fully
offline.

---

## Phase 2 — Chat-first surface *(1–2 wk)*

**Goal:** Make Cate *feel* like an AI workspace, not a canvas with a chat panel.

- Build a **chat mode** layout that promotes the agent thread to the primary
  view, with the canvas one keystroke away (reuse `AgentPanel` /`ChatThread`,
  don't rebuild). Drive it off the `workspaceMode` flag from Phase 0.
- **Agent outputs become spatial nodes:** a research answer can "pin" its sources
  as `BrowserPanel`s; a code block can spawn an `EditorPanel`; a command can open
  a `TerminalPanel`. This is the bridge that makes the canvas *serve* the chat.
- Session **presets** (saved system prompt + model + tool set), mirroring
  Odysseus's preset feature. Persist alongside sessions.
- Model **comparison / blind test**: run one prompt against N models side by side
  (N transient agent subprocesses, results in a compare panel).

**Touches:** new `src/agent/renderer/ChatWorkspace.tsx`, `appStore`,
`src/renderer/panels/registry.ts` (output → panel factories), `agentStore.ts`.
**Risk:** Medium — UX design is the hard part, not the plumbing.
**Exit criteria:** A first-run user lands in chat, asks a question, and watches
results materialize as canvas nodes.

---

## Phase 3 — Persistent memory *(2–3 wk)*

**Goal:** The workspace remembers across sessions — facts, preferences, skills.

Odysseus uses ChromaDB + fastembed (ONNX) for hybrid keyword/vector recall.
Cate today stores raw `.jsonl` transcripts (`sessionFiles.ts`) but never recalls
them.

- Add an **embeddings + vector store** in the main process. Options: a local
  ONNX embedder (`fastembed`-equivalent) writing to a local store
  (`sqlite-vec`/`hnswlib`/Chroma-node) under `.cate/pi-agent/memory/`. Keep it
  local-first to match the privacy story.
- Expose memory to the agent as a **pi tool** (`memory.search`, `memory.write`)
  so the model can recall/persist autonomously.
- Add a **memory viewer panel**: browse, edit, and forget memories.
- **Skill persistence** already partially exists (`.cate/pi-agent/skills/`,
  `AGENT_CREATE_SKILL`) — surface it in the UI so the agent visibly "learns."

**Touches:** new `src/agent/main/memory/` (embedder + store + IPC), new memory
tool registration, new `MemoryPanel`, `panels.ts` + `registry.ts`.
**Risk:** Large — embedding model bundling/size, write-conflict handling, and
"when does the agent decide to remember" policy.
**Exit criteria:** Tell Cate a preference in one session; it recalls it unprompted
in the next.

---

## Phase 4 — Deep research & web tools *(2–3 wk)*

**Goal:** Multi-step web research that synthesizes cited answers.

- **Web search tool** as a pi extension: start with DuckDuckGo (no key, like
  Odysseus) and allow a pluggable provider.
- **Browser automation:** Cate already ships a Chromium `BrowserPanel`; add a
  controllable headless path (or wire Playwright via MCP like Odysseus's built-in
  browser server) so the agent can navigate, read, and screenshot.
- **Deep-research orchestrator:** a multi-step loop (plan → fan-out searches →
  fetch → verify → synthesize with citations). A subagent/skill, surfaced as a
  "Research" entry point that streams progress into a panel.

**Touches:** new pi extension(s) under `.cate/pi-agent/`, `BrowserPanel.tsx`
(automation hooks), new research subagent/skill, possibly an MCP browser server.
**Risk:** Large — reliability of scraping/automation; citation correctness.
**Exit criteria:** "Research X" returns a synthesized, source-linked report with
the sources openable as canvas BrowserPanels.

---

## Phase 5 — Model management ("Cookbook") *(1.5–2 wk)*

**Goal:** Discover, download, and right-size local models from inside Cate.

- **Hardware scan:** detect VRAM/RAM and recommend models that fit (mirrors the
  Odysseus Cookbook). Use the existing main-process/pty access.
- **One-click pulls** (Ollama `pull`, or GGUF download) with progress, surfaced
  in a **Models panel**.
- VRAM-aware fit hints (GGUF/FP8/AWQ awareness).

**Touches:** new `src/main/models/` (hardware probe + download manager + IPC),
new `ModelsPanel`, `panels.ts` + `registry.ts`. Builds on Phase 1's local
provider.
**Risk:** Medium — cross-platform hardware probing; large downloads/disk mgmt.
**Exit criteria:** From a fresh machine, scan → recommend → download → chat,
without touching a terminal.

---

## Phase 6 — Productivity layer *(3–5 wk, optional / unbundle)*

**Goal:** The "workspace" half of "AI workspace" — email, calendar, notes, tasks.

These are the biggest lifts and the *least* aligned with Cate's coding roots, so
treat them as opt-in modules; ship the ones that fit the audience.

- **Notes / tasks / reminders:** closest to today's `EditorPanel`; add a
  structured notes panel with checklists + reminders.
- **Email (IMAP/SMTP) + AI triage:** a new main-process integration + panel +
  an agent tool for drafting/triage. Largest single feature.
- **Calendar (CalDAV):** sync + panel + agent scheduling tool.
- **Task scheduling (cron):** let the agent run jobs on a schedule (main-process
  scheduler + IPC).

**Touches:** new main-process services per integration, new panels, new agent
tools. Each is independently sequenceable.
**Risk:** Large + broad scope. **Recommendation:** Pick 1–2 (notes + scheduling
are cheapest); defer email/calendar unless they're core to the target user.

---

## Phase 7 — Distribution, privacy & polish *(ongoing)*

- **Privacy posture made explicit:** an in-app panel showing exactly what runs
  locally vs. what (if any) provider calls leave the machine; a "fully local"
  toggle that hides cloud providers.
- **Self-host / share story:** Cate is a desktop app, not a server. If a
  web/PWA reach is wanted (Odysseus is a PWA), that's a separate companion-server
  track — scope explicitly; don't assume it.
- **Theming & onboarding** to match the "your AI, your hardware" identity.
- **Docs + one-command setup** (`ollama` bootstrap, model recommendations).

---

## Suggested sequencing

```
Phase 0  ─┐
Phase 1  ─┼─ ship local serving first (the headline)   ← MVP of the pivot
Phase 2  ─┘  re-center UX on chat + canvas-as-output
Phase 3  ──  memory (the "it remembers me" moment)
Phase 4  ──  deep research (the "it does work for me" moment)
Phase 5  ──  cookbook (lowers the local-model barrier)
Phase 6  ──  productivity modules (pick & choose)
Phase 7  ──  polish + privacy story (continuous)
```

**Minimum viable pivot = Phases 0–2** (~3–5 weeks): a local-first, chat-first AI
workspace on a canvas. Everything after deepens the moat.

---

## Risks & open questions

- **pi-ai local-provider support:** Phase 1 hinges on configuring a custom
  base URL / OpenAI-compatible local provider through pi's RPC. Verify early; it
  may need a small upstream change to `@earendil-works/pi-ai`.
- **Bundle size:** local embedders and model tooling inflate the Electron build.
  Decide what's bundled vs. downloaded on demand.
- **Scope discipline:** Phase 6 is a different product surface. Resist building
  email before the local-AI core is excellent.
- **Licensing:** Odysseus is MIT; we're not copying code, only the product
  shape. Keep clean-room.
- **Audience:** Cate's roots are coding. Is the target "developers who want local
  AI" (lean into code+agents+research) or "everyone who wants private AI"
  (then Phase 6 matters more)? This choice reprioritizes 4 vs. 6.

---

## Where the work lands (quick reference)

| Capability | Primary files |
|---|---|
| Local provider | `src/agent/main/authManager.ts`, `agentManager.ts`, `ModelPicker.tsx` |
| Chat mode | new `ChatWorkspace.tsx`, `appStore.ts`, `registry.ts` |
| Memory | new `src/agent/main/memory/`, new `MemoryPanel`, pi tool |
| Research | pi extension, `BrowserPanel.tsx`, research subagent |
| Cookbook | new `src/main/models/`, new `ModelsPanel` |
| Productivity | new `src/main/<service>/`, new panels, pi tools |
| New panel (any) | `src/shared/panels.ts` + `src/renderer/panels/registry.ts` + `PanelType` in `src/shared/types.ts` |

---

*Sources on Odysseus: [GitHub](https://github.com/pewdiepie-archdaemon/odysseus) ·
[The Business Standard](https://www.tbsnews.net/tech/pewdiepie-launches-odysseus-free-self-hosted-ai-workspace-challenge-big-tech-subscriptions) ·
[80.lv](https://80.lv/articles/pewdiepie-releases-his-own-self-hosted-ai-workspace-available-for-free)*
