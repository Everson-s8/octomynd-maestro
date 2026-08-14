import type Database from "better-sqlite3";
import type {
  CapabilityRoutingPolicy,
  CapabilityRoutingUpdate,
  ProviderControl,
  ProviderControlUpdate,
  ProviderPolicySnapshot
} from "./policy.js";
import { defaultProviderPolicySnapshot } from "./policy.js";
import type { AgentCapability, AgentProviderId } from "./types.js";

type ProviderControlRow = {
  provider_id: AgentProviderId;
  mode: ProviderControl["mode"];
  fallback_enabled: number;
  model: string | null;
  updated_at: string;
};

type CapabilityRoutingRow = {
  capability: AgentCapability;
  provider_order_json: string;
  required_provider_id: AgentProviderId | null;
  preferred_model: string | null;
  updated_at: string;
};

export function migrateProviderPolicyPersistence(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS provider_controls (
      provider_id TEXT PRIMARY KEY,
      mode TEXT NOT NULL DEFAULT 'enabled' CHECK(mode IN ('enabled', 'paused', 'disabled')),
      fallback_enabled INTEGER NOT NULL DEFAULT 1 CHECK(fallback_enabled IN (0, 1)),
      model TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS provider_capability_routing (
      capability TEXT PRIMARY KEY,
      provider_order_json TEXT NOT NULL DEFAULT '[]',
      required_provider_id TEXT,
      preferred_model TEXT,
      updated_at TEXT NOT NULL
    );
  `);

  try {
    const controlColumns = db.prepare("PRAGMA table_info(provider_controls)").all() as Array<{ name: string }>;
    if (!controlColumns.some((col) => col.name === "model")) {
      db.exec("ALTER TABLE provider_controls ADD COLUMN model TEXT;");
    }
  } catch {}

  try {
    const routingColumns = db.prepare("PRAGMA table_info(provider_capability_routing)").all() as Array<{ name: string }>;
    if (!routingColumns.some((col) => col.name === "preferred_model")) {
      db.exec("ALTER TABLE provider_capability_routing ADD COLUMN preferred_model TEXT;");
    }
  } catch {}
}

export function createProviderPolicyPersistence(db: Database.Database) {
  const updateProviderControl = (input: ProviderControlUpdate): ProviderControl => {
    const now = new Date().toISOString();
    const existing = db.prepare("SELECT * FROM provider_controls WHERE provider_id = ?").get(input.providerId) as ProviderControlRow | undefined;
    const modelToSave = input.model !== undefined ? (input.model?.trim() || null) : (existing?.model ?? null);

    db.prepare(`
      INSERT INTO provider_controls (provider_id, mode, fallback_enabled, model, updated_at)
      VALUES (@providerId, @mode, @fallbackEnabled, @model, @now)
      ON CONFLICT(provider_id) DO UPDATE SET
        mode = excluded.mode,
        fallback_enabled = excluded.fallback_enabled,
        model = excluded.model,
        updated_at = excluded.updated_at
    `).run({
      providerId: input.providerId,
      mode: input.mode,
      fallbackEnabled: input.fallbackEnabled ? 1 : 0,
      model: modelToSave,
      now
    });
    return mapControl(db.prepare("SELECT * FROM provider_controls WHERE provider_id = ?")
      .get(input.providerId) as ProviderControlRow);
  };

  return {
    getProviderPolicySnapshot(): ProviderPolicySnapshot {
      const defaults = defaultProviderPolicySnapshot();
      const controls = db.prepare("SELECT * FROM provider_controls ORDER BY provider_id").all() as ProviderControlRow[];
      const rows = db.prepare("SELECT * FROM provider_capability_routing ORDER BY capability").all() as CapabilityRoutingRow[];
      const configured = new Map(rows.map((row) => [row.capability, mapRouting(row)]));
      return {
        controls: controls.map(mapControl),
        capabilities: defaults.capabilities.map((item) => configured.get(item.capability) ?? item)
      };
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

      db.prepare(`
        INSERT INTO provider_capability_routing (
          capability, provider_order_json, required_provider_id, preferred_model, updated_at
        ) VALUES (@capability, @orderJson, @requiredProviderId, @preferredModel, @now)
        ON CONFLICT(capability) DO UPDATE SET
          provider_order_json = excluded.provider_order_json,
          required_provider_id = excluded.required_provider_id,
          preferred_model = excluded.preferred_model,
          updated_at = excluded.updated_at
      `).run({
        capability: input.capability,
        orderJson: JSON.stringify([...new Set(input.order)]),
        requiredProviderId: input.requiredProviderId,
        preferredModel: preferredModelToSave,
        now
      });
      return mapRouting(db.prepare("SELECT * FROM provider_capability_routing WHERE capability = ?")
        .get(input.capability) as CapabilityRoutingRow);
    }
  };
}

function mapControl(row: ProviderControlRow): ProviderControl {
  return {
    providerId: row.provider_id,
    mode: row.mode,
    fallbackEnabled: Boolean(row.fallback_enabled),
    model: row.model ?? null,
    updatedAt: row.updated_at
  };
}

function mapRouting(row: CapabilityRoutingRow): CapabilityRoutingPolicy {
  return {
    capability: row.capability,
    order: JSON.parse(row.provider_order_json) as AgentProviderId[],
    requiredProviderId: row.required_provider_id,
    preferredModel: row.preferred_model ?? null,
    updatedAt: row.updated_at
  };
}
