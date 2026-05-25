/**
 * Invalid-action suggestion rendering (#69)
 *
 * fuzzy-enum returns invalid-action suggestions as `{ value, similarity }`, but
 * many consolidated formatters used to read `{ action, similarity }` and rendered
 * `undefined (N% match)`. This shared test exercises the *rendered* (human-readable)
 * output across the consolidated tool layer — not just the embedded JSON — so the
 * field-name contract can't silently drift again.
 */

import { describe, it, expect } from 'vitest';
import { handleImprovisationManage } from '../../../src/server/consolidated/improvisation-manage.js';
import { handleWorldMap } from '../../../src/server/consolidated/world-map.js';
import { handleWorldManage } from '../../../src/server/consolidated/world-manage.js';
import { handleTurnManage } from '../../../src/server/consolidated/turn-manage.js';
import { handleInventoryManage } from '../../../src/server/consolidated/inventory-manage.js';
import { handleSpatialManage } from '../../../src/server/consolidated/spatial-manage.js';

process.env.NODE_ENV = 'test';

const ctx = { sessionId: 'test-suggestions' };

// Split the embedded JSON block (<!-- TAG_JSON\n...\nTAG_JSON -->) from the
// rendered (human-readable) portion that precedes it.
function splitResult(result: { content: Array<{ type: string; text: string }> }) {
    const text = result.content[0].text;
    const m = text.match(/<!-- (\w+)\n([\s\S]*?)\n\1 -->/);
    const json = m ? JSON.parse(m[2]) : null;
    const rendered = m && m.index !== undefined ? text.slice(0, m.index) : text;
    return { json, rendered };
}

type Handler = (args: unknown, ctx: { sessionId: string }) => Promise<{ content: Array<{ type: string; text: string }> }>;

const cases: Array<[string, Handler]> = [
    ['improvisation_manage', handleImprovisationManage as Handler],
    ['world_map', handleWorldMap as Handler],
    ['world_manage', handleWorldManage as Handler],
    ['turn_manage', handleTurnManage as Handler],
    ['inventory_manage', handleInventoryManage as Handler],
    ['spatial_manage', handleSpatialManage as Handler],
];

describe('invalid-action suggestions render action names, not undefined (#69)', () => {
    it.each(cases)('%s renders suggested action names in the human-readable output', async (_name, handler) => {
        const result = await handler({ action: 'zzdefinitelynotanaction' }, ctx);
        const { json, rendered } = splitResult(result);

        expect(json).not.toBeNull();
        expect(json.error).toBe('invalid_action');
        expect(Array.isArray(json.suggestions)).toBe(true);
        expect(json.suggestions.length).toBeGreaterThan(0);

        // Every suggested value from the JSON must appear in the rendered output...
        for (const s of json.suggestions) {
            expect(typeof s.value).toBe('string');
            expect(rendered).toContain(s.value);
        }
        // ...and the old bug signature (undefined in the suggestion list) is gone.
        expect(rendered).not.toContain('undefined (');
    });
});
