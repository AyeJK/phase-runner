---
name: phase-builder
description: "Orchestrates automated sprint implementation from phase plans — e.g. 'run phase 1', 'implement sprint 1.3', 'run phase 4 in a worktree'. Optional worktree mode isolates a phase run on its own branch so two phases can run at once. Spawns phase-ui-implement (UI sprints + docs/design/design-system.md), general implementation (data/mixed), phase-verify, phase-wave-test (design asserts), phase-doc-sync. Skill-router per sprint. Clean orchestrator thread. Max 3 retries per gate then escalate. Pauses at blockers and phase boundaries."
---

# Phase Builder

Orchestrates sprint implementation from phase plan files at `docs/phases/Phase-{N}-*.md`. Reads the plan, identifies incomplete sprints, **groups sprints into parallel waves when safe**, spawns one sub-agent per sprint (multiple sub-agent calls in the same turn when running a wave), processes results, and manages human checkpoints at blockers and phase boundaries. **Default remains sequential** when the dependency graph, overlap risk, or sprint semantics do not justify parallelism.

**Companion files:** `runtime-adapter.md` (which sub-agent tool and skill-loading mechanism this environment uses), `project-layout.md` (workspace_root vs app_root), `skill-router.md`, `run-log.md` (the per-phase log the gate agents and implementers append to), and the `phase-ui-implement`, `phase-verify`, `phase-wave-test`, `phase-doc-sync` skills. For a published design, also design-planner's `design-sync.md` (Step 1.2).

---

## Step 0 — Resolve the runtime

Read **`runtime-adapter.md`** first, before anything else. It tells you which tool spawns sub-agents in this session, what subagent type to use, and how to load the other Phase Runner skills (by name or by path). Every "spawn a Task" and "read skill X" instruction below assumes you've already done this — substitute the resolved tool/type/loading-mechanism throughout.

---

## Step 0.5 — Worktree mode (opt-in)

**Only when the user asks for it** — "run phase 4 in a worktree", "run this in parallel with the other session", "resume phase 4 in its worktree". Otherwise skip this step entirely: a normal run works in the current checkout, and phase-builder already parallelizes independent sprints inside a phase. Worktree mode exists for running **two phases at once** in two sessions without their verify gates tripping over each other's half-written code.

**Find the repo (`repo_root`) — check before doing anything:**

- Resolve `workspace_root` per `project-layout.md` (it looks in the current folder, one level up, and one level down). `repo_root` is the git repo that contains it. This works whether the session started inside the repo or in a coordination folder above it — the worktree is always created in the repo, wherever the session started.
- `docs/phases/` must be **tracked** in `repo_root` (single-folder layout). In a split layout where `docs/phases/` sits outside the repo, doc-sync would still write to a shared phase folder — tell the user worktree mode doesn't fit this layout and stop.
- Note whether the session **started inside** `repo_root` (the start folder is the repo or inside it) or **above** it (a coordination folder holding the repo as a subfolder). This decides how the run reaches the worktree — see "Reach the worktree" below.

**Create and set up the worktree (one sub-agent — orchestrator runs no shell):**

Spawn one call, description `Worktree setup — phase {N}`, with `repo_root` and the target path `{repo_root}/.claude/worktrees/phase-{N}`. It must:

1. If the target path is already in `git worktree list`, this is a **resume** — skip creation and steps 3–4. Otherwise create it from the repo's current `HEAD`: `git -C {repo_root} worktree add {target} -b phase/{N}` (if the branch exists, add it without `-b`). Report the branch, the base commit, and whether `repo_root` has uncommitted changes. Uncommitted work never carries into a worktree; if `repo_root` is dirty, say so, because this phase may depend on work that isn't in its base.
2. Copy untracked, gitignored env files (`.env`, `.env.*`, excluding anything already tracked such as `.env.example`) from `repo_root` into the same relative paths in the worktree.
3. Install dependencies with the project's package manager (lockfile decides: `npm ci`/`npm install`, `pnpm install`, `yarn`, `pip install -r …`, etc.).
4. Confirm the worktree folder is ignored by the main checkout and excluded from its type-check and lint globs. A worktree nested in the repo (Claude Code puts them under `.claude/worktrees/`) is otherwise picked up by the main checkout's `tsc`/`eslint`, so the *other* session's verify gate would check this worktree's half-written code. If it isn't excluded, report which config needs the exclusion — do not edit it.
5. Run `git worktree list` and, for every other worktree, report whether its branch or working tree touches this phase's file or any schema/migration path.
6. Record `git -C {repo_root} status --porcelain` as `REPO_BASELINE`. Verify compares against it after each wave to catch an edit that landed in the main checkout instead of the worktree.

Return a `WORKTREE SETUP RESULT` block with `PATH`, `BRANCH`, `BASE`, `RESUMED`, `ORIGINAL_DIRTY`, `ENV_COPIED`, `INSTALL`, `EXCLUDED`, `OTHER_WORKTREES`, `REPO_BASELINE`.

**Reach the worktree (orchestrator), after the checks below pass:**

- **Session started inside `repo_root`:** call the worktree tool with `path: {PATH}` (Claude Code: `EnterWorktree`). The session's working directory is now the worktree.
- **Session started above `repo_root`, or no such tool:** don't call it. It refuses when the start folder isn't a git repo. The session stays where it is and the run works entirely through absolute paths, which sub-agents need anyway.

Either way:

- `workspace_root` and `app_root` are both `{PATH}`. Every sub-agent's `APP_ROOT` / `WORKSPACE_ROOT` is `{PATH}`. Never pass `repo_root` or the start folder to a sub-agent.
- **Every file the orchestrator checks or reads is by absolute path under `{PATH}`**: the phase file, `design-system.md`, the harness doc, convention docs. A relative path resolves against the start folder, not the worktree, and a miss there looks like "the file doesn't exist". That's how a run once told its UI sprints there was no design system.
- Every sub-agent prompt says: run every shell command from `{PATH}` (`cd {PATH} && …`), and edit only files under `{PATH}`.
- Pass `repo_root` and `REPO_BASELINE` to every verify call as `leak_check`: any path in `repo_root`'s status that isn't in the baseline is a leak. Verify reports it as a FAIL.
- Project instructions (`CLAUDE.md` and the like) in folders above the repo still apply; the worktree sits inside the repo.

**Orchestrator checks the result before Step 1:**

| Finding | Action |
|---|---|
| `ORIGINAL_DIRTY: yes` | Warn; ask whether to continue, or stop so the user can commit first |
| `EXCLUDED: no` | Warn with the config to fix; ask before continuing |
| Another worktree touches this phase file | **Stop.** Two runs on one phase file cannot be merged cleanly |
| Another worktree touches schema/migrations **and** this phase has migration tasks | Warn: worktrees share one local database, so two branches adding migrations will diverge. Recommend running one of the two phases later |
| Install failed | Stop and report |

Report once: `Worktree: {path} (branch {branch}, from {base})`. Then reach it as above and continue at Step 1. Worktree mode also adds a finish step to the Step 4 checkpoint.

---

## Step 1 — Clarify Scope and Inventory Tools

Before doing anything else:

**Confirm scope:**
1. **Which phase(s)?** — e.g. "Phase 1", "phases 1 and 2", "phase 3 from sprint 3.2 onwards"
2. **Starting sprint** — default is the first incomplete sprint in the target phase

If the user said "run phase 1", that means: start from the first incomplete sprint in Phase 1, run all sprints in that phase **using parallel waves where Step 2.5 allows**, otherwise in sprint order, then pause before Phase 2.

### Resolve project layout (required)

Read **`project-layout.md`** and resolve:

- **`workspace_root`** — where `docs/phases/` lives; doc-sync and design-system paths
- **`app_root`** — where the stack manifest and `src/` live; CLI checks, dev server, implementation

Store both absolute paths for the entire run. Report in the execution plan (see project-layout.md).

If ambiguous (multiple candidate app roots), ask once — do not guess per sprint.

**Do not** conflate workspace_root and app_root in sub-agent prompts.

**Inventory available tools:**

Scan what MCP tools and plugins are currently connected. Look for tools relevant to this project's stack — e.g. hosting/database/deployment platforms, version control. Build a short list:

```
Available integrations:
  ✓ {database platform} — migrations, table management
  ✓ {deploy platform} — deployment, environment variables
  ✗ {version control} — not connected
```

This list gets injected into every sub-agent prompt so the sub-agent knows what it can use.

**Check for required tools:**

The sub-agent will use MCP tools where connected and CLI tools where not — both are valid. Only pause here if you can identify something the sprints will need that has no CLI fallback either (e.g. a credentials-based service with no local tooling at all). In that case:

```
⚠ Sprint {X.Y} will need {tool} and nothing equivalent appears to be available.

Options:
  1. Connect it now — I'll help you find an MCP connector or CLI path for "{tool}"
  2. Proceed anyway — the sub-agent will flag what it can't do
  3. Stop here

What would you like to do?
```

If the user wants to connect it: check your environment's MCP/connector settings, search the web for an official or community connector for that service, or point them to wherever your environment manages integrations. There is no single guaranteed "registry" tool in every session — adapt to what the executor agent can actually call.

---

## Step 1.2 — Design check (published designs only)

A design published by design-planner can be changed on its page (the Design canvas, the Design System page) after the phase was planned. Before the first wave, check for differences between the published pages and `docs/design/`, so the build never runs on files that are behind.

**When.** Both must hold, otherwise skip this step and say nothing:

- `{workspace_root}/docs/design/DESIGN.md` exists and has a `Design system artifact:` or `Design canvas:` line under its title. Grep for those two labels, by absolute path.
- This session has an Artifact tool.

**How.** Spawn one sub-agent, before Step 1.5 reads `design-system.md`'s headings:

- **description:** `Design check — phase {N}`
- **prompt:** load the `design-planner` skill per runtime-adapter.md, read its companion `design-sync.md`, and run Design sync for `{workspace_root}` (absolute path). Nothing else from that skill: no design pass, no changes of its own. Return `DESIGN SYNC RESULT`.
- **model:** the run's default, not `gate_model`. A screen changed on the canvas has its spec rewritten.

This step writes nothing to the run log.

**Then**, from the result:

| `status` | Do |
|----------|-----|
| `unchanged` | Go on. Say nothing |
| `skipped` | Go on. One line only if a page couldn't be read |
| `needs-user` | Relay the question (the same screen or token changed on both sides, or a screen was removed from the canvas), wait for the answer, and spawn the check again with it |
| `synced` | Log what was copied, one line each. Then check the plan, below |

**Check the plan.** The files are now current, but the phase file was written from the old ones. Once Step 2 has parsed the sprints in this run, look for:

- a task whose Reference names a spec in `screens_changed` or `screens_removed`
- a screen in `screens_added` that no sprint covers

None: go on to the execution plan. Token changes alone never stop a run: sprints point at the specs and `design-system.md`, they don't copy values.

Any: stop before the first wave.

```
⚠ The design changed after this phase was planned.

  Settings — Profile   changed on the canvas   → Sprint {X.Y} builds it
  Billing              added on the canvas     → no sprint covers it

docs/design/ is up to date. The phase plan is not.

Options:
  1. Update the plan first — phase-planner revises the sprints above, then run again
  2. Build as planned — implementers follow the updated specs; acceptance criteria stay as written
  3. Stop here
```

---

## Step 1.5 — Skill routing (best skill per step)

Read **`skill-router.md`** at Step 1.5 (it in turn depends on `runtime-adapter.md` and `project-layout.md` already being resolved).

1. **Scan** available skill names + descriptions per skill-router.md's discovery method.
2. **Honor user-requested skills** from the run request — testing skills → wave-test; UI skills → implementation for UI sprints.
3. **Per sprint:** set `implementation_agent: ui | general`; build `implementation_skills[]`; set `design_system_doc` to `{workspace_root}/docs/design/design-system.md` when sprint is UI or mixed **and that file exists** — check existence by absolute path, never relative. When it exists, grep its headings once (`^#{1,3} `) and set `design_sections[]` per sprint: the headings that match the components and screens its tasks name. This lets sub-agents read a few sections instead of the whole file.
4. **Per wave:** mark `wave_has_ui: true|false`; build `verify_skills[]`; build `wave_test_skills[]` when UI; set `harness_doc` to `{app_root}/docs/testing/wave-test-harness.md` (pass it whether or not it exists yet — the first wave test creates it).
5. **Include skill plan** in the execution plan report (Step 2.5).

Sub-agents load their own assigned skill files/names themselves — orchestrator only passes the resolved references (paths or names, per runtime-adapter) in prompts, never runs those workflows inline.

---

## Orchestrator thread — keep clean

During an active phase run the orchestrator may only:

- Read phase files, skill-router, phase-doc-sync payload shape
- Check that a file exists, grep `design-system.md`'s headings and grep `DESIGN.md` for its artifact lines, by absolute path
- Spawn sub-agents (design check, implementation, verify, doc-sync, wave-test)
- Parse `DESIGN SYNC RESULT`, `SPRINT RESULT`, `VERIFY RESULT`, `DOC SYNC RESULT`, `WAVE TEST RESULT`
- One-line logs to the user

The orchestrator must **not**: run shell commands directly, call browser/automation tools directly, start dev servers, read tool JSON descriptors, read source files, or run grep/typecheck for verification. All of that lives in sub-agents.

---

## Sub-agent lifecycle — fresh by default

Every step an agent takes re-reads everything it has seen so far. An agent kept alive across waves drags every earlier wave's logs, screenshots and file reads into each new step. In one measured run, a single wave-test agent continued through four test jobs used 36% of the phase's tokens on its own; its context reached 600k.

| Continue an existing agent (`SendMessage` or equivalent)? | |
|---|---|
| Same sprint's implementation, retry within the **same wave** | ✓ Preferred when the agent is still addressable: it already has the code in context and the fix is usually small. Otherwise re-spawn with the full 3a prompt. Either way the retry carries its new run-log `attempt` |
| Verify re-run within the **same wave**, after a retry | ✓ |
| Wave-test retry | ✗ Spawn fresh at `tier: regression` with `retest_only` — cheaper than continuing a tester whose context is full of the first attempt's browser logs |
| Any gate agent (verify, wave-test, doc-sync) into a **new wave** | ✗ Never. Spawn fresh |
| An agent past its 3rd continuation | ✗ Spawn fresh; pass a short summary of what's already done |

Pass a gate agent only what it needs: the payload, the harness doc path, the design sections. Never paste earlier waves' results into it.

---

## Retry limits and escalation

Track retry counts **per wave** (reset when a new wave starts, or when the user chooses **continue retrying** after escalation).

| Gate | Default max | Count when |
|------|-------------|------------|
| **3b-verify-retry** | **3** | Each `VERIFY RESULT: FAIL` after re-implement + re-verify cycle |
| **3f-retry** | **3** | Each `WAVE TEST RESULT: FAIL` after full retry cycle |

User may override at run start: e.g. `max retries 5` or `strict — no retry limit` (honor explicit instruction).

**When a counter reaches max**, stop the retry loop and surface:

```
⚠ {Verify | Wave test} retry limit reached ({max}/{max}) — Sprint(s) {ids}

Last failures:
{FAILURES / ISSUES from most recent result block}

Retry history:
  Attempt 1: {one-line summary}
  Attempt 2: ...
  Attempt 3: ...

Options:
  1. Continue retrying — resets counter for this gate; re-spawn from last failure
  2. Skip this gate — advance without passing (doc-sync only if user confirms; warn phase file may be stale)
  3. Stop here — report wave state and exit phase run

What would you like to do?
```

Do **not** silently retry beyond max. Wait for user response before option 1 or 2.

Log each retry: `↻ Verify — 5.3 (retry 2/3)` or `↻ Wave test — 5.3 (retry 2/3)`.

---

## Wave sequencing (mandatory)

**A wave's gates must all pass before the next wave starts.** Gates inside a wave are **strictly sequential**. Two exceptions: multiple **implementation** sub-agent calls in the same turn when a wave has 2+ sprints (3b), and a wave's **doc-sync running alongside the next wave's implementation** (3c-sync). Implementers never touch the phase file, and the next wave's diff starts from the last verify's snapshot, not from doc-sync, so the two can't collide.

### Allowed parallelism

| Same turn | Allowed? |
|-----------|----------|
| Multiple **3b** implementation calls (multi-sprint wave only) | ✓ |
| Doc-sync (wave N) + implementation (wave N+1) | ✓ — after every wave N gate passed and 3d found no blockers |
| Verify + wave-test | ✗ |
| Wave-test + doc-sync | ✗ |
| Verify + doc-sync | ✗ |
| Verify + next wave anything | ✗ |
| Wave-test + next wave anything | ✗ |
| Doc-sync (wave N) + verify (wave N+1) | ✗ — wave N+1's verify waits for `DOC SYNC RESULT` |

### Order within one wave

**Data-only:** 3b → 3b-verify → (retry loop) → 3c → 3d → 3c-sync ∥ next wave's 3b

**UI:** 3b → 3b-verify → (retry loop) → 3c → 3f → (retry loop) → 3d → 3c-sync ∥ next wave's 3b

Each arrow = wait for the prior step's result block before spawning the next sub-agent. `∥` = same turn.

### Advance rule

**3e — Start the next wave's implementation** only after:

1. All gates passed (or user skipped via escalation), **and**
2. **3d** found no blockers (blockers come from `SPRINT RESULT`, so you know before doc-sync)

Spawn it in the same turn as **3c-sync**. Then:

- **Wait for `DOC SYNC RESULT` before the next wave's verify.** That keeps the run log in order (wave N's `doc_sync` lines before wave N+1's `implement` `pass` / `blocked` lines; only its `start` and `task` lines may come earlier) and makes sure a failed sync stops the run before more work is verified.
- **Doc-sync PARTIAL / FAILED:** let the in-flight implementation calls finish, don't spawn their verify, and show FAILURES (see 3c-sync). The fix is to the phase file only, so the next wave's `diff_base` stays valid.
- **Last wave of the phase:** doc-sync runs alone; wait for it before the Step 4 checkpoint.

---

## Retry implementation only (no Fix tasks)

On verify or wave-test **FAIL**, the **only** code-change path is re-spawn the **same sprint** implementation sub-agent (3a-ui or 3a-general) with failures injected — not a separate fix agent.

### Forbidden during phase runs

| Forbidden | Why |
|-----------|-----|
| A task description like `Fix 6.4`, `Fix TS error`, `Fix tracker` | Bypasses sprint scope and SPRINT RESULT contract |
| A dedicated "fixer" sub-agent for code fixes | doc-sync's dedicated agent (if one exists) is **doc-sync only** during phase runs |
| Spawning a new sprint while retrying the current wave | Violates wave sequencing |

### Required retry shape

- **Description:** `Sprint {X.Y} — {title} (retry {n})` — same sprint id every time
- **Prompt:** full 3a-ui or 3a-general template + `PRIOR VERIFY / WAVE TEST FAILURES` block from last `VERIFY RESULT` or `WAVE TEST RESULT`, with the `RUN LOG` block's `attempt` set for this run (see Run log). When continuing the same agent within the wave (see Sub-agent lifecycle), send only the failures block, the retry number and, when the run is logged, this line: `RUN LOG: attempt is now {attempt}. Append a new implement start line with it before anything else, and use it on your task lines.`
- **Type:** the general-purpose type resolved in runtime-adapter.md

After implementation returns → **3b-verify** again → (UI) **3f** again. Never skip verify to save time.

---

## Step 2 — Read and Parse the Phase File

Read the target phase file. Sprints are identified by this header pattern:
```
# Sprint {N}.{M} — {Title}
```

Each sprint section contains:
- **Goal** line
- **Tasks** table (with Status column: `—` not started, `~` in progress, `x` done, `BLOCKED`, `MANUAL` (the user's to do), `CUT`, `DEFERRED`)
- **Acceptance Criteria** section
- **Dependencies** section

**A sprint is complete** when all tasks with status `—`, `~`, or `BLOCKED` are gone — i.e. every task is `x`, `CUT`, or `DEFERRED`. Skip complete sprints silently.

**A sprint whose only open tasks are `MANUAL`** needs no agent work. Skip it like a complete sprint, but note its `MANUAL` tasks for the Step 4 checkpoint. A `MANUAL` task never goes to an implementer.

Build an ordered list of sprints to run. Report it to the user before starting:

```
Phase {N} — {Title}
Sprints to run: {X.1}, {X.2}, {X.3}
(Skipping: {X.0} — already complete; {X.4} — only manual tasks left)

Starting with Sprint {X.1}...
```

---

## Step 2.5 — Parallelization (waves, not forced)

After you have the **ordered list of incomplete sprints**, decide whether to run **waves** (multiple sprints at once) or **strictly one sprint at a time**.

### When parallel waves make sense

- **Dependencies satisfied:** For each sprint in a proposed wave, its **Dependencies** section (and common sense from goals/tasks) must not require **deliverables** from another sprint in the *same* wave that is not yet complete. Prior sprints in the file or already-completed sprints can satisfy deps.
- **Low merge conflict risk:** Sprints should touch **disjoint or weakly overlapping** areas (different packages, different features, different tables) when possible. If two sprints would obviously edit the same few files or the same migration chain in conflicting ways, **do not** put them in one wave.
- **Doc-sync after the wave:** Implementation sub-agents must **not** edit `docs/phases/*.md`. After the wave finishes, the orchestrator spawns **one phase-doc-sync sub-agent** (see Step 3c) to apply all `SPRINT RESULT` status updates in sprint order. That avoids parallel writers on the plan file and keeps the orchestrator thread free of per-row doc edits.

### When to stay sequential (single sprint per iteration)

- Explicit or implied **ordering**: e.g. "depends on Sprint X.Y", schema before code that imports it, foundational sprint before consumers.
- **Tight coupling** or unknown overlap — prefer sequential unless deps are clearly independent.
- **User asked for a single sprint** or a **narrow range** — usually one call.
- **Capacity / risk:** Very large sprints, flaky tooling, or first time on a phase — sequential is fine.

### Wave construction

1. Take the next contiguous set of incomplete sprints from your ordered list (or the user's requested subset).
2. Build a **dependency graph** from each sprint's Dependencies section + titles/goals (treat missing deps as "depends on prior sprint in file order" only if the prose clearly implies it).
3. Partition into **waves**: Wave 1 contains sprints whose deps are all met by completed sprints or external facts; Wave 2 is computed after Wave 1 would be done; etc. Within a wave, **all** sprints must be pairwise safe per the rules above.
4. If the only valid partition is one sprint per wave, **run sequentially** — no artificial parallelism.

**Report to the user** before spawning (adjust wording if a single sprint):

```
Execution plan:
  Wave 1 (parallel): {X.1}, {X.2}
  Wave 2 (sequential): {X.3}  — depends on schema from {X.1}
  Wave 3 (parallel): {X.4}, {X.5}
```

If everything is sequential:

```
Execution plan: sequential — {X.1} → {X.2} → {X.3} (parallelism not safe / not justified).
```

Append **skill plan** from Step 1.5 (implementation skills per sprint, wave-test skip/run per wave).

---

## Step 3 — The Sprint Loop (waves or single)

### Diff baseline (before every wave)

Verify reviews only what the current wave changed, measured from a git snapshot called `diff_base`. Track it for the whole run:

- **When a wave's gates have all passed**, record `wave_end` = the `SNAPSHOT` from that wave's **last passing** `VERIFY RESULT` (`null` if `NONE`). Verify takes it before building, so it is exactly the code that passed. On a UI wave that's the verify after the last wave-test retry, not the first one. The next wave's `diff_base` = `wave_end`; doc-sync gets both shas (see Run log).
- **Before any wave's implementation calls**, re-baseline if `diff_base` didn't come from the `wave_end` of the wave just before it — the first wave of a run, a resumed run, a gate skipped via escalation, or after any blocker pause or escalation (the user may have edited files — you can't tell, so always re-baseline). Spawn one call: description `Verify baseline`, prompt loads the `phase-verify` skill with `{ "mode": "baseline", "project_root": app_root }` (no `run_log`), model `gate_model` if resolved. Set `diff_base` = its `SNAPSHOT` (`null` if `NONE`).
- **Doc-sync edits in the next wave's diff:** in a single-folder layout the phase file is inside the repo, so wave N's Status-cell edits show up in wave N+1's diff. phase-verify knows to ignore Status-only changes to `docs/phases/*.md`; nothing to do here.
- **Resumed run** (the user says resume/continue, or this phase already has completed sprints when the run starts): skip the baseline for the first wave and set `diff_base` = `null`. An interrupted wave may have left half-written changes, and a baseline would absorb them unreviewed; `null` reviews against `HEAD` at low confidence, where out-of-scope findings are non-blocking.
- Retries within a wave keep the same `diff_base`.

The orchestrator only passes the sha along — it never runs git itself.

### Run log (every gate and implementation call)

Each verify, wave-test and doc-sync call carries a `run_log` block, and that gate appends its own events to `{workspace_root}/docs/phases/.runs/phase-{N}.jsonl`. Each implementation call carries a smaller one in its prompt's `RUN LOG` section (see 3a), and the implementer appends one `implement` `start` line as its first action, then a `task` `start` line before it begins each task and a `task` `pass` line when it finishes it. The orchestrator only builds the blocks from values it already tracks; it writes nothing. Field meanings, event shape and the append line are in **`run-log.md`**.

| Field | Value |
|-------|-------|
| `path` | Absolute path of the log under **workspace_root** (not app_root), with forward slashes |
| `phase`, `wave` | Phase number; this wave's number from the execution plan |
| `attempt` | Verify: `verify_retry_count + 1`. Wave-test: `wave_test_retry_count + 1`. Doc-sync: 1 (n on a user-requested re-run) |
| `max` | Verify: `max_verify_retries`. Wave-test: `max_wave_test_retries`. Doc-sync: 1. `0` when the user set no limit |
| `sprint_results` | Verify only: for each sprint implemented since the previous verify in this wave, `sprint`, `completed`, `blocked` and the first line of `notes`, from its `SPRINT RESULT` |
| `diff_base`, `wave_end` | Doc-sync only: the wave's `diff_base` and its `wave_end` (see Diff baseline). Doc-sync lists the files changed between them |

The implementer's block has `path`, `phase`, `wave`, `sprint` (its own sprint id), `attempt` and `max`:

| Field | Value |
|-------|-------|
| `attempt` | `verify_retry_count + 1` at the moment you spawn or continue it: 1 on the wave's first implementation, the new count + 1 on a retry after a verify FAIL. A retry after a wave-test FAIL doesn't bump the verify counter, so it repeats the current number, the same one its verify will log |
| `max` | `max_verify_retries`, `0` when the user set no limit |

Every implementation run gets one, including a retry continued in the same agent: that retry message carries the new `attempt` (see Retry implementation only), so the agent appends a fresh `start` line and puts the new `attempt` on the `task` lines of the tasks it works on again.

### Per wave (one or many sprints)

For each **wave** from Step 2.5:

#### If the wave has one sprint

**Data-only wave** (`wave_has_ui: false`):

Follow **3a → 3b → 3b-verify → 3b-verify-retry → 3c → 3d → 3c-sync ∥ 3e**.

**UI wave** (`wave_has_ui: true`):

Follow **3a → 3b → 3b-verify → 3b-verify-retry → 3c → 3f → 3f-retry → 3d → 3c-sync ∥ 3e**.

Doc-sync runs **after wave-test passes** on UI waves so the phase file reflects fully verified work.

#### If the wave has multiple sprints

1. Build the **3a** or **3a-ui** prompt **separately** for each sprint (see skill-router `implementation_agent`).
2. **3b — Spawn implementation sub-agents:** For a **multi-sprint wave only**, issue multiple sub-agent calls **in the same turn** (one per sprint). For a **single-sprint wave**, one call. Wait until **every** implementation call in **this wave** returns before **any** verify call. UI-primary sprints: prompt reads `phase-ui-implement`'s skill and `{workspace_root}/docs/design/design-system.md`. **Description:** `Sprint 5.3 — UI frequency form` or `Sprint 5.2 — cadence utils`.
3. **3b-verify** — spawn **one** verify call; **wait** for `VERIFY RESULT:` before 3c or 3f.
4. **3b-verify-retry** — on FAIL, re-spawn **same sprint** implementation (see Retry implementation only); then 3b-verify again. **Do not** spawn 3f, doc-sync, or next wave until verify passes the gate (`PASS`, or `PARTIAL` outside strict mode).
5. **3c — Parse results** — build doc-sync payload; hold until UI gates complete.
6. **3f — Wave test** (if `wave_has_ui`) — spawn **one** call; **wait** for `WAVE TEST RESULT:` before doc-sync.
7. **3f-retry** — on FAIL, same-sprint re-implement → 3b-verify-retry → 3f again. **Do not** doc-sync until wave-test PASS/WARN.
8. **3d — Blockers** — from the `SPRINT RESULT` blocks; stop here if any
9. **3c-sync ∥ 3e** — in one turn, spawn **one** doc-sync call and the next wave's implementation call(s). Wait for `DOC SYNC RESULT: SUCCESS` before the next wave's verify (see Advance rule).

### 3a. Build the sub-agent prompt

For each sprint, the sub-agent starts cold. Read project convention files (whatever your project uses to document conventions — e.g. a rules folder, a CONTRIBUTING.md, or CLAUDE.md), the phase file, and **`skill-router.md`** for this sprint's `implementation_agent` and `implementation_skills[]`.

**Design system (UI work only):** inject absolute path to **`docs/design/design-system.md`** only — never the whole `docs/design/` folder — and only if the file exists.

**Phase context (scoped, not the whole file):** a sprint's sub-agent needs two things out of the phase file — the phase-level preamble (everything from the top of the file down to, but not including, the first `# Sprint` header: title, goal, decision log, sequencing notes) and its **own** sprint section (`# Sprint {X.Y} — {Title}` through the next `# Sprint` header or end of file). It does **not** need its siblings' task tables, acceptance criteria, or verification blocks — those belong to sub-agents that aren't this one. Extract both pieces when building the prompt; don't paste the full file.

#### 3a-ui — UI-primary sprint (`implementation_agent: ui`)

Prompt must include:

```
Read and follow FIRST:
  {absolute path or skill name for docs/design/design-system.md, if it exists}
  {phase-ui-implement skill, loaded per runtime-adapter.md}

SKILLS TO READ (after design system):
{any optional UI-pattern skill available, plus any user-requested skills}
```

Use the template below with role line: `You are a UI implementation agent for a project phase sprint.`

#### 3a-general — Data or mixed sprint (`implementation_agent: general`)

Use the template below with role line: `You are a software development agent.`

If mixed sprint touches UI files, add to prompt:

```
DESIGN SYSTEM (for UI tasks in this sprint only):
{absolute path or skill name for docs/design/design-system.md, if it exists} — read before editing UI/component files
```

Then construct the prompt using this template. The `RUN LOG` section is the one exception to filling in every `{…}`: fill in its `run_log:` line (see Run log), then paste the rest of the section exactly as written, the append command's placeholders included. The implementer fills those from `run_log`. Leave the whole section out when the run isn't logged; the implementer then writes nothing: no start line and no task lines.

```
You are a {UI implementation | software development} agent. Your job is to implement a specific sprint from a project phase plan.

WORKSPACE_ROOT: {absolute path — docs/phases, doc-sync target}
APP_ROOT: {absolute path — run checks/dev from here; edit src/ here}

Everything you need from the phase plan is below. Don't open the phase file.

{Only when the run is logged:}
RUN LOG — your first action, before reading or editing anything:
run_log: {"path": "{log path, forward slashes}", "phase": {N}, "wave": {W}, "sprint": "{X.Y}", "attempt": {attempt}, "max": {max}}
Append one line to the run log from a POSIX shell (bash; Git Bash on Windows, never PowerShell). Use this exact command, replacing only the {…} placeholders and keeping every other character: {path} (twice), {phase}, {wave}, {sprint}, {attempt} and {max} come from run_log; {gate} is implement; {result} is start; {summary} is empty, so '{summary}' becomes ''.
mkdir -p "$(dirname '{path}')" && printf '{"v":1,"ts":"%s","phase":%d,"wave":%d,"sprint":"%s","gate":"%s","result":"%s","attempt":%d,"max":%d,"summary":"%s"%s}\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" '{phase}' '{wave}' '{sprint}' '{gate}' '{result}' '{attempt}' '{max}' "$(printf '%s' '{summary}' | tr '\042\134\011\012\015' "'/   " | tr -d '\000-\037')" "${RL_FILES:-}" >> '{path}'
One line per implementation run. If you're later continued with a retry that gives a new attempt, append a new start line with it first. If the command exits non-zero, fix an obvious slip and run it once more at most, then put one line in NOTES (run log: append failed — {reason}) and carry on. It never blocks a task. Never write the log with a file-edit tool.
After the start line, log each task as you work, with the same command: before you begin a task append a task start line, and when that task is finished append a task pass line. {gate} is task; {result} is start or pass; {summary} is the task number alone, so '{summary}' becomes '3' for task 3; {attempt} and {max} are the ones on your start line. A finished task's pass line and the next task's start line may be chained with && in one command. A task you couldn't finish gets no pass line. On a retry, log only the tasks you work on again. The same failure rule applies: a failed append is one line in NOTES and never blocks or delays a task. These lines only show progress; the phase file is still not yours to edit.

PROJECT CONVENTIONS:
{Point at whatever convention docs this project uses — list paths, don't paraphrase; sub-agent reads them itself}

{For 3a-ui only:}
DESIGN SYSTEM (read first — overrides generic UI skills, if it exists):
{absolute path or skill name: workspace_root/docs/design/design-system.md}
DESIGN SECTIONS (read these, not the whole file): {design_sections from skill-router}

AGENT SKILL:
{phase-ui-implement, loaded per runtime-adapter.md} — read and follow

SKILLS TO READ AND FOLLOW:
{references from skill-router — any optional UI-pattern skill for UI; domain skills for general}
Read each one before coding. Project design-system.md wins on conflict with any generic UI skill.

AVAILABLE INTEGRATIONS:
{tool inventory from Step 1 — list of connected MCP tools and what they do}

TOOL USAGE POLICY:
- Prefer connected MCP tools when available — they're more reliable and integrated.
  e.g. use a database MCP for migrations if connected, otherwise use that database's CLI.
  e.g. use a deploy-platform MCP for deploys if connected, otherwise use its CLI.
  e.g. use a version-control MCP for PRs if connected, otherwise use the CLI or git directly.
  e.g. use an end-to-end testing CLI (if the project has one) when the sprint needs browser-level verification — prefer it over ad-hoc manual click paths for repeatable checks.
- If an MCP tool is available, use it. If not, fall back to the CLI equivalent.
- Only mark a task BLOCKED if neither the MCP tool nor any CLI/code alternative can accomplish it.
  In that case, use reason "No tool available: {what's needed}" so the orchestrator can prompt
  the user to install something.
- Run a quick self-check before returning (see SELF-CHECK below). Don't run the full test suite or the build — **phase-verify sub-agent** runs those after you return and decides pass or fail.
- Do NOT run browser automation / responsive / visual QA here (MCP browser tools, manual click-throughs) — wave-test sub-agent handles that before doc-sync on UI waves. Running an e2e spec file you wrote is a test, not browser QA, and is fine.
- Don't run git commands that change the working tree, index, stash, refs or history (stash, checkout, switch, reset, restore, clean, commit, merge, rebase). Read-only git (status, diff, log, show) is fine.

PHASE CONTEXT (scoped — not the full phase file, see "Phase context" note above):
{phase-level preamble: title, goal, decision log, sequencing notes — everything before the first "# Sprint" header}

THIS SPRINT'S SECTION (verbatim from the phase file):
{this sprint's own "# Sprint {X.Y} — {Title}" section only: Goal, Tasks table, Acceptance Criteria, Dependencies, Verification. Do not include sibling sprints.}

---

YOUR TASK: Implement Sprint {X.Y} — {Sprint Title}

Goal: {sprint goal line}

Tasks to implement (implement ALL of these unless a task is genuinely impossible):
{task table rows — include only tasks with status —, ~, or BLOCKED. Never MANUAL}

Acceptance Criteria:
{acceptance criteria section}

Dependencies:
{dependencies section}

{If retry: PRIOR VERIFY / WAVE TEST FAILURES — fix these before returning:
{failures from prior run}
}

---

INSTRUCTIONS:

Work through the tasks systematically. For each task:
- Implement it fully
- Use MCP tools where available — see TOOL USAGE POLICY above
- If a task requires something only a human can provide (missing credentials, an irreversible
  external action, an architectural decision that changes the project's direction), mark it
  BLOCKED and explain clearly — do not guess or make assumptions
- If a required integration is missing, mark the task BLOCKED with "Tool not connected: {name}"
  rather than improvising a workaround
- If a task is one only the user can do (publish a package, install something on their machine,
  record a video, a call or action outside the codebase), don't mark it BLOCKED. List it under
  MANUAL and say in NOTES exactly what the user must do. Do any agent-doable part of it first

SELF-CHECK (once, when every task is written — not after each file):
1. Run the project's typecheck or lint-level check (for `package.json` projects, `npm run check` if it exists, else `npx tsc --noEmit`; use the equivalent for other stacks). It takes seconds and catches most verify failures.
2. Run only the test files this sprint added or changed, by path (e.g. `npx vitest run test/foo.test.ts`, `npx playwright test tests/e2e/foo.spec.ts`). Not the whole suite.
3. Fix what fails and re-run just the failing part. At most two fix rounds; if something still fails, stop and say so in CHECKS — verify will report it.
4. In a parallel wave another sprint is editing at the same time. A failure only in files you didn't touch is theirs: leave it alone and note it in CHECKS.

Do NOT edit `docs/phases/*.md` or any phase plan files — status updates are handled by doc-sync after all verification passes (CLI verify; plus wave-test on UI waves).

When you are done, your final message MUST end with this exact structured block:

SPRINT RESULT:
COMPLETED: [comma-separated task numbers, or NONE]
BLOCKED: [comma-separated task numbers, or NONE]
BLOCKED_REASONS: [for each blocked task on a new line: "Task N: <reason>"]
MANUAL: [comma-separated task numbers only the user can do, or NONE]
CHECKS: [self-check result, e.g. "check pass; 3 test files, 24/24 pass" — or what still fails]
NOTES: [anything important — decisions made, warnings, things the next sprint should know, what the user must do for each MANUAL task]
```

### 3b. Spawn the implementation sub-agent(s)

The **executor** (the agent running this skill) must invoke the sub-agent tool resolved in `runtime-adapter.md`.

- **One sprint in the wave:** one call — pass the full prompt from 3a as the prompt.
- **Multiple sprints in the wave:** one call **per sprint**, same turn (see Step 3 "If the wave has multiple sprints"); each call uses that sprint's 3a prompt and a distinct **description** (e.g. `Sprint 1.2 — Schema migrations`).

For every call:

- Set the **type** to the general-purpose type resolved in runtime-adapter.md for all implementation (UI agent is prompt-driven via the `phase-ui-implement` skill).
- Set **description:** `Sprint {X.Y} — UI {short title}` or `Sprint {X.Y} — {short title}`; on retry append `(retry {n})` — **never** `Fix {X.Y}`.
- **Never** spawn implementation for wave N+1 in the same turn as doc-sync, verify, or wave-test for wave N.

Sub-agents start without the parent chat history; the injected prompt is what carries context — keep it complete.

**Limits:** Parallelism is **only** multiple 3b calls within one multi-sprint wave. All gates (verify → wave-test → doc-sync) and cross-wave work are **strictly sequential** (see Wave sequencing).

### 3b-verify. CLI verify sub-agent (orchestrator — no inline commands)

After **every** implementation call in the wave returns (with valid `SPRINT RESULT` or on retry after prior verify fail):

Spawn **exactly one** verify call:

- **description:** `Verify — {sprint ids}` e.g. `Verify — 5.2, 5.3`
- **prompt:** load the `phase-verify` skill per runtime-adapter.md; JSON payload with `project_root` = **app_root**, `workspace_root`, `wave_sprints`, `skills_to_follow` (project convention docs relevant to build/test, from project-layout.md), `default_command`, `acceptance_checks`, `diff_base`, `run_log` (see Run log), and in worktree mode `leak_check`
- **`wave_sprints`:** per sprint, `id`, `title`, `verification_cli`, `acceptance` (every criterion, verbatim), and `tasks` (`n`, task text, Module cell or `null`, plus `"manual": true` on a task that is `MANUAL` in the phase file or in its `SPRINT RESULT`) — all read from the phase file you already parsed in Step 2. Verify's review contract gives each criterion a verdict and checks scope against the Module cells
- **model:** `gate_model` if resolved; a **fresh** agent each wave (see Sub-agent lifecycle)

Wait for `VERIFY RESULT:` **before spawning 3f or 3c-sync or any call for the next wave**.

| VERIFY STATUS | Orchestrator action |
|---------------|---------------------|
| PASS | `✓ Verify — {ids} ({summary}; criteria {met}/{total} met)` → 3c (UI waves: then 3f before doc-sync). Keep its `SNAPSHOT` (candidate `wave_end`) and `E2E_SPECS` (for 3f) |
| PARTIAL | Log NOTES → 3c (unless strict mode → 3b-verify-retry). Keep `SNAPSHOT` and `E2E_SPECS` as for PASS. Record every `UNVERIFIED` criterion and non-blocking scope note for the Step 4 checkpoint; drop the `UNVERIFIED (wave-test)` ones once that wave's wave-test passes. In strict mode, retry only for findings in files a sprint in this wave owns — `UNVERIFIED` criteria and files no implementer wrote can't change on a retry, so carry them to the checkpoint instead |
| FAIL | **3b-verify-retry** — do not doc-sync or wave-test |

**Missing `SPRINT RESULT`:** Re-spawn implementation first; do not verify until a result block exists.

### 3b-verify-retry. CLI verify gate (fix until pass)

On `VERIFY RESULT: STATUS: FAIL`:

1. Increment `verify_retry_count` for this wave (start at 0 when wave begins).
2. If `verify_retry_count >= max_verify_retries` (default **3**) → **escalate** (see Retry limits); do not retry until user responds.
3. Parse `AFFECTED_SPRINTS`, `FAILURES`
4. Re-spawn **same sprint** implementation — **3a-ui** or **3a-general** with `PRIOR VERIFY / WAVE TEST FAILURES` (description `Sprint {X.Y} — … (retry {n})`), run-log `attempt` = the new `verify_retry_count + 1`. **No fix-only sub-agents.**
5. Wait for `SPRINT RESULT:` → re-spawn **3b-verify** only (one call this turn)
6. Repeat until verify passes the gate (`PASS`, or `PARTIAL` outside strict mode), user says stop/skip, or escalation

Orchestrator logs: `↻ Verify — 5.3 (retry {n}/{max})`.

**Do not doc-sync or wave-test** until verify passes the gate — `PASS`, or `PARTIAL` outside strict mode (unless user explicitly skips via escalation option 2).

### 3c. Parse implementation results (orchestrator — no phase file edits)

For **each** implementation sub-agent final message in the wave:

1. Extract `SPRINT RESULT:` — require a prior passing verify (`PASS`, or `PARTIAL` outside strict mode) before doc-sync payload is used
2. Parse `COMPLETED`, `BLOCKED`, `BLOCKED_REASONS`, `MANUAL`, `NOTES` into the phase-doc-sync payload (one object per sprint, ascending `id`; `MANUAL` → `manual`). A result without a `MANUAL` line means `NONE`. Keep each `MANUAL` task and what NOTES says the user must do for the Step 4 checkpoint
3. Do **not** edit the phase file in this step
4. **Hold payload** on UI waves until **3f** passes — spawn **3c-sync** only after wave-test PASS/WARN

Load the `phase-doc-sync` skill for payload shape and `DOC SYNC RESULT` handling.

### 3c-sync. Spawn doc-sync sub-agent (required after every wave)

Spawn **exactly one** doc-sync call when:

| Wave type | Spawn doc-sync when |
|-----------|---------------------|
| **Data-only** | `VERIFY RESULT: PASS`, or `PARTIAL` outside strict mode (after 3c) |
| **UI** | `WAVE TEST RESULT: PASS` or `WARN` (after 3f; never before wave-test) |

**Do not doc-sync** on UI waves after CLI verify alone — wait for wave-test.

- **type:** the doc-sync-dedicated type if runtime-adapter.md resolved one, otherwise the same general-purpose type
- **description:** `Doc sync — {sprint ids}` e.g. `Doc sync — 11.1` or `Doc sync — 11.2, 11.4`
- **prompt:** phase-doc-sync template; `project_root` = **workspace_root**; `app_root` = **app_root**; `phase_file` relative to workspace_root; full JSON payload, including `run_log` (see Run log)
- **model:** `gate_model` if resolved; a fresh agent each wave
- **same turn:** the next wave's implementation call(s), when there is a next wave and 3d found no blockers (see Advance rule)

Wait for `DOC SYNC RESULT:` **before the next wave's verify**, and before the Step 4 checkpoint on the last wave.

| DOC SYNC STATUS | Orchestrator action |
|-----------------|---------------------|
| SUCCESS | One-line log per sprint. Next wave continues as planned |
| PARTIAL / FAILED | Let any in-flight implementation calls finish, but spawn nothing else. Show FAILURES and NOTES; offer retry doc-sync or manual fix. Once fixed, resume at the next wave's verify with the `diff_base` it already had |

**Orchestrator rule:** Never directly edit `docs/phases/*.md` during an active phase run. All status column updates go through doc-sync.

When the user skips a blocked task and says defer/cut, or says it's theirs to do, add `user_overrides` to the next doc-sync payload before spawning (`DEFERRED`, `CUT` or `MANUAL`).

### 3f. Wave test sub-agent (per wave, when UI)

After **3c** (verify passed) and **before doc-sync**, if **`wave_has_ui`**:

Spawn **exactly one** wave-test call:

- **description:** `Wave test — {sprint ids}` e.g. `Wave test — 5.2, 5.3`
- **prompt:** load the `phase-wave-test` skill per runtime-adapter.md; JSON with `project_root` = **app_root**, `workspace_root`, `design_system_doc` = `{workspace_root}/docs/design/design-system.md` (if it exists), `design_sections` (union of the wave's sprints), `harness_doc`, `tier`, `wave_sprints`, `skills_to_follow`, `test_urls`, `acceptance_notes`, `e2e_specs`, `screenshot_dir`, `run_log` (see Run log)
- **`skills_to_follow`:** each skill as the skill-router resolved it — an absolute `SKILL.md` path when you know it, otherwise the exact name to load with the skill tool. Never a bare name the tester would have to search the disk for
- **`e2e_specs`:** the `E2E_SPECS` list from the last passing `VERIFY RESULT` (spec files in this wave's diff that verify ran and saw pass). The tester skips browser checks those specs already assert
- **`screenshot_dir`:** `{workspace_root}/docs/phases/.runs/screenshots/phase-{N}/wave-{W}/`, absolute, forward slashes. Run noise, like the run log
- **tier:** `full` on the wave's first test; `regression` with `retest_only` = the previous `FAILURES` on every retry; `light` when the wave's UI change has no new visual surface, or when it only scaffolds a screen that a later sprint builds out
- **model:** `gate_model` if resolved; a **fresh** agent every time — first test and every retry (see Sub-agent lifecycle)

Wait for `WAVE TEST RESULT:` **before 3c-sync** — never batch with verify or doc-sync in the same turn.

| WAVE TEST STATUS | Orchestrator action |
|------------------|---------------------|
| PASS | `✓ Wave test — {ids} (PASS)` → 3d → **3c-sync** ∥ next wave |
| WARN | Log warnings → 3d → **3c-sync** ∥ next wave (unless strict mode → treat as FAIL) |
| FAIL | **3f-retry** — do not doc-sync or advance wave |

**Skip 3f** when `wave_has_ui: false` (data-only wave) — go straight to **3c-sync** after verify.

### 3f-retry. UI verify gate (fix until pass)

On `WAVE TEST RESULT: STATUS: FAIL`:

1. Increment `wave_test_retry_count` for this wave (start at 0 when wave begins).
2. If `wave_test_retry_count >= max_wave_test_retries` (default **3**) → **escalate** (see Retry limits); do not retry until user responds.
3. Parse `AFFECTED_SPRINTS`, `FAILURES`, `ISSUES`, `DESIGN_ISSUES`
4. Re-spawn **same sprint** implementation (3a-ui / 3a-general, `(retry {n})`, failures injected), run-log `attempt` = `verify_retry_count + 1`, unchanged. **No fix-only sub-agents.**
5. Wait for `SPRINT RESULT:` → **3b-verify** (wait for `PASS`, or `PARTIAL` outside strict mode)
6. Re-spawn **3f** only, fresh, at `tier: regression` with `retest_only` — **do not doc-sync** until wave-test PASS/WARN
7. Repeat until `PASS`/`WARN`, user says stop/skip, or escalation

Orchestrator logs: `↻ Wave test — 5.3 (retry {n}/{max})`.

### 3d. Check for blockers

If any tasks are BLOCKED (in any sprint of the current wave), **stop before the next wave** and report. For a parallel wave, list **which sprint** each blocker belongs to. `MANUAL` tasks are not blockers: never stop for them, just carry them to the Step 4 checkpoint. Handle two categories of blocker differently:

**"No tool available" blockers** — surface these with an install path:

```
⚠ Sprint {X.Y} — {Title} hit a blocker: no tool available.

  Task {N}: {description}
  Requires: {what's needed} — no MCP or CLI equivalent found

Options:
  1. Connect it now — I'll help locate an MCP server or install docs for "{tool name}"
  2. Skip this task and continue
  3. Stop here

What would you like to do?
```

If the user chooses option 1: same as Step 1 — connector discovery via your environment's integration settings or web search; then have them enable it and re-run the sprint.

**All other blockers** — surface with context:

```
⚠ Sprint {X.Y} — {Title} hit a blocker.

Blocked task(s):
{for each blocked task}
  Task {N}: {description}
  Reason: {reason from sub-agent}

Options:
  1. Resolve the blocker and re-run sprint {X.Y}
  2. Skip the blocked task(s) and continue to sprint {X.Y+1} — deferred, cut, or yours to do (MANUAL)
  3. Stop here

What would you like to do?
```

Do not proceed until the user responds. If they resolve it, re-run the implementation sub-agent for that sprint. If they skip, add `user_overrides` to the doc-sync payload (`DEFERRED` or `CUT`, or `MANUAL` when they say the task is theirs to do — e.g. "that one's mine") and spawn doc-sync — still no orchestrator edits to the phase file. A task overridden to `MANUAL` joins the checkpoint's manual list.

### 3e. Advance

If no blockers, log completion and move to the **next sprint or next wave**:

```
✓ Sprint {X.Y} complete. ({N} tasks)
✓ Verify — {ids} (PASS)
✓ Wave test — {ids} (PASS)   ← UI waves, before doc-sync
✓ Doc sync — {ids}           ← after all gates pass
```

For a multi-sprint wave, log verify → wave-test (if UI) → doc-sync → one line per sprint. **Start the next wave's implementation in the same turn as this wave's doc-sync**, and hold its verify until `DOC SYNC RESULT: SUCCESS` (see Advance rule).

---

## Step 4 — Phase Boundary Checkpoint

After all sprints in the current phase are done (or you've reached the end of what was requested), **always pause** — never auto-advance to the next phase.

**Before generating the checkpoint message:**
- Re-read the completed phase file to get accurate sprint titles and task counts. Do not rely on memory — invent nothing. Every task still `MANUAL` in it goes on the manual list, including ones planned that way in sprints that ran.
- Read the next phase file to list what's ahead.

Report:
```
Phase {N} — {Title} complete.

Sprints run:
  ✓ Sprint {X.1} — {exact title from phase file} ({N} tasks)
  ✓ Sprint {X.2} — {exact title from phase file} ({N} tasks)
  ...
{if any blockers were hit}
  ⚠ Sprint {X.Y} — {Title} has {N} blocked task(s) remaining
{if any MANUAL tasks — reported this run, overridden to MANUAL, or in sprints skipped for being manual-only}
Manual — yours to do (mark each x in the phase file when done):
  ☐ {sprint id} #{N} — {task text} — {what the user must do, from NOTES, if given}
{if verify left any criteria UNVERIFIED or scope notes}
Needs a human check:
  ? {sprint id} — "{criterion}" — {what would decide it}
  ↗ {sprint id} — touched {file} outside its Module column

---

Next: Phase {N+1} — {Title}
Sprints ahead: {X+1.1}, {X+1.2}, ...
First sprint goal: {goal of first sprint in next phase}

💡 This orchestrator thread has been accumulating result blocks from every sprint/verify/wave-test/doc-sync
   call this phase. Consider running /compact (or starting a fresh session) before continuing —
   sub-agents start cold regardless, so nothing is lost.

Ready to begin Phase {N+1}? (yes / no / not yet)
```

Only continue if the user explicitly confirms.

### Worktree mode — finish the phase

In worktree mode, the checkpoint does **not** offer the next phase — one worktree is one phase. Instead it offers:

```
Phase {N} is done on branch {branch}. Merge it back?
  1. Merge — bring master into this branch, re-verify, then merge into master
  2. Keep the worktree — stop here, merge later
```

On **1**, spawn one sub-agent, description `Worktree finish — phase {N}`:

1. Commit anything uncommitted in the worktree (message: `Phase {N}: {title}`).
2. Merge the default branch **into the worktree branch**. On conflict: `git merge --abort`, list the conflicting files, return — never resolve silently.
3. If the merge brought in changes, run the project's check command (same as `phase-verify`'s default). Fail → return without merging.
4. Merge the worktree branch into the default branch **in `repo_root`**. If `repo_root` has uncommitted changes to any file the merge touches, stop and report instead of merging.
5. Return `WORKTREE FINISH RESULT` with `STATUS: MERGED | CONFLICT | CHECK_FAILED | BLOCKED`, `FILES` and `NOTES`.

On `MERGED`, ask before removing the worktree. On yes: if the session entered the worktree, exit it with the worktree tool (`keep` — a worktree entered by path is not removed by the tool); then spawn one call, `Worktree cleanup — phase {N}`, that runs `git -C {repo_root} worktree remove {path}` and `git -C {repo_root} branch -d phase/{N}`. On anything else, show the files and stop — the user resolves it, then asks to finish again.

Migrations merged from a worktree are already applied to the shared local database. Nothing to re-run.

---

## Error Handling

| Situation | Action |
|-----------|--------|
| Phase file not found | Tell user the expected path, ask to confirm correct location |
| Sub-agent returns no SPRINT RESULT block | Re-spawn implementation; do not verify or doc-sync until result exists |
| Verify returns FAIL | 3b-verify-retry; escalate at max (default 3) — no doc-sync until pass |
| Verify retry limit reached | Escalate with failure summary; wait for user (continue / skip gate / stop) |
| Wave test returns FAIL | 3f-retry loop — re-implement, re-verify, re-test; no doc-sync until wave-test pass |
| Wave test retry limit reached | Escalate with failure summary; wait for user |
| Doc-sync returns FAILED / PARTIAL | Do not advance wave; show FAILURES; retry doc-sync or fix phase file manually |
| Orchestrator tempted to edit phase file directly | Don't — spawn doc-sync instead |
| Orchestrator tempted to run a CLI check directly | Don't — spawn phase-verify instead |
| Orchestrator tempted to run browser/QA tools directly | Don't — spawn wave-test instead |
| Sub-agent times out or errors | Report it, offer to retry or skip; if part of a parallel wave, collect sibling outcomes then decide whether to retry failed sprint(s) alone or shrink the wave |
| Git merge conflicts after parallel wave | Sign overlap was underestimated — resolve manually or re-run affected sprints sequentially with clearer ownership |
| All sprints in phase already complete | Report "Phase {N} is fully complete — nothing to run", plus the manual list if any `MANUAL` tasks are left || User says "stop" at any point | Stop immediately, report where you left off |
| Sub-agent blocked on "no tool available" | Surface install path: connector discovery, CLI install, or your environment's integration settings |
| Tool connected mid-run | Re-inject updated tool inventory into next sub-agent prompt |
| User requests a specific skill mid-run | Add to skill-router plan per skill-router.md override rules |
| Orchestrator spawns the next wave's verify before doc-sync returned | Stop — wait for DOC SYNC SUCCESS first; only the next wave's **implementation** may overlap doc-sync |
| Orchestrator batches verify + wave-test + doc-sync | Stop — one gate per turn; see Wave sequencing |
| Orchestrator spawns a "Fix {sprint}" or fixer sub-agent for code | Stop — use same-sprint re-implement `(retry n)` per Retry implementation only |
| workspace_root vs app_root unclear | Resolve via project-layout.md at Step 1; never guess per sprint |
| Worktree mode: no git repo found at, above or one level below the session folder | Say so and stop; don't guess a repo |
| Worktree mode: another worktree is running the same phase | Stop — one phase file, one worktree |
| Worktree finish: merge conflict | Abort the merge, list files, wait for the user — never resolve silently |
| Two phases in two sessions **without** worktrees | Warn: each verify gate checks the whole repo and will fail on the other session's in-progress code. Offer worktree mode |

---

## Phase File Locations

Phase files live at `docs/phases/Phase-{N}-{Name}.md`, one per phase, numbered sequentially. Example naming for a hypothetical project:

```
docs/phases/Phase-1-Foundation-and-Schema.md
docs/phases/Phase-2-Core-Feature.md
docs/phases/Phase-3-Integrations.md
...
```

The exact number of phases and their names are entirely project-specific — phase-planner creates these as the project is scoped. Nothing about phase-builder assumes a fixed count or fixed names.

---

## Example Run

```
User: "Implement phase 5 with responsive-testing"

[Step 0: runtime resolved — Task tool, general-purpose type, skills loaded by path]
[Step 1: project layout]
  workspace_root: …/my-project           — docs/phases, doc-sync
  app_root:       …/my-project/app       — build/test, src/

[Step 1.2: design is published → Sub-agent: Design check → DESIGN SYNC RESULT: unchanged]
[Step 1.5: skill-router …]

[Turn 1 — Wave 1: 5.1 only]
[Sub-agent: Sprint 5.1 → SPRINT RESULT]
[Turn 2]
[Sub-agent: Verify — 5.1 → VERIFY RESULT: PASS, SNAPSHOT = wave_end]
[Turn 3 — doc-sync for wave 1 ∥ wave 2 implementation: 5.2 + 5.3]
[Sub-agents: Doc sync — 5.1 + Sprint 5.2 + Sprint 5.3]
  → DOC SYNC RESULT: SUCCESS, then both SPRINT RESULTs
✓ Sprint 5.1 complete
[Turn 4]
[Sub-agent: Verify — 5.2, 5.3 → PASS]
[Turn 5]
[Sub-agent: Wave test — 5.2, 5.3 → PASS]
[Turn 6 — last wave: doc-sync alone]
[Sub-agent: Doc sync — 5.2, 5.3 → SUCCESS]

[On verify FAIL — no Fix task]
[Turn N]   [Sub-agent: Sprint 5.3 — UI frequency (retry 1) → SPRINT RESULT]
[Turn N+1] [Sub-agent: Verify — 5.3 → PASS]
…

[Forbidden: Doc sync 5.1 + Verify 5.2 same turn]
[Forbidden: Verify 5.9 + Wave test 5.9 + Doc sync 5.9 same turn]
[Forbidden: Sub-agent "Fix 5.4 titration test"]
```
