/**
 * The app root: the live stream, the router and the shell (design-system.md
 * "Calmer layout").
 *
 * The shell is the top bar (project name, Phase Runner link and gear), the
 * connection-lost banner while disconnected, then the view. There is one
 * layout, the list view:
 *
 * | Route           | View |
 * |-----------------|------|
 * | `/`             | The list view on the running phase, else the default one |
 * | `/phase/:n`     | The list view on phase n |
 * | `/live`         | Redirects (replacing history) once the first snapshot arrives: `/phase/{running, else default}` |
 * | anything else   | Not found, with a link back to `/` |
 *
 * `/list`, `/?phase=N`, `/overview` and `/sprint/:id` are redirected by the
 * router (`shell/router.tsx`).
 *
 * Before any view, the workspace decides what shows under the top bar
 * (design-system.md "States"): several candidate folders show the
 * pick-a-folder state, and no `docs/phases/` (or one with no phase plans)
 * shows the empty state, whatever the route.
 *
 * The document title follows the selected phase: "Phase 2: Trip Journal ·
 * trail-log", else "Phases · trail-log".
 *
 * `data-connection` on the root carries the stream status for tests. Nothing
 * connection-related shows while connected; the lost-connection banner shows
 * only while reconnecting, above the last snapshot.
 */
import { useEffect, type ReactNode } from 'react';
import type { Project } from '../core/model.js';
import type { ViewerSnapshot } from '../shared/protocol.js';
import { baseName } from './data/applyUpdate.js';
import { phaseLabel } from './data/status.js';
import { useProjectStream } from './data/useProjectStream.js';
import { impliedPhase } from './list/derive.js';
import { ListView } from './list/ListView.js';
import { paths, readShow, RouterProvider, useRouter, type Route } from './shell/router.js';
import { ConnectionLost, Loading } from './shell/states.js';
import { TopBar } from './shell/TopBar.js';
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
  const { location, route, navigate } = useRouter();
  const project = projectWithPhases(snapshot);

  // `/live` lands on a phase once there's data to pick one with, keeping the filter.
  useEffect(() => {
    if (route.name !== 'live' || !snapshot) return;
    const phase = project ? impliedPhase(project) : null;
    const show = readShow(location.search);
    navigate(phase === null ? paths.home(show) : paths.phase(phase, show), { replace: true });
  }, [route, location.search, snapshot, project, navigate]);

  useEffect(() => {
    document.title = pageTitle(route, project);
  }, [route, project]);

  const lostSince = status === 'reconnecting' ? lastUpdateAt : null;

  return (
    <div className="app" data-connection={status}>
      <TopBar root={snapshot?.workspace.kind === 'found' ? (snapshot.project?.root ?? null) : null} />
      {lostSince !== null && (
        <div className="shell-banners">
          <ConnectionLost since={lostSince} />
        </div>
      )}
      {snapshot === null ? (
        <main className="state-main" id="main">
          <Loading />
        </main>
      ) : (
        <Main snapshot={snapshot} route={route} />
      )}
    </div>
  );
}

/** Under the top bar once a snapshot is here: a workspace state, or the route's view. */
function Main({ snapshot, route }: { snapshot: ViewerSnapshot; route: Route }) {
  const { workspace } = snapshot;
  const project = projectWithPhases(snapshot);
  if (workspace.kind === 'candidates') return <StateMain><Candidates candidates={workspace.candidates} /></StateMain>;
  if (workspace.kind === 'none') return <StateMain><NoPhasePlans searched={workspace.searched} /></StateMain>;
  if (!project) {
    const phasesDir = snapshot.project?.phasesDir ?? `${workspace.root}/docs/phases`;
    return <StateMain><NoPhasePlans phasesDir={phasesDir} /></StateMain>;
  }
  switch (route.name) {
    case 'phase':
      return <ListView project={project} phase={route.phase} />;
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

/** "Phase 2: Trip Journal · trail-log" for the selected phase, else "Phases · trail-log". */
function pageTitle(route: Route, project: Project | null): string {
  if (!project) return 'phase-viewer';
  const name = baseName(project.root);
  if (route.name === 'unknown') return name;
  const n = route.name === 'phase' ? (route.phase ?? impliedPhase(project)) : null;
  if (n === null) return `Phases · ${name}`;
  const phase = project.phases.find((p) => p.number === n);
  return `${phase ? phaseLabel(phase) : `Phase ${n}`} · ${name}`;
}
