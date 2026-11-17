---
name: phase-verify
description: "Per-wave CLI verification for phase-builder. Spawned as a sub-agent after implementation calls return — runs the project's build and typecheck, the tests related to the wave's changes, and sprint acceptance grep patterns, then reviews the wave diff against a contract: a verdict per acceptance criterion, test-integrity checks, and scope against each sprint's Module column. Once per phase, in suite mode, runs the full test suite. Returns structured VERIFY RESULT. Orchestrator must never run CLI checks directly for verification."
---

# Phase Verify

Per-wave CLI verification sub-agent. **Read-only for phase plan files** — do not fix app code unless the orchestrator sets `fix_mode: true` (default `false` → report FAIL so the implementation agent fixes).

The **phase-builder orchestrator** spawns you after implementation calls in a wave return. On **data-only** waves you gate doc-sync; on **UI** waves you gate wave-test (doc-sync runs only after wave-test passes). Once per phase, after the last wave, it spawns you in `mode: "suite"` to run the full test suite (see Suite mode).

---

## Orchestrator contract

The orchestrator MUST:

1. Spawn **one** verify call per wave (after all implementation calls in the wave return), plus **one** `mode: "suite"` call at the end of the phase
2. Wait for `VERIFY RESULT:` before doc-sync (data-only) or before wave-test (UI waves)
3. On `STATUS: FAIL` — orchestrator re-spawns affected implementation sprint(s) with `FAILURES`, then re-spawns verify until it passes the gate (`PASS`, or `PARTIAL` outside strict mode) or hits the retry limit (default 3, then escalate to user)
4. Log only one line: `✓ Verify — {sprint ids} ({summary}; criteria {met}/{total} met)` — no CLI commands run directly in the orchestrator thread
5. Pass `diff_base` (the `SNAPSHOT` from the last passing verify of the previous wave, or from a baseline call — see phase-builder "Diff baseline") so the review sees only this wave's changes

The orchestrator MUST NOT run build/typecheck/test commands, or grep for acceptance, during an active phase run.

**Model (optional):** the CLI half is mechanical, but the review contract makes judgment calls that can FAIL a wave. A cheaper `gate_model` is fine for most phases — the evidence rules keep false FAILs down — but for logic-heavy phases (auth, payments, migrations) prefer the session default. If `runtime-adapter.md` resolved a `gate_model` and the phase isn't logic-heavy, spawn this call with it.

**Fresh per wave:** spawn a new verify agent for each wave. A verify re-run *within* the same wave (after a retry) may continue the same agent; a new wave never does, because the old agent carries every earlier wave's output into each step. Otherwise use the session default; this is a cost optimization, never a blocker.

---

## Input payload (from orchestrator)

```json
{
  "project_root": "/path/to/app-root",
  "workspace_root": "/path/to/workspace-root",
  "phase_file": "docs/phases/Phase-5-Example-Feature.md",
  "wave_sprints": [
    {
      "id": "5.2", "title": "Utility Layer", "verification_cli": "npm run check",
      "acceptance": ["criterion 1, verbatim from the sprint", "criterion 2"],
      "tasks": [ { "n": 1, "task": "task text", "module": "src/utils/" }, { "n": 2, "task": "task text", "module": null } ]
    },
    { "id": "5.3", "title": "Feature UI", "verification_cli": "npm run check", "acceptance": ["..."], "tasks": ["..."] }
  ],
  "diff_base": "git tree sha from the previous SNAPSHOT, or null",
  "mode": "verify",
  "skills_to_follow": [
    "{project convention doc for build/test, e.g. a rules file or CONTRIBUTING.md — resolved in project-layout.md}"
  ],
  "default_command": "{resolved from project-layout.md stack detection}",
  "acceptance_checks": ["grep patterns or notes from sprint acceptance criteria"],
  "leak_check": { "repo_root": "/path/to/main-checkout", "baseline": "git status --porcelain output from worktree setup" },
  "run_log": {
    "path": "/path/to/workspace-root/docs/phases/.runs/phase-5.jsonl", "phase": 5, "wave": 2, "attempt": 1, "max": 3,
    "sprint_results": [ { "sprint": "5.2", "completed": [1, 2], "blocked": [], "notes": "first line of NOTES" } ]
  },
  "fix_mode": false
}
```

| Field | Purpose |
|-------|---------|
| `project_root` | **app_root** — run all CLI commands from here |
| `workspace_root` | Coordination folder (optional context; phase file lives here) |
| `skills_to_follow` | Paths or names — read these first if the project has documented build/test conventions |
| `verification_cli` per sprint | From sprint `### Verification` `cli:` line; use strictest / union of commands when wave has multiple. Its test step is narrowed to related tests (see Test selection) |
| `default_command` | Fallback when no `cli:` hints — resolved by stack detection in project-layout.md, not a fixed universal default |
| `acceptance_checks` | Optional grep/file-exists checks named in acceptance criteria |
| `fix_mode` | If `true`, apply minimal fixes and re-run; default `false` → report FAIL |
| `acceptance` per sprint | Every acceptance criterion, verbatim. Each one gets a verdict in the review contract |
| `tasks` per sprint | Task text plus its Module cell (`null` when the row has none). Module cells define the sprint's scope; task text decides whether a test change was asked for. `"manual": true` marks a task only the user can do |
| `diff_base` | Git tree sha marking where this wave started. `null` → diff against `HEAD` at low confidence (see Review contract) |
| `mode` | `verify` (default), `baseline` — see Baseline mode — or `suite` — see Suite mode |
| `leak_check` | Worktree mode only. Run `git -C {repo_root} status --porcelain`; any path not in `baseline` means a sub-agent edited the main checkout instead of the worktree → `STATUS: FAIL`, list the paths in `FAILURES` |
| `run_log` | Optional. When present, append `implement` and `verify` events (see Run log). Absent → write nothing |

---

## Execution steps

1. **Read assigned skills/docs**, if any — follow the project's documented build/test workflow (prefer whatever the project's own scripts define; build only when needed)
1b. **Log implementation** — if `run_log` is present, append one `implement` line per entry in `run_log.sprint_results` (see [Run log](#run-log)). Run this append now, as its own command, before step 2 — never hold it back to write alongside the `verify` lines. A live viewer reads the `implement` line as "verifying has started"
2. **Snapshot first** — take `NOW=$(snap)` (see Review contract) *before* running anything, so build and test output never lands in the wave's diff. Report it as `SNAPSHOT`: the orchestrator uses the wave's last passing verify's `SNAPSHOT` as the next wave's `diff_base`. `snap` failed → `SNAPSHOT: NONE — {reason}`, never an empty sha
2b. **Resolve command** — per sprint `### Verification` `cli:`; if multiple sprints specify different commands, run all required commands in order. Then narrow the test step to related tests (see [Test selection](#test-selection))
3. **Run CLI checks** — from **app_root** (`project_root`): build, typecheck, then the selected tests; capture exit code and failure output
4. **Run acceptance checks** — minimal grep / file-exists patterns from sprint acceptance when specified (not full exploratory QA)
4b. **Review contract** — run the four checks in [Review contract](#review-contract-step-4b) below against the wave diff. Read the diff, not whole files; read a whole file only to trace one specific suspected problem. Budget: about 35 tool calls for the whole verify. When the budget runs out, mark the remaining criteria `UNVERIFIED` — never guess `MET` or `NOT_MET`.
4c. **List `E2E_SPECS`** — on UI waves, the end-to-end/browser spec files (Playwright, Cypress and the like) that appear in the wave diff and passed in step 3. Wave-test reads them and skips what they already assert, so only list specs that actually ran
5. **Map failures to sprints** — when stack traces, criteria, or the scope mapping show which sprint broke, set `AFFECTED_SPRINTS`; else `ALL`
6. **If `fix_mode: true`** — apply minimal fixes, re-run failed commands, take a new `NOW`, and re-run step 4b so your own fixes get reviewed too
6b. **Log the verdict** — once STATUS is decided, if `run_log` is present, append one `verify` line per sprint in `wave_sprints`
7. End with `VERIFY RESULT:` block (required)

---

## Test selection

Per wave, run only the tests related to what the wave changed. The full suite runs once, at the end of the phase (Suite mode).

1. **Changed files:** `git diff --relative --name-only {diff_base} "$NOW"` (the snapshot from step 2).
2. **Split the command.** If `verification_cli` (or `default_command`) runs the whole suite — e.g. a `check` script chaining typecheck and test — read the script from the manifest and run its non-test parts as they are. Replace only the test step.
3. **Related tests**, with the stack's runner:

| Runner | Related tests |
|--------|---------------|
| Vitest | `npx vitest related --run {changed source files}` |
| Jest | `npx jest --findRelatedTests {changed source files}` |
| pytest | Test files for the changed modules, by path (`tests/test_{module}.py`, `{module}_test.py`) |
| Go | `go test` on the changed packages (`./{dir}/...`) |
| Cargo | `cargo test -p {changed crates}` |
| Other | The stack's equivalent, if it has one |

4. **Plus every test file in the wave diff** (new or changed, e2e specs included), run by path.
5. **No way to select:** the runner has no related-tests option and test files don't map to sources by path, or the command can't be split → run the full suite and say so in NOTES (`tests: full suite — {reason}`).

Report the selection on the `TESTS` line: `24/24 passed (related to 8 changed files)`.

---

## Review contract (step 4b)

Exit codes say the code builds and the existing tests pass. The review decides whether the wave did what its sprints said, without cheating the tests or wandering out of scope.

### Get the wave diff

Run from app_root. The snapshot uses a throwaway index, so it never touches the user's staging area; it includes untracked files and respects `.gitignore`.

```bash
snap() { tmp=$(mktemp -u); cp "$(git rev-parse --git-path index)" "$tmp" 2>/dev/null; GIT_INDEX_FILE="$tmp" git add -A && GIT_INDEX_FILE="$tmp" git write-tree; rc=$?; rm -f "$tmp"; return $rc; }
NOW=$(snap)                                              # taken in step 2, before any build or test ran
git diff --relative --name-status {diff_base} "$NOW"    # what changed this wave, paths relative to app_root
git diff --relative -U5 {diff_base} "$NOW" -- <paths>   # read the hunks you need
```

PowerShell: same git commands — set `$env:GIT_INDEX_FILE` to a temp path that doesn't exist yet, run `git add -A` and `git write-tree`, then remove the variable and the file.

- `snap` exits non-zero or prints nothing → the snapshot failed; review against `HEAD` at low confidence (next bullet) and say why in NOTES.
- `diff_base` is `null` → use `HEAD` in its place (no commits yet → git's empty tree, `git hash-object -t tree /dev/null`) and report `BASE: HEAD (confidence: low)`. The diff may include uncommitted work from before the run.
- `--relative` limits the review to app_root, and Module cells are read relative to app_root. When app_root is a subfolder of the repo, also run `git diff --name-status {diff_base} "$NOW"` **without** `--relative`, and apply only the blocking out-of-scope rules (deleted files, `docs/phases/*.md`, CI/deploy config, env and auth config) to the paths outside app_root. When `docs/` sits outside the repo entirely, it isn't reviewed here.
- app_root is not in a git repo → report `TEST_INTEGRITY: SKIPPED` and `SCOPE: SKIPPED`, and judge criteria by reading the files the tasks name.
- **Did a failure exist before this wave?** Look, don't move anything: `git show {diff_base}:<path>` shows a file as the wave found it (it works on a tree sha), and `git diff {diff_base} "$NOW" -- <path>` shows what the wave did to it. If that can't settle it, say so in NOTES. Never stash, check out, or reset to find out — see "What you must not do".
- **Status edits from the previous wave's doc-sync:** doc-sync runs while the next wave is implemented, so when the phase file is inside the repo, this wave's diff can include the previous wave's Status-cell edits to `docs/phases/*.md`. A hunk there that changes nothing but Status cells (`—`/`~` → `x`, `BLOCKED`, `MANUAL`, `DEFERRED`, `CUT`) is doc-sync's, not an implementer's: ignore it. Any other change to `docs/phases/*.md` is still blocking.

### a. Acceptance criteria — one verdict each

For every criterion of every sprint in `wave_sprints`:

| Verdict | Requires |
|---------|----------|
| `MET` | Concrete evidence: a passing test that exercises the criterion, or the code in the diff that implements it, or a named acceptance check that passed. Cite `file:line` |
| `NOT_MET` | Concrete evidence it isn't met: the behavior is missing, the code contradicts it, or the test covering it fails. Cite `file:line` |
| `UNVERIFIED` | Can't be decided from the diff, the tests, and a targeted read within budget — e.g. it needs a browser, a live service, or real data. Say what would decide it |

- No evidence → `UNVERIFIED`, never `MET`. The implementer's `COMPLETED` list is a claim, not evidence.
- A suspicion without a citation → `UNVERIFIED`, never `NOT_MET`. False FAILs cost a full retry cycle.
- Visual or interaction criteria on a UI wave → `UNVERIFIED (wave-test)`. Wave-test owns those; they are not a verify failure.
- A criterion that only a `"manual": true` task can meet (the user publishes, installs or records it themselves) → `UNVERIFIED (manual)`, never `NOT_MET`. No retry can change it.

### b. Test integrity

Look at every changed test file (by the project's conventions — `*.test.*`, `*.spec.*`, `test_*.py`, `*_test.go`, `tests/`, `__tests__/`) and test config (runner config, coverage thresholds, CI test steps). Flag any of:

- A test or test file deleted, or a test commented out
- An assertion removed or loosened: exact match → truthy/any, fewer fields checked, tolerance widened, or an expected value changed to match new output
- `skip` / `only` / `todo` / `xfail` / `@Ignore` (or the stack's equivalent) added
- Snapshots rewritten in bulk
- Coverage thresholds lowered, or test paths excluded from the runner

**Exception:** if a task in this wave explicitly asks for the change (its text says to remove, replace, or update that test, or to change the behavior that test pins), record it as `EXPECTED` with the task reference instead of flagging it. Adding or tightening tests is never a flag.

### c. Scope

A sprint's scope is the Module cells of its tasks. A folder covers everything under it; a file covers itself, its test file, and co-located styles/types. Map every changed file to the sprint(s) whose scope contains it.

Never flagged: lockfiles and manifests when a dependency was added; files the project regenerates (generated types, client SDKs); index/barrel files that only re-export in-scope modules; build and test output that isn't gitignored (`*.tsbuildinfo`, `next-env.d.ts`, coverage, new snapshot files from a first run) — mention in NOTES that it should be gitignored; wave-test's own files (the harness doc under `docs/testing/`, screenshots); and the run log under `docs/phases/.runs/`, which the gates append to during the run.

Every other file that maps to no sprint in the wave is `OUT_OF_SCOPE`; name the nearest sprint by path. If any sprint in the wave has no Module cells at all, report `SCOPE: NOT_DECLARED` for it — scope findings for that wave become notes only, since you can't tell whose file it is.

### d. Severity → STATUS

**Blocking → `FAIL`:**
- Any criterion `NOT_MET`
- Any test-integrity flag that isn't `EXPECTED`
- An `OUT_OF_SCOPE` change that deletes a file; edits `docs/phases/*.md` (implementers are never allowed to); or edits CI/deploy config, env files, or auth/security config
- A hardcoded secret or credential in the diff

**Non-blocking → `PARTIAL`** (list under NOTES):
- `UNVERIFIED` criteria
- Other `OUT_OF_SCOPE` files
- Other concerns from reading the diff — duplication, dead code, missing input validation

At `confidence: low`, test-integrity and scope findings on files outside **every** sprint's scope are non-blocking — they may predate the run. Say so in NOTES.

Write every blocking finding into `FAILURES` as one actionable line starting with the sprint id, so the retry prompt can use it unchanged:

```
5.3: criterion "Expired tokens show an error" NOT_MET — src/auth/session.ts:40 returns early before checking expiry
5.2: test weakened — src/utils/cadence.test.ts:18 changed toEqual(7) to toBeTruthy(); no task asks for it
```

---

## Baseline mode

`mode: "baseline"` — sent once, before the first wave of a run, so wave 1's review has a clean starting point. Don't run build, tests, or review, and write nothing to the run log. From app_root, run the `snap` function above and return:

```
VERIFY RESULT:
STATUS: BASELINE
SNAPSHOT: {tree sha, or NONE — reason (e.g. not a git repo)}
```

---

## Suite mode

`mode: "suite"` — sent once per phase, after the last wave's doc-sync, and again after each suite retry. `wave_sprints` lists every sprint implemented this run, with tasks and Module cells but no `acceptance`. `run_log.sprint_results` lists the sprints a suite retry just re-implemented (absent on the first run). Write `implement` lines for those and `suite` lines (see Run log), never `verify` ones.

1. If `run_log` is present: append one `implement` line per `sprint_results` entry, as in step 1b, when there are any; then the `suite` `start` lines, as their own command. Then take `NOW=$(snap)`, as in step 2, and run build, typecheck and the **full** test suite from app_root — the commands as they are, no test selection.
2. No acceptance checks and no review contract: every wave already had both.
3. **Map each failure to sprints** by path: the failing test file, and the source files its stack trace or imports name, against each sprint's Module cells. A failing test that maps to no sprint, and imports nothing the run changed (`git diff --name-only {diff_base} "$NOW"`, when `diff_base` isn't `null`), may predate the phase: leave it out of `AFFECTED_SPRINTS` and say so in NOTES.
4. `leak_check` applies as in verify mode.
5. Once STATUS is decided, if `run_log` is present, append the `suite` result lines.

Return the normal block with `COMMAND`, `TESTS`, `FAILURES` (one line per failure, starting with the sprint id), `AFFECTED_SPRINTS` (sprint ids, or `NONE` when no failure maps to a sprint) and `NOTES`. Set `CRITERIA`, `TEST_INTEGRITY`, `SCOPE` and `E2E_SPECS` to `SKIPPED (suite)`. STATUS is `PASS` or `FAIL` — never `PARTIAL`.

---

## Run log

Only when the payload has `run_log` (never in baseline mode). The spec is phase-builder's `run-log.md`; this is the part you need. Append with this exact line, replacing only the `{…}` placeholders and keeping every other character, including the summary's `tr` pipe and `"${RL_FILES:-}"`. `{path}`, `{phase}`, `{wave}`, `{attempt}` and `{max}` come from `run_log`. Never write the log with a file-edit tool.

```sh
mkdir -p "$(dirname '{path}')" && printf '{"v":1,"ts":"%s","phase":%d,"wave":%d,"sprint":"%s","gate":"%s","result":"%s","attempt":%d,"max":%d,"summary":"%s"%s}\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" '{phase}' '{wave}' '{sprint}' '{gate}' '{result}' '{attempt}' '{max}' "$(printf '%s' '{summary}' | tr '\042\134\011\012\015' "'/   " | tr -d '\000-\037')" "${RL_FILES:-}" >> '{path}'
```

| When | `gate` | One line per | `result` | `summary` |
|------|--------|--------------|----------|-----------|
| Step 1b (suite mode: step 1) | `implement` | entry in `run_log.sprint_results` | `blocked` if its `blocked` list is non-empty, else `pass` | `done 1,2,3; blocked 4 — {notes}`. Empty `blocked` list → drop `; blocked …` entirely (`done 1,2 — {notes}`, never `blocked none`); empty notes → drop ` — {notes}` |
| Step 6b | `verify` | sprint in `wave_sprints` | `fail` if STATUS is FAIL and the sprint is in `AFFECTED_SPRINTS` (or it's `ALL`); `partial` if it has an `UNVERIFIED` criterion or a scope note; else `pass` | on `fail`, its first `FAILURES` line without the sprint id; else `criteria {met}/{total} met`, plus `; {k} unverified` |
| Suite mode, step 1 | `suite` | sprint in `wave_sprints` | `start` | empty: `'{summary}'` becomes `''` |
| Suite mode, step 5 | `suite` | sprint in `wave_sprints` | `fail` if STATUS is FAIL and the sprint is in `AFFECTED_SPRINTS`, or on every line when it's `NONE`; else `pass` | on `fail`, its first `FAILURES` line without the sprint id (with `NONE`, the first failure); else the `TESTS` count (`412/412 passed`) |

- Summaries are one line, at most 200 characters. Write a straight apostrophe as `'\''`; type everything else as-is, including `"` and `\`. Never backslash-escape a character: inside single quotes `\"` stays two characters and lands in the log as `/'`.
- Use a POSIX shell (Git Bash on Windows). Two separate appends: the `implement` lines at step 1b, before any check runs, and the `verify` lines at step 6b. Suite mode: the `implement` lines (if any), then the `suite` `start` lines, then the `suite` result lines, each its own append. Lines of the same gate can be chained with `&&` in one call; never chain `implement` and `verify` lines together.
- An append that exits non-zero gets one line in `NOTES` (`run log: append failed — {reason}`). It never changes STATUS.

---

## VERIFY RESULT block (required)

```
VERIFY RESULT:
STATUS: PASS | FAIL | PARTIAL
COMMAND: {command actually run}
TESTS: 24/24 passed (related to 8 changed files | full suite)
CRITERIA:
- {sprint id} | "{criterion}" | MET | NOT_MET | UNVERIFIED | {evidence file:line, or what would decide it}
TEST_INTEGRITY: CLEAN | FLAGGED | SKIPPED
- {flags, and EXPECTED changes with their task reference — omit lines when CLEAN}
SCOPE: CLEAN | FLAGGED | NOT_DECLARED | SKIPPED
- {file → nearest sprint, blocking or note — omit lines when CLEAN}
BASE: {diff_base sha, or HEAD} (confidence: high | low)
SNAPSHOT: {NOW — the tree sha taken in step 2 (or re-taken in fix_mode), or NONE — reason}
E2E_SPECS: [end-to-end/browser spec files in the wave diff that ran and passed, paths relative to app_root, or NONE]
FAILURES: [empty or actionable list — CLI failures plus blocking review findings]
AFFECTED_SPRINTS: [sprint ids, or ALL — suite mode: sprint ids, or NONE]
NOTES: [env quirks, pre-existing warnings, full-suite fallback]
```

| STATUS | Meaning |
|--------|---------|
| PASS | All required CLI checks exit 0, every criterion `MET`, no review findings |
| PARTIAL | Blocking checks passed; there are non-blocking findings (optional check failed, `UNVERIFIED` criteria, out-of-scope notes) — orchestrator treats as PASS unless strict mode |
| FAIL | A CLI check failed or the review found a blocking issue (see Severity) — orchestrator must 3b-verify-retry |

---

## What you must not do

- Edit `docs/phases/*.md`
- Run browser automation / responsive / visual QA — wave-test handles that on UI waves (before doc-sync)
- Return without `VERIFY RESULT:`
- Mark a criterion `MET` without citing evidence, or `NOT_MET` on a hunch
- Change git state in the user's repo. No `stash`, `checkout`, `switch`, `restore`, `reset`, `clean`, `commit`, `merge`, `rebase`, `pull`, or `add` outside the `snap` function's temporary index. The repo may hold hours of uncommitted work, and a stash that fails to pop strands it. Read-only git (`status`, `diff`, `show`, `log`, `rev-parse`) is all you need
- Search the disk outside app_root and workspace_root (`find /`, globbing the home folder)
- Dump long command output in the final message — summarize in `FAILURES`
