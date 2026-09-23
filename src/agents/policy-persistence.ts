import type Database from "better-sqlite3";
import type {
  CapabilityRoutingPolicy,
  CapabilityRoutingUpdate,
  ProviderControl,
  ProviderControlUpdate,
  ProviderPolicySnapshot
} from "./policy.js";
import { defaultProviderPolicySnapshot } from "./policy.js";
import type { AgentCapability, AgentProviderId, AgentReasoningEffort } from "./types.js";

type ProviderControlRow = {
  provider_id: AgentProviderId;
  mode: ProviderControl["mode"];
  fallback_enabled: number;
  model: string | null;
  effort: AgentReasoningEffort | null;
  updated_at: string;
};

type CapabilityRoutingRow = {
  capability: AgentCapability;
  provider_order_json: string;
  required_provider_id: AgentProviderId | null;
  preferred_model: string | null;
  preferred_effort: AgentReasoningEffort | null;
  updated_at: string;
};

export function migrateProviderPolicyPersistence(db: Database.Database) {
  const hadConnectionTable = db.prepare(
    "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'provider_connections'"
  ).get() !== undefined;
  db.exec(`
    CREATE TABLE IF NOT EXISTS provider_connections (
      provider_id TEXT PRIMARY KEY,
      connected_at TEXT NOT NULL,
      connection_source TEXT NOT NULL DEFAULT 'explicit'
    );

    CREATE TABLE IF NOT EXISTS provider_controls (
      provider_id TEXT PRIMARY KEY,
      mode TEXT NOT NULL DEFAULT 'enabled' CHECK(mode IN ('enabled', 'paused', 'disabled')),
      fallback_enabled INTEGER NOT NULL DEFAULT 1 CHECK(fallback_enabled IN (0, 1)),
      model TEXT,
      effort TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS provider_capability_routing (
      capability TEXT PRIMARY KEY,
      provider_order_json TEXT NOT NULL DEFAULT '[]',
      required_provider_id TEXT,
      preferred_model TEXT,
      preferred_effort TEXT,
      updated_at TEXT NOT NULL
    );
  `);

  // A previous migration promoted every enabled provider control into an
  // active connection. That made compiled-in providers appear as connected
  // even when the user had never authenticated them. Existing rows from that
  // migration are explicitly stale and must not be routed or shown as active.
  // A fresh table uses the explicit default above; an older table is marked
  // legacy when the source column is added and cleaned once.
  if (hadConnectionTable) {
    const connectionColumns = db.prepare("PRAGMA table_info(provider_connections)").all() as Array<{ name: string }>;
    if (!connectionColumns.some((col) => col.name === "connection_source")) {
      db.exec("ALTER TABLE provider_connections ADD COLUMN connection_source TEXT NOT NULL DEFAULT 'legacy';");
    }
    db.exec("DELETE FROM provider_connections WHERE connection_source = 'legacy';");
  }

  try {
    const controlColumns = db.prepare("PRAGMA table_info(provider_controls)").all() as Array<{ name: string }>;
    if (!controlColumns.some((col) => col.name === "model")) {
      db.exec("ALTER TABLE provider_controls ADD COLUMN model TEXT;");
    }
    if (!controlColumns.some((col) => col.name === "effort")) {
      db.exec("ALTER TABLE provider_controls ADD COLUMN effort TEXT;");
    }
  } catch {}

  try {
    const routingColumns = db.prepare("PRAGMA table_info(provider_capability_routing)").all() as Array<{ name: string }>;
    if (!routingColumns.some((col) => col.name === "preferred_model")) {
      db.exec("ALTER TABLE provider_capability_routing ADD COLUMN preferred_model TEXT;");
    }
    if (!routingColumns.some((col) => col.name === "preferred_effort")) {
      db.exec("ALTER TABLE provider_capability_routing ADD COLUMN preferred_effort TEXT;");
    }
  } catch {}
}

export function createProviderPolicyPersistence(db: Database.Database) {
  const getProviderPolicySnapshot = (): ProviderPolicySnapshot => {
    const defaults = defaultProviderPolicySnapshot();
    const controls = db.prepare("SELECT * FROM provider_controls ORDER BY provider_id").all() as ProviderControlRow[];
    const rows = db.prepare("SELECT * FROM provider_capability_routing ORDER BY capability").all() as CapabilityRoutingRow[];
    const configured = new Map(rows.map((row) => [row.capability, mapRouting(row)]));
    return {
      controls: controls.map(mapControl),
      // NOTE: the raw snapshot preserves the configured order (including paused/
      // disabled providers) so persistence round-trips. The UI layer filters
      // paused/disabled providers out for rendering the Control plane.
      capabilities: defaults.capabilities.map((item) => configured.get(item.capability) ?? item)
    };
  };

  const updateProviderControl = (input: ProviderControlUpdate): ProviderControl => {
    const now = new Date().toISOString();
    const existing = db.prepare("SELECT * FROM provider_controls WHERE provider_id = ?").get(input.providerId) as ProviderControlRow | undefined;
    const modelToSave = input.model !== undefined ? (input.model?.trim() || null) : (existing?.model ?? null);
    const effortToSave = input.effort !== undefined ? (input.effort || null) : (existing?.effort ?? null);

    db.prepare(`
      INSERT INTO provider_controls (provider_id, mode, fallback_enabled, model, effort, updated_at)
      VALUES (@providerId, @mode, @fallbackEnabled, @model, @effort, @now)
      ON CONFLICT(provider_id) DO UPDATE SET
        mode = excluded.mode,
        fallback_enabled = excluded.fallback_enabled,
        model = excluded.model,
        effort = excluded.effort,
        updated_at = excluded.updated_at
    `).run({
      providerId: input.providerId,
      mode: input.mode,
      fallbackEnabled: input.fallbackEnabled ? 1 : 0,
      model: modelToSave,
      effort: effortToSave,
      now
    });

    // When a provider is paused (or disabled) it must stop being routable:
    // remove it from every capability's order / required_provider_id so it no
    // longer appears as an option or the selected "first" in the Control plane.
    // (A paused provider stays connected/listed as a card, but isn't routed.)
    if (input.mode === "paused" || input.mode === "disabled") {
      const rows = db.prepare("SELECT * FROM provider_capability_routing").all() as CapabilityRoutingRow[];
      for (const row of rows) {
        const order = (JSON.parse(row.provider_order_json) as AgentProviderId[])
          .filter((item) => item !== input.providerId);
        const requiredProviderId = row.required_provider_id === input.providerId ? null : row.required_provider_id;
        const preferredModel = row.required_provider_id === input.providerId ? null : row.preferred_model;
        const preferredEffort = row.required_provider_id === input.providerId ? null : normalizeEffort(row.preferred_effort);
        db.prepare(`
          UPDATE provider_capability_routing
          SET provider_order_json = ?, required_provider_id = ?, preferred_model = ?, preferred_effort = ?, updated_at = ?
          WHERE capability = ?
        `).run(JSON.stringify(order), requiredProviderId, preferredModel, preferredEffort, now, row.capability);
      }
    }
    return mapControl(db.prepare("SELECT * FROM provider_controls WHERE provider_id = ?")
      .get(input.providerId) as ProviderControlRow);
  };

  return {
    getProviderPolicySnapshot,

    listConnectedProviderIds(): AgentProviderId[] {
      return (db.prepare("SELECT provider_id FROM provider_connections ORDER BY provider_id").all() as Array<{ provider_id: AgentProviderId }>)
        .map((row) => row.provider_id);
    },

    markProviderConnected(providerId: AgentProviderId): void {
      db.prepare(`
        INSERT INTO provider_connections (provider_id, connected_at, connection_source)
        VALUES (?, ?, 'explicit')
        ON CONFLICT(provider_id) DO NOTHING
      `).run(providerId, new Date().toISOString());
    },

    removeProviderConnection(providerId: AgentProviderId): void {
      db.prepare("DELETE FROM provider_connections WHERE provider_id = ?").run(providerId);
    },

    updateProviderControl,

    updateProviderControls(inputs: ProviderControlUpdate[]): ProviderControl[] {
      return db.transaction(() => inputs.map(updateProviderControl))();
    },

    updateCapabilityRouting(input: CapabilityRoutingUpdate): CapabilityRoutingPolicy {
      const now = new Date().toISOString();
      const existing = db.prepare("SELECT * FROM provider_capability_routing WHERE capability = ?").get(input.capability) as CapabilityRoutingRow | undefined;
      const preferredModelToSave = input.preferredModel !== undefined
        ? (input.preferredModel?.trim() || null)
        : (existing?.preferred_model ?? null);
      const preferredEffortToSave = input.preferredEffort !== undefined
        ? (input.preferredEffort ?? null)
        : normalizeEffort(existing?.preferred_effort);

      db.prepare(`
        INSERT INTO provider_capability_routing (
          capability, provider_order_json, required_provider_id, preferred_model, preferred_effort, updated_at
        ) VALUES (@capability, @orderJson, @requiredProviderId, @preferredModel, @preferredEffort, @now)
        ON CONFLICT(capability) DO UPDATE SET
          provider_order_json = excluded.provider_order_json,
          required_provider_id = excluded.required_provider_id,
          preferred_model = excluded.preferred_model,
          preferred_effort = excluded.preferred_effort,
          updated_at = excluded.updated_at
      `).run({
        capability: input.capability,
        orderJson: JSON.stringify([...new Set(input.order)]),
        requiredProviderId: input.requiredProviderId,
        preferredModel: preferredModelToSave,
        preferredEffort: preferredEffortToSave,
        now
      });
      return mapRouting(db.prepare("SELECT * FROM provider_capability_routing WHERE capability = ?")
        .get(input.capability) as CapabilityRoutingRow);
    },

    removeProvider(providerId: AgentProviderId): ProviderPolicySnapshot {
      return db.transaction(() => {
        db.prepare("DELETE FROM provider_connections WHERE provider_id = ?").run(providerId);
        db.prepare("DELETE FROM provider_controls WHERE provider_id = ?").run(providerId);
        const rows = db.prepare("SELECT * FROM provider_capability_routing").all() as CapabilityRoutingRow[];
        const now = new Date().toISOString();
        for (const row of rows) {
          const order = (JSON.parse(row.provider_order_json) as AgentProviderId[])
            .filter((item) => item !== providerId);
          const requiredProviderId = row.required_provider_id === providerId ? null : row.required_provider_id;
          const preferredModel = row.required_provider_id === providerId ? null : row.preferred_model;
          const preferredEffort = row.required_provider_id === providerId ? null : normalizeEffort(row.preferred_effort);
          db.prepare(`
            UPDATE provider_capability_routing
            SET provider_order_json = ?, required_provider_id = ?, preferred_model = ?, preferred_effort = ?, updated_at = ?
            WHERE capability = ?
          `).run(JSON.stringify(order), requiredProviderId, preferredModel, preferredEffort, now, row.capability);
        }
        return getProviderPolicySnapshot();
      })();
    }
  };
}

function mapControl(row: ProviderControlRow): ProviderControl {
  return {
    providerId: row.provider_id,
    mode: row.mode,
    fallbackEnabled: Boolean(row.fallback_enabled),
    model: row.model ?? null,
    effort: normalizeEffort(row.effort),
    updatedAt: row.updated_at
  };
}

function normalizeEffort(value: string | null | undefined): AgentReasoningEffort | null {
  return value === "minimal" || value === "low" || value === "medium" || value === "high" || value === "extra_high" || value === "max" || value === "ultra"
    ? value
    : null;
}

function mapRouting(row: CapabilityRoutingRow): CapabilityRoutingPolicy {
  return {
    capability: row.capability,
    order: JSON.parse(row.provider_order_json) as AgentProviderId[],
    requiredProviderId: row.required_provider_id,
    preferredModel: row.preferred_model ?? null,
    preferredEffort: normalizeEffort(row.preferred_effort),
    updatedAt: row.updated_at
  };
}
