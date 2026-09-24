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

**Tools.**
- TypeScript tools (`tsc`, `vitest`, `vite`) are resolved from the worktree's
  `node_modules`, then from `MAESTRO_RUNTIME_ROOT`.
- Python uses the worktree's `.venv` interpreter when it exists. Otherwise it
  probes Python 3 installations, including the Windows `py` launcher, and
  selects the first interpreter that successfully starts.

**Infrastructure failures.** If the runner itself cannot start, the Goal is
paused as `waiting_provider` (`environment_error`) and retried. It is not
blocked.

## Environment preparation

The deterministic runner prepares dependencies before tests only when the Task
has a persisted `task.workspace_access_approved` event. It creates a worktree
`.venv`, installs supported Python manifests (`requirements*.txt`, `pyproject.toml`,
`setup.py`, or `setup.cfg`), including conventional `dev`, `test`, `tests`, and
`testing` extras from `[project.optional-dependencies]`. Node app directories use
the package manager indicated by a supported lockfile (`npm ci`, frozen
pnpm/yarn/bun install); without a lockfile, npm installs without creating one.
Declared npm/Yarn/pnpm workspace members are installed through their root, not
as isolated packages. Successful dependency installs are cached against the
relevant root and member manifests outside the worktree, including Yarn PnP
layouts; failed or partial installs are retried instead of being mistaken for
a prepared environment. npm verification rejects missing required direct
dependencies but tolerates peer/extraneous warnings when declared dependencies
are present.

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
sandbox. Credential variables used by private registries are also removed, so
registries that rely only on environment tokens may need existing
user-level/package-manager credential configuration. This prevents arbitrary
lifecycle scripts from inheriting those tokens. The Task approval text states
that scripts run as the user and may affect host resources. For the local API
trust boundary, see [Goal Runtime](GOAL_RUNTIME.md#safety-boundaries). For Codex, see
[Providers](PROVIDERS.md#codex-execution-flags).

## Known gaps

- A mixed root (Python manifest plus a root `package.json`) is validated as
  `root`, without `pytest`.
- There is no deterministic UI/browser check. Visual validation depends on
  the provider having a browser available.
- Browser setup and Python managers beyond the supported requirements/setup
  manifests still require provider-led recovery.
- Python test groups declared through PEP 735 `[dependency-groups]` or Poetry
  group tables are not provisioned automatically yet; conventional
  `[project.optional-dependencies]` extras and `requirements*.txt` are supported.
