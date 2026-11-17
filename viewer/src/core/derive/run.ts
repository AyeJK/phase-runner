/**
 * Run derivation: one phase's run-log events in, waves, per-sprint run state
 * and escalations out. Pure (data in, data out) and never throws on any event
 * list the reader can produce.
 *
 * Everything comes from **line order**; `ts` is only copied, never compared
 * (clocks skew, and parallel appends share a second).
 *
 * Runs and waves (spec: `run-log.md`, "Reading the log"):
 *
 * - Events are cut into waves wherever `wave` changes between consecutive
 *   lines. A drop in `wave` (e.g. 3 → 1) starts a new run, because
 *   phase-builder restarts wave numbers on every run of the phase; a rise
 *   (1 → 2) is the next wave of the same run. A run resumed inside the same
 *   wave number reads as a continuation of that wave.
 * - Within a wave, events are grouped by sprint in first-seen order.
 * - Wave start is the wave's first event. Wave end is reached once every
 *   sprint in the wave has a passing `doc_sync` as its latest event.
 * - `implement` `start` markers don't cut waves. The next wave's
 *   implementation starts while the previous wave's doc sync runs, so its
 *   start lines can land between that wave's lines. Each marker joins the wave
 *   with its wave number in the run it belongs to (the run of the wave before
 *   it in the log, or the next run when its wave number is lower), preferring
 *   one with lines after it; with none logged yet it opens that wave on its
 *   own. Markers are never gate steps and never attempts.
 * - `task` lines (an implementer's "task N started" / "task N finished") are
 *   markers too, and kept further out: they are in no wave's or sprint's
 *   `events`, so they are never gate steps, attempts, retries or escalations,
 *   never cut a wave, and never move a wave's or sprint's start, end or
 *   state. Each one is placed like a start marker, in the wave with its wave
 *   number in the run it belongs to, but never opens a wave: one with no such
 *   wave, or whose sprint has no event in it, is left out. What they say is
 *   {@link SprintRun.tasks}: per sprint and wave, the latest `task` line per
 *   task number (`start` is running, `pass` is built; any other result is
 *   ignored). A log without them derives exactly as before.
 * - `suite` lines (the phase-end full test suite) are markers kept out the
 *   same way: in no wave, never a step, attempt or cut. Each belongs to the
 *   run a start marker with its wave number would. The suite logs under its
 *   own wave number (the last wave's + 1), so once a run has a `suite` line,
 *   its later `implement` and `task` lines with that number are the suite's
 *   retries and stay out of the waves too. Per run they become one
 *   {@link SuiteRun}: an attempt is a set of `start` lines and the result
 *   lines after them; a result line for a sprint the attempt already has a
 *   result for opens the next attempt (logs written without `start` lines).
 *   The latest attempt is `running` with only `start` lines, `fail` when any
 *   result failed, else `pass`. It escalates at `attempt >= max` (`max > 0`)
 *   when no line at all comes after it. `implement` lines after a failed
 *   attempt say which sprints are being re-implemented
 *   ({@link SuiteRun.retrying}); those before an attempt, which sprints it
 *   re-checks ({@link SuiteAttempt.retried}).
 *
 * Sprint state: see {@link SprintRunState} for the table. A wave "runs a wave
 * test" when any of its sprints is in {@link DeriveRunOptions.uiSprints}, or
 * when a `wave_test` line already appeared in the wave.
 *
 * Escalations: a sprint's latest event in a wave is a `verify` or `wave_test`
 * `fail` with `max > 0` and `attempt >= max`, and the sprint has no later
 * event anywhere in the log. `max: 0` never escalates. The escalation carries
 * every run of that gate for the sprint in the wave as its retry history.
 */
import type {
  Escalation,
  GateStep,
  PhaseRuns,
  RunEvent,
  RunGate,
  SprintRun,
  SprintRunState,
  SuiteAttempt,
  SuiteRetry,
  SuiteRun,
  TaskProgress,
  WaveRun,
} from '../model.js';

/** Extra knowledge {@link deriveRun} can use that the log itself lacks. */
export interface DeriveRunOptions {
  /**
   * Ids of sprints that have a browser test (a `ui:` route and no
   * `skip-ui: true`). A wave holding any of them runs a wave test, so a sprint
   * whose `verify` passed is `testing` rather than `syncing`. `loadProject`
   * fills this from the phase file; without it, only a `wave_test` line
   * already seen in the wave marks it as a UI wave.
   */
  uiSprints?: Iterable<string>;
  /**
   * Task numbers per sprint id, from the phase file. A `task` line naming a
   * number its sprint doesn't have is ignored. A sprint not listed here (or
   * no option at all) keeps every `task` line: there is nothing to check
   * against. `loadProject` fills this from the phase files.
   */
  sprintTasks?: Readonly<Record<string, readonly number[]>>;
}

/** What {@link deriveRun} returns: the derived parts of {@link PhaseRuns}. */
export type RunDerivation = Pick<PhaseRuns, 'waves' | 'escalations' | 'sprintHistory' | 'suites'>;

/** Gates whose failure at the retry limit escalates. */
const ESCALATING_GATES: ReadonlySet<RunGate> = new Set<RunGate>(['verify', 'wave_test']);

/**
 * Derive waves, sprint runs and escalations from one phase's events.
 *
 * @param events The phase's events in log (line) order, as `readRunLog` returns them.
 * @param options See {@link DeriveRunOptions}.
 */
export function deriveRun(events: readonly RunEvent[], options: DeriveRunOptions = {}): RunDerivation {
  const uiSprints = new Set<string>(options.uiSprints ?? []);
  const sprintTasks = options.sprintTasks ?? {};
  const waves: WaveRun[] = [];

  // 1. Cut the log into waves by line order. Start markers wait for step 1b,
  //    task lines for step 1c.
  let run = 0;
  let current: RunEvent[] | null = null;
  let currentWave = -1;
  const groups: WaveGroup[] = [];
  const starts: RunEvent[] = [];
  const taskLines: RunEvent[] = [];
  const suiteLines: RunEvent[] = [];
  // The current run's suite wave number, once a suite line has been seen.
  let suiteWave: number | null = null;
  for (const event of events) {
    if (isSuiteLine(event)) {
      suiteLines.push(event);
      suiteWave ??= event.wave;
      continue;
    }
    if (suiteWave !== null && event.wave === suiteWave && (event.gate === 'implement' || isTaskLine(event))) {
      suiteLines.push(event);
      continue;
    }
    if (isTaskLine(event)) {
      taskLines.push(event);
      continue;
    }
    if (isStartMarker(event)) {
      starts.push(event);
      continue;
    }
    if (current === null || event.wave !== currentWave) {
      if (current === null || event.wave < currentWave) {
        run++;
        suiteWave = null;
      }
      currentWave = event.wave;
      current = [];
      groups.push({ run, wave: event.wave, events: current, tasks: [] });
    }
    current.push(event);
  }

  // 1b. Place each start marker in its wave (see the module comment).
  for (const start of starts) placeStartMarker(start, groups);
  for (const group of groups) group.events.sort((a, b) => a.line - b.line);

  // 1c. Hand each task line to its wave. It joins no `events` list and opens no wave.
  for (const line of taskLines) waveOfMarker(line, groups).target?.tasks.push(line);

  // 2. Build each wave and its sprint runs.
  for (const group of groups) {
    waves.push(buildWave(group.run, group.wave, group.events, group.tasks, uiSprints, sprintTasks));
  }

  // 3. A later event for a sprint (in any later wave or run) clears an
  //    earlier escalation of it: only a sprint's last SprintRun can escalate.
  const sprintHistory: Record<string, SprintRun[]> = {};
  for (const wave of waves) {
    for (const sr of wave.sprints) {
      (sprintHistory[sr.sprint] ??= []).push(sr);
    }
  }
  for (const runs of Object.values(sprintHistory)) {
    for (let i = 0; i < runs.length - 1; i++) runs[i]!.escalation = null;
  }

  const escalations: Escalation[] = [];
  for (const wave of waves) {
    wave.escalated = wave.sprints.some((s) => s.escalation !== null);
    for (const sr of wave.sprints) if (sr.escalation) escalations.push(sr.escalation);
  }
  escalations.sort((a, b) => a.line - b.line);

  // 4. The phase-end suite, per run.
  const lastLogLine = events.reduce((n, e) => Math.max(n, e.line), 0);
  const suiteByRun = new Map<number, RunEvent[]>();
  for (const line of suiteLines) {
    const { run: r } = waveOfMarker(line, groups);
    let list = suiteByRun.get(r);
    if (!list) suiteByRun.set(r, (list = []));
    list.push(line);
  }
  const suites: SuiteRun[] = [];
  for (const [r, lines] of suiteByRun) suites.push(buildSuite(r, lines, lastLogLine));
  suites.sort((a, b) => a.latest.line - b.latest.line);

  return { waves, escalations, sprintHistory, suites };
}

/** A `suite` line: the phase-end full test suite. A marker kept out of every wave. */
export function isSuiteLine(event: Pick<RunEvent, 'gate'>): boolean {
  return event.gate === 'suite';
}

/**
 * One run's suite lines (in line order: `suite` lines, and the `implement` and
 * `task` lines of its retries) as a {@link SuiteRun}. See the module comment.
 */
function buildSuite(run: number, all: readonly RunEvent[], lastLogLine: number): SuiteRun {
  const lines = all.filter(isSuiteLine);
  const implement = all.filter((e) => e.gate === 'implement');
  const groups: RunEvent[][] = [];
  let current: RunEvent[] | null = null;
  for (const e of lines) {
    const results = current?.filter((x) => x.result !== 'start') ?? [];
    const next =
      current === null ||
      (e.result === 'start' && results.length > 0) ||
      (e.result !== 'start' && results.some((x) => x.sprint === e.sprint));
    if (next) groups.push((current = []));
    current!.push(e);
  }
  const history = groups.map((g, i) => {
    // Sprints re-implemented between the previous attempt and this one.
    const after = i === 0 ? 0 : groups[i - 1]![groups[i - 1]!.length - 1]!.line;
    const retried = implement.filter((e) => e.line > after && e.line < g[0]!.line).map((e) => e.sprint);
    return suiteAttempt(g, [...new Set(retried)]);
  });
  const latest = history[history.length - 1]!;

  // Retries after the latest attempt's results: the latest implement line per sprint.
  const retrying = new Map<string, SuiteRetry>();
  if (latest.result !== 'running') {
    for (const e of implement) {
      if (e.line <= latest.lastLine) continue;
      retrying.set(e.sprint, { sprint: e.sprint, state: isStartMarker(e) ? 'implementing' : 'implemented', attempt: e.attempt });
    }
  }

  // Implementation runs, counted like a wave's retries: a start opens one, a result without one counts on its own.
  let retries = 0;
  const open = new Set<string>();
  for (const e of implement) {
    if (isStartMarker(e)) {
      retries++;
      open.add(e.sprint);
    } else if (!open.delete(e.sprint)) {
      retries++;
    }
  }

  return {
    phase: lines[0]?.phase ?? all[0]!.phase,
    run,
    latest,
    history,
    retrying: [...retrying.values()],
    retries,
    escalated:
      latest.result === 'fail' && latest.max > 0 && latest.attempt >= latest.max && latest.lastLine >= lastLogLine,
  };
}

function suiteAttempt(lines: readonly RunEvent[], retried: string[]): SuiteAttempt {
  const first = lines[0]!;
  const last = lines[lines.length - 1]!;
  const results = lines.filter((e) => e.result !== 'start');
  const fails = results.filter((e) => e.result === 'fail');
  const failures: Array<{ sprint: string; summary: string }> = [];
  for (const e of fails) if (!failures.some((f) => f.sprint === e.sprint)) failures.push({ sprint: e.sprint, summary: e.summary });
  const attempt = Math.max(...lines.map((e) => e.attempt));
  return {
    attempt,
    max: last.max,
    result: results.length === 0 ? 'running' : fails.length > 0 ? 'fail' : 'pass',
    failures,
    retried,
    summary: (fails[0] ?? results[0])?.summary ?? '',
    startedAt: first.ts,
    updatedAt: last.ts,
    line: first.line,
    lastLine: last.line,
  };
}

/** One wave's events while the log is being cut, before it becomes a {@link WaveRun}. */
interface WaveGroup {
  run: number;
  wave: number;
  /** The wave's events, start markers included. Never a `task` line. */
  events: RunEvent[];
  /** The `task` lines placed in the wave, in line order. */
  tasks: RunEvent[];
}

/** An `implement` `start` line: a marker, never a gate step or an attempt. */
export function isStartMarker(event: Pick<RunEvent, 'gate' | 'result'>): boolean {
  return event.gate === 'implement' && event.result === 'start';
}

/** A `task` line, whatever its result: a marker kept out of every wave's and sprint's events. */
export function isTaskLine(event: Pick<RunEvent, 'gate'>): boolean {
  return event.gate === 'task';
}

/** The first and last line of a group's events. Markers are appended unsorted until every one is placed, so scan. */
const firstLine = (g: WaveGroup): number => Math.min(...g.events.map((e) => e.line));
const lastLine = (g: WaveGroup): number => Math.max(...g.events.map((e) => e.line));

/**
 * Where a marker (a start marker or a `task` line) belongs: the run it is in
 * (the run of the wave before it in the log, or the next run when its wave
 * number is lower), and the wave with its wave number in that run, preferring
 * one with lines after the marker. `target` is `null` when that wave has
 * nothing logged yet.
 */
function waveOfMarker(marker: RunEvent, groups: readonly WaveGroup[]): { run: number; target: WaveGroup | null } {
  let before: WaveGroup | null = null;
  for (const g of groups) if (firstLine(g) < marker.line) before = g;
  const run = before === null ? 1 : marker.wave < before.wave ? before.run + 1 : before.run;

  const same = groups.filter((g) => g.wave === marker.wave && g.run === run);
  return { run, target: same.find((g) => lastLine(g) > marker.line) ?? same[same.length - 1] ?? null };
}

/**
 * Put one start marker into the wave it belongs to, or open that wave when
 * nothing else of it is logged yet. `groups` stays ordered by first line.
 */
function placeStartMarker(start: RunEvent, groups: WaveGroup[]): void {
  const { run, target } = waveOfMarker(start, groups);
  if (target) {
    target.events.push(start);
    return;
  }
  const group: WaveGroup = { run, wave: start.wave, events: [start], tasks: [] };
  const at = groups.findIndex((g) => firstLine(g) > start.line);
  if (at === -1) groups.push(group);
  else groups.splice(at, 0, group);
}

/**
 * Build one {@link WaveRun} from its events (all sharing one run and wave
 * number) and the `task` lines placed in it.
 */
function buildWave(
  run: number,
  wave: number,
  events: RunEvent[],
  taskLines: readonly RunEvent[],
  uiSprints: ReadonlySet<string>,
  sprintTasks: Readonly<Record<string, readonly number[]>>,
): WaveRun {
  const bySprint = new Map<string, RunEvent[]>();
  for (const e of events) {
    let list = bySprint.get(e.sprint);
    if (!list) bySprint.set(e.sprint, (list = []));
    list.push(e);
  }

  const first = events[0]!;
  const last = events[events.length - 1]!;
  const hasWaveTest =
    events.some((e) => e.gate === 'wave_test') || [...bySprint.keys()].some((id) => uiSprints.has(id));

  const sprints: SprintRun[] = [];
  for (const [sprint, list] of bySprint) {
    const sr = buildSprintRun(sprint, run, wave, list, hasWaveTest);
    const tasks = taskLineProgress(
      taskLines.filter((e) => e.sprint === sprint),
      Object.prototype.hasOwnProperty.call(sprintTasks, sprint) ? sprintTasks[sprint] : undefined,
    );
    if (tasks.length > 0) sr.tasks = tasks;
    sprints.push(sr);
  }

  const files = unionFiles(events);
  const allDone = sprints.length > 0 && sprints.every((s) => s.state === 'done');

  return {
    phase: first.phase,
    run,
    wave,
    sprints,
    events,
    files,
    startedAt: first.ts,
    endedAt: allDone ? last.ts : null,
    escalated: sprints.some((s) => s.escalation !== null),
  };
}

/** Build one sprint's run within a wave. */
function buildSprintRun(
  sprint: string,
  run: number,
  wave: number,
  events: RunEvent[],
  waveHasWaveTest: boolean,
): SprintRun {
  const first = events[0]!;
  const last = events[events.length - 1]!;

  const gateEvents = events.filter((e) => !isStartMarker(e));
  const steps = toSteps(gateEvents);
  const attempts: Partial<Record<RunGate, number>> = {};
  for (const e of gateEvents) {
    const prev = attempts[e.gate];
    if (prev === undefined || e.attempt > prev) attempts[e.gate] = e.attempt;
  }

  const sr: SprintRun = {
    sprint,
    phase: first.phase,
    run,
    wave,
    events,
    steps,
    state: sprintState(events, waveHasWaveTest),
    attempts,
    lastEvent: last,
    escalation: null,
    files: unionFiles(events),
    startedAt: first.ts,
    updatedAt: last.ts,
  };
  sr.escalation = escalationFor(sr, events);
  return sr;
}

/**
 * The state after a sprint's events in one wave. See {@link SprintRunState}
 * for the table this implements.
 *
 * @param events The sprint's events in this wave, in line order.
 * @param waveHasWaveTest Whether the wave runs a wave test.
 */
export function sprintState(events: readonly RunEvent[], waveHasWaveTest: boolean): SprintRunState {
  let latest: RunEvent | undefined;
  for (let i = events.length - 1; i >= 0; i--) {
    // A sprint run's events never hold a task line; skipped here for callers that pass raw events.
    if (events[i]!.gate !== 'unknown' && events[i]!.gate !== 'task') {
      latest = events[i];
      break;
    }
  }
  if (!latest) return 'implementing';
  const failed = latest.result === 'fail';
  switch (latest.gate) {
    case 'implement':
      return latest.result === 'start' ? 'implementing' : 'verifying';
    case 'verify':
      if (failed) return 'failed';
      return waveHasWaveTest ? 'testing' : 'syncing';
    case 'wave_test':
      return failed ? 'failed' : 'syncing';
    case 'doc_sync':
      return failed ? 'failed' : 'done';
    default:
      return 'implementing';
  }
}

/**
 * The escalation ending this sprint's wave, if its latest event is an
 * escalating gate's `fail` at the limit. Whether a later wave clears it is
 * decided by the caller.
 */
function escalationFor(sr: SprintRun, events: readonly RunEvent[]): Escalation | null {
  const last = events[events.length - 1];
  if (!last) return null;
  if (!ESCALATING_GATES.has(last.gate) || last.result !== 'fail') return null;
  if (last.max <= 0 || last.attempt < last.max) return null;
  return {
    phase: last.phase,
    run: sr.run,
    wave: sr.wave,
    sprint: sr.sprint,
    gate: last.gate,
    attempt: last.attempt,
    max: last.max,
    summary: last.summary,
    ts: last.ts,
    line: last.line,
    history: events
      .filter((e) => e.gate === last.gate)
      .map((e) => ({ attempt: e.attempt, result: e.result, summary: e.summary, ts: e.ts, line: e.line })),
  };
}

/**
 * One sprint's task progress in one wave: the latest `task` line per task
 * number, ordered by task number. `start` reads `running`, `pass` reads
 * `built`; a line with any other result, or with no task number, says nothing
 * and is skipped.
 *
 * @param lines The sprint's `task` lines in the wave, in line order.
 * @param known The sprint's task numbers, when the phase file is at hand:
 *   a line for any other number is ignored. `undefined` keeps every number.
 */
export function taskLineProgress(lines: readonly RunEvent[], known?: readonly number[]): TaskProgress[] {
  const latest = new Map<number, TaskProgress>();
  for (const e of lines) {
    if (e.gate !== 'task' || e.task === undefined) continue;
    if (e.result !== 'start' && e.result !== 'pass') continue;
    if (known !== undefined && !known.includes(e.task)) continue;
    latest.set(e.task, {
      task: e.task,
      state: e.result === 'start' ? 'running' : 'built',
      attempt: e.attempt,
      ts: e.ts,
      line: e.line,
    });
  }
  return [...latest.values()].sort((a, b) => a.task - b.task);
}

/** Events as {@link GateStep}s, numbering each gate's occurrences in line order. */
export function toSteps(events: readonly RunEvent[]): GateStep[] {
  const seen: Partial<Record<RunGate, number>> = {};
  return events.map((e) => {
    const seq = (seen[e.gate] ?? 0) + 1;
    seen[e.gate] = seq;
    const step: GateStep = {
      gate: e.gate,
      result: e.result,
      attempt: e.attempt,
      max: e.max,
      seq,
      summary: e.summary,
      ts: e.ts,
      line: e.line,
    };
    if (e.files) step.files = [...e.files];
    return step;
  });
}

/** Union of `files` over `doc_sync` events, first-seen order; `null` when none carried `files`. */
function unionFiles(events: readonly RunEvent[]): string[] | null {
  let out: string[] | null = null;
  const seen = new Set<string>();
  for (const e of events) {
    if (e.gate !== 'doc_sync' || !e.files) continue;
    out ??= [];
    for (const f of e.files) {
      if (seen.has(f)) continue;
      seen.add(f);
      out.push(f);
    }
  }
  return out;
}
