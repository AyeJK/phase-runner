# Phase 2 — Trip Journal

Turn a saved trip into a journal: a detail page with notes and photos per waypoint, and an export for sharing a finished trip as a single file.

---

# Sprint 2.1 — Trip Detail Page

### Goal

Open a trip from the list and see its waypoints in order.

### Tasks

| Status | # | Task | Module | Reference |
|--------|---|------|--------|-----------|
| x | 1 | `/trips/:id` route with the trip header and waypoint list | src/trips/TripDetail.tsx |
| x | 2 | Link each row of the trip list to its detail page | src/trips/TripList.tsx |
| x | 3 | Not-found state for an unknown trip id | src/trips/TripDetail.tsx |

### Acceptance Criteria

- Clicking a trip in the list opens its detail page
- An unknown id shows the not-found state

### Dependencies

- Phase 1

### Verification

- cli: npm run check
- ui: /trips, /trips/1
- assert: Waypoints are listed in trip order

---

# Sprint 2.2 — Waypoint Notes

### Goal

Write a note against any waypoint and see it on the detail page.

### Tasks

| Status | # | Task | Module | Reference |
|--------|---|------|--------|-----------|
| — | 1 | Note editor under each waypoint, saved on blur | src/trips/WaypointNote.tsx |
| — | 2 | Show saved notes on the detail page | src/trips/TripDetail.tsx |
| — | 3 | Character count and a 2,000-character limit | src/trips/WaypointNote.tsx |

### Acceptance Criteria

- A note typed and blurred survives a page reload
- The editor refuses input past 2,000 characters

### Dependencies

- Sprint 2.1

### Verification

- cli: npm run check
- ui: /trips/1
- assert: A saved note shows after reload

---

# Sprint 2.3 — Photo Attachments

### Goal

Attach photos to a waypoint and keep them in local storage.

### Tasks

| Status | # | Task | Module | Reference |
|--------|---|------|--------|-----------|
| — | 1 | `photos` table keyed by waypoint | src/db/photos.ts |
| — | 2 | Resize to 1600px on import and store the blob | src/photos/import.ts |
| — | 3 | Unit tests for resize and storage | src/photos/import.test.ts |

### Acceptance Criteria

- An imported photo is stored at most 1600px on its long edge
- Deleting a waypoint deletes its photos

### Dependencies

- Sprint 2.1

### Verification

- cli: npm run check
- skip-ui: true

---

# Sprint 2.4 — Trip Export

### Goal

Export a trip, with notes and photos, as a single file someone else can open.

### Tasks

| Status | # | Task | Module | Reference |
|--------|---|------|--------|-----------|
| — | 1 | Export a trip to one `.trail` archive (JSON plus photos) | src/export/archive.ts |
| — | 2 | Import a `.trail` archive as a new trip | src/export/archive.ts |
| — | 3 | Round-trip tests for export then import | src/export/archive.test.ts |

### Acceptance Criteria

- Exporting then importing a trip gives an identical trip, notes and photos included

### Dependencies

- Sprints 2.2 and 2.3

### Verification

- cli: npm run check
- skip-ui: true

---

## Scope Guard

No cloud sharing or accounts. Export is a file the user moves themselves.
