/**
 * Sprint pieces the rail draws (design-system.md "Badges and tags", "Tasks
 * table", "Acceptance criteria list"): the status badge, the tasks table and
 * the criteria list.
 */
import type { AcceptanceCriterion, Task } from '../../core/model.js';
import { StatusIcon } from '../components/StatusIcon.js';
import { Inline } from './markdown.js';
import { taskRow, type BadgeView, type LiveTaskState } from './status.js';
import './sprint.css';

/** A derived status badge (`.status`), or the plain tag for "Not started" and friends. */
export function StatusBadge({ badge, testId }: { badge: BadgeView; testId?: string }) {
  if (badge.kind === 'tag') {
    return (
      <span className="tag" data-testid={testId} data-status="tag">
        {badge.text}
      </span>
    );
  }
  return (
    <span className={`status ${badge.kind}`} data-testid={testId} data-status={badge.kind}>
      <StatusIcon kind={badge.kind} />
      {badge.text}
    </span>
  );
}

/**
 * The tasks table: status (icon and word), `#`, task text. The Module and
 * Reference columns are never shown; a sparse row renders empty cells. A
 * blocked task gets the pink `needs` icon and word, a manual task the violet
 * `manual` icon and word (from `taskIcon`); only a blocked one gets a note
 * under its text, since a manual task's text already says what to do. A cut or deferred task is struck
 * through. Not-started tasks stay plain grey whether or not the sprint has
 * begun: waiting is idle, not a status colour.
 *
 * `live` is the sprint's live task progress (`liveTaskStates`): while the
 * sprint is being implemented, a not-started row whose task number is in it
 * reads Running or Built instead (`data-progress` says which; `data-status`
 * stays the phase file's status). Rows with any other status are never overlaid.
 */
export function TasksTable({ tasks, live }: { tasks: readonly Task[]; live?: ReadonlyMap<number, LiveTaskState> }) {
  if (tasks.length === 0) return <p className="none">No tasks</p>;
  const rows = tasks.map((task) => ({ task, view: taskRow(task, live) }));
  return (
    <table className="tasks" data-testid="tasks-table">
      <tbody>
        {rows.map(({ task, view }) => {
          const cut = task.status === 'cut' || task.status === 'deferred';
          const icon = view.icon;
          return (
            <tr
              key={task.line}
              className={cut ? 'cut' : undefined}
              data-task={task.number ?? ''}
              data-status={task.status}
              data-progress={view.live ?? undefined}
            >
              <td className={`st ${icon}`}>
                <span className="st-in">
                  <StatusIcon kind={icon} />
                  {view.words}
                </span>
              </td>
              <td className="n">{task.number ?? ''}</td>
              <td className="t">
                <span className="text">
                  <Inline text={task.text} />
                </span>
                {task.status === 'blocked' && <span className="note">Blocked: waiting on you.</span>}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/** Acceptance criteria as statements, each led by a square amber bullet. No checkboxes. */
export function CriteriaList({ criteria }: { criteria: readonly AcceptanceCriterion[] }) {
  if (criteria.length === 0) return <p className="none">None</p>;
  return (
    <ul className="criteria" data-testid="criteria">
      {criteria.map((c) => (
        <li key={c.line}>
          <span>
            <Inline text={c.text} />
          </span>
        </li>
      ))}
    </ul>
  );
}
