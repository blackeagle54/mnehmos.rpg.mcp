/**
 * Fail-loud registry validation tests for ADR-001 Phase 1 (#13)
 *
 * buildConsolidatedRegistry() must reject a tool whose discovery metadata is
 * missing OR contains blank/whitespace-only keyword/capability strings — not
 * just empty arrays. (CodeRabbit finding on PR #34.)
 *
 * Each case mocks the ConsolidatedTools source and dynamically (re)imports the
 * registry module so its private build cache starts empty, then asserts the
 * guard fires. vi.resetModules() isolates the module-level cache per case.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';

const FAKE_HANDLER = async () => ({ ok: true });

function fakeTool(overrides: Record<string, unknown>) {
  return {
    tool: {
      name: 'fake_tool',
      description: 'fake',
      category: 'meta',
      keywords: ['keyword'],
      capabilities: ['Capability'],
      inputSchema: z.object({}), // a real Zod schema, matching ToolContract.inputSchema: z.ZodTypeAny
      ...overrides,
    },
    handler: FAKE_HANDLER,
  };
}

async function buildWith(toolOverrides: Record<string, unknown>) {
  vi.resetModules();
  vi.doMock('../../../src/server/consolidated/index.js', () => ({
    ConsolidatedTools: [fakeTool(toolOverrides)],
  }));
  const { buildConsolidatedRegistry } = await import(
    '../../../src/server/consolidated-registry.js'
  );
  return buildConsolidatedRegistry;
}

describe('buildConsolidatedRegistry fail-loud validation (#13)', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock('../../../src/server/consolidated/index.js');
  });

  it('rejects a tool with a blank keyword string', async () => {
    const build = await buildWith({ keywords: [''] });
    // Single invocation: the registry assigns its module-level cache to `{}`
    // before the validation loop throws, so a second call would return that
    // empty cache instead of re-throwing.
    expect(() => build()).toThrow(/fake_tool.*discovery metadata/s);
  });

  it('rejects a tool with a whitespace-only keyword string', async () => {
    const build = await buildWith({ keywords: ['valid', '   '] });
    expect(() => build()).toThrow(/fake_tool/);
  });

  it('rejects a tool with a blank capability string', async () => {
    const build = await buildWith({ capabilities: ['valid', ''] });
    expect(() => build()).toThrow(/fake_tool/);
  });

  it('rejects a tool with a non-string keyword', async () => {
    const build = await buildWith({ keywords: [123] });
    expect(() => build()).toThrow(/fake_tool/);
  });

  it('still rejects empty keyword arrays', async () => {
    const build = await buildWith({ keywords: [] });
    expect(() => build()).toThrow(/fake_tool/);
  });

  it('still rejects empty capability arrays', async () => {
    const build = await buildWith({ capabilities: [] });
    expect(() => build()).toThrow(/fake_tool/);
  });

  it('accepts a tool with non-blank keywords and capabilities', async () => {
    const build = await buildWith({
      keywords: ['alpha', 'beta'],
      capabilities: ['Does a thing'],
    });
    const registry = build();
    expect(registry.fake_tool).toBeDefined();
    expect(registry.fake_tool.metadata.keywords).toEqual(['alpha', 'beta']);
  });
});
