---
name: phase-planner
description: Creates and maintains phase plan documents in docs/phases/ files. Use when turning design chat into a structured phase plan, or when adding, removing, editing, moving, or changing task status in sprint plans, viewing sprint or phase progress, or restructuring sprints. Also used by the phase-doc-sync sub-agent when phase-builder applies SPRINT RESULT updates after each implementation wave.
---

# Phase Planner

Creates and maintains phase plan documents — task and sprint lifecycle in `docs/phases/Phase-*.md` files.

For detailed format specification and edge cases, see [reference.md](reference.md).

---

## Phase File Location

All phase files live at: `docs/phases/Phase-{N}-{Name}.md`

One file per phase, numbered sequentially from 1. Always read the target file before making edits.

---

## Task Table Format

Each sprint has a task table. The **canonical format** includes a Status column:

```
| Status | # | Task | Module | Reference |
|--------|---|------|--------|-----------|
| — | 1 | Do the thing | src/core/ | Doc.txt |
| ~ | 2 | Another thing | src/ui/ |
| x | 3 | Done thing | src/core/ | Doc.txt |
| — | 4 | Verification step with no code anchor |
| MANUAL | 5 | Publish the package to the registry |
```

**Module and Reference are optional cells.** The header row always lists all five columns (`Status | # | Task | Module | Reference`), but a task row **omits trailing placeholders** instead of writing `| — |` or `| — | — |`:

| Row shape | When |
|-----------|------|
| `\| Status \| # \| Task \| Module \| Reference \|` | Both Module and Reference have real values. |
| `\| Status \| # \| Task \| Module \|` | Module is set; Reference is N/A (do not append `\| — \|`). |
| `\| Status \| # \| Task \|` | Neither Module nor Reference applies (e.g. manual QA only). |

Do not end a row with `| — | — |`. If Reference alone were needed without Module, use `\| Status \| # \| Task \| Reference \|` (rare).

### Status Values

| Status | Meaning |
|--------|---------|
| `—` | Not started (default) |
| `~` | In progress |
| `x` | Completed |
| `BLOCKED` | Blocked by dependency or issue |
| `MANUAL` | Only the user can do it (publish, install on their machine, record, an outside call) |
| `CUT` | Removed from scope (preserves history) |
| `DEFERRED` | Pushed to a later sprint or phase |

**`MANUAL` vs `BLOCKED`.** Both need the user. `BLOCKED` is agent work that got stuck (a missing credential, a decision) and goes back to an agent once unblocked. `MANUAL` is never agent work: phase-builder doesn't send it to an implementer or stop the run for it, and lists it at the phase checkpoint. The user marks it `x` when they've done it.

### Format Migration

Legacy tables have no Status column. When **first editing** a sprint's task table, add the Status column:

1. Add `| Status |` to the header row
2. Add `|--------|` to the separator row
3. Add `| — |` to every existing task row

Do this migration atomically with the requested edit. Never leave a table half-migrated.

---

## Operations

### 0. Create Phase

Turn a plan (a chat, a spec, a product-planner doc) into a new phase file. This is the entry point on a fresh project.

**Input:** What the phase delivers, plus whatever plan material the user has.

**Steps:**
1. If the design is published, bring the files up to date first (Design sync, below)
2. Look for `docs/phases/` at the workspace root. If it doesn't exist, create it. No setup script is needed first
3. Pick the phase number: one higher than the highest existing `Phase-{N}-*.md`, or `1` if there are none
4. Write `docs/phases/Phase-{N}-{Name}.md` from the full template in [reference.md](reference.md): phase goal, then sprints, each with Goal, Tasks, Acceptance Criteria, Dependencies and **Verification**
5. Every task starts at Status `—`, except a task only the user can do, which starts at `MANUAL` (not `—` with "(manual)" in the text). Use the sparse-row rules for Module and Reference
6. Show the user the sprint list and ask them to confirm before `run phase {N}`

Never overwrite an existing phase file. If `Phase-{N}` already exists, use the next number or ask.

**Design sync.** A design published by design-planner can be changed on its page (the Design canvas, the Design System page) as well as in the files. `docs/design/DESIGN.md` records the pages in the lines under its title, as `Design system artifact: {url}` and `Design canvas: {url}`. If either line is there and the session has an Artifact tool, run the design-planner skill's Design sync (`design-sync.md`, beside its SKILL.md) before reading `docs/design/`. It copies what changed on the page into the files, and what changed in the files onto the page, without asking.

- Run it once per planning request, not once per phase file.
- With no `docs/design/DESIGN.md`, neither line in it, or no Artifact tool, skip it and plan from the files as they are.
- The phase plan is always written from `docs/design/`, never from a published page.

---

### 1. Set Task Status

Change a task's status. This is the most common operation.

**Input:** Sprint ID (e.g., `1.3`), task number(s), target status.

**Steps:**
1. Read the phase file
2. Find the sprint section by header (`# Sprint X.Y`)
3. Migrate the table if no Status column exists
4. Update the Status cell for the specified task(s)
5. Write the file

**Multiple tasks:** When marking several tasks at once, update all in a single edit.

**Shorthand the user might say:**
- "mark 1.3 task 4 as done" -> Status = DONE
- "start task 2 in sprint 1.1" -> Status = ACTIVE
- "block 1.4 #6" -> Status = BLOCKED
- "1.4 #7 is mine" / "I'll do that one" -> Status = MANUAL
- "cut task 8 from 1.3" -> Status = CUT
- "defer 1.5 task 3" -> Status = DEFERRED
- "sprint 1.2 is done" -> All tasks in 1.2 = DONE

---

### 2. Add Task

Add a new task to a sprint's table.

**Input:** Sprint ID, task description, module, reference (optional).

**Steps:**
1. Read the phase file
2. Find the sprint section
3. Migrate the table if needed
4. Assign the next sequential task number
5. Append the new row with Status `—` (`MANUAL` if only the user can do it)
6. Write the file

**Format:** Use the sparse-row rules above: `| — | {next#} | {task}` when module and reference are both absent; otherwise include `| {module} |` and/or `| {reference} |` only for columns that have real values — never pad with trailing `| — |` only to fill the table.

If the user provides incomplete info, infer the module from context or ask. Omit the Reference column when there is no doc pointer.

---

### 3. Remove Task

Remove a task row and renumber remaining tasks.

**Input:** Sprint ID, task number.

**Steps:**
1. Read the phase file
2. Find the sprint and task row
3. Remove the row
4. Renumber all remaining task rows sequentially (1, 2, 3...)
5. Write the file

**Prefer CUT over Remove:** If the user says "remove" but the task was meaningful work, suggest using CUT status instead (preserves history). Only hard-remove for tasks added by mistake or duplicates.

---

### 4. Edit Task

Modify a task's description, module, or reference.

**Input:** Sprint ID, task number, fields to change.

**Steps:**
1. Read the phase file
2. Find the sprint and task row
3. Update the specified cells, leave others unchanged
4. Write the file

Never change the task number during an edit. Never change Status unless explicitly asked.

---

### 5. Move Task

Move a task from one sprint to another (same phase or cross-phase).

**Input:** Source sprint + task number, target sprint.

**Steps:**
1. Read source file (and target file if cross-phase)
2. Copy the full task row from source sprint
3. Remove from source, renumber source tasks
4. Append to target sprint with next sequential number, preserve Status
5. Write file(s)

If the target sprint is in a different phase file, both files must be edited.

---

### 6. Add Sprint

Add a new sprint section to a phase file.

**Input:** Phase number, sprint title, goal.

**Steps:**
1. Read the phase file
2. Determine the next sprint number (e.g., if last is 2.4, new is 2.5)
3. Insert sprint section before the non-sprint content (risk mitigations, scope guard, etc.)
4. Use the standard sprint template (see reference.md) — **include `### Verification`** on every new sprint (see below)
5. Write the file

---

## Verification section (new sprints)

**Include on every new sprint going forward.** Do not retroactively add to completed phases unless the user asks.

Placed after `### Dependencies` (before the sprint `---` divider). Gives phase-builder / skill-router explicit test scope instead of inferring routes and skills from task Module paths.

**UI sprints** automatically use `docs/design/design-system.md` via `phase-ui-implement` (implementation) and wave-test (design asserts) — when that file exists. No separate `design:` field — always that file.

```markdown
### Verification

- cli: npm run check
- ui: /settings/profile
- skills: visual-qa-testing, responsive-testing
- viewports: 375, 428, 768, 1280, 1536
- assert: Profile form saves without a full reload; validation errors appear inline
```

### Fields

| Key | Required | Purpose |
|-----|----------|---------|
| `cli:` | Yes (or infer from stack — see project-layout.md) | Command **phase-verify** sub-agent runs until exit 0 |
| `ui:` | When sprint has UI | App route(s) for wave-test — comma-separate multiple |
| `skills:` | When UI or QA | Skill names phase-builder assigns to wave-test (e.g. `visual-qa-testing`, `responsive-testing`) — only if such skills are actually available; see skill-router.md |
| `viewports:` | Optional | Breakpoints for responsive testing; omit to use a sensible default (375–1536) |
| `skip-ui:` | Data-only sprints | `true` — no wave-test after this sprint's wave |
| `assert:` | Recommended for UI | Short browser checklist — what PASS means |

### When to fill what

| Sprint type | Example |
|-------------|---------|
| DB / types / utils only | `cli: <check command>` + `skip-ui: true` |
| UI component or page | `cli` + `ui` + `skills` + `assert` — design-system.md applied automatically when present |
| Mobile layout | Add a responsive-testing skill to `skills` if one is available; mention key widths in `viewports` |
| End-to-end user flow | `assert` describes the flow steps end to end |
| QA / regression sprint | All relevant `ui` routes + full `skills` list + detailed `assert` bullets |

### Authoring rules

- Keep `assert` lines short — one observable outcome per bullet
- Put **routes** in `ui:`, not in task Module cells
- Do not duplicate verification prose in the task table; reference acceptance criteria instead
- **Preserve** existing `### Verification` blocks when editing tasks unless the user asks to change them
- phase-doc-sync and sprint status updates **never** modify this section

---

### 7. Sprint Report

Summarize progress for a sprint.

**Input:** Sprint ID.

**Steps:**
1. Read the phase file
2. Find the sprint section
3. Count tasks by status
4. Report format:

```
Sprint {X.Y} — {Title}
Total: {n} tasks
  DONE:     {n}
  ACTIVE:   {n}
  BLOCKED:  {n}
  MANUAL:   {n}
  DEFERRED: {n}
  CUT:      {n}
  Remaining:{n}
Progress: {done}/{total eligible} ({percent}%)
```

"Total eligible" excludes CUT and DEFERRED tasks.

---

### 8. Phase Report

Summarize progress across all sprints in a phase.

**Input:** Phase number.

**Steps:**
1. Read the phase file
2. For each sprint, count tasks by status
3. Report format:

```
Phase {N} — {Title}

Sprint {X.1}: {done}/{eligible} ({%}) — {title}
Sprint {X.2}: {done}/{eligible} ({%}) — {title}
...

Phase Total: {done}/{eligible} ({percent}%)
```

---

### 9. List / Filter Tasks

List tasks filtered by status, sprint, module, or keyword.

**Input:** Filter criteria (any combination).

**Steps:**
1. Read the relevant phase file(s)
2. Parse all task tables
3. Filter by provided criteria
4. Output matching tasks with their sprint ID, task number, and status

---

### 10. Bulk Status Update

Update multiple tasks across sprints in a single operation.

**Input:** List of sprint+task pairs and target status.

**Steps:**
1. Read the phase file
2. Migrate any unmigrated tables that will be touched
3. Update all specified tasks
4. Write the file once (not per-task)

---

### 11. Apply SPRINT RESULT (phase-builder doc-sync)

**Who runs this:** The **phase-doc-sync** sub-agent, not the phase-builder orchestrator. See `runtime-adapter.md` in the phase-builder skill for how doc-sync is loaded/spawned in your environment.

**When:** After each implementation wave, from structured `SPRINT RESULT` data the orchestrator parsed.

**Steps:**
1. Read the phase file once
2. For each sprint in the payload (ascending `X.Y`):
   - Set `x` for `completed`, `BLOCKED` for `blocked`, `MANUAL` for `manual`, `DEFERRED` / `CUT` as specified
   - Prefer **one edit per sprint** on the whole `### Tasks` table block
3. Write the file with batched edits — **never one edit per task row**
4. Return `DOC SYNC RESULT` per phase-doc-sync skill

**Orchestrator:** Must not perform this operation inline during a phase run — spawn doc-sync instead.

---

## Sprint Section Identification

Sprints are identified by their header pattern:

```
# Sprint {PhaseNum}.{SprintNum} — {Title}
```

Example: `# Sprint 1.3 — Model Connector Layer`

When the user says "sprint 1.3", match against this pattern. The sprint section extends from its header to the next sprint header (or end of sprints content).

---

## Editing Rules

1. **Always read before editing.** Never assume file contents.
2. **Preserve all content outside the target table.** Do not modify acceptance criteria, dependencies, verification, notes, or any non-task-table content unless explicitly asked.
3. **Use targeted edits.** Match the exact old content, replace with new. Never rewrite the entire file.
4. **One write per file per operation.** Batch related changes into a single edit when possible.
5. **Renumber after removal.** Task numbers must always be sequential starting from 1.
6. **Migrate on first touch.** Add the Status column the first time you edit any task table.
7. **Confirm destructive ops.** Before hard-removing tasks or deleting sprints, confirm with the user.

---

## User Command Shortcuts

The user may use informal language. Map these to operations:

| User says | Operation |
|-----------|-----------|
| "mark X done" / "complete X" / "finish X" | Set Status -> DONE |
| "start X" / "working on X" / "begin X" | Set Status -> ACTIVE |
| "block X" / "X is blocked" | Set Status -> BLOCKED |
| "X is mine" / "I'll do X" / "X is manual" | Set Status -> MANUAL |
| "cut X" / "X is out of scope" | Set Status -> CUT |
| "defer X" / "push X" / "move X to later" | Set Status -> DEFERRED |
| "reset X" / "unstart X" | Set Status -> — |
| "add task to X" | Add Task |
| "remove task from X" / "delete task" | Remove Task (suggest CUT) |
| "edit task X" / "change task X" / "update task" | Edit Task |
| "move task X to Y" | Move Task |
| "how's sprint X" / "sprint X status" | Sprint Report |
| "how's phase X" / "phase X progress" | Phase Report |
| "what's active" / "what am I working on" | List where Status = ACTIVE |
| "what's blocked" | List where Status = BLOCKED |
| "what's on me" / "what do I need to do" | List where Status = MANUAL |
| "what's left in X" | List where Status = — in sprint X |
| "new sprint in phase X" | Add Sprint |
| "plan phase X" / "turn this into a phase" / "start a phase plan" | Create Phase |
