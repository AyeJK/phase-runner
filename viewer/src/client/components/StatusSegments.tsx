/**
 * The status bar (design-system.md "Status bar"): full width, split into one
 * segment per task status, each as wide as its share of the tasks (cut and
 * deferred included). Used by list view rows, the rail's
 * phase bar and each sprint card. Hovering a segment names it; the whole bar is
 * labelled for screen readers. Manual tasks sit right after blocked ones, in
 * violet beside blocked pink, so everything waiting on the user sits together
 * but the two still read apart.
 * Not-started tasks are grey whether or not their sprint has begun: waiting
 * is idle, not a status colour.
 * Phase bars pass `notStarted`, the to-do and manual tasks in sprints that
 * haven't started: a planned manual task there joins the grey not-started
 * segment, so it stays quiet until its sprint starts.
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

/** A segment: a task status, or `built` for tasks built during a run and not yet synced. */
type Segment = TaskStatus | 'built';

/** Segment order and words. */
const SEGMENTS: readonly [Segment, string][] = [
  ['done', 'complete'],
  ['built', 'built'],
  ['active', 'running'],
  ['blocked', 'blocked'],
  ['manual', 'manual'],
  ['todo', 'not started'],
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
  /** Tasks in sprints that haven't started; their manual tasks are drawn grey (see the module comment). */
  notStarted?: NotStarted;
  /** Not-started tasks that are running or built in the run under way (see the module comment). */
  live?: LiveTaskCounts;
  testId?: string;
}) {
  const allTodo = progress?.byStatus.todo ?? 0;
  const built = Math.min(live?.built ?? 0, allTodo);
  const running = Math.min(live?.running ?? 0, allTodo - built);
  const manual = progress?.byStatus.manual ?? 0;
  const quietManual = Math.min(notStarted?.manual ?? 0, manual);
  const counts: Partial<Record<Segment, number>> = {
    todo: allTodo - built - running + quietManual,
    manual: manual - quietManual,
    active: (progress?.byStatus.active ?? 0) + running,
    built,
  };
  const count = (s: Segment): number => counts[s] ?? progress?.byStatus[s as TaskStatus] ?? 0;
  const parts = SEGMENTS.map(([status, word]) => ({ status, word, n: count(status) })).filter((p) => p.n > 0);
  const label = parts.length === 0 ? 'No tasks' : parts.map((p) => `${p.n} ${p.word}`).join(', ');
  return (
    <span className="seg-bar" role="img" aria-label={label} data-testid={testId}>
      {parts.map((p) => (
        <i key={p.status} data-status={p.status} style={{ flexGrow: p.n }} title={`${p.n} ${p.word}`} />
      ))}
    </span>
  );
}
