/**
 * Rail derivation: one phase of a {@link Project} in, what the unified
 * interface's phase rail draws out (design-system.md "Unified interface").
 * Pure (no DOM, no React), so unit tests run it in Node against fixtures.
 *
 * It builds on the core's waves, sprint runs and escalations
 * (`core/derive/run.ts`), the sprint status (`data/status.ts`) and the
 * attempt notes (`live/derive.ts`), and adds only what the rail
 * needs on top.
 *
 * **Rail rows.** The phase's sprints in plan order, grouped:
 *
 * | Row | Holds |
 * |-----|-------|
 * | "No run log" (first) | Sprints with no events that have work done (a task done, running or blocked): they ran before the log existed |
 * | One per logged wave, in log order | The sprints whose latest wave it is. Parallel when the logged wave holds more than one sprint |
 * | "Not run yet" (last) | Sprints with no events and no work done (added after the run); every sprint of a phase with no run log |
 *
 * Empty rows are left out. A sprint re-run in a later run of the phase sits
 * in its latest wave only. Sprints the log names but the phase file doesn't
 * have are left out.
 *
 * **Wave durations.** A wave ends at its last passing `doc_sync`. It starts
 * at its first `implement` `start` marker when one is logged, otherwise at
 * the previous wave's end in the same run (phase-verify writes the other
 * `implement` lines as verifying begins, so they can't mark the start). The
 * first wave of a run with no start marker reads "start not logged". A wave
 * whose sprints aren't all done is running and reads "N min so far".
 *
 * **Retries** per wave are the extra implementation runs across its sprints
 * (see {@link waveRetries}): a retry counts from its start marker.
 *
 * **Sprint card state**, first match wins:
 *
 * | State | When |
 * |-------|------|
 * | Needs you (`needs-you`, pink) | A task is blocked, or the sprint's latest wave ended in an escalation |
 * | Needs you (`manual`, violet) | The sprint has started (a task done or running, or run events for it) and its manual tasks are all that's left: every other task is done and no gate is running for it. Blocked wins when both apply |
 * | Waiting | The sprint passed verify or the wave test, but a sibling in its wave hasn't, so the wave's next gate can't run yet (typically the sibling is retrying) |
 * | Verify failed, Wave test failed (red) | The sprint's latest step in the phase's latest run is a failed verify or wave test with retries left (not escalated), and the retry hasn't started |
 * | Implementing, Verifying, Wave testing, Doc syncing | The sprint's derived next gate in the phase's latest run |
 * | Re-implementing, Re-verifying, Wave retesting | The same, when that gate already ran for the sprint in this wave: a retry after a failure (or a re-check after a sibling's) |
 * | Complete | Every eligible task done |
 * | Waiting | Some tasks done, the rest not |
 * | Not started | Anything else (a manual task in a sprint that hasn't started included) |
 *
 * So a sprint with a manual task reads Implementing, Verifying and so on
 * while it is built, and Needs you only once the agents' tasks are done.
 *
 * **Run notes** per sprint, in log order across every wave it ran in: each
 * failed attempt (with how it was resolved, once a later run of the same
 * gate passed), and each `partial` or `warn` result as "passed with notes".
 * While a failure is being retried, the open card also shows it under the
 * tasks table (see {@link currentFailure}).
 *
 * **Filter groups** for the filter row: `complete` (every eligible task done,
 * and no sprint card in a gate state or Needs you), `future` (no task done,
 * running or blocked, and no run events), otherwise `progress`. A manual task
 * is eligible, so a phase with one left is never `complete`; on its own it is
 * not work started, so a phase whose only non-todo tasks are manual stays
 * `future`.
 */
import type {
  Phase,
  PhaseRuns,
  Progress,
  Project,
  RunGate,
  RunResult,
  Sprint,
  SprintRun,
  SprintRunState,
  WaveRun,
} from '../../core/model.js';
import { isStartMarker } from '../../core/derive/run.js';
import { currentSprintRun, phaseRuns, sprintRan, sprintStatus } from '../data/status.js';
import { formatTime, GATE_NAMES, plural } from '../format.js';
import { attemptNotes, attemptTitle, resolutionText, type AttemptResolution } from '../live/derive.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A sprint card's state (its badge). See the module comment. */
export type SprintState =
  | 'implementing'
  | 'verifying'
  | 'wave-testing'
  | 'doc-syncing'
  | 're-implementing'
  | 're-verifying'
  | 're-wave-testing'
  | 'verify-failed'
  | 'wave-test-failed'
  | 'complete'
  | 'waiting'
  | 'not-started'
  | 'needs-you'
  | 'manual';

/** Badge words, typed in sentence case (CSS uppercases them). */
export const SPRINT_STATE_TEXT: Record<SprintState, string> = {
  implementing: 'Implementing',
  verifying: 'Verifying',
  'wave-testing': 'Wave testing',
  'doc-syncing': 'Doc syncing',
  're-implementing': 'Re-implementing',
  're-verifying': 'Re-verifying',
  're-wave-testing': 'Wave retesting',
  'verify-failed': 'Verify failed',
  'wave-test-failed': 'Wave test failed',
  complete: 'Complete',
  waiting: 'Waiting',
  'not-started': 'Not started',
  'needs-you': 'Needs you',
  manual: 'Needs you',
};

/** Card states where a gate is running (or about to, for a retry): the running (blue) look. */
const GATE_STATES: ReadonlySet<SprintState> = new Set<SprintState>([
  'implementing',
  'verifying',
  'wave-testing',
  'doc-syncing',
  're-implementing',
  're-verifying',
  're-wave-testing',
]);

/** Card states after a failed verify or wave test with retries left: the failed (red) look. */
const FAILED_STATES: ReadonlySet<SprintState> = new Set<SprintState>(['verify-failed', 'wave-test-failed']);

/** Whether a card state is one of the gate (running) states. */
export function isGateState(state: SprintState): boolean {
  return GATE_STATES.has(state);
}

/** Whether a card state is a failed gate the run will retry. */
export function isFailedState(state: SprintState): boolean {
  return FAILED_STATES.has(state);
}

/** A gate is running, or failed and about to be retried: the sprint's run is still going. */
export function isActiveState(state: SprintState): boolean {
  return GATE_STATES.has(state) || FAILED_STATES.has(state);
}

/** One entry of a sprint's Run notes. */
export interface RunNote {
  /** `failed`: a failed attempt. `notes`: a `partial` or `warn` result ("passed with notes"). */
  kind: 'failed' | 'notes';
  gate: RunGate;
  result: RunResult;
  /** Logged attempt number. */
  attempt: number;
  /** Run index and wave number the step belongs to. */
  run: number;
  wave: number;
  /** `ts` as logged. */
  ts: string;
  /** 12-hour local time of `ts` ("9:25 PM"). */
  time: string;
  /** "Verify attempt 1 failed" / "Verify attempt 1 passed with notes". */
  title: string;
  /** The gate's summary, exactly as logged (may be empty). */
  summary: string;
  /** Failed attempts only: set once a later run of the same gate in the wave passed. */
  resolution: AttemptResolution | null;
  /** "Fixed in implement attempt 3; verify passed at 2:11 AM.", or `null` while unresolved and for `notes`. */
  resolutionText: string | null;
  /** 1-based line in the run log (a stable key). */
  line: number;
}

/** One sprint card on the rail. */
export interface RailSprint {
  id: string;
  title: string;
  goal: string | null;
  /** The sprint as parsed from the phase file. */
  sprint: Sprint;
  state: SprintState;
  /** {@link SPRINT_STATE_TEXT} of `state`. */
  stateText: string;
  /** The core's task counts for the sprint. */
  progress: Progress;
  /** The sprint's run in the phase's latest run, or `null` (none, or only in older runs). */
  run: SprintRun | null;
  /** See {@link RunNote}. Its length is the collapsed Run notes row's count. */
  runNotes: RunNote[];
  /** The failure being retried, shown under the open card's tasks. See {@link currentFailure}. */
  failure: CurrentFailure | null;
}

/** The failed attempt a sprint is retrying, with where the retry has got to. */
export interface CurrentFailure {
  note: RunNote;
  /** "Retry next · 2 attempts left", "Retrying with the failure attached", "Verifying the retry". */
  statusText: string;
}

/** Which kind of rail row. See the module comment. */
export type RailRowKind = 'no-run-log' | 'wave' | 'not-run';

/** One rail row: a group of sprint cards with its wave column entry. */
export interface RailRow {
  kind: RailRowKind;
  /** Stable key: `no-run-log`, `not-run`, or `wave-{run}-{wave}`. */
  key: string;
  /** "Wave 2", "No run log", "Not run yet". */
  label: string;
  /** Wave number; `null` for the dashed groups. */
  wave: number | null;
  /** Run index; `null` for the dashed groups. */
  run: number | null;
  /** More than one sprint in the logged wave. Always `false` for the dashed groups. */
  parallel: boolean;
  /** `done` once every sprint's latest event is a passing doc sync, else `running`; `null` for the dashed groups. */
  state: 'done' | 'running' | null;
  /** Derived wave start `ts`, or `null` when not logged (and for the dashed groups). */
  startedAt: string | null;
  /** `ts` of the wave's last passing `doc_sync` once `done`, else `null`. */
  endedAt: string | null;
  /** Extra implement attempts across the wave's sprints. `0` for the dashed groups. */
  retries: number;
  /** "15 min", "4 min so far", "start not logged"; `null` for the dashed groups. */
  durationText: string | null;
  /** "27 min · 2 retries": the duration plus the retries when there are any; `null` for the dashed groups. */
  metaText: string | null;
  /** Sprint cards in plan order. Never empty. */
  sprints: RailSprint[];
}

/** Everything the rail shows for one phase. */
export interface RailView {
  phase: number;
  /** `false` when the phase has no run log: the rail is one "Not run yet" row. */
  hasRunLog: boolean;
  /** Rows in order: "No run log", waves, "Not run yet". */
  rows: RailRow[];
  /** Wave rows on the rail. */
  waves: number;
  /** Retries summed over the wave rows. */
  retries: number;
  /** "4 waves · 2 retries", or `null` with no run log. */
  summaryText: string | null;
}

/** A phase's filter group. See the module comment. */
export type PhaseGroup = 'progress' | 'complete' | 'future';

/** One filter of the filter row, in display order. */
export type PhaseFilter = 'all' | PhaseGroup;

/** Group labels, typed in sentence case: the filters' and the kanban lanes'. */
export const PHASE_GROUP_LABEL: Record<PhaseGroup, string> = {
  progress: 'In progress',
  complete: 'Complete',
  future: 'Not started',
};

/** Filter labels in display order. */
export const PHASE_FILTERS: ReadonlyArray<{ key: PhaseFilter; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'progress', label: PHASE_GROUP_LABEL.progress },
  { key: 'complete', label: PHASE_GROUP_LABEL.complete },
  { key: 'future', label: PHASE_GROUP_LABEL.future },
];

// ---------------------------------------------------------------------------
// Rail view
// ---------------------------------------------------------------------------

const ZERO: Progress = {
  total: 0,
  eligible: 0,
  done: 0,
  percent: 0,
  byStatus: { todo: 0, active: 0, done: 0, blocked: 0, manual: 0, cut: 0, deferred: 0, unknown: 0 },
};

/**
 * Build the rail for one phase. See the module comment.
 *
 * @param now Epoch ms used for a running wave's "N min so far". Defaults to now.
 */
export function railView(project: Project, phase: Phase, now: number = Date.now()): RailView {
  const runs = phaseRuns(project, phase.number);
  const cards = new Map<string, RailSprint>(
    phase.sprints.map((s) => [s.id, railSprint(project, s, runs)] as const),
  );
  const planOrder = (ids: Iterable<string>): RailSprint[] =>
    phase.sprints.filter((s) => [...ids].includes(s.id)).map((s) => cards.get(s.id)!);

  if (!runs) {
    const rows = phase.sprints.length > 0 ? [dashedRow('not-run', [...cards.values()])] : [];
    return { phase: phase.number, hasRunLog: false, rows, waves: 0, retries: 0, summaryText: null };
  }

  // Each sprint sits in its latest wave.
  const placed = new Map<WaveRun, string[]>();
  const logged = new Set<string>();
  for (const s of phase.sprints) {
    const history = runs.sprintHistory[s.id];
    const latest = history?.[history.length - 1];
    if (!latest) continue;
    // Matched by value, not identity: in the browser the project arrives as
    // JSON, so `sprintHistory` and `waves` hold separate copies of each run.
    const wave = runs.waves.find(
      (w) =>
        w.run === latest.run &&
        w.wave === latest.wave &&
        w.sprints.some((sr) => sr.sprint === latest.sprint && sr.startedAt === latest.startedAt),
    );
    if (!wave) continue;
    logged.add(s.id);
    placed.set(wave, [...(placed.get(wave) ?? []), s.id]);
  }

  const rows: RailRow[] = [];
  const unlogged = phase.sprints.filter((s) => !logged.has(s.id));
  const ranUnlogged = unlogged.filter((s) => hasWork(project.progress.bySprint[s.id]));
  if (ranUnlogged.length > 0) rows.push(dashedRow('no-run-log', planOrder(ranUnlogged.map((s) => s.id))));

  runs.waves.forEach((wave, i) => {
    const ids = placed.get(wave);
    if (!ids) return;
    rows.push(waveRow(wave, previousInRun(runs.waves, i), planOrder(ids), now));
  });

  const notRun = unlogged.filter((s) => !ranUnlogged.includes(s));
  if (notRun.length > 0) rows.push(dashedRow('not-run', planOrder(notRun.map((s) => s.id))));

  const waveRows = rows.filter((r) => r.kind === 'wave');
  const retries = waveRows.reduce((n, r) => n + r.retries, 0);
  return {
    phase: phase.number,
    hasRunLog: true,
    rows,
    waves: waveRows.length,
    retries,
    summaryText: `${plural(waveRows.length, 'wave')} · ${plural(retries, 'retry', 'retries')}`,
  };
}

/** A task done, running or blocked: the sprint has been worked on. A manual task alone is not work. */
function hasWork(progress: Progress | undefined): boolean {
  if (!progress) return false;
  return progress.done > 0 || progress.byStatus.active > 0 || progress.byStatus.blocked > 0;
}

/** The wave before `waves[i]` in the same run, or `null` when it is the run's first. */
function previousInRun(waves: readonly WaveRun[], i: number): WaveRun | null {
  const prev = waves[i - 1];
  const wave = waves[i]!;
  return prev && prev.run === wave.run ? prev : null;
}

function dashedRow(kind: 'no-run-log' | 'not-run', sprints: RailSprint[]): RailRow {
  return {
    kind,
    key: kind,
    label: kind === 'no-run-log' ? 'No run log' : 'Not run yet',
    wave: null,
    run: null,
    parallel: false,
    state: null,
    startedAt: null,
    endedAt: null,
    retries: 0,
    durationText: null,
    metaText: null,
    sprints,
  };
}

function waveRow(wave: WaveRun, previous: WaveRun | null, sprints: RailSprint[], now: number): RailRow {
  const state = wave.endedAt !== null ? 'done' : 'running';
  const startedAt = waveStart(wave, previous);
  const endedAt = state === 'done' ? lastDocSyncPass(wave) : null;
  const retries = waveRetries(wave);
  const durationText = waveDurationText({ state, startedAt, endedAt }, now);
  return {
    kind: 'wave',
    key: `wave-${wave.run}-${wave.wave}`,
    label: `Wave ${wave.wave}`,
    wave: wave.wave,
    run: wave.run,
    parallel: wave.sprints.length > 1,
    state,
    startedAt,
    endedAt,
    retries,
    durationText,
    metaText: retries > 0 ? `${durationText} · ${plural(retries, 'retry', 'retries')}` : durationText,
    sprints,
  };
}

/** The first `implement` `start` marker, else the previous wave's end, else `null`. */
export function waveStart(wave: WaveRun, previous: WaveRun | null): string | null {
  const start = wave.events.find(isStartMarker);
  if (start) return start.ts;
  return previous ? lastDocSyncPass(previous) : null;
}

/** `ts` of the wave's last passing (not failed) `doc_sync`, or `null`. */
export function lastDocSyncPass(wave: WaveRun): string | null {
  for (let i = wave.events.length - 1; i >= 0; i--) {
    const e = wave.events[i]!;
    if (e.gate === 'doc_sync' && e.result !== 'fail') return e.ts;
  }
  return null;
}

/**
 * Extra implementation runs across the wave's sprints. Each `start` marker
 * begins a run, and so does an `implement` result with no start before it (a
 * log from before start markers); a result after a start closes that run. So
 * a retry counts as soon as it starts, and never twice.
 */
export function waveRetries(wave: WaveRun): number {
  let n = 0;
  for (const sr of wave.sprints) {
    let runsOfImplement = 0;
    let open = false;
    for (const e of sr.events) {
      if (e.gate !== 'implement') continue;
      if (isStartMarker(e)) {
        runsOfImplement++;
        open = true;
      } else {
        if (!open) runsOfImplement++;
        open = false;
      }
    }
    if (runsOfImplement > 1) n += runsOfImplement - 1;
  }
  return n;
}

/**
 * "15 min" (done), "4 min so far" (running), or "start not logged". Minutes
 * are rounded; under half a minute reads "under 1 min".
 */
export function waveDurationText(
  wave: { state: 'done' | 'running'; startedAt: string | null; endedAt: string | null },
  now: number,
): string {
  const start = wave.startedAt === null ? NaN : Date.parse(wave.startedAt);
  if (Number.isNaN(start)) return 'start not logged';
  const end = wave.state === 'done' && wave.endedAt !== null ? Date.parse(wave.endedAt) : now;
  if (Number.isNaN(end)) return 'start not logged';
  const minutes = Math.round(Math.max(0, end - start) / 60_000);
  const text = minutes === 0 ? 'under 1 min' : `${minutes} min`;
  return wave.state === 'running' ? `${text} so far` : text;
}

// ---------------------------------------------------------------------------
// Sprint cards
// ---------------------------------------------------------------------------

function railSprint(project: Project, sprint: Sprint, runs: PhaseRuns | null): RailSprint {
  const progress = project.progress.bySprint[sprint.id] ?? ZERO;
  const run = currentSprintRun(runs, sprint.id);
  const state = cardState(sprint, progress, run, sprintRan(runs, sprint.id), runs);
  const notes = runNotes(runs, sprint.id);
  return {
    id: sprint.id,
    title: sprint.title,
    goal: sprint.goal,
    sprint,
    state,
    stateText: SPRINT_STATE_TEXT[state],
    progress,
    run,
    runNotes: notes,
    failure: currentFailure(state, run, notes),
  };
}

/** Where a retry has got to, under the failure it's fixing. */
const RETRY_STATUS: Partial<Record<SprintState, string>> = {
  're-implementing': 'Retrying with the failure attached',
  're-verifying': 'Verifying the retry',
  're-wave-testing': 'Wave testing the retry',
};

/**
 * The failure a sprint is retrying: the latest failed verify or wave test in
 * its current wave that no later run of the same gate has passed, while the
 * card is in a gate or failed state. `null` otherwise (never failed, fixed,
 * or escalated, which the escalation banner shows instead).
 */
export function currentFailure(state: SprintState, run: SprintRun | null, notes: readonly RunNote[]): CurrentFailure | null {
  if (!run || !isActiveState(state)) return null;
  const note = [...notes]
    .reverse()
    .find(
      (n) =>
        n.kind === 'failed' &&
        (n.gate === 'verify' || n.gate === 'wave_test') &&
        n.run === run.run &&
        n.wave === run.wave &&
        n.resolution === null,
    );
  if (!note) return null;
  if (isFailedState(state)) {
    const max = run.steps.find((s) => s.line === note.line)?.max ?? 0;
    const left = max - note.attempt;
    return { note, statusText: max > 0 && left > 0 ? `Retry next · ${plural(left, 'attempt')} left` : 'Retry next' };
  }
  return { note, statusText: RETRY_STATUS[state] ?? '' };
}

const RUNNING: Record<SprintRunState, SprintState | null> = {
  implementing: 'implementing',
  verifying: 'verifying',
  testing: 'wave-testing',
  syncing: 'doc-syncing',
  done: null,
  failed: null,
};

/** The retry word of a gate state whose gate already ran in the sprint's wave. Doc sync runs once. */
const RETRYING: Partial<Record<SprintState, { state: SprintState; gate: RunGate }>> = {
  implementing: { state: 're-implementing', gate: 'implement' },
  verifying: { state: 're-verifying', gate: 'verify' },
  'wave-testing': { state: 're-wave-testing', gate: 'wave_test' },
};

/**
 * A sprint card's state from its task counts and its run in the phase's latest
 * run. See the module comment.
 *
 * @param ran Whether the run log has events for the sprint in any run;
 *   defaults to whether `run` is set.
 * @param runs The phase's run log, to tell when a sibling in the sprint's
 *   wave holds it (see {@link heldByWave}). Without it, a sprint is never held.
 */
export function cardState(
  sprint: Sprint,
  progress: Progress | undefined,
  run: SprintRun | null,
  ran: boolean = run !== null,
  runs: PhaseRuns | null = null,
): SprintState {
  const status = sprintStatus(sprint, progress, run, ran);
  if (status === 'needs') return 'needs-you';
  if (status === 'manual') return 'manual';
  if (heldByWave(runs, run)) return 'waiting';
  const gate = runningGate(run);
  if (gate !== null) return gate;
  if (status === 'complete') return 'complete';
  return (progress?.done ?? 0) > 0 ? 'waiting' : 'not-started';
}

/** {@link cardState} looked up from the project. */
export function sprintCardState(project: Project, sprint: Sprint): SprintState {
  const runs = phaseRuns(project, sprint.phase);
  return cardState(
    sprint,
    project.progress.bySprint[sprint.id],
    currentSprintRun(runs, sprint.id),
    sprintRan(runs, sprint.id),
    runs,
  );
}

// ---------------------------------------------------------------------------
// Run end
// ---------------------------------------------------------------------------

/** The line under the last wave once the phase's run has ended. See {@link runEnd}. */
export interface RunEnd {
  /** `pass` (green): nothing needs you. `needs` (pink): a blocked task or an escalation. `manual` (violet): only manual tasks. */
  kind: 'pass' | 'needs' | 'manual';
  /** "Phase run complete", or "Run paused" when sprints are left but something needs you. */
  title: string;
  /** "1 task needs your attention", or `null` when nothing does. */
  attentionText: string | null;
  /** One line per thing that needs you: "Sprint 2.5 · task 3 blocked". */
  items: string[];
}

/**
 * How the phase's run ended, once it has: the phase has a run log, every
 * logged wave is done and no sprint is in a gate state. "Phase run complete"
 * when every sprint is Complete or Needs you; "Run paused" when sprints are
 * left and something needs you; otherwise (a run stopped with nothing to do
 * for you) `null`. What needs you: blocked tasks, open escalations, and
 * manual tasks left in sprints that have started.
 */
export function runEnd(view: RailView): RunEnd | null {
  if (!view.hasRunLog) return null;
  const waves = view.rows.filter((r) => r.kind === 'wave');
  if (waves.length === 0 || waves.some((r) => r.state !== 'done')) return null;
  const sprints = view.rows.flatMap((r) => r.sprints);
  if (sprints.some((s) => isActiveState(s.state))) return null;

  const items: string[] = [];
  let tasks = 0;
  let escalations = 0;
  let needs = false;
  for (const s of sprints) {
    if (s.run?.escalation) {
      items.push(`Sprint ${s.id} · ${GATE_NAMES[s.run.escalation.gate]} retry limit reached`);
      escalations++;
      needs = true;
    }
    for (const t of s.sprint.tasks) {
      const n = t.number === null ? '' : ` ${t.number}`;
      if (t.status === 'blocked') {
        items.push(`Sprint ${s.id} · task${n} blocked`);
        tasks++;
        needs = true;
      } else if (t.status === 'manual' && (s.state === 'manual' || s.state === 'needs-you')) {
        items.push(`Sprint ${s.id} · task${n} is yours to do`);
        tasks++;
      }
    }
  }

  const finished = sprints.every((s) => s.state === 'complete' || s.state === 'needs-you' || s.state === 'manual');
  if (!finished && items.length === 0) return null;
  const n = tasks + escalations;
  const noun = escalations === 0 ? 'task' : tasks === 0 ? 'escalation' : 'item';
  return {
    kind: needs ? 'needs' : items.length > 0 ? 'manual' : 'pass',
    title: finished ? 'Phase run complete' : 'Run paused',
    attentionText: n === 0 ? null : `${plural(n, noun)} ${n === 1 ? 'needs' : 'need'} your attention`,
    items,
  };
}

/** How far through a wave's gates each run state is. Implement comes before verify, then wave test, then doc sync. */
const GATE_ORDER: Record<SprintRunState, number> = {
  implementing: 0,
  failed: 0,
  verifying: 1,
  testing: 2,
  syncing: 3,
  done: 4,
};

/**
 * Whether the sprint is held by its wave: it passed verify (or the wave
 * test), but the next gate runs once for the whole wave, and a sibling in the
 * same wave hasn't reached it yet, typically one retrying after a failed
 * verify. The card then reads Waiting, not the gate it's waiting for.
 */
export function heldByWave(runs: PhaseRuns | null, run: SprintRun | null): boolean {
  if (!runs || !run || run.escalation || (run.state !== 'testing' && run.state !== 'syncing')) return false;
  const wave = runs.waves.find((w) => w.run === run.run && w.wave === run.wave);
  return wave?.sprints.some((s) => s.sprint !== run.sprint && GATE_ORDER[s.state] < GATE_ORDER[run.state]) ?? false;
}

/**
 * The state word of the sprint's derived next gate, or `null` when no gate is
 * next. A failed verify or wave test with retries left reads Verify failed or
 * Wave test failed until the retry's start line; a gate that already ran in
 * the wave reads as its retry (Re-implementing, Re-verifying, Wave retesting).
 */
function runningGate(run: SprintRun | null): SprintState | null {
  if (!run || run.escalation) return null;
  if (run.state === 'failed') {
    const last = run.steps[run.steps.length - 1];
    if (last?.gate === 'verify') return 'verify-failed';
    if (last?.gate === 'wave_test') return 'wave-test-failed';
    return null;
  }
  const gate = RUNNING[run.state];
  if (gate === null) return null;
  // Steps leave out start markers, so an implement step here is an earlier, finished run.
  const retry = RETRYING[gate];
  return retry && run.steps.some((s) => s.gate === retry.gate) ? retry.state : gate;
}

// ---------------------------------------------------------------------------
// Run notes
// ---------------------------------------------------------------------------

/** Every failed attempt and every `partial` / `warn` result for a sprint, in log order. See the module comment. */
export function runNotes(runs: PhaseRuns | null, sprintId: string): RunNote[] {
  const notes: RunNote[] = [];
  for (const sr of runs?.sprintHistory[sprintId] ?? []) {
    const failed = new Map(attemptNotes(sr.steps).map((n) => [n.line, n] as const));
    for (const step of sr.steps) {
      const base = {
        gate: step.gate,
        result: step.result,
        attempt: step.attempt,
        run: sr.run,
        wave: sr.wave,
        ts: step.ts,
        time: formatTime(step.ts),
        summary: step.summary,
        line: step.line,
      };
      if (step.result === 'fail') {
        const resolution = failed.get(step.line)?.resolution ?? null;
        notes.push({
          ...base,
          kind: 'failed',
          title: attemptTitle(step),
          resolution,
          resolutionText: resolution ? resolutionText(resolution) : null,
        });
      } else if (step.result === 'partial' || step.result === 'warn') {
        notes.push({
          ...base,
          kind: 'notes',
          title: `${GATE_NAMES[step.gate]} attempt ${step.attempt} passed with notes`,
          resolution: null,
          resolutionText: null,
        });
      }
    }
  }
  return notes;
}

// ---------------------------------------------------------------------------
// Filter groups
// ---------------------------------------------------------------------------

/** Card states that keep a phase in progress however many tasks are done: the active ones and Needs you. */
function isBusy(state: SprintState): boolean {
  return isActiveState(state) || state === 'needs-you' || state === 'manual';
}

/** Which filter a phase falls under. See the module comment. */
export function phaseGroup(project: Project, phase: Phase): PhaseGroup {
  const progress = project.progress.byPhase[String(phase.number)];
  const runs = phaseRuns(project, phase.number);
  // Card states, not `sprintStatus`: a complete sprint whose gate is running again is busy.
  const busy = phase.sprints.some((s) => isBusy(sprintCardState(project, s)));
  const complete = progress !== undefined && progress.eligible > 0 && progress.done === progress.eligible;
  if (complete && !busy) return 'complete';
  const started = hasWork(progress) || (runs !== null && runs.events.length > 0);
  return started || busy ? 'progress' : 'future';
}

/** Phase counts per filter, for the filter row ("All 8 · In progress 1 · Complete 6 · Not started 1"). */
export function phaseGroupCounts(project: Project): Record<PhaseFilter, number> {
  const counts: Record<PhaseFilter, number> = { all: project.phases.length, progress: 0, complete: 0, future: 0 };
  for (const phase of project.phases) counts[phaseGroup(project, phase)]++;
  return counts;
}
