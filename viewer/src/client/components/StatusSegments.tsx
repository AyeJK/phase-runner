/**
 * The status bar (design-system.md "Status bar"): full width, split into one
 * segment per task status, each as wide as its share of the tasks (cut and
 * deferred included). Used by kanban columns, list view rows, the rail's
 * phase bar and each sprint card. Hovering a segment names it; the whole bar is
 * labelled for screen readers. Manual tasks sit right after blocked ones, in
 * violet beside blocked pink, so everything waiting on the user sits together
 * but the two still read apart.
 * Once any task is done or running, the bar is
 * `started` and not-started tasks show amber, as in the tasks table.
 * Phase bars pass `notStarted`, the to-do and manual tasks in sprints that
 * haven't started: they stay grey ("not started"), after the amber ones ("to
 * do") on a started bar, so a planned manual task stays quiet until its
 * sprint starts.
 * Sprint cards pass `live`, the not-started tasks the implementer's `task`
 * lines say are running or built (`liveTaskCounts`): they leave the
 * not-started segment for `built` and `active`, both in the running colour,
 * so the bar fills while the sprint is implemented and turns green at doc
 * sync.
 * Styles: `.seg-bar` in `styles/app.css`.
 */
import type { Progress, TaskStatus } from '../../core/model.js';
import type { NotStarted } from '../data/status.js';
import type { LiveTaskCounts } from '../sprint/status.js';

/**
 * A segment: a task status, `built` for tasks built during a run and not yet
 * synced, or `future` for tasks in sprints not started on a started bar.
 */
type Segment = TaskStatus | 'built' | 'future';

/** Segment order and words. */
const SEGMENTS: readonly [Segment, string][] = [
  ['done', 'complete'],
  ['built', 'built'],
  ['active', 'running'],
  ['blocked', 'blocked'],
  ['manual', 'manual'],
  ['todo', 'not started'],
  ['future', 'not started'],
  ['unknown', 'unknown'],
  ['deferred', 'deferred'],
  ['cut', 'cut'],
];

export function StatusSegments({
  progress,
  notStarted,
  live,
  testId,
}: {
  progress: Progress | undefined;
  /** Tasks in sprints that haven't started, drawn grey (see the module comment). */
  notStarted?: NotStarted;
  /** Not-started tasks that are running or built in the run under way (see the module comment). */
  live?: LiveTaskCounts;
  testId?: string;
}) {
  const allTodo = progress?.byStatus.todo ?? 0;
  const built = Math.min(live?.built ?? 0, allTodo);
  const running = Math.min(live?.running ?? 0, allTodo - built);
  const active = (progress?.byStatus.active ?? 0) + running;
  const started = (progress?.done ?? 0) + active + built > 0;
  const todo = allTodo - built - running;
  const manual = progress?.byStatus.manual ?? 0;
  const quietTodo = Math.min(notStarted?.todo ?? 0, todo);
  const quietManual = Math.min(notStarted?.manual ?? 0, manual);
  // A started bar splits off the quiet tasks as grey `future`; an unstarted one is grey already.
  const counts: Partial<Record<Segment, number>> = started
    ? { todo: todo - quietTodo, future: quietTodo + quietManual }
    : { todo: todo + quietManual, future: 0 };
  counts.manual = manual - quietManual;
  counts.active = active;
  counts.built = built;
  const count = (s: Segment): number => counts[s] ?? (s === 'future' ? 0 : (progress?.byStatus[s as TaskStatus] ?? 0));
  const parts = SEGMENTS.map(([status, word]) => ({
    status,
    word: status === 'todo' && started && (counts.future ?? 0) > 0 ? 'to do' : word,
    n: count(status),
  })).filter((p) => p.n > 0);
  const label = parts.length === 0 ? 'No tasks' : parts.map((p) => `${p.n} ${p.word}`).join(', ');
  return (
    <span className={started ? 'seg-bar started' : 'seg-bar'} role="img" aria-label={label} data-testid={testId}>
      {parts.map((p) => (
        <i key={p.status} data-status={p.status} style={{ flexGrow: p.n }} title={`${p.n} ${p.word}`} />
      ))}
    </span>
  );
}
