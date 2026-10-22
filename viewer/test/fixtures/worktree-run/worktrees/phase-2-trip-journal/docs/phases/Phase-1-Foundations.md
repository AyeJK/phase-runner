# Phase 1 — Foundations

Set up the Trail Log app: a local database for trips and waypoints, and the app shell every later screen sits in.

---

# Sprint 1.1 — Trip Storage

### Goal

Store trips and their waypoints locally, with no UI yet.

### Tasks

| Status | # | Task | Module | Reference |
|--------|---|------|--------|-----------|
| x | 1 | `trips` and `waypoints` tables with a migration runner | src/db/ |
| x | 2 | Repository functions for create, list and delete | src/db/trips.ts |
| x | 3 | Unit tests for the repository | src/db/trips.test.ts |

### Acceptance Criteria

- A trip saved with three waypoints reads back with the same three waypoints in order
- Deleting a trip deletes its waypoints

### Dependencies

- None

### Verification

- cli: npm run check
- skip-ui: true

---

# Sprint 1.2 — App Shell

### Goal

A top bar, a trip list route and an empty state, so later screens have somewhere to live.

### Tasks

| Status | # | Task | Module | Reference |
|--------|---|------|--------|-----------|
| x | 1 | Top bar with the app name and a New trip link | src/shell/TopBar.tsx |
| x | 2 | `/trips` route listing saved trips, newest first | src/trips/TripList.tsx |
| x | 3 | Empty state when there are no trips | src/trips/TripList.tsx |

### Acceptance Criteria

- `/trips` lists every saved trip, newest first
- With no trips, the empty state shows and nothing else

### Dependencies

- Sprint 1.1

### Verification

- cli: npm run check
- ui: /trips
- assert: Trips are listed newest first

---

## Scope Guard

No sync, accounts or maps in this phase.
