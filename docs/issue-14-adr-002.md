## ADR-002: Explicit Session Context Injection

### Status
Accepted

### Context
Some consolidated tool modules use module-scoped mutable session context (example pattern in `src/server/consolidated/combat-manage.ts`).

### Problem
Module-scoped mutable context can produce hidden coupling and race/leak risks under concurrent calls and parallel tests.

### Decision
Require **explicit `SessionContext` injection** through router/handler signatures. Disallow module-scoped mutable context holders in consolidated tools.

### Consequences
**Positive**
- Predictable request scoping
- Better concurrency safety
- Easier test isolation and reasoning

**Trade-offs**
- Refactor touches many handlers/routers
- Transitional adapter code may be needed while migrating

### Acceptance Criteria
- [x] No module-level mutable `SessionContext` holders in consolidated tool modules
- [x] Router utilities support explicit context threading
- [x] Multi-session/concurrency tests prove no context leakage
- [x] Runtime behavior for existing tool calls remains unchanged

### Implementation
The `createActionRouter`/`createDiscriminatedRouter` factories in
`src/utils/action-router.ts` now accept an **optional** 2nd `ctx` argument on
the returned `route(args, ctx?)` function and forward it to each
`ActionDefinition.handler(args, ctx)`. The ctx slot is typed opaquely (`any`/
`unknown`) so `src/utils` stays free of `src/server` imports while concrete
handlers declare a typed `ctx: SessionContext`.

The 5 router-based consolidated tools — `combat-manage`, `combat-action`,
`combat-map`, `world-map`, `spatial-manage` — were migrated: the
`let currentContext: SessionContext | null` module holders (and their
`finally { currentContext = null }` resets) were removed, each handler now
takes `(params, ctx: SessionContext)` and guards with
`if (!ctx) throw new Error('No session context')`, and each top-level
`handleX` calls `await router(args, ctx)`. Because the router's ctx arg is
optional, the other 19 tools that call `router(args)` with 0/1-arg handlers
are unaffected.

Tests: `tests/utils/action-router-ctx.test.ts` proves ctx is threaded to
handlers and stays isolated across interleaved concurrent `route()` calls
(handlers reading ctx after a real `await`), plus backward compatibility for
ctx-less handlers. `tests/server/consolidated/combat-manage.test.ts` adds a
`session context isolation` block: a concurrent-create isolation guard and a
structural guard asserting no `let currentContext` holder remains in any of
the 5 files.

### Source
Architecture analysis: `docs/ARCHITECTURE-CODEBASE-ANALYSIS.md`
