# AGENTS.md

Guidance for autonomous coding agents (Google Jules, and any other
AGENTS.md-aware agent) working in this repository. This file is read on every
task — keep it accurate.

> Cate's human/Claude-oriented notes live in `CLAUDE.md`. This file is the
> agent-facing summary; when the two overlap, both should agree.

## What Cate is

Cate is a desktop application: an infinite zoomable canvas where editor,
terminal, and browser panels float spatially (think Figma/Miro, but for
coding). Built with **Electron + React 18 + TypeScript**, styled with
**Tailwind CSS**, bundled with **electron-vite**.

## Environment & setup

- **Node:** 20 (see `.nvmrc`; `engines` requires `>=20 <23`).
- **Python:** 3.12 with `setuptools` — required by `node-gyp` to build the
  native `node-pty` module that backs the terminal panels.
- The committed `package-lock.json` can carry platform-specific (macOS) native
  binaries. CI deletes it before installing; on a Linux VM do the same if a
  plain install fails. See `.jules/setup.sh` for a ready-to-use setup script
  (paste it into the Jules environment configuration).

```bash
npm install        # install dependencies (runs scripts/patch-electron-name.sh)
npm run dev        # dev server with hot reload (needs a display; not for CI)
npm run build      # production build (electron-vite)
npm run typecheck  # tsc --noEmit
npm run test:unit  # vitest run
```

## Verifying a change (run before opening a PR)

Run these and make sure they pass — this matches what CI checks:

```bash
npm run build
npm run typecheck
npm run test:unit
```

Notes:
- `npm run dev` and the Electron smoke test (`npm run test:smoke:electron`)
  need a graphical display and won't run in a headless sandbox — rely on
  `build` + `typecheck` + `test:unit` instead.
- A few git-touching tests assume a clean working tree and a repo without a
  local `main` branch; those failures are environmental, not regressions.
- Set `NODE_OPTIONS=--max-old-space-size=4096` if the build runs out of memory.

## Architecture (where things live)

Electron three-process model:

- **Main** (`src/main/`) — window management, IPC handlers, native APIs.
- **Preload** (`src/preload/`) — secure bridge exposing IPC to the renderer.
- **Renderer** (`src/renderer/`) — the React canvas UI.

Shared contracts:
- IPC channel names: `src/shared/ipc-channels.ts`
- Shared types: `src/shared/types.ts`
- Panel definitions: `src/shared/panels.ts`

Canvas & coordinates:
- `src/renderer/canvas/` — `Canvas.tsx`, `CanvasNode.tsx`.
- Panel positions are stored in **canvas-space** and converted to
  **view-space** via zoom + viewport offset. Conversions live in
  `src/renderer/lib/coordinates.ts` (`canvasToView()` / `viewToCanvas()`).
  Zoom bounds are `ZOOM_MIN` / `ZOOM_MAX` in shared types.
- Interaction hooks: `useCanvasInteraction` (wheel/zoom/pan), `useNodeDrag`,
  `useNodeResize`.

Panels (`src/renderer/panels/`): Editor (Monaco), Terminal (xterm.js +
node-pty), Browser (webview), Canvas (nested), Git, FileExplorer,
ProjectList, Document (PDF/docx), Agent (Claude-Code thread). Each panel is
wrapped in a `CanvasNode` or lives in a dock zone via
`src/renderer/docking/DockTabStack`.

State (Zustand, `src/renderer/stores/`): `canvasStore` (per-canvas instances
via `CanvasStoreContext`), `appStore`, `dockStore`, `settingsStore`,
`shortcutStore`, `statusStore`, `uiStore`, `updateStore`, `urlPromptStore`.
Session persistence serializes workspace state to JSON via `electron-store`.

## Conventions

- **Functional React** with hooks for all logic — no class components.
- **Zustand** for global state (no Redux/Context boilerplate).
- **Tailwind CSS** for styling.
- **IPC** for every main↔renderer interaction (filesystem, git, terminal,
  shell) — never reach across the process boundary directly.
- Tests use **Vitest** and live next to the code they cover
  (`*.test.ts` / `*.test.tsx`). Add/adjust tests when you change behavior.
- Keep new code consistent with the surrounding file's style, naming, and
  comment density. Match existing patterns rather than introducing new ones.

## Pull requests

- Keep changes focused; update or add tests for the behavior you touch.
- Make sure `build`, `typecheck`, and `test:unit` all pass before opening a PR.
- Write a clear PR description: what changed, why, and how it was verified.
