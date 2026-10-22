/**
 * The phase-viewer core model.
 *
 * One typed snapshot of a project folder: its phase plans (phases → sprints →
 * tasks) plus the run-log events phase-builder's gates appended while running
 * them, grouped into waves with derived escalations and progress.
 *
 * Three layers fill it:
 *
 * - The phase-file parser fills {@link Phase}, {@link Sprint}, {@link Task} and
 *   everything under them. It never throws; anything it can't read becomes a
 *   {@link Warning}.
 * - The run-log reader fills {@link RunEvent}. It skips malformed lines, also
 *   with a warning.
 * - `loadProject` (`load.ts`) ties both together and derives {@link PhaseRuns},
 *   {@link WaveRun}, {@link SprintRun}, {@link Escalation} (`derive/run.ts`)
 *   and {@link ProjectProgress} (`derive/progress.ts`). `sprintHistory`
 *   (`derive/history.ts`) answers the Sprint detail page's run questions.
 *
 * Everything here is plain JSON data (no Maps, Sets, Dates or classes) so the
 * server can send a {@link Project} over SSE unchanged.
 *
 * Line numbers are always 1-based. Paths in {@link Task.module} are relative to
 * the app root; paths in {@link Task.reference} are relative to the project
 * folder. Both are kept exactly as written in the phase file.
 */

// ---------------------------------------------------------------------------
// Enumerations
// ---------------------------------------------------------------------------

/**
 * Every normalized task status, in display order.
 *
 * Phase files write these as `—` (todo), `~` (active), `x` (done), `BLOCKED`,
 * `MANUAL`, `CUT` and `DEFERRED`. The parser also accepts common variants (`-`,
 * `–`, `[ ]`, `[x]`, lowercase words). Anything else normalizes to `unknown`
 * and the raw text is kept in {@link Task.rawStatus}.
 *
 * `blocked` means an agent tried the task and got stuck; `manual` is a task
 * only the user can do (publish, reinstall, record). Both need the user, and
 * both are eligible and not done.
 */
export const TASK_STATUSES = [
  'todo',
  'active',
  'done',
  'blocked',
  'manual',
  'cut',
  'deferred',
  'unknown',
] as const;

/** A task's normalized status. See {@link TASK_STATUSES}. */
export type TaskStatus = (typeof TASK_STATUSES)[number];

/**
 * Run-log gate names from event format v1, plus `unknown` for any other value
 * a future writer might send.
 *
 * `task` is not a gate that runs: an implementer writes a `task` line as it
 * starts and as it finishes each task. Those lines are markers, kept out of
 * every wave's and sprint's events and steps; what they say is in
 * {@link SprintRun.tasks} (see `derive/run.ts`).
 */
export const RUN_GATES = ['implement', 'verify', 'wave_test', 'doc_sync', 'task', 'unknown'] as const;

/** Which gate wrote a {@link RunEvent}. See {@link RUN_GATES}. */
export type RunGate = (typeof RUN_GATES)[number];

/**
 * Run-log results from event format v1, plus `unknown` for any other value.
 *
 * `start` is only valid on `implement` and `task`. On `implement`,
 * phase-builder logs it when a sprint's implementation begins (logs written
 * before it existed have none, and read exactly as before). It is a marker,
 * not an outcome: it is never a {@link GateStep}, never counts as an attempt,
 * and never cuts a wave (see `derive/run.ts`). On `task`, the implementer logs
 * it as it begins a task, and `pass` as it finishes it. `start` on any other
 * gate is read as `unknown`, with a warning.
 */
export const RUN_RESULTS = ['pass', 'partial', 'warn', 'fail', 'blocked', 'start', 'unknown'] as const;

/** A gate's outcome for one sprint. See {@link RUN_RESULTS}. */
export type RunResult = (typeof RUN_RESULTS)[number];

/**
 * Where a sprint stands inside one wave, derived from its latest event with a
 * known gate (events with gate `unknown` are skipped, and `task` lines are
 * never among a sprint's events). Any result other than
 * `fail` counts as the gate passing (`partial`, `warn`, `blocked` and
 * `unknown` included):
 *
 * | Latest event                        | State |
 * |-------------------------------------|-------|
 * | none with a known gate              | `implementing` |
 * | `implement` `start`                 | `implementing`: phase-builder logs it as implementation begins |
 * | `implement` (any other result)      | `verifying`: phase-verify logs `implement` as it starts, so its `ts` marks when verifying began |
 * | `verify` fail                       | `failed` |
 * | `verify` not fail, UI wave          | `testing`: the wave runs a wave test (a sprint in it has a browser test, or a `wave_test` line was already seen in the wave) |
 * | `verify` not fail, data-only wave   | `syncing` |
 * | `wave_test` fail                    | `failed` |
 * | `wave_test` not fail                | `syncing` |
 * | `doc_sync` fail                     | `failed` |
 * | `doc_sync` not fail                 | `done` |
 *
 * - `implementing`: an `implement` `start` line is the latest event. Logs
 *   without start lines only yield this for a sprint whose every event has an
 *   unknown gate. Consumers may use it for a sprint they know is in the
 *   running wave but that has no events yet.
 * - `failed`: a gate failed and nothing later was logged for the sprint. That
 *   covers a retry in progress, a run the user stopped, and an escalation
 *   alike; the viewer doesn't guess which. {@link SprintRun.escalation} tells
 *   an escalation apart.
 */
export const SPRINT_RUN_STATES = [
  'implementing',
  'verifying',
  'testing',
  'syncing',
  'done',
  'failed',
] as const;

/** A sprint's derived state within one wave. See {@link SPRINT_RUN_STATES}. */
export type SprintRunState = (typeof SPRINT_RUN_STATES)[number];

// ---------------------------------------------------------------------------
// Warnings
// ---------------------------------------------------------------------------

/**
 * Something the parser or reader could not fully understand. Warnings never
 * stop parsing; the model is always returned alongside them.
 */
export interface Warning {
  /** Path of the file the warning is about, as given to the parser (`loadProject` passes absolute paths). */
  file: string;
  /** 1-based line number the problem is on. `0` when it concerns the whole file (e.g. the file could not be read). */
  line: number;
  /** The offending line exactly as read, without its line ending. Empty when `line` is `0`. */
  raw: string;
  /** Human-readable description of the problem, e.g. `"Table row has no closing pipe"`. */
  message: string;
}

/**
 * The shape every never-throw parse function returns: its best-effort value
 * plus whatever it had to warn about.
 */
export interface ParseResult<T> {
  /** The parsed value. Always present, even when the input was garbage. */
  value: T;
  /** Problems found while parsing, in file order. */
  warnings: Warning[];
}

// ---------------------------------------------------------------------------
// Phase files
// ---------------------------------------------------------------------------

/**
 * A markdown section the parser keeps as raw text rather than interpreting:
 * unknown `###` sections inside a sprint, or `##` sections at the end of a
 * phase file such as `## Scope Guard` and `## Risk Mitigations`.
 */
export interface Section {
  /** Heading text without the leading `#` marks, trimmed, e.g. `"Scope Guard"`. */
  heading: string;
  /** Heading level: the number of `#` marks (2 for `##`, 3 for `###`). */
  level: number;
  /** Raw markdown between this heading and the next heading of the same or higher level, trimmed. */
  body: string;
  /** 1-based line of the heading. */
  line: number;
}

/** One row of a sprint's task table. */
export interface Task {
  /** The `#` cell as a number. `null` when the cell is missing or not an integer. */
  number: number | null;
  /** The Task cell text exactly as written (inline markdown such as backticks kept). */
  text: string;
  /** Normalized status. Always `todo` for a legacy row (a table without a Status column). */
  status: TaskStatus;
  /** The Status cell as written, trimmed (e.g. `"x"`, `"—"`, `"[ ]"`). `null` for a legacy row. */
  rawStatus: string | null;
  /** `true` when the row comes from a legacy table that has no Status column. */
  legacy: boolean;
  /** The Module cell (a path relative to the app root). `null` when the row omits it or writes a placeholder (`—`, `-`). */
  module: string | null;
  /** The Reference cell (a path relative to the project folder, may include a `#fragment`). `null` when omitted or a placeholder. */
  reference: string | null;
  /** 1-based line of the row in the phase file. */
  line: number;
}

/** One bullet from a sprint's `### Acceptance Criteria` section. */
export interface AcceptanceCriterion {
  /** Bullet text without the bullet marker or checkbox, trimmed. */
  text: string;
  /** Checkbox state when the bullet is written as `- [ ]` / `- [x]`; `null` for a plain bullet. */
  checked: boolean | null;
  /** 1-based line of the bullet. */
  line: number;
}

/**
 * One bullet from a sprint's `### Dependencies` section, with the sprint and
 * phase ids it mentions pulled out. Resolution against the project's actual
 * sprints and phases happens in `loadProject`, which warns about ids that
 * don't exist.
 *
 * Only `Sprint X.Y` and `Phase N` mentions count (also `Sprints X.Y and X.Z`,
 * `Sprint X.Y, X.Z`); a bare `X.Y` is not an id. Text in parentheses and in
 * inline code is a note and is not scanned.
 */
export interface Dependency {
  /** Bullet text without the bullet marker, trimmed, e.g. `"Sprint 1.1 (preferences table must exist)"`. */
  raw: string;
  /** Sprint ids mentioned in the bullet, in order of first mention, without duplicates, e.g. `["1.1"]`. */
  sprints: string[];
  /** Phase numbers mentioned as whole phases (`"Phase 1 (…)"`), in order. Sprint mentions do not add their phase here. */
  phases: number[];
  /** `true` when the bullet says there is no dependency (`"None"`). */
  none: boolean;
  /** 1-based line of the bullet. */
  line: number;
}

/**
 * A sprint's `### Verification` block: the keys phase-builder reads to decide
 * which checks and browser tests to run.
 */
export interface VerificationConfig {
  /** `cli:` value, the check command phase-verify runs (e.g. `"npm run check"`). Absent when the key is missing. */
  cli?: string;
  /** `ui:` routes, split on commas and trimmed. Empty when absent. */
  ui: string[];
  /** `skills:` names, split on commas and trimmed. Empty when absent. */
  skills: string[];
  /** `viewports:` widths in CSS pixels. Non-numeric entries are dropped with a warning. Empty when absent. */
  viewports: number[];
  /** `skip-ui:` as a boolean. Absent when the key is missing or its value isn't a boolean (which warns). */
  skipUi?: boolean;
  /** `assert:` values, one entry per `assert:` bullet (or nested bullet under `assert:`), in order. Empty when absent. */
  assert: string[];
  /**
   * Any other `key: value` bullet, keyed by the normalized key (lowercased,
   * spaces and underscores as hyphens). A repeated key keeps its last value.
   */
  extra: Record<string, string>;
  /** 1-based line of the `### Verification` heading; `0` when the sprint has no Verification block. */
  line: number;
}

/** One `# Sprint N.M — Title` block inside a phase file. */
export interface Sprint {
  /** Sprint id as written in the header, e.g. `"2.1"`. */
  id: string;
  /** Phase number, the part of the id before the dot. */
  phase: number;
  /** Sprint number within the phase, the part of the id after the dot. */
  number: number;
  /** Title after the separator (`—`, `–`, `-` or `:`), trimmed. */
  title: string;
  /** Text of the `### Goal` section, trimmed. `null` when the sprint has no Goal section. */
  goal: string | null;
  /** Rows of the `### Tasks` table, in file order. Empty when there is no table. */
  tasks: Task[];
  /** `true` when the task table has no Status column (every task is then `legacy`). */
  legacyTable: boolean;
  /** Bullets from `### Acceptance Criteria`, in order. */
  acceptanceCriteria: AcceptanceCriterion[];
  /** Bullets from `### Dependencies`, in order. */
  dependencies: Dependency[];
  /**
   * The `### Verification` block. A sprint without one gets an empty config
   * (every list empty, no `cli` or `skipUi`, `line` `0`), not a warning.
   */
  verification: VerificationConfig;
  /** Any other `###` section inside the sprint (e.g. `### Notes`), kept raw, in order. */
  sections: Section[];
  /** 1-based line of the `# Sprint` header. */
  line: number;
  /** 1-based line of the sprint's last line (before the next sprint header or trailing `##` section, or end of file). */
  endLine: number;
}

/** One `docs/phases/Phase-{N}-{Name}.md` file. */
export interface Phase {
  /** Phase number from the `# Phase N — Title` header (falls back to the file name). */
  number: number;
  /** Title after the separator in the `# Phase` header, trimmed. */
  title: string;
  /** Prose between the phase header and the first sprint, trimmed, with `---` dividers removed. Empty when there is none. */
  intro: string;
  /** Path of the phase file (absolute when produced by `loadProject`). */
  file: string;
  /** Sprints in file order. */
  sprints: Sprint[];
  /** `##` sections after the last sprint (e.g. `Scope Guard`, `Risk Mitigations`), in order. */
  trailingSections: Section[];
  /** 1-based line of the `# Phase` header, or `0` when the file has none. */
  line: number;
  /**
   * The linked git worktree this copy of the phase file was read from, when
   * the viewer shows it from one (the phase is running there). Absent for a
   * copy from the main checkout, and always absent from `loadProject`.
   */
  worktree?: WorktreeRef;
}

/**
 * A linked git worktree a {@link Phase} or {@link PhaseRuns} was read from
 * (see `server/checkouts.ts`).
 */
export interface WorktreeRef {
  /** The worktree's name: its folder under `{git common dir}/worktrees/`. */
  name: string;
  /** Checked-out branch without `refs/heads/`; `null` when detached or unknown. */
  branch: string | null;
  /** Absolute project folder inside the worktree (the one holding its `docs/phases/`). */
  path: string;
}

// ---------------------------------------------------------------------------
// Run log
// ---------------------------------------------------------------------------

/**
 * One line of `docs/phases/.runs/phase-{N}.jsonl`, run-log event format v1.
 * Field meanings follow the spec in `plugin/skills/phase-builder/run-log.md`.
 */
export interface RunEvent {
  /**
   * Format version as logged: normally `1`. A line with a newer version (`> 1`)
   * is still read best-effort, with one warning per file; anything else is skipped.
   */
  v: number;
  /** UTC timestamp of the append, `YYYY-MM-DDTHH:MM:SSZ`, kept as written. */
  ts: string;
  /** Phase number. */
  phase: number;
  /** Wave number within the run. A drop in wave number between lines marks a new run. */
  wave: number;
  /** Sprint id, e.g. `"2.4"`. */
  sprint: string;
  /** Gate that wrote the event; `unknown` when the log has a gate this reader doesn't know. */
  gate: RunGate;
  /** The `gate` field exactly as logged. */
  rawGate: string;
  /** Gate outcome; `unknown` when the log has a result this reader doesn't know. */
  result: RunResult;
  /** The `result` field exactly as logged. */
  rawResult: string;
  /** 1-based attempt of this gate in this wave. A label only; line order is the true sequence. */
  attempt: number;
  /**
   * Retry limit for this gate; `0` means no limit. When the line has no valid
   * `max`, the reader fills the spec default: `1` for `doc_sync`, `3` otherwise.
   */
  max: number;
  /** One-line summary; empty string when missing. */
  summary: string;
  /** `doc_sync` only: files the wave changed, relative to the app root. Absent when not logged. */
  files?: string[];
  /** `task` lines only: the task number, read from `summary`. Absent on every other gate. */
  task?: number;
  /** 1-based line of the event in its `.jsonl` file. */
  line: number;
}

/**
 * Where one task stands while its sprint is being implemented, from the
 * sprint's latest `task` line for that task number in one wave.
 *
 * It is the implementer's own report, not a status: the gates still decide
 * whether the work passes, and the task's {@link Task.status} changes only
 * when doc sync edits the phase file.
 */
export interface TaskProgress {
  /** Task number: the `#` of the task's row. */
  task: number;
  /**
   * `running` after the task's `task` `start` line; `built` after its `pass`
   * line: the implementer finished it, and no gate has checked it yet.
   */
  state: 'running' | 'built';
  /** `attempt` as logged: the implementation run that wrote the line. */
  attempt: number;
  /** Timestamp as logged. */
  ts: string;
  /** 1-based line of the `task` line in the `.jsonl` file. */
  line: number;
}

/**
 * One event of a sprint within one wave, as a step of its gate timeline.
 * Copies the event's fields and adds {@link GateStep.seq}.
 */
export interface GateStep {
  /** Gate that wrote the event. */
  gate: RunGate;
  /** Gate outcome. */
  result: RunResult;
  /** `attempt` as logged. A label: a verify re-run after a wave-test failure repeats it, and it resets to 1 after "continue retrying". */
  attempt: number;
  /** Retry limit as logged (or the reader's default); `0` means no limit. */
  max: number;
  /**
   * 1-based count of this gate's steps for this sprint in this wave, in line
   * order: the true sequence, which {@link GateStep.attempt} may not be.
   */
  seq: number;
  /** One-line summary; empty when none was logged. */
  summary: string;
  /** Timestamp as logged. */
  ts: string;
  /** 1-based line of the event in the `.jsonl` file. */
  line: number;
  /** `doc_sync` only: files the wave changed, as logged. Absent when the event carried none. */
  files?: string[];
}

/** One run of the escalated gate, as listed in {@link Escalation.history}. */
export interface EscalationAttempt {
  /** `attempt` as logged. */
  attempt: number;
  /** Gate outcome of this run. */
  result: RunResult;
  /** One-line summary (the failure reason on a `fail`). */
  summary: string;
  /** Timestamp as logged. */
  ts: string;
  /** 1-based line in the `.jsonl` file. */
  line: number;
}

/**
 * A derived escalation: a `verify` or `wave_test` `fail` at `attempt >= max`
 * (with `max > 0`) and no later line for that sprint anywhere later in the
 * log. Never logged directly; any later event for the sprint (an `implement`
 * after "continue retrying", a skipped gate's `doc_sync`, a new run) clears it.
 */
export interface Escalation {
  /** Phase number. */
  phase: number;
  /** 1-based index of the run within the phase's log (see {@link WaveRun.run}). */
  run: number;
  /** Wave number within that run. */
  wave: number;
  /** Sprint id. */
  sprint: string;
  /** Gate that failed for the last time. */
  gate: RunGate;
  /** Attempt number of the final failure (normally equal to `max`; never below it). */
  attempt: number;
  /** Retry limit that was reached. */
  max: number;
  /** Summary of the final failing event. */
  summary: string;
  /** Timestamp of the final failing event. */
  ts: string;
  /** 1-based line of the final failing event in the `.jsonl` file. */
  line: number;
  /**
   * Every run of the escalated gate for this sprint in this wave, in line
   * order (the retry history: attempt 1, 2, 3 …, including earlier cycles
   * before a "continue retrying" reset). The last entry is the final failure.
   */
  history: EscalationAttempt[];
}

/** Everything that happened to one sprint within one wave of one run. */
export interface SprintRun {
  /** Sprint id. */
  sprint: string;
  /** Phase number. */
  phase: number;
  /** 1-based run index (see {@link WaveRun.run}). */
  run: number;
  /** Wave number within the run. */
  wave: number;
  /** This sprint's events in this wave, in log order, `implement` `start` markers included. `task` lines are not: see {@link SprintRun.tasks}. */
  events: RunEvent[];
  /** The same events as ordered gate steps, with a per-gate sequence number. `start` markers are left out. */
  steps: GateStep[];
  /** Derived state after the latest event. See {@link SprintRunState} for the table. */
  state: SprintRunState;
  /** Highest `attempt` seen per gate (gates never logged are absent). `start` markers don't count. */
  attempts: Partial<Record<RunGate, number>>;
  /** The latest event, or `null` if the sprint has none yet. */
  lastEvent: RunEvent | null;
  /** The escalation that ended this sprint's wave, or `null` (none, or cleared by a later event for the sprint). */
  escalation: Escalation | null;
  /**
   * Union of `files` from this sprint's `doc_sync` events in this wave, in
   * first-seen order. `null` when none carried `files`. doc-sync logs the
   * whole wave's diff on every sprint's line; `sprintHistory` puts the files
   * under the sprint's Module paths first.
   */
  files: string[] | null;
  /**
   * Task progress from the sprint's `task` lines in this wave: the latest
   * line per task number, ordered by task number. Absent when the wave has no
   * `task` line for the sprint, so a log without them derives exactly as it
   * did before they existed. `task` lines change nothing else here: not
   * `events`, `steps`, `state`, `attempts`, `lastEvent`, `startedAt` or
   * `updatedAt`.
   */
  tasks?: TaskProgress[];
  /** `ts` of the first event. */
  startedAt: string;
  /** `ts` of the latest event. */
  updatedAt: string;
}

/** One wave of one run, as reconstructed from line order. */
export interface WaveRun {
  /** Phase number. */
  phase: number;
  /**
   * 1-based run index within the phase's log. Wave numbers restart at 1 each
   * time phase-builder runs the phase again, so a drop in `wave` starts a new run.
   */
  run: number;
  /** Wave number within the run. */
  wave: number;
  /** One entry per sprint that appears in the wave, in first-seen order. */
  sprints: SprintRun[];
  /**
   * Every event of the wave, in log order, including the `implement` `start`
   * markers placed in it (which may sit on lines between the previous wave's
   * events: the next wave's implementation starts as the previous wave's doc
   * sync runs). `task` lines are left out; they are in each sprint's
   * {@link SprintRun.tasks}.
   */
  events: RunEvent[];
  /** Union of `files` from the wave's `doc_sync` events, or `null` when none carried `files`. */
  files: string[] | null;
  /** `ts` of the wave's first event (derived wave start; a `start` marker when one was logged). */
  startedAt: string;
  /**
   * Derived wave end: once every sprint in the wave has a passing `doc_sync`
   * as its latest event (every sprint `done`), the `ts` of the wave's last
   * event. `null` while any sprint is not `done` (running, failed, escalated).
   */
  endedAt: string | null;
  /** `true` when any sprint in the wave escalated. */
  escalated: boolean;
}

/** All run-log data for one phase. */
export interface PhaseRuns {
  /** Phase number. */
  phase: number;
  /** Path of the `.jsonl` file (absolute when produced by `loadProject`). */
  file: string;
  /** Every valid event, in log order, `task` lines included. */
  events: RunEvent[];
  /** Waves in log order, across all runs. */
  waves: WaveRun[];
  /** Every derived escalation, in log order. */
  escalations: Escalation[];
  /** Per sprint id, every {@link SprintRun} for that sprint across runs and waves, oldest first. */
  sprintHistory: Record<string, SprintRun[]>;
  /**
   * The linked git worktree this run log was read from, when the viewer shows
   * it from one. Absent for the main checkout's log, and always absent from
   * `loadProject`.
   */
  worktree?: WorktreeRef;
}

/** One wave of a sprint's history, as returned by `sprintHistory`. */
export interface SprintWaveHistory {
  /** 1-based run index (see {@link WaveRun.run}). */
  run: number;
  /** Wave number within the run. */
  wave: number;
  /** The sprint's derived state at the end of this wave (or now, for the running wave). */
  state: SprintRunState;
  /** The sprint's gate steps in this wave, in line order. */
  steps: GateStep[];
  /** The escalation that ended this wave for the sprint, or `null`. */
  escalation: Escalation | null;
  /**
   * Files the wave changed (union of the wave's `doc_sync` `files`), with the
   * files under this sprint's Module paths first, each group in logged order.
   * `null` when no `doc_sync` in the wave carried `files` ("not logged").
   */
  files: string[] | null;
  /** The leading part of {@link SprintWaveHistory.files} that falls under the sprint's Module paths. Empty when `files` is `null`. */
  moduleFiles: string[];
  /** `ts` of the wave's latest `doc_sync` event that carried `files`; `null` when none did. */
  filesAt: string | null;
  /** `ts` of the sprint's first event in the wave. */
  startedAt: string;
  /** `ts` of the sprint's latest event in the wave. */
  updatedAt: string;
}

/** A gate step placed in its run and wave, for a flat cross-wave timeline. */
export interface HistoryStep extends GateStep {
  /** 1-based run index. */
  run: number;
  /** Wave number within the run. */
  wave: number;
}

/** Everything the run log says about one sprint, across runs and waves. */
export interface SprintHistory {
  /** Sprint id. */
  sprint: string;
  /** Phase number. */
  phase: number;
  /** Path of the phase's `.jsonl` run log. */
  file: string;
  /** One entry per wave the sprint appears in, oldest first. Empty when the log never mentions the sprint. */
  waves: SprintWaveHistory[];
  /** Every step across those waves, oldest first (line order). */
  steps: HistoryStep[];
}

// ---------------------------------------------------------------------------
// Progress and project
// ---------------------------------------------------------------------------

/**
 * Task counts for a sprint, a phase or the whole project. Cut and deferred
 * tasks are not eligible: they count in `byStatus` and `total` but not in
 * `eligible` or `percent`. Blocked, manual and unknown tasks are eligible and
 * not done.
 */
export interface Progress {
  /** Every task, including cut and deferred. */
  total: number;
  /** Tasks that count toward completion: `total` minus `cut` and `deferred`. */
  eligible: number;
  /** Tasks with status `done`. */
  done: number;
  /** `done / eligible * 100`, rounded to a whole number; `0` when `eligible` is `0`. */
  percent: number;
  /** Count of tasks per status (every status present, zero when none). */
  byStatus: Record<TaskStatus, number>;
}

/** The sprint the Overview's "Next up" card points at. */
export interface NextUp {
  /** Phase number. */
  phase: number;
  /** Sprint id. */
  sprint: string;
  /** Sprint title. */
  title: string;
}

/** A task with status `blocked`, located for the Overview's "Blocked" card. */
export interface BlockedTask {
  /** Phase number. */
  phase: number;
  /** Sprint id. */
  sprint: string;
  /** The task's `#`, or `null` when the row has none. */
  number: number | null;
  /** Task text as written. */
  text: string;
  /** Path of the phase file. */
  file: string;
  /** 1-based line of the task row. */
  line: number;
}

/** Derived progress at every level, keyed so it serializes as plain JSON. */
export interface ProjectProgress {
  /** All tasks in all phases. */
  overall: Progress;
  /** Per phase number (as a string key, e.g. `"2"`). */
  byPhase: Record<string, Progress>;
  /** Per sprint id (e.g. `"2.1"`). */
  bySprint: Record<string, Progress>;
  /**
   * The first sprint with a `todo` or `active` task, walking phases from the
   * lowest number and sprints in file order. `null` when no sprint has one.
   */
  nextUp: NextUp | null;
  /** Every `blocked` task, in phase then file order. */
  blocked: BlockedTask[];
  /** Number of `deferred` tasks in the project (left out of every percent). */
  deferred: number;
  /** Number of `cut` tasks in the project (left out of every percent). */
  cut: number;
}

/** Everything the viewer knows about one project folder. */
export interface Project {
  /** Absolute path of the project folder (the folder that contains `docs/phases/`). */
  root: string;
  /** Absolute path of the phases folder, normally `{root}/docs/phases`. */
  phasesDir: string;
  /** Parsed phase files, sorted by phase number. */
  phases: Phase[];
  /** Run-log data, one entry per phase that has a `.runs/phase-{N}.jsonl`, sorted by phase number. */
  runs: PhaseRuns[];
  /** `true` when `{root}/docs/design/design-system.md` exists. */
  hasDesignSystem: boolean;
  /** Derived task progress. */
  progress: ProjectProgress;
  /**
   * Every warning from the loader, every phase file and every run log,
   * grouped by file in load order (phase files by number, then run logs).
   * A missing `docs/phases/` is one warning on `phasesDir`.
   */
  warnings: Warning[];
}
