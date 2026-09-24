# Deterministic validation in the testing phase

When a Goal enters `testing`, Maestro runs its own deterministic checks
(`DeterministicValidationRunner`, `src/validation/runner.ts`) before the provider's
testing step. The result, compacted, becomes evidence for the provider and for
review.

## What runs

1. `diff_check`: `git diff --check` against the base ref.
2. `secret_scan`: scans changed and untracked files for credentials.
3. Only if both pass, the layout-specific checks below. Each check has its own
   timeout, and a check with a `skipReason` is recorded as skipped (passed).

| Layout | How it is detected | Checks |
|---|---|---|
| `nested-app` | First-level `backend`/`server`/`api` and `frontend`/`client`/`web` directories (optionally suffixed, e.g. `frontend-ts`) containing a recognized app manifest | backend typecheck, frontend typecheck, Vitest, Vite build (each skipped if its config is missing) |
| `python` | a Python manifest (`pyproject.toml`, `requirements*.txt`, `setup.*`, `pytest.ini`, `tox.ini`, `Pipfile`, `environment.yml`) or any `.py` file, **and** no root TypeScript manifest | `compileall`, then `pytest -q` (skipped when there are no `test_*.py` / `*_test.py`) |
| `root` | everything else (Maestro itself and TypeScript roots) | backend typecheck, `ui/` typecheck, Vitest, Vite build with `ui/vite.config.ts` |

Project manifests are inventoried independently of directory names. In Git repositories,
discovery uses `git ls-files --cached --others --exclude-standard`, so ignored build output
and generated package trees are not treated as project roots; non-Git folders use the same
bounded filesystem scan. The inventory records Rust, Go, Java, .NET, Ruby, PHP, Elixir,
Dart, Swift, and container manifests as evidence, but automatic provisioning and
deterministic checks for those ecosystems are not implemented yet.

**Tools.**
- TypeScript tools (`tsc`, `vitest`, `vite`) are resolved from the worktree's
  `node_modules`, then from `MAESTRO_RUNTIME_ROOT`.
- Python uses the selected project's `.venv` interpreter when it exists.
  Otherwise it probes Python 3 installations, including the Windows `py`
  launcher, and selects the first interpreter that successfully starts.

**Infrastructure failures.** If the runner itself cannot start, the Goal is
paused as `waiting_provider` (`environment_error`) and retried. It is not
blocked.

## Environment preparation

The deterministic runner prepares dependencies before tests only when the Task
has a persisted `task.workspace_access_approved` event. It creates a worktree
`.venv` for Python projects included in the validation plan, installs supported
Python manifests (`requirements*.txt`, `pyproject.toml`, `setup.py`, or `setup.cfg`),
including conventional `dev`, `test`, `tests`, and `testing` extras from
`[project.optional-dependencies]`, and runs their checks from that same project
directory and virtual environment. Node app directories selected by the current
validation catalog use the package manager indicated by a supported lockfile
(`npm ci`, frozen pnpm
or bun install, immutable Yarn Berry install, or frozen Yarn Classic install);
without a lockfile, npm installs without creating one.
Only the repository root, declared workspace roots, frontend/backend roots selected
by the deterministic validation catalog, and a sole nested standalone Node project
are prepared. The standalone Node profile runs declared standard `typecheck`,
`lint`, `test`, and `build` scripts from that package; if none are declared, the
check is explicitly skipped and project-led validation is required. Other discovered
manifests (for example, example apps and test fixtures) are inventory evidence, not
implicit install requests. Workspace paths
are read from the project's own npm/Yarn/pnpm manifests and
matched with standard glob syntax; directory names such as `packages/` are not
assumed. Declared workspace members are installed through their root, not as
isolated packages. A pnpm workspace without a lockfile uses
`pnpm install --no-lockfile` so preparation does not silently switch to npm or
create a lockfile. Successful dependency installs are cached against the
relevant root and member manifests outside the worktree, including Yarn PnP
layouts; failed or partial installs are retried instead of being mistaken for
a prepared environment. For workspaces with root dependencies, cache reuse
requires root install artifacts; member artifacts alone only qualify when the
root has no package manifest or declares no direct dependencies. npm
verification reads the JSON report from stdout
(npm's diagnostic stderr can follow it on a nonzero exit), rejects missing or
invalid required direct dependencies, and tolerates peer/extraneous warnings
when declared dependencies are present.

The user's explicit Create Task action records approval for autonomous commands
and dependency changes inside that Task's isolated worktree; no second approval
prompt is required. Checks still run and record missing-tool evidence when
preparation is unavailable. `Pipfile` and `environment.yml` are detected but
are not automatically installed; preparation reports them as unsupported.
Generated environments are excluded from Git before install. Git's
`.git/info/exclude` is shared by linked worktrees, so Maestro adds only missing
patterns there and records this repository-local change in the validation
artifact. If excludes cannot be verified, dependency installation is skipped.

Important: a Git worktree isolates checked-out project files, not the operating
system. Package lifecycle scripts and test commands execute as the Maestro user's
account and can have effects outside the worktree. Maestro removes secret-shaped
environment variables before starting installers and project validation
commands; this limits credential exposure but is not an operating-system
sandbox. Connection-string variables ending in `_URL`, `_URI`, or `_DSN` are
removed when their value contains credentials, including for localhost URLs.
Credential variables used by private registries are also removed, so
registries that rely only on environment tokens may need existing
user-level/package-manager credential configuration. This prevents arbitrary
lifecycle scripts from inheriting those tokens. Proxy variables such as
`HTTP_PROXY` and `HTTPS_PROXY` are preserved for network connectivity; if they
contain credentials, project scripts can read them. The Task approval text
states that scripts run as the user and may affect host resources. For the local
API trust boundary, see [Goal Runtime](GOAL_RUNTIME.md#safety-boundaries). For
Codex, see [Providers](PROVIDERS.md#codex-execution-flags).

## Known gaps

- Validation profile selection still uses the existing root/nested-app/Python
  command catalog and backend/frontend roles. The manifest inventory removes
  folder-name assumptions from dependency preparation, but selecting checks for
  every arbitrary multi-language structure is still in progress; unsupported
  ecosystems must be validated by the Goal provider rather than treated as
  automatically supported.
- A mixed root (Python manifest plus a root `package.json`) is validated as
  `root`, without `pytest`.
- There is no deterministic UI/browser check. Visual validation depends on
  the provider having a browser available.
- Yarn PnP dependency preparation and caching are supported, but deterministic
  TypeScript/Vitest/Vite tool discovery still expects `node_modules` or the
  Maestro runtime; validation commands are not yet launched through Yarn's PnP
  loader. A PnP-only project may therefore need provider-led validation.
- Browser setup and Python managers beyond the supported requirements/setup
  manifests still require provider-led recovery.
- Python test groups declared through PEP 735 `[dependency-groups]` or Poetry
  group tables are not provisioned automatically yet; conventional
  `[project.optional-dependencies]` extras and `requirements*.txt` are supported.
