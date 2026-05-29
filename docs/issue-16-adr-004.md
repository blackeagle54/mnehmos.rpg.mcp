## ADR-004: Legacy Tool Surface Strategy (Deprecate vs Compatibility Mode)

### Status
Accepted

### Date
2026-05-29

### Context
The consolidated runtime path is active, while `src/server/tools.ts` remains as a legacy-style tool surface.

### Problem
Without explicit policy, dual surfaces increase maintenance cost and risk behavior divergence.

### Decision
**Retain the legacy surface in compatibility mode.** (Option 2 of the previously proposed alternatives.)

The consolidated path (`src/server/consolidated/*`) is the single advertised, supported surface.
`src/server/tools.ts` is kept in compatibility mode — no new tools are added to it, it is not
documented as a public surface, and it is slated for staged removal once the deprecation trigger
(below) is met.

Rationale:
- **Mandated by accepted direction.** `docs/ADR-005-unified-ownership-architecture.md` (§5, "Legacy
  surface policy") states the legacy surface enters compatibility mode immediately and is removed
  only after the defined deprecation window. `docs/EXECUTION-PRIORITIES-unified-ownership.md`
  (Priority 1, "Decision closure") directs us to "Finalize ADR-004 as compatibility mode with a
  clear deprecation trigger." Compatibility-then-staged-deprecation is therefore the required path,
  not immediate removal.
- **Live consumers.** Removing the surface today would break behavior. `src/server/consolidated/world-map.ts`
  re-exports seven worldgen handlers from `tools.ts`
  (`handleGetWorldMapOverview`, `handleGetRegionMap`, `handleGetWorldTiles`, `handleApplyMapPatch`,
  `handlePreviewMapPatch`, `handleFindValidPoiLocation`, `handleSuggestPoiLocations`), and the server
  integration/consistency tests import handler functions and the `Tools` map from it. The handlers
  must stay live; the `Tools` export must not be removed.

### Deprecation Trigger
The legacy surface is removed only after **all** of the following hold, per ADR-005 §5 and the
Execution Priorities removal-readiness criteria:
1. The consolidated path fully owns the worldgen handlers (the `world-map` tool no longer re-exports
   them from `tools.ts`), so no consolidated module depends on the legacy file.
2. The server integration, consistency, and tools-simple tests are migrated to import from the
   consolidated surface (parity matrix below stays green against the consolidated path).
3. Legacy endpoint usage is measured below the 5% traffic threshold defined in
   `docs/EXECUTION-PRIORITIES-unified-ownership.md` (Success Metrics) for a full deprecation window,
   and the removal is announced via the migration/release-notes package.

Until that trigger is satisfied, `tools.ts` is retained as-is with the `@deprecated` compatibility-mode
banner at the top of the file.

### Parity Test Matrix
The following existing suites pin the workflows that the retained surface must keep behaving
identically while in compatibility mode. They double as the migration gate: each must stay green
when its imports are pointed at the consolidated path.

| Workflow | Coverage suite | Surface exercised |
| --- | --- | --- |
| World generation + state retrieval | `tests/server/tools-simple.test.ts` | `handleGenerateWorld`, `clearWorld` |
| Full server tool round-trip (worldgen + map ops) | `tests/server/integration.test.ts` | `Tools` map + handler fns |
| World data consistency / state integrity | `tests/server/world-consistency.test.ts` | `handleGetWorldState` |
| Consolidated world-map delegation to legacy worldgen handlers | `tests/docs/adr-004-finalized.test.ts` (compatibility-mode lock) + `src/server/consolidated/world-map.ts` | `Tools`, `handleGetWorldMapOverview` |

### Consequences
**Retained compatibility (chosen)**
- Better short-term backward compatibility; no consumer breakage today.
- Ongoing parity testing/maintenance overhead until the deprecation trigger is met.

**Deprecate/remove (rejected for now)**
- Lower long-term maintenance and less drift risk, but would break live consumers
  (`consolidated/world-map.ts` and server tests) immediately, violating ADR-005 §5.

### Acceptance Criteria
- [x] ADR finalized with selected option (retain in compatibility mode)
- [x] README/docs updated with the decision
- [x] Parity test matrix for critical workflows documented (the surface is retained)
- [x] Staged removal path defined via the Deprecation Trigger above (retained-then-staged removal, not immediate)

### Source
Architecture analysis: `docs/ARCHITECTURE-CODEBASE-ANALYSIS.md`
