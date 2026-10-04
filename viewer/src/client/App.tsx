/**
 * The app root: the live stream, the router and the unified shell
 * (design-system.md "Unified interface").
 *
 * The shell is the 56px top bar (wordmark and settings gear), the filter row under it,
 * the connection-lost banner while disconnected, then the view:
 *
 * | Route           | View |
 * |-----------------|------|
 * | `/`             | The phase kanban; `?phase=N` opens phase N's slide-in panel over it |
 * | `/list`         | The list view; `?phase=N` selects phase N |
 * | `/live`         | Redirects (replacing history) once the first snapshot arrives: `/?phase={N, else the running phase, else the default one}` |
 * | anything else   | Not found, with a link back to the phases |
 *
 * `/overview`, `/phase/:n` and `/sprint/:id` are redirected by the router
 * (`shell/router.tsx`), and a bare `/` on first load opens the last layout
 * used (the list view when none is remembered).
 *
 * Before any view, the workspace decides what shows under the filter row
 * (design-system.md "States"): several candidate folders show the
 * pick-a-folder state, and no `docs/phases/` (or one with no phase plans)
 * shows the empty state, whatever the route.
 *
 * While the slide-in panel is open, the top bar, filter row and board are
 * `inert`, so focus stays in the panel.
 *
 * The document title follows the open or selected phase: "Phase 2: Trip
 * Journal · trail-log", else "Phases · trail-log".
 *
 * `data-connection` on the root carries the stream status for tests. Nothing
 * connection-related shows while connected; the lost-connection banner shows
 * only while reconnecting, above the last snapshot.
 */
import { useEffect, type ReactNode } from 'react';
import type { Project } from '../core/model.js';
import type { ViewerSnapshot } from '../shared/protocol.js';
import { Board } from './board/Board.js';
import { impliedPhase } from './board/derive.js';
import { baseName } from './data/applyUpdate.js';
import { phaseLabel } from './data/status.js';
import { useProjectStream } from './data/useProjectStream.js';
import { ListView } from './list/ListView.js';
import { FilterRow } from './shell/FilterRow.js';
import { paths, RouterProvider, useRouter, type Route } from './shell/router.js';
import { ConnectionLost, Loading } from './shell/states.js';
import { TopBar } from './shell/TopBar.js';
import { rememberView } from './shell/viewPref.js';
import { Candidates } from './states/Candidates.js';
import { NoPhasePlans } from './states/NoPhasePlans.js';
import { PageNotFound } from './states/NotFound.js';

export function App() {
  return (
    <RouterProvider>
      <Viewer />
    </RouterProvider>
  );
}

/** The project when the workspace has one with phase plans, else `null`. */
function projectWithPhases(snapshot: ViewerSnapshot | null): Project | null {
  const project = snapshot?.workspace.kind === 'found' ? snapshot.project : null;
  return project && project.phases.length > 0 ? project : null;
}

function Viewer() {
  const { status, snapshot, lastUpdateAt } = useProjectStream();
  const { route, navigate } = useRouter();
  const project = projectWithPhases(snapshot);

  // `/live` lands on a phase once there's data to pick one with.
  useEffect(() => {
    if (route.name !== 'live' || !snapshot) return;
    const phase = route.phase ?? (project ? impliedPhase(project) : null);
    navigate(paths.board({ phase }), { replace: true });
  }, [route, snapshot, project, navigate]);

  // The last layout used is what a bare `/` opens next time.
  useEffect(() => {
    if (route.name === 'board') rememberView('kanban');
    else if (route.name === 'list') rememberView('list');
  }, [route.name]);

  useEffect(() => {
    document.title = pageTitle(route, project);
  }, [route, project]);

  const lostSince = status === 'reconnecting' ? lastUpdateAt : null;
  const banner = lostSince !== null ? <ConnectionLost since={lostSince} /> : null;
  // The panel is a modal: everything behind it is inert.
  const modal = project !== null && route.name === 'board' && route.phase !== null;

  return (
    <div className="app" data-connection={status}>
      <TopBar inert={modal} />
      <FilterRow project={project} inert={modal} />
      {banner && (
        <div className="shell-banners" inert={modal}>
          {banner}
        </div>
      )}
      {snapshot === null ? (
        <main className="state-main" id="main">
          <Loading />
        </main>
      ) : (
        <Main snapshot={snapshot} route={route} banner={banner} />
      )}
    </div>
  );
}

/** Below the filter row once a snapshot is here: a workspace state, or the route's view. */
function Main({ snapshot, route, banner }: { snapshot: ViewerSnapshot; route: Route; banner: ReactNode }) {
  const { workspace } = snapshot;
  const project = projectWithPhases(snapshot);
  if (workspace.kind === 'candidates') return <StateMain><Candidates candidates={workspace.candidates} /></StateMain>;
  if (workspace.kind === 'none') return <StateMain><NoPhasePlans searched={workspace.searched} /></StateMain>;
  if (!project) {
    const phasesDir = snapshot.project?.phasesDir ?? `${workspace.root}/docs/phases`;
    return <StateMain><NoPhasePlans phasesDir={phasesDir} /></StateMain>;
  }
  switch (route.name) {
    case 'board':
      return <Board project={project} phase={route.phase} banner={banner} />;
    case 'list':
      return <ListView project={project} phase={route.phase} show={route.show} />;
    case 'live':
      return null; // Redirecting.
    case 'unknown':
      return <StateMain><PageNotFound /></StateMain>;
  }
}

function StateMain({ children }: { children: ReactNode }) {
  return (
    <main className="state-main" id="main">
      {children}
    </main>
  );
}

/** "Phase 2: Trip Journal · trail-log" for the open or selected phase, else "Phases · trail-log". */
function pageTitle(route: Route, project: Project | null): string {
  if (!project) return 'phase-viewer';
  const name = baseName(project.root);
  let n: number | null = null;
  if (route.name === 'board') n = route.phase;
  else if (route.name === 'list') n = route.phase ?? impliedPhase(project);
  else if (route.name === 'unknown') return name;
  if (n === null) return `Phases · ${name}`;
  const phase = project.phases.find((p) => p.number === n);
  return `${phase ? phaseLabel(phase) : `Phase ${n}`} · ${name}`;
}
