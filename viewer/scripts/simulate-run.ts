#!/usr/bin/env node
/**
 * Play a phase-builder run against a throwaway copy of a fixture project, so
 * the viewer has something live to show without running phase-builder.
 *
 *     tsx scripts/simulate-run.ts [--fixture trail-log | --from <project>] [--script retry|escalation|none]
 *                                 [--interval 2000] [--stale | --as-is] [--out <folder>] [--keep]
 *     tsx scripts/simulate-run.ts --replay <run-log.jsonl> [--start-at <ts>] [--speed 30] [--max-gap 4000]
 *                                 [--reset-later] [--fill-tasks] [--fixture trail-log | --from <project>] ...
 *
 * 1. {@link prepareFixture} copies `test/fixtures/{fixture}/` into a temp
 *    folder (`{tmp}/phase-viewer-sim-XXXX/{fixture}/`, so the project folder
 *    keeps the fixture's name) and, unless `freshness` is `as-is`, shifts
 *    every `ts` in its run logs so the latest event is recent (`fresh`, 90 s
 *    ago) or old (`stale`, 3 h ago). Relative gaps between events are kept.
 *    With `--from`, it copies that project's `docs/` instead, into a folder
 *    named after the project.
 * 2. {@link simulateRun} appends a scripted sequence of run-log v1 events
 *    (see `plugin/skills/phase-builder/run-log.md`) at a fixed interval, each
 *    stamped with the current time, the way the gate agents would. When a
 *    step is a doc-sync, it first marks that sprint's tasks done in the phase
 *    file, as phase-doc-sync does.
 *
 * Replay (`--replay`) plays a run log file instead of a named script: a real
 * one, or one written by hand. Lines with the same `ts` are one step, the way
 * one gate's chained appends land together. {@link prepareReplay} first
 * resets the copy to before that run: every phase in the file loses its run
 * log, and every sprint in it has its done and active tasks set back to `—`.
 * Steps before `--start-at` are written straight away, so the run opens
 * part-way through. With `--speed`, the wait between steps is the logged gap
 * divided by the speed (at most `--max-gap`), and each `ts` keeps the logged
 * gaps, so wave durations read as they were logged. Without it, steps play at
 * `--interval` and are stamped with the current time. A doc-sync step marks
 * the sprint's tasks done, and the ones its implement line lists as blocked
 * `BLOCKED`. `--reset-later` also resets every later phase to not started.
 * `--fill-tasks` turns each sprint's tasks active (`~`) one by one while it's
 * implemented, so its progress bar fills before doc sync marks them done.
 *
 * Task lines. {@link simulateRun} also writes the `task` lines an implementer
 * writes (see {@link addTaskLines}): between each sprint's first `implement`
 * `start` line and its result, a `task` `start` and a `task` `pass` line for
 * every task the result lists as done, so the viewer's tasks table shows each
 * one Running, then Built. A replayed log that already has `task` lines for a
 * sprint keeps its own. They never touch the phase file.
 *
 * Scripts (written for the `trail-log` fixture, phase 2). {@link buildScript}
 * gives a script's gate lines only, for tests that append them on cue;
 * {@link buildRun} is what a named script plays: the same lines, each
 * implementation run led by its `implement` `start` line, with the `task`
 * lines above.
 *
 * | Script       | What it appends |
 * |--------------|-----------------|
 * | `retry`      | Wave 2: sprints 2.2 (UI) and 2.3 in parallel; 2.3's verify fails at attempt 1 and passes at attempt 2; wave test; doc sync. Wave 3: sprint 2.4 passes first time. |
 * | `escalation` | Wave 2 as in `retry`, then wave 3: sprint 2.4's verify fails at attempts 1, 2 and 3 of 3, and nothing after (an escalation). |
 * | `none`       | Nothing. The copy is left as prepared (useful with `stale`). |
 *
 * Used by `npm run dev` (`scripts/dev.ts`), by Playwright through it, and by
 * tests, which import the functions directly. Running this file on its own
 * prints the project folder to point a viewer at
 * (`npm run serve -- --dir <folder>`), plays the script, and removes the copy
 * on Ctrl+C unless `--keep` is given.
 */
import { appendFile, cp, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

/** `test/fixtures/`, where fixture projects live. */
export const FIXTURES_ROOT = fileURLToPath(new URL('../test/fixtures/', import.meta.url));

/** The fixture the scripts are written for, and the default. */
export const DEFAULT_FIXTURE = 'trail-log';

/** Default time between scripted steps. */
export const DEFAULT_INTERVAL_MS = 2_000;

/** How the copied run logs' existing timestamps are treated. */
export type Freshness = 'fresh' | 'stale' | 'as-is';

/** How long before now the latest existing event lands, per {@link Freshness}. */
export const FRESHNESS_AGE_MS: Record<Exclude<Freshness, 'as-is'>, number> = {
  fresh: 90_000,
  stale: 3 * 60 * 60_000,
};

/** A named scripted sequence. See the module comment. */
export type ScriptName = 'retry' | 'escalation' | 'none';

/** Every script name. */
export const SCRIPT_NAMES: readonly ScriptName[] = ['retry', 'escalation', 'none'];

/** One run-log event to append, without `v` and `ts` (added when it's written). */
export interface ScriptEvent {
  phase: number;
  wave: number;
  sprint: string;
  gate: 'implement' | 'verify' | 'wave_test' | 'doc_sync' | 'task';
  result: 'pass' | 'partial' | 'warn' | 'fail' | 'blocked' | 'start';
  attempt: number;
  max: number;
  /** On a `task` line, the task number alone. */
  summary: string;
  /** `doc_sync` only. */
  files?: string[];
}

/** What happens at one tick: events appended together, like one gate's chained append lines. */
export interface ScriptStep {
  events: ScriptEvent[];
  /** Sprint ids whose `—` / `~` tasks are marked `x` in the phase file before the events are appended. */
  markDone?: string[];
  /** Single task status changes, applied after `markDone`. */
  tasks?: TaskChange[];
  /** Replayed steps only: the logged `ts`, in ms. */
  at?: number;
  /**
   * Paced replays only: the longest wait before this step, in place of the
   * run's `maxGap`. For a step worth lingering on, like the end of an
   * implementation whose tasks should be seen one by one.
   */
  maxGapMs?: number;
  /**
   * A step added between logged steps (see {@link fillTasks} and
   * {@link addTaskLines}). With `speed` it's placed by `at` inside the wait
   * between the logged steps around it, so it never lengthens the run.
   */
  filler?: boolean;
}

/** Set task `task` of sprint `sprint` to `status` (`~`, `BLOCKED`, …) in its phase file. */
export interface TaskChange {
  sprint: string;
  task: number;
  status: string;
}

// ---------------------------------------------------------------------------
// Scripts
// ---------------------------------------------------------------------------

const ev = (
  wave: number,
  sprint: string,
  gate: ScriptEvent['gate'],
  result: ScriptEvent['result'],
  attempt: number,
  summary: string,
  files?: string[],
): ScriptEvent => ({
  phase: 2,
  wave,
  sprint,
  gate,
  result,
  attempt,
  max: gate === 'doc_sync' ? 1 : 3,
  summary,
  ...(files ? { files } : {}),
});

const WAVE_2_FILES = [
  'src/db/photos.ts',
  'src/photos/import.ts',
  'src/photos/import.test.ts',
  'src/trips/TripDetail.tsx',
  'src/trips/WaypointNote.tsx',
  'src/trips/WaypointNote.css',
];

/** Phase 2, wave 2: 2.2 and 2.3 in parallel, 2.3 fails verify once and passes on retry. */
const WAVE_2: ScriptStep[] = [
  {
    events: [
      ev(2, '2.2', 'implement', 'pass', 1, 'done 1,2,3 — Note editor saves on blur; 2,000-character limit'),
      ev(2, '2.3', 'implement', 'pass', 1, 'done 1,2,3 — Photos table and resize on import'),
    ],
  },
  {
    events: [
      ev(2, '2.2', 'verify', 'pass', 1, 'criteria 2/2 met'),
      ev(2, '2.3', 'verify', 'fail', 1, 'test: 2 failing in src/photos/import.test.ts (portrait photos come out 1600px wide)'),
    ],
  },
  { events: [ev(2, '2.3', 'implement', 'pass', 2, 'done 1,2,3 — Retry 1. Resize on the long edge, keep the aspect ratio.')] },
  {
    events: [
      ev(2, '2.2', 'verify', 'pass', 2, 'criteria 2/2 met'),
      ev(2, '2.3', 'verify', 'pass', 2, 'criteria 2/2 met'),
    ],
  },
  {
    events: [
      ev(2, '2.2', 'wave_test', 'pass', 1, '1 URLs, 3 viewports'),
      ev(2, '2.3', 'wave_test', 'pass', 1, '1 URLs, 3 viewports'),
    ],
  },
  {
    markDone: ['2.2', '2.3'],
    events: [
      ev(2, '2.2', 'doc_sync', 'pass', 1, '3 tasks updated', WAVE_2_FILES),
      ev(2, '2.3', 'doc_sync', 'pass', 1, '3 tasks updated', WAVE_2_FILES),
    ],
  },
];

/** Phase 2, wave 3: 2.4 passes first time. */
const WAVE_3_PASS: ScriptStep[] = [
  { events: [ev(3, '2.4', 'implement', 'pass', 1, 'done 1,2,3 — .trail archive export and import')] },
  { events: [ev(3, '2.4', 'verify', 'pass', 1, 'criteria 1/1 met')] },
  {
    markDone: ['2.4'],
    events: [ev(3, '2.4', 'doc_sync', 'pass', 1, '3 tasks updated', ['src/export/archive.ts', 'src/export/archive.test.ts'])],
  },
];

/** Phase 2, wave 3: 2.4 fails verify at attempts 1, 2 and 3 of 3, then nothing (an escalation). */
const WAVE_3_ESCALATE: ScriptStep[] = [
  { events: [ev(3, '2.4', 'implement', 'pass', 1, 'done 1,2,3 — .trail archive export and import')] },
  { events: [ev(3, '2.4', 'verify', 'fail', 1, 'test: round trip loses photo order in src/export/archive.test.ts')] },
  { events: [ev(3, '2.4', 'implement', 'pass', 2, 'done 1,2,3 — Retry 1. Sort photos by waypoint index on import.')] },
  { events: [ev(3, '2.4', 'verify', 'fail', 2, 'test: round trip loses photo order in src/export/archive.test.ts')] },
  { events: [ev(3, '2.4', 'implement', 'pass', 3, 'done 1,2,3 — Retry 2. Store the photo order in the archive manifest.')] },
  { events: [ev(3, '2.4', 'verify', 'fail', 3, 'test: 1 failing in src/export/archive.test.ts (photo order on a trip with 40+ photos)')] },
];

/** The steps of a named script: its gate lines only. Returns a fresh copy each call. */
export function buildScript(name: ScriptName): ScriptStep[] {
  const steps =
    name === 'retry' ? [...WAVE_2, ...WAVE_3_PASS] : name === 'escalation' ? [...WAVE_2, ...WAVE_3_ESCALATE] : [];
  return steps.map((step) => ({
    events: step.events.map((e) => ({ ...e, ...(e.files ? { files: [...e.files] } : {}) })),
    ...(step.markDone ? { markDone: [...step.markDone] } : {}),
  }));
}

/**
 * {@link buildScript}'s steps with the implementers' `implement` `start`
 * lines: a step before each step that holds `implement` results, with one
 * start line per result (same sprint, wave and attempt, empty summary).
 */
export function withStartLines(steps: readonly ScriptStep[]): ScriptStep[] {
  const out: ScriptStep[] = [];
  for (const step of steps) {
    const results = step.events.filter((e) => e.gate === 'implement' && e.result !== 'start');
    if (results.length > 0) out.push({ events: results.map((e): ScriptEvent => ({ ...e, result: 'start', summary: '' })) });
    out.push(step);
  }
  return out;
}

/**
 * What a named script plays: {@link buildScript}'s gate lines, with the lines
 * the implementers write ({@link withStartLines}, then {@link addTaskLines}).
 */
export function buildRun(name: ScriptName): ScriptStep[] {
  return addTaskLines(withStartLines(buildScript(name)));
}

/** Task numbers an `implement` summary lists as done: "done 1,2; blocked 3 — notes" → `[1, 2]`. */
export function doneTasks(summary: string): number[] {
  const m = /\bdone ([\d,\s]+)/.exec(summary.split(' — ')[0] ?? '');
  return m ? m[1]!.split(',').map((n) => Number(n.trim())).filter((n) => Number.isInteger(n) && n > 0) : [];
}

/**
 * Add the `task` lines an implementer writes (run-log.md, "Gates"): between
 * each sprint's first `implement` `start` line (attempt 1) and its `implement`
 * result, a `task` `start` line and then a `task` `pass` line for every task
 * the result's summary lists as done, in that order, each finished task's
 * `pass` chained with the next one's `start`. The viewer's tasks table then
 * shows each task Running, then Built, before doc sync marks it done.
 *
 * The added steps are fillers, spread evenly between the start step and the
 * result step (by `at` when every step has one, so a paced replay keeps its
 * length). Sprints started in the same step and finished in the same step
 * move together. A sprint is left alone when its result lists no done tasks,
 * when no result follows its start, on a retry (which reworks what failed,
 * not every task), and when the steps already hold `task` lines for it
 * between the two (a replayed log that has its own).
 *
 * Pure: returns a new list, and never reads or writes the phase file.
 */
export function addTaskLines(steps: readonly ScriptStep[]): ScriptStep[] {
  const timed = steps.length > 0 && steps.every((s) => s.at !== undefined);
  const position = (i: number): number => (timed ? steps[i]!.at! : i);
  const same = (a: ScriptEvent, b: ScriptEvent): boolean => a.phase === b.phase && a.sprint === b.sprint;
  const fillers: Array<{ position: number; step: ScriptStep }> = [];

  for (let i = 0; i < steps.length; i++) {
    // The sprints started in this step, grouped by the step that holds their result.
    const byResult = new Map<number, Array<{ start: ScriptEvent; tasks: number[] }>>();
    for (const start of steps[i]!.events) {
      if (start.gate !== 'implement' || start.result !== 'start' || start.attempt !== 1) continue;
      const isResult = (e: ScriptEvent): boolean => same(e, start) && e.gate === 'implement' && e.result !== 'start';
      const j = steps.findIndex((s, k) => k > i && s.events.some(isResult));
      if (j === -1) continue;
      const logged = steps.slice(i, j + 1).some((s) => s.events.some((e) => e.gate === 'task' && same(e, start)));
      if (logged) continue;
      const tasks = doneTasks(steps[j]!.events.find(isResult)!.summary);
      if (tasks.length === 0) continue;
      byResult.set(j, [...(byResult.get(j) ?? []), { start, tasks }]);
    }

    for (const [j, sprints] of byResult) {
      const most = Math.max(...sprints.map((s) => s.tasks.length));
      // Slot k: each sprint's task k finishes (k ≥ 1) and its task k + 1 starts.
      for (let k = 0; k <= most; k++) {
        const events: ScriptEvent[] = [];
        for (const { start, tasks } of sprints) {
          if (k >= 1 && k <= tasks.length) events.push(taskLine(start, 'pass', tasks[k - 1]!));
          if (k < tasks.length) events.push(taskLine(start, 'start', tasks[k]!));
        }
        if (events.length === 0) continue;
        const at = position(i) + ((k + 1) / (most + 2)) * (position(j) - position(i));
        fillers.push({ position: at, step: { events, filler: true, ...(timed ? { at } : {}) } });
      }
    }
  }

  // Stable: a filler at the same position as a logged step comes after it.
  return [...steps.map((step, i) => ({ position: position(i), step })), ...fillers]
    .sort((a, b) => a.position - b.position)
    .map((s) => s.step);
}

/** One `task` line for the implementation run that `start` began. */
function taskLine(start: ScriptEvent, result: 'start' | 'pass', task: number): ScriptEvent {
  return {
    phase: start.phase,
    wave: start.wave,
    sprint: start.sprint,
    gate: 'task',
    result,
    attempt: start.attempt,
    max: start.max,
    summary: String(task),
  };
}

// ---------------------------------------------------------------------------
// Fixture copy
// ---------------------------------------------------------------------------

/** Options for {@link prepareFixture}. */
export interface PrepareOptions {
  /** Folder name under `test/fixtures/`. Default {@link DEFAULT_FIXTURE}. Ignored when `source` is given. */
  fixture?: string;
  /** A project folder to copy instead of a fixture. Only its `docs/` is copied. */
  source?: string;
  /**
   * Folder to copy into; the project lands at `{dir}/{fixture}` and must not
   * exist yet. Default: a new `phase-viewer-sim-*` folder in the OS temp folder.
   */
  dir?: string;
  /** Default `fresh`. */
  freshness?: Freshness;
  /** "Now" for `freshness` (for tests). Default `new Date()`. */
  preparedAt?: Date;
}

/** A prepared copy. */
export interface PreparedFixture {
  /** Absolute project folder (what `phase-viewer --dir` takes). */
  root: string;
  /** Absolute `{root}/docs/phases`. */
  phasesDir: string;
  /** Absolute `{root}/docs/phases/.runs`. */
  runsDir: string;
  /** The project folder's name (the fixture's, or the source project's), which the viewer shows as the project name. */
  name: string;
  /** Delete the copy (and the temp folder when this call created it). Safe to call twice. */
  cleanup(): Promise<void>;
}

/** Copy a fixture project to a throwaway folder and set its run-log freshness. */
export async function prepareFixture(options: PrepareOptions = {}): Promise<PreparedFixture> {
  const source = options.source === undefined ? path.join(FIXTURES_ROOT, options.fixture ?? DEFAULT_FIXTURE) : path.resolve(options.source);
  const name = path.basename(source);
  if (!(await isDirectory(path.join(source, 'docs', 'phases')))) {
    throw new Error(`No ${options.source === undefined ? 'fixture ' : ''}project at ${source} (expected docs/phases/ inside it)`);
  }

  let owned: string;
  let root: string;
  if (options.dir === undefined) {
    owned = await mkdtemp(path.join(tmpdir(), 'phase-viewer-sim-'));
    root = path.join(owned, name);
  } else {
    await mkdir(options.dir, { recursive: true });
    root = path.resolve(options.dir, name);
    if (await exists(root)) throw new Error(`${root} already exists; remove it or pick another --out folder`);
    owned = root;
  }
  if (options.source === undefined) await cp(source, root, { recursive: true });
  else await cp(path.join(source, 'docs'), path.join(root, 'docs'), { recursive: true });

  const phasesDir = path.join(root, 'docs', 'phases');
  const runsDir = path.join(phasesDir, '.runs');
  const freshness = options.freshness ?? 'fresh';
  if (freshness !== 'as-is') {
    await retimeRunLogs(runsDir, (options.preparedAt ?? new Date()).getTime() - FRESHNESS_AGE_MS[freshness]);
  }

  let cleaned: Promise<void> | null = null;
  return {
    root,
    phasesDir,
    runsDir,
    name,
    cleanup() {
      cleaned ??= rm(owned, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      return cleaned;
    },
  };
}

/**
 * Shift every event's `ts` in every `.jsonl` in `runsDir` by one offset, so
 * the latest event across all logs lands at `latestAt` (ms since the epoch).
 * Lines that aren't JSON events with a valid `ts` are kept unchanged.
 */
async function retimeRunLogs(runsDir: string, latestAt: number): Promise<void> {
  let names: string[];
  try {
    names = (await readdir(runsDir)).filter((n) => n.endsWith('.jsonl'));
  } catch {
    return;
  }
  const logs = await Promise.all(
    names.map(async (n) => ({ file: path.join(runsDir, n), text: await readFile(path.join(runsDir, n), 'utf8') })),
  );

  let latest = -Infinity;
  for (const { text } of logs) {
    for (const line of text.split('\n')) {
      const t = eventTime(line);
      if (t !== null && t > latest) latest = t;
    }
  }
  if (!Number.isFinite(latest)) return;
  const offset = latestAt - latest;

  for (const { file, text } of logs) {
    const out = text
      .split('\n')
      .map((line) => {
        const t = eventTime(line);
        if (t === null) return line;
        const event = JSON.parse(line) as Record<string, unknown>;
        event.ts = formatTs(new Date(t + offset));
        return JSON.stringify(event);
      })
      .join('\n');
    await writeFile(file, out, 'utf8');
  }
}

/** The `ts` of a run-log line in ms, or `null` when the line isn't an event with a valid `ts`. */
function eventTime(line: string): number | null {
  if (line.trim() === '') return null;
  try {
    const event: unknown = JSON.parse(line);
    const ts = typeof event === 'object' && event !== null ? (event as { ts?: unknown }).ts : undefined;
    if (typeof ts !== 'string') return null;
    const t = Date.parse(ts);
    return Number.isNaN(t) ? null : t;
  } catch {
    return null;
  }
}

/** `YYYY-MM-DDTHH:MM:SSZ`, the run log's `ts` format (UTC, no milliseconds). */
export function formatTs(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

// ---------------------------------------------------------------------------
// Playing a script
// ---------------------------------------------------------------------------

/** Options for {@link simulateRun}. */
export interface SimulateOptions {
  /** The project folder to write into (normally {@link PreparedFixture.root}). */
  root: string;
  /** Named script. Default `retry`. Ignored when `steps` is given. Played with its `implement` `start` lines ({@link withStartLines}). */
  script?: ScriptName;
  /** Explicit steps instead of a named script. */
  steps?: ScriptStep[];
  /**
   * Write the implementers' `task` lines between each sprint's `implement`
   * `start` and its result ({@link addTaskLines}). Default `true`; `false`
   * plays the steps without them.
   */
  taskLines?: boolean;
  /** Time between steps. Default {@link DEFAULT_INTERVAL_MS}. Ignored when the steps are paced by `speed`. */
  intervalMs?: number;
  /** Time before the first step. Default `intervalMs`. */
  startDelayMs?: number;
  /**
   * Replayed steps (every step has `at`) only: wait the logged gap divided by
   * this between steps, and stamp each step `origin + (at - first at)`.
   */
  speed?: number;
  /** With `speed`: the longest wait between two steps. Default {@link DEFAULT_MAX_GAP_MS}. */
  maxGapMs?: number;
  /** With `speed`: the `ts` of the first step, in ms. Default the clock when the first step is written. */
  origin?: number;
  /** Called after each step is written, with its 0-based index. */
  onStep?: (step: ScriptStep, index: number) => void;
  /** The clock used for `ts`. Default `() => new Date()`. */
  now?: () => Date;
}

/** Default longest wait between two paced steps. */
export const DEFAULT_MAX_GAP_MS = 4_000;

/** A running simulation. */
export interface Simulation {
  /** Resolves when every step is written or {@link Simulation.stop} is called; rejects if a write fails. */
  readonly done: Promise<void>;
  /** Stop before the next step. Safe to call twice. */
  stop(): void;
  /**
   * The run's clock now, in ms: the time the run log is being written at. With
   * `speed`, it runs `speed` times faster than the wall clock between steps
   * (so a browser can be shown the same time as the log), and at normal speed
   * before the first step and after the last. Otherwise it's the clock.
   */
  clock(): number;
}

/** Append a script's steps to the project's run logs, one step per interval (or per logged gap, with `speed`). */
export function simulateRun(options: SimulateOptions): Simulation {
  const given = options.steps ?? withStartLines(buildScript(options.script ?? 'retry'));
  const steps = options.taskLines === false ? given : addTaskLines(given);
  const interval = Math.max(0, options.intervalMs ?? DEFAULT_INTERVAL_MS);
  const startDelay = Math.max(0, options.startDelayMs ?? interval);
  const now = options.now ?? (() => new Date());
  const speed = options.speed !== undefined && options.speed > 0 && steps.every((s) => s.at !== undefined) ? options.speed : null;
  const maxGap = Math.max(0, options.maxGapMs ?? DEFAULT_MAX_GAP_MS);
  /** With speed: each step's wall time after the first step's. */
  const wallAt = speed === null ? [] : paceSteps(steps, speed, maxGap);

  /** Wait before step `i` (i ≥ 1). */
  const gapBefore = (i: number): number => (speed === null ? interval : wallAt[i]! - wallAt[i - 1]!);

  // With speed: ts of step i is origin + (at_i - at_0). `origin` is fixed on the first step when not given.
  let origin = options.origin ?? null;
  const expectedFirst = now().getTime() + (steps.length > 0 ? startDelay : 0);
  /** Wall time of the first step, and index of the last step written, for {@link Simulation.clock}. */
  let firstWall: number | null = null;
  let last: { index: number } | null = null;

  const stampFor = (index: number, wall: number): number => {
    if (speed === null) return wall;
    origin ??= wall;
    return origin + (steps[index]!.at! - steps[0]!.at!);
  };

  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let finish: () => void = () => {};

  const done = new Promise<void>((resolve, reject) => {
    finish = resolve;
    let index = 0;
    const tick = async (): Promise<void> => {
      if (stopped || index >= steps.length) return resolve();
      const step = steps[index]!;
      const wall = now().getTime();
      firstWall ??= wall;
      const stamp = stampFor(index, wall);
      try {
        await writeStep(options.root, step, new Date(stamp));
      } catch (err) {
        return reject(err instanceof Error ? err : new Error(String(err)));
      }
      last = { index };
      options.onStep?.(step, index);
      index++;
      if (stopped || index >= steps.length) return resolve();
      timer = setTimeout(() => void tick(), gapBefore(index));
    };
    if (steps.length === 0) resolve();
    else timer = setTimeout(() => void tick(), startDelay);
  });

  return {
    done,
    stop() {
      stopped = true;
      clearTimeout(timer);
      finish();
    },
    clock() {
      const wall = now().getTime();
      if (speed === null) return wall;
      if (last === null || firstWall === null || origin === null) return (origin ?? expectedFirst) - (expectedFirst - wall);
      // Between two steps, run time moves in step with the wall clock from one to the next.
      const runAt = (i: number): number => origin! + (steps[i]!.at! - steps[0]!.at!);
      const t = wall - firstWall;
      const k = last.index;
      if (k === steps.length - 1) return runAt(k) + Math.max(0, t - wallAt[k]!);
      const span = wallAt[k + 1]! - wallAt[k]!;
      const f = span <= 0 ? 1 : Math.min(1, Math.max(0, (t - wallAt[k]!) / span));
      return runAt(k) + f * (runAt(k + 1) - runAt(k));
    },
  };
}

/**
 * Wall time of each step after the first, with `speed`: a logged step comes
 * the logged gap divided by `speed` after the previous logged step, at most
 * `maxGap` (or the step's own `maxGapMs`). Filler steps sit inside that wait
 * in proportion to their `at`.
 */
export function paceSteps(steps: readonly ScriptStep[], speed: number, maxGap: number): number[] {
  const wall = new Array<number>(steps.length).fill(0);
  const gap = (a: number, b: number): number => Math.min(steps[b]!.maxGapMs ?? maxGap, Math.max(0, (steps[b]!.at! - steps[a]!.at!) / speed));
  let prev = -1;
  for (let i = 0; i < steps.length; i++) {
    if (steps[i]!.filler) continue;
    wall[i] = prev === -1 ? 0 : wall[prev]! + gap(prev, i);
    for (let j = prev + 1; j < i; j++) {
      if (prev === -1) continue;
      const span = steps[i]!.at! - steps[prev]!.at!;
      const f = span <= 0 ? 1 : (steps[j]!.at! - steps[prev]!.at!) / span;
      wall[j] = wall[prev]! + f * (wall[i]! - wall[prev]!);
    }
    prev = i;
  }
  for (let j = prev + 1; j < steps.length; j++) wall[j] = j === 0 ? 0 : wall[j - 1]! + gap(j - 1, j);
  return wall;
}

// ---------------------------------------------------------------------------
// Replay
// ---------------------------------------------------------------------------

/**
 * A run log file as steps: consecutive lines with the same `ts` are one step,
 * `at` is that `ts`, and each passing `doc_sync` marks its sprint done, except
 * the tasks its latest `implement` result lists as blocked ("done 1,2;
 * blocked 3 — …"), which it marks `BLOCKED`, as phase-doc-sync does. Blank
 * lines are skipped; any other line that isn't a v1 event is an error.
 */
export async function readReplay(file: string): Promise<ScriptStep[]> {
  const steps: ScriptStep[] = [];
  const blockedBySprint = new Map<string, number[]>();
  const lines = (await readFile(file, 'utf8')).split(/\r?\n/);
  lines.forEach((line, i) => {
    if (line.trim() === '') return;
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(line) as Record<string, unknown>;
    } catch {
      throw new Error(`${file}:${i + 1}: not JSON`);
    }
    const at = typeof raw.ts === 'string' ? Date.parse(raw.ts) : NaN;
    if (Number.isNaN(at) || typeof raw.phase !== 'number' || typeof raw.sprint !== 'string' || typeof raw.gate !== 'string') {
      throw new Error(`${file}:${i + 1}: not a run-log event (needs ts, phase, sprint and gate)`);
    }
    const event: ScriptEvent = {
      phase: raw.phase,
      wave: Number(raw.wave),
      sprint: raw.sprint,
      gate: raw.gate as ScriptEvent['gate'],
      result: raw.result as ScriptEvent['result'],
      attempt: Number(raw.attempt),
      max: Number(raw.max),
      summary: typeof raw.summary === 'string' ? raw.summary : '',
      ...(Array.isArray(raw.files) ? { files: raw.files as string[] } : {}),
    };
    const prev = steps[steps.length - 1];
    const step = prev && prev.at === at ? prev : { events: [], at };
    if (step !== prev) steps.push(step);
    step.events.push(event);
    if (event.gate === 'implement' && event.result !== 'start') blockedBySprint.set(event.sprint, blockedTasks(event.summary));
    if (event.gate === 'doc_sync' && event.result === 'pass') {
      (step.markDone ??= []).push(event.sprint);
      for (const task of blockedBySprint.get(event.sprint) ?? []) (step.tasks ??= []).push({ sprint: event.sprint, task, status: 'BLOCKED' });
    }
  });
  return steps;
}

/** Task numbers an `implement` summary lists as blocked: "done 1,2; blocked 3,4 — notes" → `[3, 4]`. */
export function blockedTasks(summary: string): number[] {
  const m = /\bblocked ([\d,\s]+)/.exec(summary.split(' — ')[0] ?? '');
  return m ? m[1]!.split(',').map((n) => Number(n.trim())).filter((n) => Number.isInteger(n) && n > 0) : [];
}

/**
 * Add filler steps so a sprint's progress bar fills while it's implemented:
 * between each sprint's first `implement` `start` and its `implement` result,
 * its to-do tasks turn active (`~`) one by one, evenly through the gap, in
 * task order. Tasks the result lists as blocked are left. Doc sync then marks
 * them done, as in a real run. Reads task numbers from the project's phase
 * files as they are now (after {@link prepareReplay}).
 */
export async function fillTasks(root: string, steps: ScriptStep[]): Promise<ScriptStep[]> {
  const phasesDir = path.join(root, 'docs', 'phases');
  const fillers: ScriptStep[] = [];
  for (let i = 0; i < steps.length; i++) {
    for (const start of steps[i]!.events) {
      if (start.gate !== 'implement' || start.result !== 'start' || start.attempt !== 1) continue;
      const j = steps.findIndex((s, k) => k > i && s.events.some((e) => e.sprint === start.sprint && e.gate === 'implement' && e.result !== 'start'));
      if (j === -1) continue;
      const result = steps[j]!.events.find((e) => e.sprint === start.sprint && e.gate === 'implement')!;
      const blocked = blockedTasks(result.summary);
      const todo = (await readSprintTasks(phasesDir, start.sprint)).filter((t) => /^(?:—|–|-)$/.test(t.status) && !blocked.includes(t.task));
      const from = steps[i]!.at!;
      const to = steps[j]!.at!;
      todo.forEach((t, k) => {
        fillers.push({ events: [], filler: true, at: from + ((k + 1) / (todo.length + 1)) * (to - from), tasks: [{ sprint: start.sprint, task: t.task, status: '~' }] });
      });
    }
  }
  // Stable: a filler at the same time as a logged step comes after it.
  return [...steps, ...fillers].sort((a, b) => a.at! - b.at!);
}

/** Options for {@link prepareReplay}. */
export interface ReplayOptions {
  /** Steps logged before this time (any `Date.parse` string) are written at once. Default: none are. */
  startAt?: string;
  /** Run time the first step still to play is stamped with, in ms (as {@link SimulateOptions.origin}). */
  origin: number;
  /** Also reset every phase numbered above the replayed ones to not started: no run log, done and active tasks back to `—`. */
  resetLater?: boolean;
}

/**
 * Get a project copy ready to replay `steps` (from {@link readReplay}): reset
 * the phases and sprints the steps touch (see the module comment), then write
 * the steps logged before `startAt`, stamped on the same clock the rest will
 * play on. Returns the steps still to play.
 */
export async function prepareReplay(root: string, steps: ScriptStep[], options: ReplayOptions): Promise<ScriptStep[]> {
  const phasesDir = path.join(root, 'docs', 'phases');
  const events = steps.flatMap((s) => s.events);
  const phases = new Set(events.map((e) => e.phase));
  const sprints = new Set(events.map((e) => e.sprint));
  if (options.resetLater) {
    const last = Math.max(...phases);
    for (const name of await readdir(phasesDir)) {
      const n = /^Phase-(\d+)/i.exec(name);
      if (!n || Number(n[1]) <= last) continue;
      phases.add(Number(n[1]));
      const text = await readFile(path.join(phasesDir, name), 'utf8');
      for (const m of text.matchAll(/^#\s+Sprint\s+([\d.]+)/gm)) sprints.add(m[1]!);
    }
  }
  for (const phase of phases) await rm(path.join(phasesDir, '.runs', `phase-${phase}.jsonl`), { force: true });
  for (const sprint of sprints) await markSprintTodo(phasesDir, sprint);

  const startAt = options.startAt === undefined ? -Infinity : Date.parse(options.startAt);
  if (Number.isNaN(startAt)) throw new Error(`--start-at: can't read "${options.startAt}" as a time`);
  const split = steps.findIndex((s) => s.at! >= startAt);
  const seed = split === -1 ? steps : steps.slice(0, split);
  const rest = split === -1 ? [] : steps.slice(split);
  const anchor = (rest[0] ?? steps[steps.length - 1])?.at ?? 0;
  for (const step of seed) await writeStep(root, step, new Date(options.origin + (step.at! - anchor)));
  return rest;
}

/** Write one step: phase-file status edits first (as doc-sync does), then the events. */
export async function writeStep(root: string, step: ScriptStep, at: Date): Promise<void> {
  const phasesDir = path.join(root, 'docs', 'phases');
  for (const sprint of step.markDone ?? []) await markSprintDone(phasesDir, sprint);
  for (const t of step.tasks ?? []) await setTaskStatus(phasesDir, t.sprint, t.task, t.status);

  const ts = formatTs(at);
  const byFile = new Map<string, string[]>();
  for (const e of step.events) {
    const file = path.join(phasesDir, '.runs', `phase-${e.phase}.jsonl`);
    const lines = byFile.get(file) ?? [];
    lines.push(eventLine(e, ts));
    byFile.set(file, lines);
  }
  for (const [file, lines] of byFile) {
    await mkdir(path.dirname(file), { recursive: true });
    await appendFile(file, lines.map((l) => `${l}\n`).join(''), 'utf8');
  }
}

/** One run-log v1 line, with keys in the order the gate agents write them. */
export function eventLine(e: ScriptEvent, ts: string): string {
  return JSON.stringify({
    v: 1,
    ts,
    phase: e.phase,
    wave: e.wave,
    sprint: e.sprint,
    gate: e.gate,
    result: e.result,
    attempt: e.attempt,
    max: e.max,
    summary: e.summary,
    ...(e.files ? { files: e.files } : {}),
  });
}

/**
 * Mark every to-do or active task in sprint `id` done, in whichever phase
 * file holds its `# Sprint {id}` header: the Status cell `—`, `-`, `–` or `~`
 * becomes `x`. Does nothing when no phase file has the sprint.
 */
export async function markSprintDone(phasesDir: string, id: string): Promise<void> {
  await rewriteSprintStatus(phasesDir, id, /^\|\s*(?:—|–|-|~)\s*\|/, '| x |');
}

/**
 * Set every done or active task in sprint `id` back to to-do: the Status cell
 * `x` or `~` becomes `—`. Blocked, manual, cut and deferred tasks are left.
 */
export async function markSprintTodo(phasesDir: string, id: string): Promise<void> {
  await rewriteSprintStatus(phasesDir, id, /^\|\s*(?:x|X|~)\s*\|/, '| — |');
}

/** Set the Status cell of task `task` in sprint `id` to `status`. */
export async function setTaskStatus(phasesDir: string, id: string, task: number, status: string): Promise<void> {
  await rewriteSprintStatus(phasesDir, id, new RegExp(`^\\|[^|]*\\|\\s*${task}\\s*\\|`), `| ${status} | ${task} |`);
}

/** Sprint `id`'s task rows as `{ task, status }`, in file order; empty when no phase file has it. */
export async function readSprintTasks(phasesDir: string, id: string): Promise<Array<{ task: number; status: string }>> {
  const header = new RegExp(`^#\\s+Sprint\\s+${id.replace('.', '\\.')}(?![\\d.])`);
  for (const name of await readdir(phasesDir)) {
    if (!/^Phase-\d+.*\.md$/i.test(name)) continue;
    const lines = (await readFile(path.join(phasesDir, name), 'utf8')).split('\n');
    const start = lines.findIndex((l) => header.test(l));
    if (start === -1) continue;
    const rows: Array<{ task: number; status: string }> = [];
    for (let i = start + 1; i < lines.length; i++) {
      const line = lines[i]!;
      if (/^#\s+Sprint\b/.test(line) || /^##\s/.test(line)) break;
      const m = /^\|\s*([^|]*?)\s*\|\s*(\d+)\s*\|/.exec(line);
      if (m) rows.push({ status: m[1]!, task: Number(m[2]) });
    }
    return rows;
  }
  return [];
}

/** Replace `from` with `to` on the task rows of sprint `id`, in whichever phase file holds it. */
async function rewriteSprintStatus(phasesDir: string, id: string, from: RegExp, to: string): Promise<void> {
  const header = new RegExp(`^#\\s+Sprint\\s+${id.replace('.', '\\.')}(?![\\d.])`);
  for (const name of await readdir(phasesDir)) {
    if (!/^Phase-\d+.*\.md$/i.test(name)) continue;
    const file = path.join(phasesDir, name);
    const text = await readFile(file, 'utf8');
    const lines = text.split('\n');
    const start = lines.findIndex((l) => header.test(l));
    if (start === -1) continue;
    let changed = false;
    for (let i = start + 1; i < lines.length; i++) {
      const line = lines[i]!;
      if (/^#\s+Sprint\b/.test(line) || /^##\s/.test(line)) break;
      const next = line.replace(from, to);
      if (next !== line) {
        lines[i] = next;
        changed = true;
      }
    }
    if (changed) await writeFile(file, lines.join('\n'), 'utf8');
    return;
  }
}

// ---------------------------------------------------------------------------
// Both together
// ---------------------------------------------------------------------------

/** A prepared copy with a script playing on it. */
export interface SimulatedProject {
  fixture: PreparedFixture;
  simulation: Simulation;
  /** Stop the script and delete the copy. */
  close(): Promise<void>;
}

/** Options for {@link startSimulatedProject}. */
export type StartOptions = PrepareOptions &
  Omit<SimulateOptions, 'root' | 'origin'> & {
    /** A run log file to replay instead of `script` or `steps`. */
    replay?: string;
    /** With `replay`: see {@link ReplayOptions.startAt}. */
    startAt?: string;
    /** With `replay`: see {@link ReplayOptions.resetLater}. */
    resetLater?: boolean;
    /** With `replay`: fill progress bars as sprints are implemented (see {@link fillTasks}). */
    fillTasks?: boolean;
  };

/** {@link prepareFixture}, then {@link simulateRun} on the copy (after {@link prepareReplay}, with `replay`). */
export async function startSimulatedProject(options: StartOptions = {}): Promise<SimulatedProject> {
  const fixture = await prepareFixture(options);
  let steps = options.steps;
  let origin: number | undefined;
  if (options.replay !== undefined) {
    try {
      origin = Date.now() + Math.max(0, options.startDelayMs ?? options.intervalMs ?? DEFAULT_INTERVAL_MS);
      steps = await prepareReplay(fixture.root, await readReplay(options.replay), {
        startAt: options.startAt,
        origin,
        resetLater: options.resetLater,
      });
      if (options.fillTasks) steps = await fillTasks(fixture.root, steps);
    } catch (err) {
      await fixture.cleanup();
      throw err;
    }
  }
  const simulation = simulateRun({ ...options, steps, origin, root: fixture.root });
  return {
    fixture,
    simulation,
    async close() {
      simulation.stop();
      await simulation.done.catch(() => undefined);
      await fixture.cleanup();
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function isDirectory(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/** Parse `--interval`-style values: a whole number of ms, or `null`. */
export function parseMs(raw: string | undefined): number | null {
  if (raw === undefined || !/^\d+$/.test(raw.trim())) return null;
  return Number(raw.trim());
}

/** Parse `--speed`: a positive number, or `null`. */
export function parseSpeed(raw: string | undefined): number | null {
  const n = raw === undefined ? NaN : Number(raw.trim());
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Whether `raw` names a script. */
export function isScriptName(raw: string): raw is ScriptName {
  return (SCRIPT_NAMES as readonly string[]).includes(raw);
}

// ---------------------------------------------------------------------------
// Command line
// ---------------------------------------------------------------------------

/** Whether this module is the program Node started (not an import). */
function isProcessEntry(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    const self = realpathSync(fileURLToPath(import.meta.url));
    const started = realpathSync(entry);
    return process.platform === 'win32' ? self.toLowerCase() === started.toLowerCase() : self === started;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      fixture: { type: 'string' },
      from: { type: 'string' },
      script: { type: 'string' },
      escalate: { type: 'boolean' },
      replay: { type: 'string' },
      'start-at': { type: 'string' },
      speed: { type: 'string' },
      'max-gap': { type: 'string' },
      'reset-later': { type: 'boolean' },
      'fill-tasks': { type: 'boolean' },
      interval: { type: 'string' },
      stale: { type: 'boolean' },
      'as-is': { type: 'boolean' },
      out: { type: 'string' },
      keep: { type: 'boolean' },
    },
    strict: true,
    allowPositionals: false,
  });

  const script = values.escalate ? 'escalation' : (values.script ?? 'retry');
  if (!isScriptName(script)) throw new Error(`--script must be one of ${SCRIPT_NAMES.join(', ')}`);
  const intervalMs = values.interval === undefined ? DEFAULT_INTERVAL_MS : parseMs(values.interval);
  if (intervalMs === null) throw new Error('--interval must be a whole number of milliseconds');
  const speed = values.speed === undefined ? undefined : parseSpeed(values.speed);
  if (speed === null) throw new Error('--speed must be a number above 0');
  const maxGapMs = values['max-gap'] === undefined ? undefined : parseMs(values['max-gap']);
  if (maxGapMs === null) throw new Error('--max-gap must be a whole number of milliseconds');
  const freshness: Freshness = values['as-is'] ? 'as-is' : values.stale ? 'stale' : 'fresh';

  const sim = await startSimulatedProject({
    fixture: values.fixture,
    source: values.from,
    dir: values.out,
    freshness,
    script,
    replay: values.replay,
    startAt: values['start-at'],
    resetLater: values['reset-later'],
    fillTasks: values['fill-tasks'],
    speed,
    maxGapMs,
    intervalMs,
    onStep: (step, index) => {
      if (step.filler) return;
      const what = step.events.map((e) => `${e.sprint} ${e.gate} ${e.result}`).join(', ');
      process.stdout.write(`step ${index + 1}: ${what}\n`);
    },
  });
  const playing = values.replay === undefined ? `${script} script` : `replay of ${path.basename(values.replay)}`;
  process.stdout.write(
    [
      `simulate-run: ${playing} on a copy of ${sim.fixture.name}`,
      `project: ${sim.fixture.root}`,
      `view it: npm run serve -- --dir "${sim.fixture.root}"`,
      values.keep ? 'Ctrl+C stops; the copy is kept.' : 'Ctrl+C stops and deletes the copy.',
      '',
    ].join('\n'),
  );

  let stopping = false;
  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    sim.simulation.stop();
    void (values.keep ? Promise.resolve() : sim.fixture.cleanup()).finally(() => process.exit(0));
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  await sim.simulation.done;
  process.stdout.write('Script finished. Ctrl+C to exit.\n');
  // Stay alive so the copy survives until Ctrl+C.
  setInterval(() => {}, 1 << 30);
}

if (isProcessEntry()) {
  main().catch((err: unknown) => {
    process.stderr.write(`simulate-run: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
}
