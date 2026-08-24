# PR #132 — audit and release gates

This document records the evidence used while preparing PR #132 for the open-source
beta. It is deliberately separate from the product documentation: it describes the
review of the integration, not a user-facing feature contract.

## Scope

- Branch: `maestro/task-149-preparar-o-maestro-para-ser-distribuido-como-apl`
- Base: `main`
- Review target before final consolidation: `0dc8451`
- Surfaces: shared core, CLI, dashboard/API, desktop packaging, providers, task
  intake/execution, chat, GitHub delivery and open-source onboarding.

## Findings addressed

- Provider subprocesses could fail without a useful recovery path; routing now
  distinguishes recoverable provider failures from terminal failures and records the
  attempted fallback.
- A task's full request was being reused as its UI/branch/PR title; task persistence
  now keeps the original request and derives a short title plus an execution
  specification.
- Chat was coupled to a project and exposed status-oriented responses; it now has
  project and general contexts, persistent threads, loading/scroll behavior, and
  backend-enforced read-only, standard and full-access modes.
- The human-review PR link could open an invalid `local://` URL through the Windows
  protocol handler; unavailable local-only links are now rendered as unavailable and
  real HTTPS links are opened externally.
- A failed remote push could be ignored before delivery; remote push failures now
  stop delivery with an actionable error, while a repository without `origin` stays
  explicitly local-only.
- Runtime dependencies were mixed with UI/build dependencies. The package now keeps
  React/Vite/test/build tooling in `devDependencies`; the runtime install audit is
  clean and the CLI package can be installed without dashboard dependencies.

## Evidence collected

| Area | Evidence | Current result |
| --- | --- | --- |
| CLI-only package | `npm pack --dry-run`; clean `npm install --omit=dev` with native install scripts; `maestro --help`, `status`, `project add/list`, `task create/list` | PASS |
| Backend | `npm run typecheck`; `npm run build:backend` | PASS |
| UI | `npm run typecheck:ui`; `npm run build:ui` | PASS |
| Core tests | `npm test -- --reporter=dot` (79 files, 680 tests) | PASS |
| Runtime smoke | `npm run smoke` (3 providers, GitHub readiness and routing) | PASS |
| Runtime dependency security | `npm audit --omit=dev --audit-level=high` | PASS: 0 vulnerabilities |
| Diff hygiene | `git diff --check`; secret-pattern scan | PASS |
| Windows desktop | `npm run dist:win` produced `release/Maestro-Setup-0.3.3-x64.exe`; SHA-256 `9CA5EAAD04D9777D48A1C18C14CC90B231BEDC3D8A7EEF9638A841E71CBE01B4` | PASS for packaging; signing/SmartScreen remains a documented limitation |

## Gate result

The final review records the following status after implementation and verification:

1. **GATE 1 — PASS:** architecture, changed flows, risks and corrections are recorded
   here and in the existing ADRs/runtime docs.
2. **GATE 2 — PASS:** `npm ci` is reproducible; a runtime-only package install works
   without UI/build dependencies; the compiled Windows CLI works without external
   Node/npm; the dashboard development API exposes the shared provider registry.
3. **GATE 3 — PASS:** provider construction is shared through
   `src/agents/runtime.ts`; dashboard and CLI use the same database/application
   command contracts. A live dashboard check returned health, providers and chat data.
4. **GATE 4 — PASS:** provider auth/discovery, Antigravity permissions, quota reasons,
   provider failure and fallback cases are covered by the provider test suites; live
   smoke found Codex, Claude and Antigravity ready on the validation machine.
5. **GATE 5 — PASS:** `test/task-intake.test.ts` covers short, detailed, generic and
   diagnostic requests; persistence keeps the original request, derived title and
   specification separately.
6. **GATE 6 — PASS:** circuit-breaker, retry, goal and agent-failure suites pass;
   delivery now stops on a failed remote push instead of creating a misleading PR.
7. **GATE 7 — PASS:** chat thread/project/general-context and permission tests pass;
   a live read-only mutation attempt returned HTTP 403 from the backend.
8. **GATE 8 — PASS:** UI typecheck/build pass; the active chat has thread creation,
   deletion, loading feedback, auto-scroll and access context; the obsolete duplicate
   chat component was removed.
9. **GATE 9 — PASS:** goal/task prompts, provider routing and governed Skills were
   reviewed; task title/specification rules live in code, while prompts receive the
   bounded derived context rather than owning business rules.

The remaining release limitations are explicit below and are not hidden as green
provider/task states.

## Known release limitations

- Windows binaries are unsigned. GitHub Releases plus SHA-256 checksums are the
  free distribution path; SmartScreen may still show the first-download warning.
- The full development tree reports vulnerabilities in the Electron/build toolchain
  under `npm audit`; the runtime-only audit is clean. Do not claim the development
  toolchain is vulnerability-free until those upgrades are evaluated.
- Full Access is a governed Maestro action policy, not an unrestricted operating-system
  shell. Provider CLIs can still impose their own permission prompts or policies.

## Final gate status

The table is intentionally updated only after the final test/build run and remote PR
verification. A green local build alone is not evidence that PR #132 is mergeable.
