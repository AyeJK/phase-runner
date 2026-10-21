/**
 * The phase list (design-system.md "Calmer layout", Sidebar): the heading
 * line ("Phases" / "7 of 8 complete") and one row per phase. The sidebar and
 * the phone switcher's sheet both render this, so the two can't drift apart;
 * the switcher's button reuses {@link PhaseEndItem} for its end item.
 *
 * A row is a link to `/phase/N`: the number, the title (wraps, never cut
 * off), the end item (a quiet `pass` icon when complete, the `run`, `needs`
 * or `manual` icon, else the task count), and a 4px status bar under the
 * title while the phase is in progress (not complete, not unstarted).
 *
 * Test hooks: `a[data-phase-item]` (with `data-group`, and
 * `aria-current="page"` on the selected one), `[data-end]` on its end item.
 */
import { StatusIcon } from '../components/StatusIcon.js';
import { StatusSegments } from '../components/StatusSegments.js';
import { Link, paths } from '../shell/router.js';
import type { PhaseRow } from './derive.js';

/** Words for an icon end item (its accessible name). */
const END_WORDS = {
  pass: 'Complete',
  run: 'Running',
  needs: 'Needs you',
  manual: 'Needs you',
} as const;

/** "Complete", "Running", "Needs you", or "1/8 tasks". */
function endWords(row: PhaseRow): string {
  return row.end === 'count' ? `${row.done}/${row.eligible} tasks` : END_WORDS[row.end];
}

/** The title shown for a phase ("Phase 3" when its file has none). */
export function phaseTitle(row: PhaseRow): string {
  return row.title === '' ? `Phase ${row.number}` : row.title;
}

/** A row's accessible name: "Phase 2: Library UI, Needs you". */
export function phaseRowName(row: PhaseRow): string {
  return `${row.label}, ${endWords(row)}`;
}

/** The end item of a phase row, and of the switcher's button. */
export function PhaseEndItem({ row }: { row: PhaseRow }) {
  if (row.end === 'count') {
    return (
      <span className="ph-end ph-count" data-end="count">
        {row.done}/{row.eligible}
      </span>
    );
  }
  return (
    <span className="ph-end" data-end={row.end} title={END_WORDS[row.end]}>
      <StatusIcon kind={row.end} />
    </span>
  );
}

interface PhaseListProps {
  rows: readonly PhaseRow[];
  /** The selected phase's number, or `null`. */
  selected: number | null;
  /** Called when a row is chosen (before it navigates). */
  onChoose?: () => void;
}

/** The heading line and the phase rows. */
export function PhaseList({ rows, selected, onChoose }: PhaseListProps) {
  const complete = rows.filter((r) => r.group === 'complete').length;
  return (
    <>
      <div className="side-h">
        <b>Phases</b>
        <span data-testid="phases-complete">
          {complete} of {rows.length} complete
        </span>
      </div>
      <ol className="phases">
        {rows.map((row) => (
          <li key={row.number}>
            <PhaseRowLink row={row} current={row.number === selected} onChoose={onChoose} />
          </li>
        ))}
      </ol>
    </>
  );
}

/** One phase row. */
function PhaseRowLink({ row, current, onChoose }: { row: PhaseRow; current: boolean; onChoose?: () => void }) {
  return (
    <Link
      className="ph"
      to={paths.phase(row.number)}
      options={{ scroll: false }}
      aria-current={current ? 'page' : undefined}
      aria-label={phaseRowName(row)}
      data-phase-item={row.number}
      data-group={row.group}
      onClick={onChoose}
    >
      <span className="ph-n">{row.number}</span>
      <span className="ph-t">{phaseTitle(row)}</span>
      <PhaseEndItem row={row} />
      {row.group === 'progress' && <StatusSegments progress={row.progress} notStarted={row.notStarted} />}
    </Link>
  );
}
