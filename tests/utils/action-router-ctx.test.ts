/**
 * Issue #14 — action-router explicit session-context threading.
 *
 * The router is the shared seam used by all 24 consolidated tools. To remove
 * the module-scoped `let currentContext` holders from the 5 router-based tools,
 * the router must forward an OPTIONAL 2nd `ctx` argument straight to each
 * ActionDefinition handler. These tests pin that contract:
 *
 *  1. ctx threading — the returned route function passes its 2nd arg to the
 *     matched handler as a 2nd positional arg. (RED on current code: the router
 *     calls `handler(parseResult.data)` with no ctx, so the handler observes
 *     `undefined`.)
 *  2. concurrency isolation — two interleaved route() calls carrying DISTINCT
 *     ctx objects, where each handler reads ctx AFTER a real `await`, must each
 *     observe their own ctx. This is the exact race the module-global pattern
 *     risked: a shared mutable holder set by call B between call A's await and
 *     A's post-await read would leak B's ctx into A. Threading makes each call
 *     carry its own ctx down its own stack. (RED today: ctx is never forwarded,
 *     so both handlers see `undefined` and the sessionId assertions fail.)
 *  3. backward compatibility — a 1-arg handler invoked via route(args) (no ctx)
 *     still works, proving the 19 other tools are unaffected.
 */

import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { createActionRouter } from '../../src/utils/action-router.js';

function parse(result: { content: Array<{ type: string; text: string }> }) {
    return JSON.parse(result.content[0].text);
}

describe('action-router explicit ctx threading (#14)', () => {
    it('forwards the 2nd ctx argument to the matched handler', async () => {
        const router = createActionRouter({
            actions: ['ping'] as const,
            definitions: {
                ping: {
                    schema: z.object({ action: z.literal('ping') }),
                    handler: (_args: unknown, ctx?: unknown) => ({
                        sessionId: (ctx as { sessionId?: string } | undefined)?.sessionId ?? null
                    })
                }
            }
        });

        const result = await router({ action: 'ping' }, { sessionId: 'ctx-123' });
        expect(parse(result).sessionId).toBe('ctx-123');
    });

    it('keeps each call\'s ctx isolated under interleaved concurrency', async () => {
        // Handlers that read ctx AFTER a real await — the precise shape a shared
        // module-global holder would corrupt. Threading keeps them isolated.
        const router = createActionRouter({
            actions: ['slow'] as const,
            definitions: {
                slow: {
                    schema: z.object({ action: z.literal('slow') }),
                    handler: async (_args: unknown, ctx?: unknown) => {
                        // Yield so the sibling call's synchronous prefix runs in between.
                        await new Promise<void>((r) => setTimeout(r, 5));
                        return { sessionId: (ctx as { sessionId?: string } | undefined)?.sessionId ?? null };
                    }
                }
            }
        });

        const ctxA = { sessionId: 'A-iso' };
        const ctxB = { sessionId: 'B-iso' };
        const [ra, rb] = await Promise.all([
            router({ action: 'slow' }, ctxA),
            router({ action: 'slow' }, ctxB)
        ]);

        expect(parse(ra).sessionId).toBe('A-iso');
        expect(parse(rb).sessionId).toBe('B-iso');
    });

    it('remains backward-compatible with 1-arg handlers and route(args)', async () => {
        const router = createActionRouter({
            actions: ['legacy'] as const,
            definitions: {
                legacy: {
                    schema: z.object({ action: z.literal('legacy'), value: z.number() }),
                    handler: (args: { value: number }) => ({ doubled: args.value * 2 })
                }
            }
        });

        // No ctx supplied — the 19 non-context tools call route(args) like this.
        const result = await router({ action: 'legacy', value: 21 });
        expect(parse(result).doubled).toBe(42);
    });
});
