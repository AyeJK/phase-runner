# Phase 3 — Maps

Show a trip's route on a map and let the user drop waypoints by tapping it.

---

# Sprint 3.1 — Route Map

### Goal

Draw a trip's waypoints as a route on an offline map.

### Tasks

| Status | # | Task | Module | Reference |
|--------|---|------|--------|-----------|
| — | 1 | Map view on the detail page with the route drawn | src/maps/RouteMap.tsx |
| — | 2 | Fit the map to the route on open | src/maps/RouteMap.tsx |

### Acceptance Criteria

- Every waypoint with coordinates appears on the route

### Dependencies

- Phase 2

### Verification

- cli: npm run check
- ui: /trips/1
- assert: The route is drawn and fitted to the view

---

# Sprint 3.2 — Drop a Waypoint

### Goal

Add a waypoint by tapping the map.

### Tasks

| Status | # | Task | Module | Reference |
|--------|---|------|--------|-----------|
| — | 1 | Tap the map to add a waypoint at that point | src/maps/RouteMap.tsx |
| — | 2 | Undo the last dropped waypoint | src/maps/RouteMap.tsx |

### Acceptance Criteria

- A tapped point becomes the trip's last waypoint

### Dependencies

- Sprint 3.1

### Verification

- cli: npm run check
- ui: /trips/1
