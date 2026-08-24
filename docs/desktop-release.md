# Maestro Desktop — Build & Release (Windows)

This document describes how the Maestro orchestrator is packaged as a
shareable Windows desktop application, how to install and use it on a clean
machine, and the update path.

## Goals

- One person can install and open Maestro on a **clean machine** without a
  separate Node/npm/tsx installation, reach the dashboard and use the bundled
  terminal launcher.
- Git is required for Git-backed project registration, worktrees and task
  execution. Provider CLIs or API credentials are also user-provided; they are
  not copied from the build machine.
- The packaged runtime never runs `npm install` or `npm ci` inside a user's
  project. A root Node project with a lockfile must arrive with its own
  validation dependencies prepared (`node_modules`); this is reported by
  Environment Doctor before a task starts.
- The build ships **no secrets** and **no developer-specific paths**.
- Artifacts are **versioned and reproducible**, ready to share.

## Architecture of the packaged app

| Concern | In the checkout (dev) | In the installed app (prod) |
| --- | --- | --- |
| UI | `ui/` (Vite dev server) | `ui/dist` served by the backend |
| Backend / orchestrator | `tsx src/index.ts` | compiled `dist/index.js`, spawned by Electron |
| Runtime | your local Node + tsx | the app's bundled Electron, run as Node (`ELECTRON_RUN_AS_NODE=1`) |
| Database & migrations | `better-sqlite3`, `.maestro/maestro.db` in cwd | `better-sqlite3` rebuilt for Electron, db under user data dir |
| Config & credentials | `.env.local` in the checkout | `.env.local` under the user data dir |
| CLI | `maestro …` via tsx | `maestro.cmd` beside `Maestro.exe`, backed by compiled `dist/cli` and bundled Electron |

The Electron main process for the packaged app is `src/desktop/main.cjs`. It:

1. resolves the per-user **data directory** (Electron `userData`, override with
   `MAESTRO_DATA_DIR`) where config, credentials and the database live — so
   updates never overwrite them and no secret ships in the installer;
2. seeds a secret-free `.env.local` from the committed `.env.example` on first
   run (never overwrites an existing one);
3. spawns the compiled backend (`dist/index.js`) using the app's own Electron
   binary as Node, with `cwd` set to the data dir. This is why **no external
   Node/npm/tsx** is required just to launch the app; Git and provider CLIs are
   still required for their respective integrations. The app does not silently
   borrow its bundled TypeScript/Vitest toolchain for a root Node project with
   its own lockfile;
4. waits for the dashboard API health check, then opens the window against
   `http://127.0.0.1:4787/`.

Pure, testable decisions (paths, spawn config, seeding, channel) live in
`src/desktop/production.cjs` (covered by `test/desktop-production.test.ts`).

Providers and the Antigravity session work in the installed app because the
full orchestrator (`dist/index.js`) runs unchanged; provider account logins and
the Antigravity CLI session are performed from the running app exactly as in a
checkout. Telegram is optional in the desktop app: the app sets
`MAESTRO_REQUIRE_TELEGRAM=false` so it boots to the dashboard before any bot is
configured (`createTelegramBot` also tolerates an empty token).

## Building (on a build machine with the toolchain)

Prerequisites on the **build** machine only (not the target): Node 22.12.x or newer
(within the repository's supported `<25` range),
npm, and the Windows build tools electron-builder needs to rebuild
`better-sqlite3` (Visual Studio Build Tools / Python, per electron-builder docs).

```powershell
npm install

# Clean, reproducible compile of UI + backend (no installer yet):
npm run build:desktop

# Package the versioned Windows installer (NSIS) into ./release:
npm run dist:win

# Or do both in one step:
npm run release:win
```

Output: `release/Maestro-Setup-<version>-x64.exe`, where `<version>` comes from
`package.json`. The artifact name is deterministic and versioned for sharing.
The initial build is unsigned; a production release pipeline should add a
Windows code-signing certificate before public distribution.

### Free public distribution

The unsigned beta can be distributed without a paid certificate through GitHub
Releases. Publish the installer together with its SHA-256 checksum and keep the
source repository public:

```powershell
$artifact = Get-ChildItem .\release\Maestro-Setup-*-x64.exe | Select-Object -First 1
Get-FileHash $artifact.FullName -Algorithm SHA256
gh release create "v$(node -p "require('./package.json').version")" $artifact.FullName `
  --title "Maestro v$(node -p "require('./package.json').version")" --generate-notes
```

Copy the resulting SHA-256 value into the release notes. Users should download
only from the repository's Releases page and verify the checksum before running
an unsigned installer. GitHub Releases hosting and checksums are free; they do
not remove Windows SmartScreen's first-download warning.

### Development (HG) vs production (main)

- **Production** builds are cut from `main`. Leave `MAESTRO_RELEASE_CHANNEL`
  unset (defaults to `prod`); the window title is `Maestro`.
- **Development** builds from an HG branch set `MAESTRO_RELEASE_CHANNEL=dev`
  before launching; the window title becomes `Maestro (dev)` so a dev build is
  never confused with a shared production one. Keep dev artifacts out of the
  production share channel.

```powershell
# Development build marker
$env:MAESTRO_RELEASE_CHANNEL = "dev"
npm run release:win
```

## Installing & using (clean machine)

1. Copy `Maestro-Setup-<version>-x64.exe` to the target machine and run it.
   The NSIS installer lets you choose the install directory and creates
   Start Menu / Desktop shortcuts.
2. Launch **Maestro**. The app starts its backend and opens the dashboard.
3. Optional terminal access: run `maestro.cmd` from the installation directory, or add that directory to the user's `PATH`. It supports the same CLI commands without Node/npm/tsx. The CLI stores configuration and its database under `%APPDATA%\\Maestro`, while relative project paths still resolve from the terminal's current directory.
4. In the dashboard:
   - open **Providers** and log in / add the providers you want (Codex,
     Claude, Antigravity/Gemini, custom endpoints). Credentials are stored in
     the per-user data dir, never in the install folder.
   - **register a project** (local Git path or GitHub URL; Git must be
     installed on the target machine).
   - for a root Node project, prepare its dependencies before starting a task;
     the app validates the project's own TypeScript/Vitest toolchain and does
     not install packages on its behalf.
   - create and **run a task** after configuring a provider CLI/API; watch it
     execute from the dashboard.

Where user data lives: `%APPDATA%\Maestro` (the Electron `userData` dir),
containing `.env.local`, `.maestro/maestro.db` and related runtime state. The
execution/worktrees root stays outside the user profile at
`C:\MaestroRuntime\<project>` per the execution contract.

## Updating

Installing a newer `Maestro-Setup-<version>-x64.exe` replaces the app in place.
User data under `%APPDATA%\Maestro` (config, credentials, database) is preserved
across versions, so providers and projects survive updates. The packaged app
already checks the configured GitHub Releases channel for updates; publishing
the installer to the repository's Releases page is what makes an update visible
to installed users. Keep development/HG artifacts out of that production
channel.

## Clean-machine validation checklist

Run on a machine **without** Node/npm/tsx installed. For the full project/task
flow, install Git and configure at least one provider CLI or API key:

- [ ] Installer runs and completes; shortcuts are created.
- [ ] App launches and the dashboard loads (no console/terminal needed).
- [ ] Providers can be configured and a provider login succeeds.
- [ ] Git-backed project registration succeeds.
- [ ] A root Node project's dependencies are prepared, or Environment Doctor
      clearly reports the missing project toolchain before execution.
- [ ] A task can be created and executed to completion with a configured provider.
- [ ] `maestro.cmd --help` runs from a terminal without Node/npm/tsx.
- [ ] `%APPDATA%\Maestro\.env.local` exists and contains no secrets from the
      build machine; the install folder contains no `.env.local`/database.
- [ ] Re-installing a newer build keeps existing providers/projects/history.

Run this checklist on a clean target machine before sharing a release. The build
machine and target machine should be treated as separate environments; the
target must not inherit the build machine's provider credentials or data folder.
