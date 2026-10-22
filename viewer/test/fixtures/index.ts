/**
 * Absolute paths to every test fixture, so tests never build `../` paths by hand.
 *
 * Each project fixture is a project folder: `{root}/docs/phases/Phase-N-*.md`,
 * so `loadProject(root)` can point straight at it. Fixtures are copies checked
 * in here; no test reads the plugin's `examples/` folder.
 *
 * | Fixture          | What it covers |
 * |------------------|----------------|
 * | `sample-project` | Verbatim copy of the plugin's `examples/sample-project/docs/` (phases + design). 1 phase, 2 sprints, 7 tasks, all `x`, 0 warnings expected. Has `docs/design/design-system.md`. |
 * | `multi-phase`    | 3 phases, 7 sprints. Cross-sprint and cross-phase dependencies, all seven canonical statuses (3.2's task 3 is `MANUAL`), sprint 2.2 has no Verification block, sprint 3.1 has an unknown `### Notes` section, sprint 2.3 has two `ui` routes and an unknown `timeout` key, sprint 2.1 has two `assert` bullets. Phase 1 ends with `## Scope Guard`; phase 2 ends with `## Scope Guard` and `## Risk Mitigations`. No design system. Run logs in `docs/phases/.runs/`, see {@link MULTI_PHASE_RUN_LOGS}. |
 * | `legacy-table`   | Sprint 1.1 table has no Status column (3 legacy tasks, 5/4/3-cell rows); sprint 1.2 is the migrated shape. Sprint 1.1 has no Verification block. |
 * | `sparse-rows`    | Sprint 1.1: 5-column header with 5-, 4- and 3-cell rows. Task 2 is a 4-cell Module-only row (`src/api/retry.ts`); task 4 is the 4-cell Reference-only form (`docs/design/screens/settings.md`, which a parser can only tell apart by its `docs/` / `.md` shape); task 5 has a `—` placeholder Module. Sprint 1.2: a 4-column `Status \| # \| Task \| Reference` header. |
 * | `mixed-symbols`  | Status cells `[x]`, `[X]`, `[ ]`, `-`, `–`, `—`, `X`, `blocked`, `Cut`, `deferred`, and `WIP` (→ `unknown`). Headers with en dash (phase + 1.1), colon (1.2) and hyphen (1.3). Checkbox and `*` acceptance bullets. Mixed-case Verification keys in 1.2 (`CLI:`, `Skip-UI: TRUE`). |
 * | `broken`         | See {@link BROKEN_LINES}. Contains real NUL and invalid UTF-8 bytes; `.gitattributes` marks it binary. |
 * | `trail-log`      | The dev / e2e fixture that `scripts/simulate-run.ts` plays a live run on. 3 phases, 8 sprints, run logs for phases 1 and 2. See {@link TRAIL_LOG}. |
 * | `worktree-run`   | `trail-log` as a git repo with phase 2 running in a linked worktree. The main checkout has phases 1–3, phase 2 with nothing done and no log. `dot-git/` is the synthetic `.git` (main on `main`, worktree `phase-2-trip-journal` on `claude/phase-2-trip-journal`) and `worktrees/phase-2-trip-journal/` its checkout, with phases 1–2 (2.1 done) and phase 2's log. Only usable as a copy: `prepareFixture` renames `dot-git/` and writes the path files (`linkWorktrees` in `scripts/simulate-run.ts`). |
 *
 * {@link RUN_LOGS} holds standalone `.jsonl` run logs: two real ones
 * (`realSmoke`, `realPhase1`) and synthetic ones for each shape the reader and
 * wave derivation must handle. Lines are LF-terminated unless noted.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Absolute path of `test/fixtures/`. */
export const FIXTURES_DIR = path.dirname(fileURLToPath(import.meta.url));

/** Absolute path of the viewer app root (`phase-runner-repo/viewer/`). */
export const APP_ROOT = path.resolve(FIXTURES_DIR, '..', '..');

/**
 * This project's own phase plans, `../../docs/phases/` from the app root (the
 * coordination folder that holds `phase-runner-repo/`). Only present in the
 * author's workspace, never in a fresh clone or CI; the dogfood test skips
 * itself when it's missing.
 */
export const DOGFOOD_PHASES_DIR = path.resolve(APP_ROOT, '..', '..', 'docs', 'phases');

/** Paths for one project-shaped fixture. */
export interface ProjectFixture {
  /** Absolute project folder (what `loadProject` takes). */
  root: string;
  /** Absolute `{root}/docs/phases`. */
  phasesDir: string;
  /** Absolute paths of each phase file, in phase order. */
  phaseFiles: string[];
}

function projectFixture(name: string, phaseFileNames: string[]): ProjectFixture {
  const root = path.join(FIXTURES_DIR, name);
  const phasesDir = path.join(root, 'docs', 'phases');
  return { root, phasesDir, phaseFiles: phaseFileNames.map((f) => path.join(phasesDir, f)) };
}

/** Copy of the plugin's sample project. */
export const SAMPLE_PROJECT = projectFixture('sample-project', ['Phase-1-Notifications.md']);

/** Synthetic three-phase project. */
export const MULTI_PHASE = projectFixture('multi-phase', [
  'Phase-1-Foundations.md',
  'Phase-2-Library-UI.md',
  'Phase-3-Sharing.md',
]);

/**
 * Run logs inside the `multi-phase` fixture (`docs/phases/.runs/`), so
 * `loadProject` sees a project with logs. Phase 3 has none.
 */
export const MULTI_PHASE_RUN_LOGS = {
  /** Wave 1: sprint 1.1 implement → verify → doc_sync (3 files). Wave 2: sprint 1.2 verify fails at attempt 1, passes at 2, doc_sync with 4 files incl. `README.md` (8 events). */
  phase1: path.join(MULTI_PHASE.phasesDir, '.runs', 'phase-1.jsonl'),
  /** Wave 1: sprint 2.1 (a `ui:` sprint) implement `blocked`, verify `partial`; nothing after, so it is waiting on the wave test (2 events). */
  phase2: path.join(MULTI_PHASE.phasesDir, '.runs', 'phase-2.jsonl'),
} as const;

/** A task table without a Status column, next to a migrated one. */
export const LEGACY_TABLE = projectFixture('legacy-table', ['Phase-1-Legacy.md']);

/** 3-, 4- and 5-cell rows, including the Reference-only form. */
export const SPARSE_ROWS = projectFixture('sparse-rows', ['Phase-1-Sparse.md']);

/** Non-canonical status symbols and sprint-header separators. */
export const MIXED_SYMBOLS = projectFixture('mixed-symbols', ['Phase-1-Mixed.md']);

/** A deliberately malformed phase file. */
export const BROKEN = projectFixture('broken', ['Phase-1-Broken.md']);

/**
 * The dev and end-to-end fixture: a small "Trail Log" app mid-build. Phase 1
 * is complete (its log has a verify fail → retry → pass and a wave test);
 * phase 2 has run wave 1 (sprint 2.1, all four gates) and has 2.2 (UI), 2.3
 * (data) and 2.4 still to do; phase 3 hasn't started. 0 warnings expected.
 * `scripts/simulate-run.ts` copies it to a temp folder and appends phase 2's
 * next waves to `.runs/phase-2.jsonl`.
 */
export const TRAIL_LOG = projectFixture('trail-log', [
  'Phase-1-Foundations.md',
  'Phase-2-Trip-Journal.md',
  'Phase-3-Maps.md',
]);

/** Run logs inside the `trail-log` fixture. */
export const TRAIL_LOG_RUN_LOGS = {
  /** Wave 1: 1.1 to doc_sync. Wave 2: 1.2 verify fails at attempt 1, passes at 2, wave test, doc_sync (9 events). */
  phase1: path.join(TRAIL_LOG.phasesDir, '.runs', 'phase-1.jsonl'),
  /** Wave 1: 2.1 implement → verify → wave_test → doc_sync (4 events). */
  phase2: path.join(TRAIL_LOG.phasesDir, '.runs', 'phase-2.jsonl'),
} as const;

/** Every project fixture by name. */
export const PROJECT_FIXTURES = {
  'sample-project': SAMPLE_PROJECT,
  'multi-phase': MULTI_PHASE,
  'legacy-table': LEGACY_TABLE,
  'sparse-rows': SPARSE_ROWS,
  'mixed-symbols': MIXED_SYMBOLS,
  broken: BROKEN,
  'trail-log': TRAIL_LOG,
} as const satisfies Record<string, ProjectFixture>;

/** Standalone run-log fixtures (`test/fixtures/runs/*.jsonl`). */
export const RUN_LOGS = {
  /** Real log from the Phase 1 smoke run: verify fails at attempt 1, passes at attempt 2, then doc_sync with files (5 events, sprint 2.1, wave 1). */
  realSmoke: path.join(FIXTURES_DIR, 'runs', 'real-smoke.jsonl'),
  /** Real Phase 1 log: sprint 1.4, wave 1 — implement pass, verify `partial`, doc_sync pass with 5 files (3 events). */
  realPhase1: path.join(FIXTURES_DIR, 'runs', 'real-phase-1.jsonl'),
  /** Phase 2, wave 3, sprint 2.4: implement #1, verify #1 fail, implement #2, verify #2 pass, doc_sync pass with 2 files (5 events). */
  failRetryPass: path.join(FIXTURES_DIR, 'runs', 'fail-retry-pass.jsonl'),
  /**
   * Phase 3. Wave 1 runs sprints 3.1 and 3.2 in parallel (3.2's implement is `blocked`,
   * its verify `partial`; both doc_sync lines carry the same 3 files). Line 4's `ts` is one
   * second earlier than line 3's (clock skew). Wave 2 runs 3.3 to doc_sync (9 events).
   */
  parallelWave: path.join(FIXTURES_DIR, 'runs', 'parallel-wave.jsonl'),
  /** Phase 2, wave 2, sprint 2.5: implement + verify `fail` at attempts 1, 2 and 3 of max 3, nothing after (6 events). */
  escalation: path.join(FIXTURES_DIR, 'runs', 'escalation.jsonl'),
  /**
   * `escalation`'s 6 lines, then the user picked "continue retrying": implement at attempt 1
   * (the counter reset), verify pass at attempt 1, doc_sync pass with 2 files (9 events).
   */
  continuedAfterEscalation: path.join(FIXTURES_DIR, 'runs', 'continued-after-escalation.jsonl'),
  /**
   * Real log of this project's own Phase 2 through wave 3 (12 events). Wave 1: 2.1. Wave 2:
   * 2.2 and 2.3 in parallel (2.3 verify `partial`, both doc_sync lines carry the same 31 files).
   * Wave 3: 2.4.
   */
  realPhase2: path.join(FIXTURES_DIR, 'runs', 'real-phase-2.jsonl'),
  /**
   * Real log of this project's own Phase 2, complete (15 events): `realPhase2` plus wave 4
   * (2.5). No `implement` `start` lines. Rail durations: start not logged, 15, 13, 16 min.
   */
  realPhase2Full: path.join(FIXTURES_DIR, 'runs', 'real-phase-2-full.jsonl'),
  /**
   * Real log of this project's own Phase 4 (16 events). Wave 1: 4.1 with a wave test. Wave 2:
   * 4.2 verify fails at attempts 1 and 2, implement attempt 3 fixes it, then wave test and
   * doc_sync (27 min, 2 retries). Wave 3: 4.3.
   */
  realPhase4: path.join(FIXTURES_DIR, 'runs', 'real-phase-4.jsonl'),
  /**
   * Phase 4, wave 1, sprint 4.2: verify pass, wave_test #1 fail, implement + verify re-run
   * (attempt stays 1), wave_test #2 pass, doc_sync pass (7 events).
   */
  waveTestRetry: path.join(FIXTURES_DIR, 'runs', 'wave-test-retry.jsonl'),
  /** Phase 5, wave 1, sprint 5.1: implement pass, verify fail at attempt 1 of 3, then nothing (2 events). */
  stoppedRun: path.join(FIXTURES_DIR, 'runs', 'stopped-run.jsonl'),
  /** Phase 2, sprint 2.2: 2 complete events, then a doc_sync line cut off mid-write with NO trailing newline. */
  truncatedLastLine: path.join(FIXTURES_DIR, 'runs', 'truncated-last-line.jsonl'),
  /** Phase 2, sprint 2.1: 5 lines; line 3 is a torn (newline-terminated) append. 4 events. See {@link RUN_LOG_LINES}. */
  malformedInterior: path.join(FIXTURES_DIR, 'runs', 'malformed-interior.jsonl'),
  /**
   * Phase 6, sprint 6.1, 5 events. Line 1: extra `agent` field. Lines 2–3: `v: 2` (line 2 has an
   * extra field, line 3 gate `review`). Line 4: result `skipped`. Line 5: doc_sync with no
   * `summary` and no `max`. See {@link RUN_LOG_LINES}.
   */
  unknownValues: path.join(FIXTURES_DIR, 'runs', 'unknown-values.jsonl'),
  /**
   * Binary garbage (NUL, 0xFF 0xFE, lone 0x80, truncated 0xC3, ESC, DEL, PNG magic with CR LF).
   * 5 terminated lines — only line 3 is a valid event (phase 7, sprint 7.1) — then an
   * unterminated garbage tail. Read it as a Buffer.
   */
  binaryGarbage: path.join(FIXTURES_DIR, 'runs', 'binary-garbage.jsonl'),
  /**
   * Phase 3 with the implementers' `task` lines (28 lines: 13 gate and start lines, 15 `task`
   * lines). Wave 1 runs 3.1 and 3.2 in parallel, their `task` lines interleaved: 3.1 builds
   * tasks 1 and 2; 3.2 builds 1 and 2 and starts 3, which its `implement` line reports blocked
   * (a `start` with no `pass`). 3.1's verify fails and its retry (attempt 2) logs task 2 again.
   * Wave 2's `start` line and first `task` line land before wave 1's `doc_sync` lines; it ends
   * mid-implementation with task 1 built, task 2 running, and a `task` line for a task 9.
   * See {@link TASK_LINES}.
   */
  taskLines: path.join(FIXTURES_DIR, 'runs', 'task-lines.jsonl'),
} as const;

/** 1-based line numbers in the `taskLines` fixture. */
export const TASK_LINES = {
  /** 3.2's `task` `start` for task 3, which never gets a `pass`. */
  blockedTaskStart: 11,
  /** 3.1's `implement` `start` for attempt 2. */
  retryStart: 16,
  /** 3.1's `task` `pass` for task 2 in the retry (its latest line for that task). */
  retryTaskPass: 18,
  /** Wave 2's `implement` `start`, before wave 1's `doc_sync` lines. */
  nextWaveStart: 22,
  /** Wave 1's last line: 3.2's `doc_sync`. */
  waveOneEnd: 25,
  /** 3.3's `task` line for task 9. */
  unknownTask: 28,
} as const;

/** 1-based line numbers of the notable lines in the run-log fixtures. */
export const RUN_LOG_LINES = {
  /** `malformedInterior`: the torn append. */
  malformedInterior: 3,
  /** `unknownValues`: first `v: 2` line (the file's one version warning). */
  unknownVersion: 2,
  /** `unknownValues`: gate `review`. */
  unknownGate: 3,
  /** `unknownValues`: result `skipped`. */
  unknownResult: 4,
  /** `unknownValues`: doc_sync without `summary` or `max`. */
  missingOptional: 5,
  /** `binaryGarbage`: the only valid event. */
  binaryValidEvent: 3,
} as const;

/**
 * 1-based line numbers of each problem in `broken/docs/phases/Phase-1-Broken.md`
 * (91 lines, LF endings). The fixture test checks these still point at the
 * right lines.
 */
export const BROKEN_LINES = {
  /** `| — | 2 | Second row has no closing pipe | src/b.ts` (sprint 1.1 table). */
  unclosedRow: 18,
  /** `| — | 3 | Third row was cut off mid-cell | src/c` (also has no closing pipe). */
  truncatedRow: 19,
  /** Prose directly after the table with no blank line: the table never closes cleanly. */
  proseAfterTable: 20,
  /** `# Sprint one — Malformed Header`: no `N.M` id. Its table (1 task) belongs to no sprint. */
  malformedSprintHeader: 32,
  /** `# Sprint 1.3 — Missing Goal`: the sprint has Tasks but no `### Goal`. */
  missingGoal: 46,
  /** Stray bytes: NUL, SOH, 0xFF 0xFE, lone 0x80, ESC, DEL, `stray bytes`, NUL, truncated 0xC3. */
  binaryBytes: 55,
  /** `# Sprint 1.4 — Recovers`: a well-formed sprint after the damage (2 tasks, expect no warnings inside it). */
  recoversSprint: 67,
} as const;
