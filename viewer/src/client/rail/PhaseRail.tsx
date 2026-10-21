/**
 * The phase page (design-system.md "Calmer layout": "Phase page", "Waves and
 * sprint rows"; the open row's body is "Rail sprint cards"): one phase's
 * sprints in plan order, as rows in one list per wave.
 *
 * Top to bottom, inside a page capped at `--content` and centred:
 *
 * - The header: the eyebrow "Phase 2" (hidden below 720px, where the phase
 *   switcher already says it), the title `h1`, and the meta line: "Complete
 *   · 55 of 55 tasks · 4 waves, 69 min · No retries · Finished Oct 3, 5:14 PM".
 * - The phase's status bar, unless the phase is complete.
 * - Banners: open escalations, parse warnings for the phase file and its run
 *   log (and for any file no phase owns), then, once the run has ended with
 *   something left for you, the pink or violet run-end banner ("Run paused ·
 *   1 task needs your attention"). There's no green "Phase run complete"
 *   banner: the meta line says it.
 * - One section per rail group from `railView`: a heading line ("Wave 2 ·
 *   Running · Parallel · 12 min so far · 1 retry", or "No run log" / "Not run
 *   yet") over one bordered list of sprint rows (dashed for "Not run yet").
 *
 * Rows start collapsed except the running ones (a gate running, or a failed
 * one about to be retried; a sprint that starts running later opens as it
 * starts); `#s{id}` opens that row and scrolls to it. Opening or closing a
 * row never changes another. The page keeps that state across live updates,
 * so render it with `key={phase.number}` when the phase can change under it.
 *
 * Everything shown comes from `railView` (`derive.ts`), recomputed on every
 * stream update and once a minute while a wave is running (its "so far").
 *
 * Test hooks: `phase-rail` (with `data-phase`), `phase-meta`, `phase-status`
 * (with `data-status`), `phase-progress-text`, `rail-summary` (the waves
 * item), `rail-retries`, `phase-time`, `phase-status-bar`,
 * `section[data-rail-row]` (with `data-kind`, `data-row-state`), `wave-name`,
 * `wave-live`, `wave-mode`, `wave-duration`, `wave-retries`,
 * `escalation-banner`, `run-end` (with `data-kind`), plus those in `SprintCard.tsx`.
 */
import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Escalation, Phase, Project } from '../../core/model.js';
import { StatusIcon } from '../components/StatusIcon.js';
import { StatusSegments } from '../components/StatusSegments.js';
import { notStartedTasks, phaseLabel, phaseRuns } from '../data/status.js';
import { plural } from '../format.js';
import { ESCALATION_TEXT, escalationTitle } from '../live/derive.js';
import { paths, useRouter } from '../shell/router.js';
import { ParseWarnings } from '../states/ParseWarnings.js';
import { pageWarningFiles } from '../states/warnings.js';
import { isActiveState, railView, runEnd, type PhaseMeta, type RailRow, type RailView, type RunEnd } from './derive.js';
import { SprintCard } from './SprintCard.js';
import './rail.css';

export interface PhaseRailProps {
  project: Project;
  phase: Phase;
  /** Level of the phase title heading: 1 on its own page (default). */
  headingLevel?: 1 | 2;
}

export function PhaseRail({ project, phase, headingLevel = 1 }: PhaseRailProps) {
  // Re-derived on every update, and each minute while a wave runs.
  const [tick, setTick] = useState(0);
  const view = useMemo(() => railView(project, phase, Date.now()), [project, phase, tick]);
  const running = view.rows.some((r) => r.state === 'running');
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => setTick((t) => t + 1), 60_000);
    return () => window.clearInterval(timer);
  }, [running]);

  const open = useOpenCards(view);
  const end = runEnd(view);

  const runs = phaseRuns(project, phase.number);
  const progress = project.progress.byPhase[String(phase.number)];

  const Title = `h${headingLevel}` as const;
  const WaveHeading = `h${headingLevel + 1}` as 'h2' | 'h3';
  const cardLevel = (headingLevel + 2) as 3 | 4;

  return (
    <div className="phase-rail" data-testid="phase-rail" data-phase={phase.number}>
      <header className="page-head">
        {/* Named outright: the eyebrow and title would otherwise read "Phase 2 : Title". */}
        <Title className="page-title" aria-label={phaseLabel(phase)}>
          {phase.title !== '' ? (
            <>
              <span className="eyebrow">
                Phase {phase.number}
                <span className="visually-hidden">:</span>
              </span>{' '}
              <span className="page-name">{phase.title}</span>
            </>
          ) : (
            <span className="page-name">Phase {phase.number}</span>
          )}
        </Title>
        <MetaLine meta={view.meta} />
      </header>

      {!view.meta.complete && (
        <StatusSegments
          progress={progress}
          notStarted={notStartedTasks(project, phase)}
          testId="phase-status-bar"
        />
      )}

      <div className="page-banners">
        {(runs?.escalations ?? []).map((escalation) => (
          <EscalationBanner key={escalation.line} escalation={escalation} />
        ))}
        <ParseWarnings project={project} files={pageWarningFiles(project, phase)} />
        {end && end.kind !== 'pass' && <RunEndBanner end={end} />}
      </div>

      <div className="waves">
        {view.rows.map((row) => (
          <section
            key={row.key}
            className={`wave ${row.kind}`}
            aria-label={row.label}
            data-rail-row={row.key}
            data-kind={row.kind}
            data-row-state={row.state ?? ''}
          >
            <WaveHeading className="wave-h">
              <WaveLine row={row} />
            </WaveHeading>
            <ul className={row.kind === 'not-run' ? 'sprints dashed' : 'sprints'}>
              {row.sprints.map((sprint) => (
                <li key={sprint.id}>
                  <SprintCard
                    sprint={sprint}
                    open={open.ids.has(sprint.id)}
                    onToggle={() => open.toggle(sprint.id)}
                    dashed={row.kind === 'not-run'}
                    headingLevel={cardLevel}
                  />
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}

/** Items joined by a dot in `--border-strong`. */
function Dotted({ items }: { items: ReactNode[] }) {
  return (
    <>
      {items.map((item, i) => (
        <Fragment key={i}>
          {i > 0 && (
            <span className="sep" aria-hidden="true">
              ·
            </span>
          )}
          {item}
        </Fragment>
      ))}
    </>
  );
}

/** "Complete · 55 of 55 tasks · 4 waves, 69 min · No retries · Finished Oct 3, 5:14 PM". */
function MetaLine({ meta }: { meta: PhaseMeta }) {
  const items: ReactNode[] = [
    <span key="state" className={`meta-state ${meta.stateKind}`} data-testid="phase-status" data-status={meta.stateKind}>
      {meta.stateIcon !== null && <StatusIcon kind={meta.stateIcon} />}
      {meta.stateText}
    </span>,
    <span key="tasks" data-testid="phase-progress-text">
      {meta.tasksText}
    </span>,
    <span key="waves" data-testid="rail-summary">
      {meta.wavesText}
    </span>,
  ];
  if (meta.retriesText !== null) {
    items.push(
      <span key="retries" data-testid="rail-retries">
        {meta.retriesText}
      </span>,
    );
  }
  if (meta.timeText !== null) {
    items.push(
      <span key="time" data-testid="phase-time">
        {meta.timeText}
      </span>,
    );
  }
  return (
    <p className="meta" data-testid="phase-meta">
      <Dotted items={items} />
    </p>
  );
}

/**
 * A wave's heading line: "Wave 2 · Running · Parallel · 12 min so far · 1
 * retry". The dashed groups read "No run log" / "Not run yet" alone. No done check.
 */
function WaveLine({ row }: { row: RailRow }) {
  const name = (
    <b key="name" data-testid="wave-name">
      {row.label}
    </b>
  );
  if (row.kind !== 'wave') return <Dotted items={[name]} />;
  const items: ReactNode[] = [name];
  if (row.state === 'running') {
    items.push(
      <span key="live" className="live" data-testid="wave-live">
        <StatusIcon kind="run" />
        Running
      </span>,
    );
  }
  items.push(
    <span key="mode" className={row.parallel ? 'par' : undefined} data-testid="wave-mode">
      {row.parallel ? 'Parallel' : 'Sequential'}
    </span>,
  );
  if (row.durationText !== null) {
    items.push(
      <span key="dur" data-testid="wave-duration">
        {row.durationText}
      </span>,
    );
  }
  if (row.retries > 0) {
    items.push(
      <span key="retries" data-testid="wave-retries">
        {plural(row.retries, 'retry', 'retries')}
      </span>,
    );
  }
  return <Dotted items={items} />;
}

/** Under the meta line once the run has ended with something left for you: pink or violet. */
function RunEndBanner({ end }: { end: RunEnd }) {
  return (
    <div className={`banner rail-end ${end.kind}`} role="status" data-testid="run-end" data-kind={end.kind}>
      <StatusIcon kind={end.kind} />
      <div>
        <strong>{end.title}</strong>
        {end.attentionText !== null && <span className="rail-end-attention"> · {end.attentionText}</span>}
        {end.items.length > 0 && (
          <ul>
            {end.items.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/**
 * Which rows are open. Starts with the running ones; a row that starts
 * running later opens once, as it starts; `#s{id}` opens that row and
 * scrolls to it. Toggling changes only the row toggled.
 */
function useOpenCards(view: RailView): { ids: ReadonlySet<string>; toggle: (id: string) => void } {
  const [ids, setIds] = useState<ReadonlySet<string>>(() => new Set(runningIds(view)));
  const seen = useRef<Set<string>>(new Set(runningIds(view)));

  useEffect(() => {
    const started = runningIds(view).filter((id) => !seen.current.has(id));
    if (started.length === 0) return;
    for (const id of started) seen.current.add(id);
    setIds((prev) => new Set([...prev, ...started]));
  }, [view]);

  const { location } = useRouter();
  useEffect(() => {
    const id = sprintIdFromHash(location.hash);
    if (id === null) return;
    setIds((prev) => (prev.has(id) ? prev : new Set([...prev, id])));
    // Scroll once the row has opened (the next frame, after React commits).
    const frame = window.requestAnimationFrame(() => {
      document.getElementById(paths.sprintSection(id))?.scrollIntoView({ block: 'start' });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [location.hash]);

  const toggle = (id: string): void =>
    setIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return { ids, toggle };
}

function runningIds(view: RailView): string[] {
  return view.rows.flatMap((r) => r.sprints.filter((s) => isActiveState(s.state)).map((s) => s.id));
}

/** `#s2.3` → `2.3`; anything else → `null`. */
function sprintIdFromHash(hash: string): string | null {
  if (!hash.startsWith('#s') || hash.length < 3) return null;
  try {
    return decodeURIComponent(hash.slice(2));
  } catch {
    return null;
  }
}

/** Needs-you banner for a gate that hit its retry limit. It goes once a later event for the sprint is logged. */
function EscalationBanner({ escalation }: { escalation: Escalation }) {
  return (
    <div
      className="banner esc"
      role="alert"
      data-testid="escalation-banner"
      data-sprint={escalation.sprint}
      data-gate={escalation.gate}
    >
      <StatusIcon kind="needs" />
      <div>
        <strong>{escalationTitle(escalation)}</strong>
        <p>{ESCALATION_TEXT}</p>
      </div>
    </div>
  );
}
