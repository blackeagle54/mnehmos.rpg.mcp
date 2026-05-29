import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

import * as tools from '../../src/server/tools.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, '../../');

const adrPath = resolve(repoRoot, 'docs/issue-16-adr-004.md');
const toolsPath = resolve(repoRoot, 'src/server/tools.ts');

const adr = readFileSync(adrPath, 'utf8');
const toolsSource = readFileSync(toolsPath, 'utf8');

describe('ADR-004 finalized (compatibility mode, retain legacy tools.ts)', () => {
    it('marks the ADR Status as Accepted', () => {
        expect(adr).toMatch(/### Status\s*\n+\s*Accepted/);
    });

    it('has no unchecked acceptance-criteria boxes remaining', () => {
        expect(adr).not.toMatch(/^- \[ \]/m);
    });

    // Compatibility-mode lock: the legacy surface MUST stay live. This guards
    // against future removal of the Tools map / worldgen handlers that the
    // consolidated world-map tool (src/server/consolidated/world-map.ts) and
    // server integration tests still consume.
    it('keeps the legacy Tools map and worldgen handlers live', () => {
        expect(typeof tools.Tools).toBe('object');
        expect(typeof tools.handleGenerateWorld).toBe('function');
        expect(typeof tools.handleGetWorldMapOverview).toBe('function');
    });

    it('marks src/server/tools.ts with a @deprecated compatibility-mode banner', () => {
        expect(toolsSource).toMatch(/@deprecated/);
    });
});
