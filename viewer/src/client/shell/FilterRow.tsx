/**
 * The filter row (design-system.md "Filter row"): 48px, sticky under the top
 * bar, in both layouts.
 *
 * - Filters (list view only), left to right: All, In progress, Complete,
 *   Not started. Each is a toggle button (`aria-pressed`) with its phase
 *   count from `phaseGroupCounts`; a filter with 0 stays selectable. The
 *   filter lives in the URL (`?show=progress`) and changing it replaces the
 *   history entry. The kanban has none: its lanes are the groups.
 * - The List | Kanban toggle at the right switches between `/list` and `/`,
 *   keeping the phase named in the URL, and remembers the layout
 *   (`viewPref.ts`). The filter doesn't follow to the kanban.
 *
 * Counts show once there's a project to count.
 *
 * Test hooks: `filter-row`, `button[data-filter]` (with `aria-pressed`),
 * `filter-count`, `view-toggle`.
 */
import { useMemo } from 'react';
import type { Project } from '../../core/model.js';
import { PHASE_FILTERS, phaseGroupCounts, type PhaseFilter } from '../rail/derive.js';
import { paths, useRouter } from './router.js';
import { rememberView, type ViewKind } from './viewPref.js';
import './shell.css';

export function FilterRow({ project, inert = false }: { project: Project | null; inert?: boolean }) {
  const { route, navigate } = useRouter();
  const view: ViewKind = route.name === 'list' ? 'list' : 'kanban';
  const show: PhaseFilter = route.name === 'list' ? route.show : 'all';
  const phase = route.name === 'board' || route.name === 'list' ? route.phase : null;
  const counts = useMemo(() => (project ? phaseGroupCounts(project) : null), [project]);

  const setFilter = (filter: PhaseFilter): void => {
    navigate(paths.list({ phase, show: filter }), { replace: true, scroll: false });
  };

  const setView = (next: ViewKind): void => {
    rememberView(next);
    if (next !== view) navigate(next === 'list' ? paths.list({ phase, show }) : paths.board({ phase }));
  };

  return (
    <div className="filter-row" data-testid="filter-row" inert={inert}>
      {view === 'list' && (
        <nav className="filters" aria-label="Filter phases">
          {PHASE_FILTERS.map((filter) => (
            <button
              key={filter.key}
              type="button"
              className="filter"
              aria-pressed={show === filter.key}
              onClick={() => setFilter(filter.key)}
              data-filter={filter.key}
            >
              <span className="filter-label">{filter.label}</span>
              {counts && (
                <span className="filter-count" data-testid="filter-count">
                  {counts[filter.key]}
                </span>
              )}
            </button>
          ))}
        </nav>
      )}
      <div className="view-toggle" role="group" aria-label="Layout" data-testid="view-toggle">
        <button type="button" aria-pressed={view === 'list'} onClick={() => setView('list')}>
          List
        </button>
        <button type="button" aria-pressed={view === 'kanban'} onClick={() => setView('kanban')}>
          Kanban
        </button>
      </div>
    </div>
  );
}
