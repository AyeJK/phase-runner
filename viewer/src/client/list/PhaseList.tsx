/**
 * The phase list (design-system.md "Calmer layout", Sidebar): the heading
 * line ("Phases" and the filter, {@link PhaseFilterMenu}) and one row per
 * phase the filter (`?show=`) lets through. The sidebar and the phone
 * switcher's sheet both render this, so the two can't drift apart; the
 * switcher's button reuses {@link PhaseEndItem} for its end item.
 *
 * Counts come from the rows' groups (`phaseGroup`). A filter nothing matches
 * shows one grey line ("No phases in progress", or "No matching phases" for
 * several groups). The selected phase stays on
 * the page even when the filter hides its row, and the rows' links keep the
 * filter.
 *
 * A row is a link to `/phase/N`: the number, the title (wraps, never cut
 * off), the end item (the green `pass` icon when complete, the `run`, `needs`
 * or `manual` icon, else the task count), and a 4px status bar under the
 * title while the phase is in progress (not complete, not unstarted).
 *
 * Test hooks: `a[data-phase-item]` (with `data-group`, and
 * `aria-current="page"` on the selected one), `[data-end]` on its end item,
 * `phases-empty`, plus {@link PhaseFilterMenu}'s.
 */
import { useMemo } from 'react';
import { StatusIcon } from '../components/StatusIcon.js';
import { StatusSegments } from '../components/StatusSegments.js';
import { countGroups, type PhaseShow } from '../rail/derive.js';
import { Link, paths, readShow, useRouter } from '../shell/router.js';
import { filterPhaseRows, phaseShowEmpty, type PhaseRow } from './derive.js';
import { PhaseFilterMenu } from './PhaseFilterMenu.js';

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

/** The heading line with the filter, and the rows the filter shows. */
export function PhaseList({ rows, selected, onChoose }: PhaseListProps) {
  const show = readShow(useRouter().location.search);
  const counts = useMemo(() => countGroups(rows.map((r) => r.group)), [rows]);
  const shown = filterPhaseRows(rows, show);
  const empty = phaseShowEmpty(show);
  return (
    <>
      <div className="side-h">
        <b>Phases</b>
        <PhaseFilterMenu show={show} counts={counts} />
      </div>
      {shown.length > 0 ? (
        <ol className="phases">
          {shown.map((row) => (
            <li key={row.number}>
              <PhaseRowLink row={row} show={show} current={row.number === selected} onChoose={onChoose} />
            </li>
          ))}
        </ol>
      ) : (
        empty !== null && (
          <p className="phases-empty" data-testid="phases-empty">
            {empty}
          </p>
        )
      )}
    </>
  );
}

interface PhaseRowLinkProps {
  row: PhaseRow;
  /** The filter, kept in the row's link. */
  show: PhaseShow;
  current: boolean;
  onChoose?: () => void;
}

/** One phase row. */
function PhaseRowLink({ row, show, current, onChoose }: PhaseRowLinkProps) {
  return (
    <Link
      className="ph"
      to={paths.phase(row.number, show)}
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
