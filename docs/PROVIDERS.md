# Providers: catalog, connection and routing

Maestro is a harness. Codex, Claude, Antigravity and custom CLIs/endpoints are
interchangeable tools that the user connects. None of them is part of the
product, and none is used unless the user connected it.

## Catalog versus connection

- **Catalog (runtime adapters).** `createAgentRegistry` (`src/agents/runtime.ts`)
  always compiles the Codex and Claude adapters. It adds Antigravity when
  `runtime.antigravityEnabled` is set, and every custom provider from the
  user-owned provider config. Being in the catalog only means Maestro knows
  how to talk to the tool.
- **Connection (user decision).** Only providers listed in the
  `provider_connections` table are connected, plus custom providers saved in
  the provider config (saving one is an explicit decision). A fresh install
  has **no connected provider**.
- **Legacy cleanup.** An older migration promoted every enabled provider
  control into a connection, which made compiled-in providers look connected
  without login ("ghost providers"). `migrateProviderPolicyPersistence` marks
  those rows as `legacy` and deletes them.

`AgentRegistry.list()` returns connected providers only; the dashboard, CLI and
Telegram all read from it.

## Connect, disconnect, pause

| Action | Effect |
|---|---|
| Connect | `connectProvider` adds the connection (`connection_source = 'explicit'`) and starts health probing. |
| Disconnect / delete | `disconnectProvider` removes the connection, its controls and every mention in capability routing. The adapter stays dormant so it can be reconnected without restarting Maestro. It is refused while the provider has active work. |
| Pause or disable | The provider stays connected (still shown as a card) but is removed from every routing order and required-provider pin. |

## Routing

For each capability (`planning`, `coding`, `testing`, `reviewing`, …):

1. Start from the configured order, or the default order in `src/agents/policy.ts`.
2. Keep only providers whose control mode is `enabled`.
3. If a required provider is pinned, use only that provider.
4. If the first provider has `fallbackEnabled = false`, use only that provider.
5. **Keep only connected providers** (`AgentRegistry.providerOrder`).
6. Skip providers in cooldown, at their concurrency limit, or whose health is
   not `ready`.

A Goal's preferred provider (for example after the chat action
`switch_goal_provider`) is moved to the front only if it survives the filters
above, so a disconnected provider is never chosen. If nothing is eligible, the
Goal waits (`waiting_provider`) instead of borrowing an unconfigured provider.

## Codex execution flags

Writable Codex steps (implementing and testing) run with `--approve-for-me`
when the resolved CLI supports it. That flag already uses the workspace-write
sandbox and auto-reviews approvals, including the network access needed to
install dependencies. Codex rejects `--approve-for-me` together with `--sandbox`
(codex-cli 0.149 exits with code 2).

CLIs without the flag get
`--sandbox workspace-write --config sandbox_workspace_write.network_access=true`.
Read-only steps always use `--sandbox read-only`. Support is detected once per
CLI entry from `codex exec --help`. When several Codex installations exist,
`resolveCodexCliEntry` prefers the newest version found on `PATH` or in the
npm prefix.

## Where to verify behaviour

- `src/agents/registry.ts`, `src/agents/policy.ts`,
  `src/agents/policy-persistence.ts` and `src/agents/runtime.ts`.
- Tests: `test/registry*.test.ts`, `test/provider*.test.ts` and `test/codex.test.ts`.
- End to end, on a clean client:
  1. The app starts with no providers.
  2. Deleting a provider removes it from every surface.
  3. Forcing one provider to fail makes the work fall back only to other connected providers.
