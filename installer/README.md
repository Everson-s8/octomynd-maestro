# Maestro Setup

`Maestro-Setup.exe` is the branded Windows installer. It is a small Tauri app
(Rust + WebView2) with its own screens, real stages and a log. It does not
replace the NSIS package: it downloads the published NSIS payload, checks it
and runs it silently. `electron-updater` keeps updating the installed app with
that same NSIS payload, so updates are unchanged.

## What it does

| Stage | Real work |
|---|---|
| Verificando o computador | Refuses to run while `Maestro.exe` is open; checks free space on the install drive (900 MB). |
| Buscando a versão mais recente | Reads `latest.yml` from the latest GitHub release (version, file name, sha512, size). |
| Baixando o Maestro | Streams the NSIS payload to `%TEMP%\Maestro-Setup\` with byte progress and speed. A complete earlier download is reused. |
| Conferindo a integridade | sha512 of the file must match `latest.yml`; a mismatch deletes the file and fails. |
| Instalando o aplicativo | Runs the payload with `/S` (per-user, no administrator) and checks `Maestro.exe` and its version on disk. |
| Registrando o comando maestro | Confirms the install folder is in the user PATH (the payload adds it) and repairs it if missing. |
| Procurando Git e agentes | Looks for `git`, `codex`, `claude` and `gemini` on the PATH a new terminal will see. Informational; never fails. |

Cancel is available until the NSIS copy starts. Logs go to
`%LOCALAPPDATA%\Maestro-Setup\logs\setup-<timestamp>.log`; the failure and done
screens open it.

## Design

The screens follow the Maestro brand skill: the `Maestro.` wordmark in
Newsreader Display with the orange dot, Newsreader for titles, Geist for the
interface, Geist Mono only for paths, versions and logs, and the dark
"mesa calma" palette. The only brand motion is the batuta. Fonts ship inside
the app (`src/assets/fonts`, SIL OFL 1.1, licenses in `src/assets/licenses`);
nothing is loaded from the network.

## Develop

```bash
npm install
npm run dev          # screens in a browser with a simulated backend (?demo=fail, ?installed=0.4.0)
npm run tauri:dev    # the real window and backend
```

## Build

Requires Rust (stable) and the WebView2 runtime (present on Windows 10/11).

```bash
npm run tauri:build
```

The installer is `src-tauri/target/release/Maestro-Setup.exe`. To test a
release candidate before publishing it, point the setup at a local payload;
a `latest.yml` next to it enables the hash check:

```bash
Maestro-Setup.exe --payload C:\path\to\Maestro-Setup-0.4.2-x64.exe
```

## Not covered yet

- Code signing (the app and the NSIS payload are unsigned today).
- Choosing a custom install folder in the UI (`/D=` is supported by the pipeline).
- Publishing `Maestro-Setup.exe` from the release workflow.
