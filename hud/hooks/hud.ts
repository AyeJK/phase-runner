/**
 * The HUD's read model and its texts: the toasts and the `/phase-status`
 * answer. Pure (file listings and file text in, strings out) and never throws;
 * `register.ts` makes every `$` call.
 *
 * Parsing and run derivation are the viewer's own modules, copied into
 * `core/` by `hud/scripts/sync-core.mjs`. The reading rules are the run-log
 * spec's (`plugin/skills/phase-builder/run-log.md`, "Reading the log"):
 * unparseable lines are skipped, `implement` `start` lines are markers, a drop
 * in `wave` starts a new run, and an escalation is a `fail` at the retry limit
 * with no later line for that sprint. `task` lines (an implementer starting
 * and finishing each task) are markers too: the derive code keeps them out of
 * every wave's and sprint's events, so they change neither the current gate
 * `/phase-status` names nor any toast. They do count as the log's last event.
 */
import { taskProgress } from './core/derive/progress.js';
import { deriveRun } from './core/derive/run.js';
import type { Phase, RunEvent, RunGate, Sprint, SprintRun, WaveRun } from './core/model.js';
import { parsePhaseFile } from './core/parser/phase.js';
import { readRunLog } from './core/runlog/read.js';

/** A run log with no event newer than this is not a running phase. */
export const STALE_MS = 30 * 60 * 1000;

/** Name of the run-log folder inside `docs/phases/`. */
export const RUNS_DIR = '.runs';

/** The fields of a `$.fs.list` entry the HUD reads. */
export interface Entry {
  /** File or folder name, without its directory. */
  name: string;
  /** `file`, `dir` or `other` (a symbolic link is `other`). */
  kind: 'file' | 'dir' | 'other';
  /** Size in bytes, for a file. */
  size: number;
  /** Last-modified time in milliseconds since the epoch, for a file. */
  mtimeMs: number;
}

/** A run log found in `docs/phases/.runs/`. */
export interface RunLogEntry extends Entry {
  /** Phase number `N` from `phase-{N}.jsonl`. */
  phase: number;
}

/** Everything the HUD knows about the phase it is watching. */
export interface HudView {
  /** Phase number, from the run log's file name. */
  phase: number;
  /** The parsed `Phase-{N}-*.md`, or `null` when the folder has none for this phase. */
  plan: Phase | null;
  /** Every readable run-log event, in line order. */
  events: RunEvent[];
  /** Waves in log order, across all runs of the phase. */
  waves: WaveRun[];
  /** Per sprint id, its run in every wave it appears in, oldest first. */
  history: Record<string, SprintRun[]>;
}

/** Where the run is now: the sprint `/phase-status` names. */
export interface Current {
  /** Wave number within the latest run. */
  wave: number;
  /** Sprint id, e.g. `"8.3"`. */
  sprint: string;
  /** The gate it is at and the attempt, e.g. `"verify 2/3"`, `"verify failed 3/3"`, `"done"`. */
  step: string;
}

/** One thing that raises a toast, with the key that keeps it to one toast. */
export interface Occurrence {
  /** See `HudToasted` in `types/index.d.ts`. */
  key: string;
  /** The toast's text. */
  text: string;
}

/** The mod's two `userConfig` options, as `register` uses them. */
export interface HudOptions {
  /** The `workspace` option, trimmed; empty for the session's directory. */
  workspace: string;
  /** The `sound` option. */
  hasSound: boolean;
}

/** Read the options `register(on, options)` was given. Anything of the wrong type counts as unset. */
export function readOptions(options: Readonly<Record<string, unknown>>): HudOptions {
  const workspace = options['workspace'];
  return {
    workspace: typeof workspace === 'string' ? workspace.trim() : '',
    hasSound: options['sound'] === true,
  };
}

/** Join path parts with `/`, which every platform's file calls accept. */
export function joinPath(base: string, ...parts: string[]): string {
  return [base.replace(/[\\/]+$/, ''), ...parts].join('/');
}

/** `true` for `/x`, `\x`, `C:\x` and `C:/x`. */
export function isAbsolutePath(path: string): boolean {
  return /^(?:[\\/]|[A-Za-z]:[\\/])/.test(path);
}

/**
 * The folder that should hold `docs/phases/`: the `workspace` option when it
 * is absolute, the option under the session's directory when it is relative,
 * and the session's directory when it is empty.
 */
export function workspaceFolder(sessionDir: string, workspace: string): string {
  if (workspace === '') return sessionDir;
  return isAbsolutePath(workspace) ? workspace : joinPath(sessionDir, workspace);
}

const RUN_LOG_NAME = /^phase-(0|[1-9]\d*)\.jsonl$/;

/**
 * The run log to watch: the most recently modified `phase-{N}.jsonl`, the
 * higher phase number on a tie. `null` when the folder has none.
 */
export function newestRunLog(entries: readonly Entry[]): RunLogEntry | null {
  let newest: RunLogEntry | null = null;
  for (const entry of entries) {
    if (entry.kind !== 'file') continue;
    const m = RUN_LOG_NAME.exec(entry.name);
    if (!m) continue;
    const phase = Number(m[1]);
    if (
      newest === null ||
      entry.mtimeMs > newest.mtimeMs ||
      (entry.mtimeMs === newest.mtimeMs && phase > newest.phase)
    ) {
      newest = { name: entry.name, kind: entry.kind, size: entry.size, mtimeMs: entry.mtimeMs, phase };
    }
  }
  return newest;
}

/** The `Phase-{N}-*.md` file for a phase (the first by name when there are several), or `null`. */
export function phaseFileFor(entries: readonly Entry[], phase: number): Entry | null {
  const name = new RegExp(`^Phase-${phase}(?:-.*)?\\.md$`, 'i');
  const found = entries.filter((e) => e.kind === 'file' && name.test(e.name));
  found.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return found[0] ?? null;
}

/**
 * Build the view of one phase.
 *
 * @param phase Phase number, from the run log's file name.
 * @param logText Contents of `phase-{N}.jsonl`.
 * @param plan The phase file's name and contents, or `null` when there is none.
 */
export function buildView(phase: number, logText: string, plan: { file: string; text: string } | null): HudView {
  const parsed = plan ? parsePhaseFile(plan.text, plan.file).phase : null;
  const { events } = readRunLog(logText, `phase-${phase}.jsonl`);
  const uiSprints = (parsed?.sprints ?? [])
    .filter((s) => s.verification.ui.length > 0 && s.verification.skipUi !== true)
    .map((s) => s.id);
  const { waves, sprintHistory } = deriveRun(events, { uiSprints });
  return { phase, plan: parsed, events, waves, history: sprintHistory };
}

/** Milliseconds since the epoch for a run-log `ts`, or `null` when it isn't a time. */
export function parseTs(ts: string): number | null {
  const at = Date.parse(ts);
  return Number.isNaN(at) ? null : at;
}

/** The log's last event, or `null` for an empty log. */
export function lastEvent(view: HudView): RunEvent | null {
  return view.events[view.events.length - 1] ?? null;
}

/**
 * A sprint is complete when its latest gate result is a passing `doc_sync`, or
 * when it has tasks and every eligible one is `x`.
 */
export function isSprintComplete(sprint: Sprint, history: Record<string, SprintRun[]>): boolean {
  const runs = history[sprint.id];
  if (runs?.[runs.length - 1]?.state === 'done') return true;
  const progress = taskProgress(sprint.tasks);
  return progress.total > 0 && progress.done === progress.eligible;
}

/** A phase is complete when its phase file has sprints and every one is complete. Without the file it never is. */
export function isPhaseComplete(view: HudView): boolean {
  const plan = view.plan;
  if (plan === null || plan.sprints.length === 0) return false;
  return plan.sprints.every((sprint) => isSprintComplete(sprint, view.history));
}

const GATE_LABELS: Readonly<Record<RunGate, string>> = {
  implement: 'implement',
  verify: 'verify',
  wave_test: 'wave-test',
  doc_sync: 'doc-sync',
  // Never shown: `task` lines are in no sprint's events. Here to complete the record.
  task: 'task',
  unknown: 'gate',
};

/** `2/3`, or just `2` when the gate has no retry limit (`max: 0`). */
function count(attempt: number, max: number): string {
  return max > 0 ? `${attempt}/${max}` : String(attempt);
}

/** The latest event of a gate in a sprint's wave, if it logged one. */
function latestOf(sr: SprintRun, gate: RunGate): RunEvent | undefined {
  for (let i = sr.events.length - 1; i >= 0; i--) {
    if (sr.events[i]!.gate === gate) return sr.events[i];
  }
  return undefined;
}

/** What a sprint is doing in its wave, as `/phase-status` says it. */
function stepOf(sr: SprintRun): string {
  const last = sr.lastEvent;
  if (last === null) return 'implement';
  switch (sr.state) {
    case 'implementing':
      return `implement ${count(last.attempt, last.max)}`;
    case 'verifying':
      // phase-verify logs `implement` as it starts; verify shares its counter.
      return `verify ${count(last.attempt, last.max)}`;
    case 'testing': {
      const before = latestOf(sr, 'wave_test');
      return `wave-test ${before ? count(before.attempt + 1, before.max) : count(1, 3)}`;
    }
    case 'syncing': {
      const before = latestOf(sr, 'doc_sync');
      return `doc-sync ${before ? count(before.attempt + 1, before.max) : count(1, 1)}`;
    }
    case 'failed':
      return `${GATE_LABELS[last.gate]} failed ${count(last.attempt, last.max)}`;
    case 'done':
      return 'done';
  }
}

function lastLine(events: readonly RunEvent[]): number {
  let line = 0;
  for (const e of events) if (e.line > line) line = e.line;
  return line;
}

/**
 * Where the run is now. Looks at the latest run only: the wave with the newest
 * line among those with a sprint still not done, and in it the sprint that
 * isn't done and logged last. When every wave is done, the wave and sprint of
 * the log's last line.
 */
export function current(view: HudView): Current | null {
  const latest = view.waves[view.waves.length - 1];
  if (!latest) return null;
  const inRun = view.waves.filter((w) => w.run === latest.run);
  const newestFirst = [...inRun].sort((a, b) => lastLine(b.events) - lastLine(a.events));
  const wave = newestFirst.find((w) => w.sprints.some((s) => s.state !== 'done')) ?? newestFirst[0];
  if (!wave) return null;

  const byNewest = [...wave.sprints].sort((a, b) => lastLine(b.events) - lastLine(a.events));
  const sprint = byNewest.find((s) => s.state !== 'done') ?? byNewest[0];
  if (!sprint) return null;
  return { wave: wave.wave, sprint: sprint.sprint, step: stepOf(sprint) };
}

/** The toast key for a completed phase. */
export function completeKey(phase: number): string {
  return `complete:${phase}`;
}

/** `sprint 8.2`, `sprints 8.2 and 8.3`, `sprints 8.1, 8.2 and 8.3`. */
function sprintList(ids: readonly string[]): string {
  const unique = [...new Set(ids)];
  if (unique.length <= 1) return `sprint ${unique[0] ?? ''}`;
  return `sprints ${unique.slice(0, -1).join(', ')} and ${unique[unique.length - 1]}`;
}

/**
 * Everything in the view that should have raised a toast by now, limited to
 * what happened since the mod started:
 *
 * - Escalation: a sprint whose last line in the log is a gate `fail` at
 *   `attempt >= max` with `max > 0`. One per wave and gate, so two sprints
 *   failing the same verify share a toast.
 * - Blocker: an `implement` `blocked` line. One per wave, so a retry that
 *   reports the same blocked task again doesn't repeat it.
 * - Phase complete: see {@link isPhaseComplete}.
 *
 * The caller drops the ones whose key it has already raised.
 *
 * @param since Milliseconds since the epoch. Events older than this (to the second) raise nothing.
 */
export function occurrences(view: HudView, since: number): Occurrence[] {
  const out: Occurrence[] = [];
  const isFresh = (events: readonly RunEvent[]): boolean =>
    events.some((e) => {
      const at = parseTs(e.ts);
      // `ts` is written to the second.
      return at !== null && at + 1000 > since;
    });

  for (const wave of view.waves) {
    const failed = new Map<RunGate, RunEvent[]>();
    for (const sr of wave.sprints) {
      const runs = view.history[sr.sprint];
      const last = sr.lastEvent;
      if (last === null || runs?.[runs.length - 1] !== sr) continue;
      if (last.result !== 'fail' || last.max <= 0 || last.attempt < last.max) continue;
      const list = failed.get(last.gate);
      if (list) list.push(last);
      else failed.set(last.gate, [last]);
    }
    for (const [gate, events] of failed) {
      if (!isFresh(events)) continue;
      events.sort((a, b) => a.line - b.line);
      const first = events[0]!;
      out.push({
        key: `fail:${view.phase}:${first.line}`,
        text: `Phase ${view.phase} needs you: ${sprintList(events.map((e) => e.sprint))} ${GATE_LABELS[gate]} failed ${count(first.attempt, first.max)}.`,
      });
    }

    const blocked = wave.events.filter((e) => e.gate === 'implement' && e.result === 'blocked');
    if (blocked.length > 0 && isFresh(blocked)) {
      const ids = blocked.map((e) => e.sprint);
      out.push({
        key: `blocked:${view.phase}:${blocked[0]!.line}`,
        text: `Phase ${view.phase} needs you: ${sprintList(ids)} ${new Set(ids).size > 1 ? 'have' : 'has'} a blocked task.`,
      });
    }
  }

  const last = lastEvent(view);
  if (last !== null && isFresh([last]) && isPhaseComplete(view)) {
    out.push({ key: completeKey(view.phase), text: `Phase ${view.phase} is complete. The run is at its checkpoint.` });
  }
  return out;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

/**
 * A time as the user's clock shows it, 12-hour: `4:12 PM`, with the date in
 * front (`Sep 28, 4:12 PM`) when it isn't today.
 *
 * @param at The time, in milliseconds since the epoch.
 * @param now The current time, to tell whether `at` is today.
 * @param offsetMinutes The local time zone's offset from UTC in minutes, east positive (`-420` for UTC-7).
 */
export function formatTime(at: number, now: number, offsetMinutes: number): string {
  const local = new Date(at + offsetMinutes * 60_000);
  const today = new Date(now + offsetMinutes * 60_000);
  const hours = local.getUTCHours();
  const time = `${hours % 12 || 12}:${String(local.getUTCMinutes()).padStart(2, '0')} ${hours < 12 ? 'AM' : 'PM'}`;
  const sameDay =
    local.getUTCFullYear() === today.getUTCFullYear() &&
    local.getUTCMonth() === today.getUTCMonth() &&
    local.getUTCDate() === today.getUTCDate();
  return sameDay ? time : `${MONTHS[local.getUTCMonth()]} ${local.getUTCDate()}, ${time}`;
}

/** How long ago, in words: `just now`, `3 min ago`, `2 h 5 min ago`, `4 days ago`. */
export function formatAgo(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 === 0 ? `${hours} h ago` : `${hours} h ${minutes % 60} min ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? '1 day ago' : `${days} days ago`;
}

/**
 * The `/phase-status` answer: the phase, each sprint's tasks as `done/eligible`,
 * the current wave and gate, and when the last event was logged.
 *
 * @param now Milliseconds since the epoch.
 * @param offsetMinutes The local time zone's offset from UTC in minutes, east positive.
 */
export function statusReport(view: HudView, now: number, offsetMinutes: number): string {
  const lines: string[] = [];
  const plan = view.plan;
  const complete = isPhaseComplete(view);
  lines.push(`Phase ${view.phase}${plan && plan.title !== '' ? ` — ${plan.title}` : ''}${complete ? ' (complete)' : ''}`);

  if (plan && plan.sprints.length > 0) {
    const all = taskProgress(plan.sprints.flatMap((s) => s.tasks));
    const each = plan.sprints.map((s) => {
      const p = taskProgress(s.tasks);
      return `${s.id} ${p.done}/${p.eligible}`;
    });
    lines.push(`Sprints: ${each.join(' · ')} (${all.done}/${all.eligible} tasks)`);
  } else {
    lines.push(`Sprints: no Phase-${view.phase}-*.md file to read tasks from`);
  }

  const last = lastEvent(view);
  const cur = current(view);
  if (last === null || cur === null) {
    lines.push('Now: no run logged yet');
    return lines.join('\n');
  }
  const at = parseTs(last.ts);
  const where = `wave ${cur.wave} · ${cur.sprint} ${cur.step}`;
  if (complete) lines.push(`Now: phase complete (last: ${where})`);
  else if (at !== null && now - at >= STALE_MS) lines.push(`Now: ${where} (no event in the last 30 min)`);
  else lines.push(`Now: ${where}`);
  lines.push(
    at === null
      ? `Last event: ${last.ts}`
      : `Last event: ${formatTime(at, now, offsetMinutes)}, ${formatAgo(now - at)}`,
  );
  return lines.join('\n');
}
