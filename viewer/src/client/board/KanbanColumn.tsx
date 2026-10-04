/**
 * One phase card in a kanban lane (design-system.md "Phase kanban"): the
 * whole card is one link that opens the phase's slide-in panel
 * (`/?phase=N`). Top to bottom: "Phase N" and "done/eligible tasks" (plus
 * the warnings and Stretch tags), the title (two lines at most), the
 * phase's status bar, then one tile per sprint in plan order.
 *
 * The card keeps the `kan-col` class and hooks from when each phase was a
 * column of the board.
 *
 * A tile shows its state icon, id and title; a running tile adds its state
 * badge ("Implementing", or red "Verify failed" before a retry). Other tiles carry the state word as visually
 * hidden text, so the icon is never the only carrier. The link's accessible
 * name is "Phase 2: Core Model"; the tiles describe it.
 *
 * Test hooks: `a[data-kan-col]` (with `data-group`, `data-running`),
 * `kan-count`, `kan-title`, `phase-status-bar`, `li[data-tile]` (with
 * `data-state`), `tile-badge`, `[data-tag]`.
 */
import { useId } from 'react';
import { StatusIcon, type IconKind } from '../components/StatusIcon.js';
import { StatusSegments } from '../components/StatusSegments.js';
import { plural } from '../format.js';
import { isFailedState, type SprintState } from '../rail/derive.js';
import { Link, paths } from '../shell/router.js';
import type { KanbanColumn as Column, KanbanTile } from './derive.js';

/** History-entry marker for a panel opened from the board, so closing it can go Back. */
export const PANEL_ENTRY = { panel: true } as const;

function tileLook(state: SprintState, running: boolean): { icon: IconKind; className: string } {
  // A failed gate is still working (its retry is next): the spinner, in red.
  if (isFailedState(state)) return { icon: 'run', className: 'tile fail' };
  if (running) return { icon: 'run', className: 'tile run' };
  switch (state) {
    case 'complete':
      return { icon: 'pass', className: 'tile pass' };
    case 'needs-you':
      return { icon: 'needs', className: 'tile needs' };
    case 'manual':
      return { icon: 'manual', className: 'tile manual' };
    case 'waiting':
      return { icon: 'wait', className: 'tile remaining' };
    default:
      return { icon: 'wait', className: 'tile future' };
  }
}

function Tile({ tile }: { tile: KanbanTile }) {
  const look = tileLook(tile.state, tile.running);
  return (
    <li className={look.className} data-tile={tile.id} data-state={tile.state}>
      <StatusIcon kind={look.icon} />
      <span className="tile-id">{tile.id}</span>
      <span className="tile-name">{tile.title}</span>
      {tile.running ? (
        <span className="tile-badge">
          <span className={isFailedState(tile.state) ? 'status fail' : 'status run'} data-testid="tile-badge">
            {tile.stateText}
          </span>
        </span>
      ) : (
        <span className="visually-hidden">, {tile.stateText}</span>
      )}
    </li>
  );
}

interface KanbanColumnProps {
  column: Column;
  /** Its panel is open (or closing). */
  open: boolean;
}

export function KanbanColumn({ column, open }: KanbanColumnProps) {
  const tilesId = useId();
  const className = [
    'kan-col',
    column.running ? 'running' : '',
    column.group === 'future' ? 'future' : '',
    open ? 'open' : '',
  ]
    .filter(Boolean)
    .join(' ');
  const title = column.title === '' ? `Phase ${column.number}` : column.title;

  return (
    <Link
      className={className}
      to={paths.board({ phase: column.number })}
      options={{ state: PANEL_ENTRY, scroll: false }}
      aria-label={column.label}
      aria-describedby={column.tiles.length > 0 ? tilesId : undefined}
      data-kan-col={column.number}
      data-group={column.group}
      data-running={column.running}
    >
      <span className="kan-head">
        <span className="num">Phase {column.number}</span>
        <span className="kan-meta">
          <span className="kan-count" data-testid="kan-count">
            {column.countText}
          </span>
          {column.warnings > 0 && (
            <span className="tag warn" data-tag="warnings">
              {plural(column.warnings, 'warning')}
            </span>
          )}
          {column.stretch && (
            <span className="tag" data-tag="stretch">
              Stretch
            </span>
          )}
        </span>
      </span>
      <span className="kan-title" title={title} data-testid="kan-title">
        {title}
      </span>
      <StatusSegments progress={column.progress} notStarted={column.notStarted} testId="phase-status-bar" />
      <ol className="kan-tiles" id={tilesId}>
        {column.tiles.map((tile) => (
          <Tile key={tile.id} tile={tile} />
        ))}
      </ol>
    </Link>
  );
}
