/**
 * Consolidated Save Management Tool (Phase 5 — Campaign Save Bundles).
 *
 * One consolidated capability with two halves:
 *   - export: serialize ONE campaign (scoped by worldId, optionally narrowed to a
 *     single partyId) into a self-contained JSON bundle, keeping every row's UUID
 *     VERBATIM, and
 *   - import: re-insert that bundle with the SAME UUIDs via upsert inside ONE
 *     transaction, in FK-safe order. "Load == restore/overwrite this campaign."
 *
 * Design decision (FROZEN):
 *   - Preserve UUIDs + transactional upsert. We never remap IDs — every foreign
 *     key (party_members.character_id, inventory_items.item_id, quests.world_id,
 *     reputation→factionId, …) stays valid because the referenced rows keep their
 *     original UUIDs. import re-inserts with INSERT ... ON CONFLICT(pk) DO UPDATE
 *     so importing the same bundle twice converges (idempotent) and a diverged
 *     live row is overwritten back to the bundle's state.
 *   - Validate the bundle shape + schemaVersion BEFORE touching the DB, then run
 *     ALL writes inside a single db.transaction(...). A malformed/partial bundle
 *     therefore never half-writes (no-clobber): either the whole campaign lands
 *     or nothing does.
 *
 * What the bundle INCLUDES (the player-facing campaign — enough to faithfully
 * restore a save):
 *   worlds, parties, party_members, characters (incl. their skills/achievements/
 *   reputation JSON columns), items, inventory_items, quests, quest_logs,
 *   factions, secrets, narrative_notes.
 *
 * What the bundle EXCLUDES and why:
 *   The DERIVED worldgen tables — regions, tiles, structures, rivers, room_nodes
 *   — are NOT serialized. They regenerate deterministically from worlds.seed +
 *   worlds.gen_options (both carried verbatim on the world row), so shipping them
 *   would bloat the save with cheaply-reproducible data. (Nations / diplomacy /
 *   turn-state strategy-sim tables are likewise out of scope for a player save.)
 *
 * Philosophy: "LLM describes, engine validates; the database is the source of
 * truth." The engine owns serialization of its own rows — export reads full rows
 * verbatim and import writes them back verbatim, with the Zod bundle envelope as
 * the only contract the caller sees.
 */

import { z } from 'zod';
import Database from 'better-sqlite3';
import { createActionRouter, ActionDefinition, McpResponse } from '../../utils/action-router.js';
import { SessionContext } from '../types.js';
import { RichFormatter } from '../utils/formatter.js';
import { getDb } from '../../storage/index.js';
import { resolveConsolidatedDbPath } from './db-path.js';
import { WorldRepository } from '../../storage/repos/world.repo.js';
import { ToolContract } from '../tool-metadata.js';

// ═══════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════

const ACTIONS = ['export', 'import'] as const;
type SaveManageAction = typeof ACTIONS[number];

/** The only save-bundle schema version this build can read/write. */
const SCHEMA_VERSION = 1;

/**
 * The campaign tables a bundle carries, in FK-safe PARENT→CHILD order (import
 * walks this array front-to-back so parents land before the children that
 * reference them).
 *
 * Each entry declares:
 *  - key:        the bundle field name (== the SQL table name),
 *  - table:      the SQL table,
 *  - pk:         the PRIMARY KEY column(s) for the ON CONFLICT upsert target.
 *
 * `items` and `factions` are GLOBAL (un-scoped) tables; export collects only the
 * rows the campaign actually references (the items its characters carry, the
 * factions its characters have reputation/affiliation with) so a bundle stays
 * self-contained without dragging the entire global catalog.
 */
interface BundleTable {
    key: string;
    table: string;
    pk: string[];
}

const BUNDLE_TABLES: BundleTable[] = [
    // Root identity.
    { key: 'worlds', table: 'worlds', pk: ['id'] },
    // Global catalogs the campaign references (no world scoping of their own).
    { key: 'items', table: 'items', pk: ['id'] },
    { key: 'factions', table: 'factions', pk: ['id'] },
    // Characters (referenced by party_members / inventory_items / quest_logs).
    { key: 'characters', table: 'characters', pk: ['id'] },
    // Parties depend on worlds; members depend on parties + characters.
    { key: 'parties', table: 'parties', pk: ['id'] },
    { key: 'party_members', table: 'party_members', pk: ['id'] },
    // Inventory rows depend on characters + items.
    { key: 'inventory_items', table: 'inventory_items', pk: ['character_id', 'item_id'] },
    // Quests depend on worlds; quest logs depend on characters.
    { key: 'quests', table: 'quests', pk: ['id'] },
    { key: 'quest_logs', table: 'quest_logs', pk: ['character_id'] },
    // World-scoped narrative state.
    { key: 'secrets', table: 'secrets', pk: ['id'] },
    { key: 'narrative_notes', table: 'narrative_notes', pk: ['id'] },
];

// A row is an opaque column→value map; export/import never inspect column
// meaning, only column NAMES (read from the live row / re-bound on insert), so a
// future ALTER TABLE flows through without touching this tool.
type Row = Record<string, unknown>;

// ═══════════════════════════════════════════════════════════════════════════
// DATABASE HELPER
// ═══════════════════════════════════════════════════════════════════════════

function ensureDb(): Database.Database {
    const db = getDb(resolveConsolidatedDbPath());
    // The worlds table's `environment` / `gen_options` columns are added LAZILY
    // by WorldRepository's constructor, not by migrate(). On a never-touched DB
    // (e.g. a fresh install loading a save) those columns would be missing and a
    // verbatim INSERT of a world row carrying them would fail. Instantiating the
    // repo here is the idempotent way to guarantee the full schema before we
    // read or write world rows. (Other tables' migration columns are all added
    // in migrate(), which getDb() already ran.)
    new WorldRepository(db);
    return db;
}

// ═══════════════════════════════════════════════════════════════════════════
// EXPORT — read the campaign's rows verbatim (UUIDs preserved)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Collect every row of one campaign, scoped by worldId (+ optional partyId).
 *
 * Scoping chain:
 *   worlds      → id = worldId
 *   parties     → world_id = worldId  (narrowed to id = partyId when given)
 *   party_members → party_id ∈ (this campaign's parties)
 *   characters  → id ∈ (those members' character_id) — characters carry NO
 *                 world_id column, so they are reachable ONLY transitively
 *                 through party membership.
 *   items       → id ∈ (those characters' inventory item_id) — global catalog,
 *                 restricted to what the campaign references.
 *   factions    → id ∈ (those characters' faction_id ∪ reputation-map keys) —
 *                 global catalog, restricted to referenced factions.
 *   inventory_items → character_id ∈ (campaign characters)
 *   quests      → world_id = worldId
 *   quest_logs  → character_id ∈ (campaign characters)
 *   secrets / narrative_notes → world_id = worldId
 */
function collectCampaign(db: Database.Database, worldId: string, partyId?: string): Record<string, Row[]> | null {
    const world = db.prepare('SELECT * FROM worlds WHERE id = ?').get(worldId) as Row | undefined;
    if (!world) return null;

    // Parties for this campaign (optionally a single party).
    const parties = (partyId
        ? db.prepare('SELECT * FROM parties WHERE world_id = ? AND id = ?').all(worldId, partyId)
        : db.prepare('SELECT * FROM parties WHERE world_id = ?').all(worldId)) as Row[];

    const partyIds = parties.map((p) => String(p.id));

    // Members of those parties → the set of campaign characters.
    const party_members: Row[] = [];
    const characterIds = new Set<string>();
    if (partyIds.length > 0) {
        const placeholders = partyIds.map(() => '?').join(',');
        const members = db
            .prepare(`SELECT * FROM party_members WHERE party_id IN (${placeholders})`)
            .all(...partyIds) as Row[];
        for (const m of members) {
            party_members.push(m);
            characterIds.add(String(m.character_id));
        }
    }

    const charIds = [...characterIds];
    const characters: Row[] = [];
    const inventory_items: Row[] = [];
    const quest_logs: Row[] = [];
    const itemIds = new Set<string>();
    const factionIds = new Set<string>();

    if (charIds.length > 0) {
        const placeholders = charIds.map(() => '?').join(',');

        const charRows = db
            .prepare(`SELECT * FROM characters WHERE id IN (${placeholders})`)
            .all(...charIds) as Row[];
        for (const c of charRows) {
            characters.push(c);
            // Referenced factions: the character's faction_id + every key in its
            // reputation JSON map (the standing the save must restore).
            if (c.faction_id) factionIds.add(String(c.faction_id));
            if (typeof c.reputation === 'string' && c.reputation) {
                try {
                    const rep = JSON.parse(c.reputation) as Record<string, unknown>;
                    for (const fid of Object.keys(rep)) factionIds.add(fid);
                } catch {
                    // Malformed live reputation column — skip faction harvesting for
                    // this character rather than abort the whole export; the raw
                    // column is still serialized verbatim below.
                }
            }
        }

        const invRows = db
            .prepare(`SELECT * FROM inventory_items WHERE character_id IN (${placeholders})`)
            .all(...charIds) as Row[];
        for (const ii of invRows) {
            inventory_items.push(ii);
            itemIds.add(String(ii.item_id));
        }

        const logRows = db
            .prepare(`SELECT * FROM quest_logs WHERE character_id IN (${placeholders})`)
            .all(...charIds) as Row[];
        quest_logs.push(...logRows);
    }

    // Referenced items (global catalog, restricted to what the campaign carries).
    const items: Row[] = [];
    if (itemIds.size > 0) {
        const ids = [...itemIds];
        const placeholders = ids.map(() => '?').join(',');
        items.push(...(db.prepare(`SELECT * FROM items WHERE id IN (${placeholders})`).all(...ids) as Row[]));
    }

    // Referenced factions (global catalog, restricted to referenced factions).
    const factions: Row[] = [];
    if (factionIds.size > 0) {
        const ids = [...factionIds];
        const placeholders = ids.map(() => '?').join(',');
        factions.push(...(db.prepare(`SELECT * FROM factions WHERE id IN (${placeholders})`).all(...ids) as Row[]));
    }

    const quests = db.prepare('SELECT * FROM quests WHERE world_id = ?').all(worldId) as Row[];
    const secrets = db.prepare('SELECT * FROM secrets WHERE world_id = ?').all(worldId) as Row[];
    const narrative_notes = db.prepare('SELECT * FROM narrative_notes WHERE world_id = ?').all(worldId) as Row[];

    return {
        worlds: [world],
        items,
        factions,
        characters,
        parties,
        party_members,
        inventory_items,
        quests,
        quest_logs,
        secrets,
        narrative_notes,
    };
}

// ═══════════════════════════════════════════════════════════════════════════
// IMPORT — validate, then upsert verbatim inside ONE transaction
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Validate the bundle envelope BEFORE any write. We deliberately keep this loose
 * on a row's INNER shape (rows are opaque column maps the engine round-trips)
 * but STRICT on the envelope: schemaVersion must equal SCHEMA_VERSION and every
 * present table key must be an array of objects. This is what makes the
 * "validate-before-write / no-clobber" guarantee real — a wrong-version or
 * structurally-malformed bundle is rejected here, before db.transaction runs.
 */
const RowSchema = z.record(z.unknown());
const RowArraySchema = z.array(RowSchema);

function validateBundle(bundle: unknown, declaredVersion?: number): { ok: true; tables: Record<string, Row[]> } | { ok: false; message: string } {
    if (typeof bundle !== 'object' || bundle === null || Array.isArray(bundle)) {
        return { ok: false, message: 'Bundle must be an object' };
    }
    const b = bundle as Record<string, unknown>;

    // schemaVersion: trust the bundle's own field first, fall back to the
    // explicit arg; either way it MUST equal the supported version.
    const version = (typeof b.schemaVersion === 'number' ? b.schemaVersion : declaredVersion);
    if (version !== SCHEMA_VERSION) {
        return {
            ok: false,
            message: `Unsupported save schemaVersion ${version ?? '(missing)'} — this build reads schemaVersion ${SCHEMA_VERSION}`,
        };
    }

    // worlds is the campaign root and must be a non-empty array.
    const worldsParse = RowArraySchema.safeParse(b.worlds);
    if (!worldsParse.success || worldsParse.data.length === 0) {
        return { ok: false, message: 'Bundle.worlds must be a non-empty array' };
    }

    // Every PRESENT table key must be an array of row objects. Absent keys
    // default to [] (a bundle need not carry empty tables).
    const tables: Record<string, Row[]> = {};
    for (const { key } of BUNDLE_TABLES) {
        if (b[key] === undefined) {
            tables[key] = [];
            continue;
        }
        const parsed = RowArraySchema.safeParse(b[key]);
        if (!parsed.success) {
            return { ok: false, message: `Bundle.${key} must be an array of rows` };
        }
        tables[key] = parsed.data as Row[];
    }

    return { ok: true, tables };
}

/**
 * Upsert one row verbatim into `table`, keying the ON CONFLICT on `pk`. Column
 * names come from the row itself, so the write mirrors whatever export read —
 * no per-table column list to drift from the schema.
 */
function upsertRow(db: Database.Database, table: string, pk: string[], row: Row): void {
    const cols = Object.keys(row);
    if (cols.length === 0) return;

    const colList = cols.map((c) => `"${c}"`).join(', ');
    const placeholders = cols.map((c) => `@${c}`).join(', ');

    // Update every NON-pk column on conflict (the pk columns are the match key).
    const pkSet = new Set(pk);
    const updates = cols
        .filter((c) => !pkSet.has(c))
        .map((c) => `"${c}" = excluded."${c}"`)
        .join(', ');

    const conflictTarget = pk.map((c) => `"${c}"`).join(', ');
    const onConflict = updates
        ? `ON CONFLICT(${conflictTarget}) DO UPDATE SET ${updates}`
        : // A row that is ALL primary key (e.g. a pure join row) has nothing to
          // update — DO NOTHING keeps the upsert idempotent without a no-op SET.
          `ON CONFLICT(${conflictTarget}) DO NOTHING`;

    db.prepare(`INSERT INTO "${table}" (${colList}) VALUES (${placeholders}) ${onConflict}`).run(row);
}

// ═══════════════════════════════════════════════════════════════════════════
// ACTION SCHEMAS
// ═══════════════════════════════════════════════════════════════════════════

const ExportSchema = z.object({
    action: z.literal('export'),
    worldId: z.string().describe('Campaign root world ID to export'),
    partyId: z.string().optional().describe('Narrow the export to a single party in that world'),
});

const ImportSchema = z.object({
    action: z.literal('import'),
    bundle: z.unknown().describe('A save bundle produced by export'),
    schemaVersion: z.number().optional().describe('Expected schema version (defaults to the bundle\'s own)'),
});

// ═══════════════════════════════════════════════════════════════════════════
// ACTION HANDLERS
// ═══════════════════════════════════════════════════════════════════════════

async function handleExport(args: z.infer<typeof ExportSchema>): Promise<object> {
    const db = ensureDb();

    const collected = collectCampaign(db, args.worldId, args.partyId);
    if (!collected) {
        return { error: true, message: `World ${args.worldId} not found` };
    }

    // The bundle is self-describing: it carries its own schemaVersion so a file
    // on disk can be validated without out-of-band metadata.
    const bundle = { schemaVersion: SCHEMA_VERSION, ...collected };

    return {
        success: true,
        actionType: 'export',
        schemaVersion: SCHEMA_VERSION,
        worldId: args.worldId,
        counts: Object.fromEntries(BUNDLE_TABLES.map(({ key }) => [key, collected[key].length])),
        bundle,
    };
}

async function handleImport(args: z.infer<typeof ImportSchema>): Promise<object> {
    const db = ensureDb();

    // Validate-before-write: a wrong-version or malformed bundle is rejected here,
    // before the transaction runs, so the DB is never touched on a bad bundle.
    const validated = validateBundle(args.bundle, args.schemaVersion);
    if (!validated.ok) {
        return { error: true, message: validated.message };
    }
    const tables = validated.tables;

    // ONE transaction for the whole campaign: better-sqlite3's db.transaction
    // wrapper rolls back automatically if the function throws, so a row that
    // violates a constraint mid-import leaves the DB untouched (no half-write).
    const imported = db.transaction(() => {
        const counts: Record<string, number> = {};
        // Front-to-back == FK-safe PARENT→CHILD order (see BUNDLE_TABLES).
        for (const { key, table, pk } of BUNDLE_TABLES) {
            const rows = tables[key];
            for (const row of rows) {
                upsertRow(db, table, pk, row);
            }
            counts[key] = rows.length;
        }
        return counts;
    })();

    return {
        success: true,
        actionType: 'import',
        schemaVersion: SCHEMA_VERSION,
        imported,
    };
}

// ═══════════════════════════════════════════════════════════════════════════
// ACTION ROUTER
// ═══════════════════════════════════════════════════════════════════════════

const definitions: Record<SaveManageAction, ActionDefinition> = {
    export: {
        schema: ExportSchema,
        handler: handleExport,
        aliases: ['save', 'backup', 'dump'],
        description: 'Export one campaign (scoped by worldId) into a self-contained save bundle',
    },
    import: {
        schema: ImportSchema,
        handler: handleImport,
        aliases: ['load', 'restore'],
        description: 'Import a save bundle, restoring/overwriting the campaign with its original UUIDs',
    },
};

const router = createActionRouter({
    actions: ACTIONS,
    definitions,
    threshold: 0.6,
});

// ═══════════════════════════════════════════════════════════════════════════
// TOOL DEFINITION & HANDLER
// ═══════════════════════════════════════════════════════════════════════════

export const SaveManageTool = {
    name: 'save_manage',
    // category:'meta' — a session/meta capability (like session_manage and
    // batch_manage), reusing an existing ToolCategory union member rather than
    // widening it. A save bundle is a whole-campaign serialization, not a single
    // domain axis.
    category: 'meta',
    keywords: ['save', 'load', 'export', 'import', 'backup', 'campaign'],
    capabilities: ['Campaign export', 'Campaign import', 'Save bundles'],
    description: `Manage campaign save files: export one campaign into a self-contained bundle and import it back, preserving every UUID (load == restore/overwrite this exact campaign).
Actions: export, import
Aliases: save/backup/dump→export, load/restore→import

💾 SAVE WORKFLOW:
1. export({ worldId }) - serialize ONE campaign (optionally narrowed to a partyId) into a JSON bundle, keeping every row's UUID verbatim
2. import({ bundle }) - validate schemaVersion + shape, then upsert every entity (same UUIDs) inside ONE transaction, in FK-safe order

Bundle INCLUDES: worlds (with seed + gen_options), parties, party_members, characters (incl. skills/achievements/reputation), items, inventory_items, quests, quest_logs, factions, secrets, narrative_notes.
Bundle EXCLUDES the derived worldgen tables (regions/tiles/structures/rivers/room_nodes) — they regenerate deterministically from the world's seed + gen_options, so they are not stored in the save.`,
    inputSchema: z.object({
        action: z.string().describe(`Action: ${ACTIONS.join(', ')}`),
        worldId: z.string().optional().describe('Campaign root world ID (for export)'),
        partyId: z.string().optional().describe('Narrow export to a single party (for export)'),
        bundle: z.unknown().optional().describe('A save bundle produced by export (for import)'),
        schemaVersion: z.number().optional().describe('Expected schema version (for import)'),
    }),
} satisfies ToolContract;

export async function handleSaveManage(args: unknown, _ctx: SessionContext): Promise<McpResponse> {
    const result = await router(args as Record<string, unknown>);
    const parsed = JSON.parse(result.content[0].text);

    let output = '';

    if (parsed.error) {
        output = RichFormatter.header('Error', '❌');
        output += RichFormatter.alert(parsed.message || 'Unknown error', 'error');
        if (parsed.suggestions) {
            output += '\n**Did you mean:**\n';
            parsed.suggestions.forEach((s: { value: string; similarity: number }) => {
                output += `  • ${s.value} (${s.similarity}% match)\n`;
            });
        }
    } else {
        switch (parsed.actionType) {
            case 'export':
                output = RichFormatter.header('Campaign Exported', '💾');
                output += RichFormatter.keyValue({
                    'World': parsed.worldId,
                    'Schema': `v${parsed.schemaVersion}`,
                    'Characters': parsed.counts?.characters,
                    'Parties': parsed.counts?.parties,
                    'Quests': parsed.counts?.quests,
                    'Items': parsed.counts?.items,
                });
                break;
            case 'import':
                output = RichFormatter.header('Campaign Imported', '📂');
                if (parsed.imported && typeof parsed.imported === 'object') {
                    output += RichFormatter.section('Restored');
                    for (const [table, n] of Object.entries(parsed.imported)) {
                        output += `- **${table}**: ${n}\n`;
                    }
                }
                output += RichFormatter.success('Campaign restored (UUIDs preserved).');
                break;
            default:
                output = RichFormatter.header('Save', '💾');
                if (parsed.message) output += parsed.message + '\n';
        }
    }

    output += RichFormatter.embedJson(parsed, 'SAVE_MANAGE');

    return {
        content: [{
            type: 'text' as const,
            text: output,
        }],
    };
}
