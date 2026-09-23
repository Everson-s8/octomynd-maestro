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
| `nested-app` | `backend/package.json`, `backend/tsconfig.json` or `frontend/{package.json,tsconfig.json,vite.config.*}` | backend typecheck, frontend typecheck, Vitest, Vite build (each skipped if its config is missing) |
| `python` | a Python manifest (`pyproject.toml`, `requirements*.txt`, `setup.*`, `pytest.ini`, `tox.ini`, `Pipfile`, `environment.yml`) or any `.py` file, **and** no root TypeScript manifest | `compileall`, then `pytest -q` (skipped when there are no `test_*.py` / `*_test.py`) |
| `root` | everything else (Maestro itself and TypeScript roots) | backend typecheck, `ui/` typecheck, Vitest, Vite build with `ui/vite.config.ts` |

**Tools.**
- TypeScript tools (`tsc`, `vitest`, `vite`) are resolved from the worktree's
  `node_modules`, then from `MAESTRO_RUNTIME_ROOT`.
- Python uses the worktree's `.venv` interpreter when it exists; otherwise it
  uses `py -3` (Windows) or `python3`.

**Infrastructure failures.** If the runner itself cannot start, the Goal is
paused as `waiting_provider` (`environment_error`) and retried. It is not
blocked.

## The runner does not install anything

The deterministic runner never creates a virtual environment and never runs
`pip`, `npm install` or a browser install. Missing dependencies surface as
failed checks: for example, `pytest` absent or modules not importable.

Repairing them is the provider's job in the testing step. The Goal prompt
authorizes the agent to install project dependencies and test/browser tooling
inside the worktree. It should prefer a worktree-local `.venv` and the
project's package manager, and use `uv` when Python itself is missing.

This only works when the provider's sandbox allows network access. For Codex,
see [Providers](PROVIDERS.md#codex-execution-flags).

## Known gaps

- Folder names other than `frontend/` and `backend/` (for example
  `frontend-ts/`, `web/`, `client/`) are not detected as a nested app. A
  Python root with such a frontend is validated as `python` only.
- A mixed root (Python manifest plus a root `package.json`) is validated as
  `root`, without `pytest`.
- There is no deterministic UI/browser check. Visual validation depends on
  the provider having a browser available.
- Dependency provisioning could move into the runner itself (create `.venv`,
  install from the manifest, `npm ci`) so that validation does not depend on
  the provider deciding to repair the environment.
