#!/usr/bin/env node
/* Global `maestro` binary shim.
 *
 * Node cannot parse TypeScript directly, and the global `bin` runs via
 * plain `node`, not via the tsx CLI. This CommonJS shim registers the tsx
 * ESM loader before importing the real CLI entry, so a globally-installed
 * `maestro` works the same as `npx tsx src/cli/index.ts`.
 */
require("tsx/cjs");
require("./index");
