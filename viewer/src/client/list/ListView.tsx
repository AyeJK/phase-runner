/**
 * The list view, the viewer's one layout (design-system.md "Calmer layout"):
 * the phase sidebar on the left and the selected phase's rail filling the
 * rest. Clicking a phase row swaps the rail; nothing slides. Below 720px the
 * sidebar is hidden and the phase switcher (a bar under the top bar that
 * opens a sheet of the same rows) takes its place.
 *
 * - `/phase/N` selects phase N. At `/` the view selects the running phase,
 *   else the default phase (`impliedPhase`), and the URL stays as it is.
 * - The page scrolls as a whole; the sidebar is sticky under the top bar with
 *   a scroll of its own. A newly selected phase starts at the top.
 * - The rail's heading is a plain heading line here (not sticky), with the
 *   phase title as the page's `h1`.
 * - Warnings on files no phase owns show in the rail's parse-warnings banner
 *   on every phase page (`states/warnings.ts`).
 *
 * Test hooks: `list-view`, `phase-sidebar`, `list-main`, plus
 * {@link PhaseList}'s, {@link PhaseSwitcher}'s and the rail's.
 */
import { useEffect, useMemo } from 'react';
import type { Project } from '../../core/model.js';
import { PhaseRail } from '../rail/PhaseRail.js';
import { PhaseNotFound } from '../states/NotFound.js';
import { impliedPhase, phaseRows } from './derive.js';
import { PhaseList } from './PhaseList.js';
import { PhaseSwitcher } from './PhaseSwitcher.js';
import './list.css';

interface ListViewProps {
  project: Project;
  /** The phase named in the URL, or `null`. */
  phase: number | null;
}

export function ListView({ project, phase }: ListViewProps) {
  const rows = useMemo(() => phaseRows(project), [project]);
  const selected = phase ?? impliedPhase(project);
  const selectedPhase = selected === null ? undefined : project.phases.find((p) => p.number === selected);

  // A newly selected phase starts at the top of the page (unless a card is named).
  useEffect(() => {
    if (window.location.hash === '') window.scrollTo(0, 0);
  }, [selected]);

  return (
    <div className="list-layout" data-testid="list-view">
      {rows.length > 0 && <PhaseSwitcher rows={rows} selected={selected} />}
      <nav className="side" aria-label="Phases" data-testid="phase-sidebar">
        <PhaseList rows={rows} selected={selected} />
      </nav>
      <main className="list-main" id="main" data-testid="list-main">
        {selectedPhase ? (
          <div className="list-rail">
            <PhaseRail key={selectedPhase.number} project={project} phase={selectedPhase} headingLevel={1} />
          </div>
        ) : selected !== null ? (
          <PhaseNotFound number={selected} />
        ) : null}
      </main>
    </div>
  );
}
