## ADR-003: Domain Service/Facade Boundary

### Status
Accepted (combat domain — phase 1)

### Context
Consolidated MCP handlers currently include direct persistence access patterns (e.g., direct DB/repository calls).

### Problem
Transport-layer handlers directly coupling to DB lifecycle/persistence details increases test friction and architectural rigidity.

### Decision
Introduce **domain service/facade interfaces** between MCP handlers and repositories:
- Server/tool handlers depend on service interfaces
- Services coordinate domain operations and repository calls
- Storage layer owns DB lifecycle and repository implementation details

### Consequences
**Positive**
- Improved separation of concerns
- Better testability via service mocks
- Cleaner boundaries for future transport/runtime changes

**Trade-offs**
- Additional abstraction layer and wiring
- Requires phased migration to avoid regressions

### Acceptance Criteria
- [x] Combat handlers route through a service facade first (world/inventory deferred — see follow-up below)
- [x] Combat handlers no longer call `getDb()` directly
- [x] Unit tests can mock services without DB dependency
- [x] Architecture docs updated with boundary contracts

> **Follow-up (world / inventory domains):** the consolidated world-manage,
> world-map, and inventory-manage handlers already resolve the DB through
> `resolveConsolidatedDbPath()` (#68/#72) and are path-honest, so they were
> intentionally left out of phase 1 to keep the blast radius small. Extracting
> their own domain facades (`WorldRepos` / `InventoryRepos`) is tracked as a
> follow-up and does not block this ADR for the combat domain.

### Boundary Contract

- **Handlers depend on an interface, not the DB.** `src/server/handlers/combat-handlers.ts`
  depends only on the `CombatRepos` interface
  (`src/services/combat-db.service.ts`): `{ db, encounters, characters,
  concentration, actionLog }`. It contains zero `getDb()` calls and no hardcoded
  database path.
- **The service owns resolution + construction.** `getCombatRepos()` resolves the
  combat database exactly once via `getDb(resolveConsolidatedDbPath())` — the #72
  single source of truth — and constructs the four combat repositories. This
  replaces the legacy `getDb(NODE_ENV === 'test' ? ':memory:' : 'rpg.db')`
  pattern, which hardcoded `'rpg.db'` and ignored `RPG_DATA_DIR` (a latent
  #68 singleton-conflict / #72 path-drift bug). The factory re-resolves on every
  call (it never caches the handle at module scope) so it respects the `getDb()`
  process-global singleton and vitest's per-file isolate forks.
- **Tests drive handlers via a DI seam.** `combat-handlers.ts` exposes
  `setCombatRepos(factory)` / `resetCombatRepos()` (mirroring the existing
  `setCombatPubSub` pattern). Tests can inject a DB-free `CombatRepos` stub and
  must call `resetCombatRepos()` in `afterEach` to avoid leaking the stub into
  sibling combat tests sharing the same fork.

### Source
Architecture analysis: `docs/ARCHITECTURE-CODEBASE-ANALYSIS.md`
