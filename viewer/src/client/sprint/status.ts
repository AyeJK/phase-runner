/**
 * Derived answers the rail asks of the model: the phase's status badge
 * (design-system.md "Badges and tags", "Slide-in panel"), task-row icons and
 * status words, and a sprint's task count. Pure, no DOM.
 *
 * Phase badge: blocked tasks ("N tasks blocked"), then an open escalation
 * ("Needs you", pink `needs`), then a started sprint with only its manual
 * tasks left ("Needs you", violet `manual`; pink wins when both apply), then every
 * eligible task done ("Complete"), then a running
 * sprint ("Running · wave 1 of 2", from the wave count in `live/derive.ts`),
 * else a plain tag: "Not started" (nothing done), "Waiting" (some tasks
 * done), "Deferred" / "Cut" (nothing eligible).
 *
 * Live task progress (design-system.md "Tasks table"): while a sprint is
 * being implemented, its `task` lines in the run log say which task is
 * running and which are built. {@link liveTaskStates} picks the ones that
 * still apply and {@link taskRow} overlays them on rows whose phase-file
 * status is `—`. The sprint card's status bar counts the same rows
 * ({@link liveTaskCounts}), so it fills as the sprint is built. Nothing else
 * reads them: task counts, phase status bars, card states and the phase badge
 * come from the phase file and the gate lines.
 */
import type { Phase, Progress, Project, SprintRun, Task, TaskStatus } from '../../core/model.js';
import type { IconKind } from '../components/iconKind.js';
import { phaseRuns, projectSprintStatus } from '../data/status.js';
import { plural } from '../format.js';
import { liveView } from '../live/derive.js';

/** A status badge (`.status.{kind}`) or a plain tag (`.tag`). */
export type BadgeView =
  | { kind: 'pass' | 'run' | 'needs' | 'manual' | 'fail'; text: string }
  | { kind: 'tag'; text: string };

/** The plain tag for something that isn't complete, running or blocked. */
function idleTag(progress: Progress | undefined): BadgeView {
  if (progress && progress.total > 0 && progress.eligible === 0) {
    return { kind: 'tag', text: progress.byStatus.cut === progress.total ? 'Cut' : 'Deferred' };
  }
  return { kind: 'tag', text: (progress?.done ?? 0) > 0 ? 'Waiting' : 'Not started' };
}

function blockedText(n: number): string {
  return `${plural(n, 'task')} blocked`;
}

/** See the module comment. */
export function phaseBadge(project: Project, phase: Phase): BadgeView {
  const progress = project.progress.byPhase[String(phase.number)];
  const blocked = progress?.byStatus.blocked ?? 0;
  if (blocked > 0) return { kind: 'needs', text: blockedText(blocked) };
  const runs = phaseRuns(project, phase.number);
  if (runs && runs.escalations.length > 0) return { kind: 'needs', text: 'Needs you' };
  const statuses = phase.sprints.map((s) => projectSprintStatus(project, s));
  // A sprint's own escalation (pink), then a started sprint with only its manual tasks left (violet): data/status.ts.
  if (statuses.includes('needs')) return { kind: 'needs', text: 'Needs you' };
  if (statuses.includes('manual')) return { kind: 'manual', text: 'Needs you' };
  if (progress && progress.eligible > 0 && progress.done === progress.eligible) return { kind: 'pass', text: 'Complete' };
  if (statuses.includes('running')) {
    const view = liveView(project, phase);
    return {
      kind: 'run',
      text: view.current !== null ? `Running · wave ${view.current} of ${view.total}` : 'Running',
    };
  }
  return idleTag(progress);
}

/** Task-row icon (design-system.md "Tasks table"). */
export function taskIcon(status: TaskStatus): IconKind {
  switch (status) {
    case 'done':
      return 'pass';
    case 'active':
      return 'run';
    case 'blocked':
      return 'needs';
    case 'manual':
      return 'manual';
    default:
      return 'wait';
  }
}

/** The status word shown beside a task row's icon. */
export function taskStatusWords(task: Pick<Task, 'status' | 'rawStatus'>): string {
  switch (task.status) {
    case 'done':
      return 'Complete';
    case 'active':
      return 'Running';
    case 'blocked':
      return 'Blocked';
    case 'manual':
      return 'Manual';
    case 'cut':
      return 'Cut';
    case 'deferred':
      return 'Deferred';
    case 'todo':
      return 'Not started';
    case 'unknown':
      return task.rawStatus ? `Status ${task.rawStatus}` : 'Unknown status';
  }
}

/** What a `task` line makes a row read: Running after `start`, Built after `pass`. */
export type LiveTaskState = 'running' | 'built';

const NO_LIVE_TASKS: ReadonlyMap<number, LiveTaskState> = new Map();

/**
 * The task progress to overlay on a sprint's tasks table, by task number.
 *
 * It comes from the sprint's run in the phase's latest run: the latest `task`
 * line per task number in that wave (`SprintRun.tasks`). A line stops
 * applying once the gates have moved past it:
 *
 * - any line before the sprint's latest `doc_sync` line: doc sync has written
 *   the phase file, so every row shows its status there again (and `task`
 *   lines after it, from the sprint being implemented again, start afresh);
 * - a `start` line before the sprint's latest `implement` result line:
 *   implementing is over, and the log doesn't say the task was built.
 *
 * @param run The sprint's run in the phase's latest run (`currentSprintRun`),
 *   or `null` when it has none.
 */
export function liveTaskStates(run: Pick<SprintRun, 'steps' | 'tasks'> | null): ReadonlyMap<number, LiveTaskState> {
  if (!run?.tasks || run.tasks.length === 0) return NO_LIVE_TASKS;
  let synced = 0;
  let implemented = 0;
  for (const step of run.steps) {
    if (step.gate === 'doc_sync') synced = Math.max(synced, step.line);
    else if (step.gate === 'implement') implemented = Math.max(implemented, step.line);
  }
  const live = new Map<number, LiveTaskState>();
  for (const p of run.tasks) {
    if (p.line < synced) continue;
    if (p.state === 'running' && p.line < implemented) continue;
    live.set(p.task, p.state);
  }
  return live;
}

/** What one row of the tasks table shows. */
export interface TaskRowView {
  icon: IconKind;
  /** The status word beside the icon. */
  words: string;
  /** Set when the row shows live task progress instead of its phase-file status. */
  live: LiveTaskState | null;
}

/**
 * A task row's icon and status word. A row whose phase-file status is `—`
 * (not started) reads Running or Built while {@link liveTaskStates} has its
 * task number; a row with any other status is never overlaid.
 */
export function taskRow(
  task: Pick<Task, 'status' | 'rawStatus' | 'number'>,
  live: ReadonlyMap<number, LiveTaskState> = NO_LIVE_TASKS,
): TaskRowView {
  const state = task.status === 'todo' && task.number !== null ? (live.get(task.number) ?? null) : null;
  if (state === 'running') return { icon: 'run', words: 'Running', live: state };
  if (state === 'built') return { icon: 'built', words: 'Built', live: state };
  return { icon: taskIcon(task.status), words: taskStatusWords(task), live: null };
}

/** How many of a sprint's tasks live task progress shows as Running and as Built. */
export interface LiveTaskCounts {
  running: number;
  built: number;
}

/**
 * The rows {@link taskRow} overlays, counted, for the sprint card's status
 * bar: the tasks whose phase-file status is `—` and that `live` says are
 * running or built.
 */
export function liveTaskCounts(
  tasks: readonly Pick<Task, 'status' | 'rawStatus' | 'number'>[],
  live: ReadonlyMap<number, LiveTaskState> = NO_LIVE_TASKS,
): LiveTaskCounts {
  const counts: LiveTaskCounts = { running: 0, built: 0 };
  for (const task of tasks) {
    const state = taskRow(task, live).live;
    if (state !== null) counts[state]++;
  }
  return counts;
}

/** "5/5": done over eligible, for a sprint's task count. */
export function doneOfEligible(progress: Progress | undefined): string {
  return `${progress?.done ?? 0}/${progress?.eligible ?? 0}`;
}
