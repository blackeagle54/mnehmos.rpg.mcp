import { z } from 'zod';
import { PubSub } from '../engine/pubsub.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { withSession } from './types.js';

export const EventTools = {
    SUBSCRIBE: {
        name: 'subscribe_to_events',
        description: 'Subscribe to real-time events on world or combat topics. Events sent as JSON-RPC notifications.',
        inputSchema: z.object({
            topics: z.array(z.enum(['world', 'combat'])).min(1)
        })
    },
    UNSUBSCRIBE: {
        name: 'unsubscribe_from_events',
        description: 'Unsubscribe from all event topics',
        inputSchema: z.object({})
    }
} as const;

// Track subscriptions per session
const activeSubscriptions: Map<string, Array<() => void>> = new Map();

export function registerEventTools(server: McpServer, pubsub: PubSub) {
    server.tool(
        EventTools.SUBSCRIBE.name,
        EventTools.SUBSCRIBE.description,
        EventTools.SUBSCRIBE.inputSchema.extend({ sessionId: z.string().optional() }).shape,
        withSession(EventTools.SUBSCRIBE.inputSchema, async (args, ctx) => {
            const { sessionId } = ctx;

            // Clean up previous subscriptions for this session
            const existing = activeSubscriptions.get(sessionId) || [];
            existing.forEach(unsub => unsub());

            const newSubs: Array<() => void> = [];

            for (const topic of args.topics) {
                const unsub = pubsub.subscribe(topic, (payload) => {
                    server.server.notification({
                        method: 'notifications/rpg/event',
                        params: {
                            topic,
                            payload,
                            sessionId // Optional: include sessionId in notification so client knows which session it's for
                        }
                    });
                });
                newSubs.push(unsub);
            }

            activeSubscriptions.set(sessionId, newSubs);

            return {
                content: [{
                    type: 'text',
                    text: `Subscribed to topics: ${args.topics.join(', ')}`
                }]
            };
        })
    );

    // Add unsubscribe tool
    server.tool(
        EventTools.UNSUBSCRIBE.name,
        EventTools.UNSUBSCRIBE.description,
        EventTools.UNSUBSCRIBE.inputSchema.extend({ sessionId: z.string().optional() }).shape,
        withSession(EventTools.UNSUBSCRIBE.inputSchema, async (_args, ctx) => {
            const { sessionId } = ctx;
            const subs = activeSubscriptions.get(sessionId) || [];
            subs.forEach(unsub => unsub());
            activeSubscriptions.delete(sessionId);
            return { content: [{ type: 'text', text: 'Unsubscribed from all topics' }] };
        })
    );
}
