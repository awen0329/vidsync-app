# syncthing-frontend

Pure-web frontend for the Syncthing-based collaboration product. Built
with [Vite](https://vitejs.dev) + React + TypeScript + Tailwind, talks
to the syncthing daemon's REST API.

The plan is to develop here in the browser for fast iteration, then
later wrap the same frontend with [Wails](https://wails.io) for a
single-installer desktop build (which can reuse the Go code under
`internal/gui/`).

## Prerequisites

- Node.js 20+ and npm (or pnpm/yarn — anything that reads
  `package.json`)
- A running syncthing daemon. The simplest way is the one we built:
  `bin/syncthing.exe serve --no-browser` (or `bin/syncthing` on
  Linux/macOS).

## Setup

```bash
cd frontend
cp .env.example .env.local
# Edit .env.local, set VITE_API_KEY to the daemon's <apikey> value
# (look in <user-config-dir>/Syncthing/config.xml)
npm install
npm run dev
```

Open http://localhost:5173.

## How it works

- All `/rest/*` calls from the page are proxied through Vite to the
  daemon's URL (default `http://127.0.0.1:8384`). The proxy injects the
  `X-API-Key` header, so the browser never sees CORS preflight issues.
- Folder origin (Owned vs Invited) is tracked in `localStorage`; the
  daemon doesn't know about it. When you click **+ New** the folder is
  marked Owned; when you Accept a pending invitation it's marked
  Invited. Folders created elsewhere default to Owned.

## Project layout

```
frontend/
├── index.html
├── package.json
├── vite.config.ts            ← /rest proxy + alias config
├── tsconfig.json
├── tailwind.config.ts
├── postcss.config.js
└── src/
    ├── main.tsx              ← React entry point
    ├── App.tsx               ← Top-level layout with two tabs
    ├── index.css             ← Tailwind directives
    ├── lib/
    │   └── utils.ts          ← cn() helper for Tailwind classes
    ├── api/
    │   ├── client.ts         ← SyncthingClient — typed REST wrapper
    │   ├── types.ts          ← TypeScript shapes for daemon responses
    │   ├── hooks.ts          ← TanStack Query hooks (useConfig, …)
    │   └── origins.ts        ← localStorage-backed Owned/Invited tracker
    ├── components/
    │   ├── Button.tsx        ← Styled button (primary/secondary/danger)
    │   ├── Modal.tsx         ← Lightweight modal with backdrop + Esc
    │   ├── OfflineBanner.tsx ← "Daemon offline — retrying…" strip
    │   └── SplitView.tsx     ← Two-column layout for the project tabs
    └── pages/
        ├── YourProjects.tsx     ← Tab 1 — own projects + members panel
        └── InvitedProjects.tsx  ← Tab 2 — accepted invites + sync status
```

## Build

```bash
npm run build      # → dist/
npm run preview    # serve the built bundle locally
npm run typecheck  # tsc --noEmit
```

## Eventual desktop wrap

The folder structure here is intentionally shaped to drop into a Wails
project: `dist/` becomes the embedded asset bundle, the API client
already abstracts the base URL (so a Wails host can pass it in via
`window.runtime` or env), and origin storage moves from `localStorage`
to a Go-side file (already implemented in `internal/gui/origins/`).

When you're ready, scaffold a Wails app at the repo root (`wails init`)
and point its `frontend/` field at this directory.
