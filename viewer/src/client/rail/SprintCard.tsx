/**
 * One sprint card on the phase rail (design-system.md "Rail sprint cards",
 * "Sprint card states", "Run notes"). Everything shown comes from
 * `derive.ts`'s {@link RailSprint}; this file only draws it.
 *
 * - Collapsed: a toggle row ("Sprint 2.1", the title, the state badge and a
 *   chevron), then the sprint's status bar (left out once it's Complete; the
 *   badge says it all). While the sprint is implemented the bar fills in the
 *   running colour, a task at a time, from the implementer's `task` lines. A
 *   card that turns Complete while on screen keeps its all-green bar for
 *   {@link COMPLETE_BAR_MS} first.
 * - Open: the goal, the tasks table (shared `TasksTable`, not-started rows in
 *   amber once the sprint has begun, and rows following the implementer's
 *   `task` lines as Running then Built until doc sync), the failure being retried (while there
 *   is one), then collapsed rows: Acceptance criteria (count), Dependencies
 *   (as text), Verification (count) and Run notes (count; left out when the
 *   sprint has none). Every attempt note stays in Run notes.
 *
 * The card's open state belongs to the rail (`PhaseRail.tsx`); the rows are
 * native `<details>`, closed by default, and keep their own state across
 * live updates.
 *
 * Test hooks: `article[data-sprint-card]` (with `data-state`, `data-open`),
 * `card-toggle`, `card-state` (with `data-state`), `card-status-bar`,
 * `card-body`, `card-failure` (with `data-gate`, `data-attempt`),
 * `card-failure-next`, `details[data-row]` (`criteria`, `dependencies`,
 * `verification`, `run-notes`) and `run-note` (with `data-kind`, `data-gate`,
 * `data-attempt`, `data-resolved`).
 */
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { Sprint, VerificationConfig } from '../../core/model.js';
import { StatusIcon, type IconKind } from '../components/StatusIcon.js';
import { StatusSegments } from '../components/StatusSegments.js';
import { paths } from '../shell/router.js';
import { Inline } from '../sprint/markdown.js';
import { CriteriaList, TasksTable } from '../sprint/parts.js';
import { doneOfEligible, liveTaskCounts, liveTaskStates } from '../sprint/status.js';
import { isFailedState, isGateState, type CurrentFailure, type RailSprint, type RunNote, type SprintState } from './derive.js';

/** Badge class (`.status.{kind}`) per state; `not-started` is a plain tag instead. */
function badgeKind(state: SprintState): 'run' | 'fail' | 'pass' | 'needs' | 'manual' | 'remaining' {
  if (isGateState(state)) return 'run';
  if (isFailedState(state)) return 'fail';
  if (state === 'complete') return 'pass';
  if (state === 'needs-you') return 'needs';
  if (state === 'manual') return 'manual';
  return 'remaining';
}

/** Card class per state: the border and tint the design gives each. */
function cardClass(state: SprintState, dashed: boolean): string {
  if (dashed) return 'rail-card dashed';
  if (isGateState(state)) return 'rail-card run';
  if (isFailedState(state)) return 'rail-card fail';
  if (state === 'needs-you') return 'rail-card needs';
  if (state === 'manual') return 'rail-card manual';
  if (state === 'waiting') return 'rail-card remaining';
  return 'rail-card';
}

export interface SprintCardProps {
  sprint: RailSprint;
  open: boolean;
  onToggle: () => void;
  /** In the "Not run yet" group: dashed and transparent. */
  dashed: boolean;
  /** Heading level of the card title (one below the rail's "Sprints" heading). */
  headingLevel: 2 | 3 | 4;
}

export function SprintCard({ sprint, open, onToggle, dashed, headingLevel }: SprintCardProps) {
  const bodyId = `sb${sprint.id}`;
  const title = sprint.title === '' ? 'Untitled' : sprint.title;
  const Heading = `h${headingLevel}` as const;
  const justCompleted = useJustCompleted(sprint.state);
  return (
    <article
      className={cardClass(sprint.state, dashed)}
      id={paths.sprintSection(sprint.id)}
      data-sprint-card={sprint.id}
      data-state={sprint.state}
      data-open={open ? 'true' : 'false'}
    >
      <Heading className="card-h">
        <button
          type="button"
          className="card-toggle"
          aria-expanded={open}
          aria-controls={bodyId}
          data-testid="card-toggle"
          onClick={onToggle}
        >
          <span className="sid">Sprint {sprint.id}</span>
          <span className="sname">{title}</span>
          <span className="card-end">
            <StateBadge state={sprint.state} text={sprint.stateText} />
            <ChevronIcon className="card-chev" />
          </span>
        </button>
      </Heading>
      {(sprint.state !== 'complete' || justCompleted) && (
        <StatusSegments
          progress={sprint.progress}
          live={liveTaskCounts(sprint.sprint.tasks, liveTaskStates(sprint.run))}
          testId="card-status-bar"
        />
      )}

      <div className="card-body" id={bodyId} hidden={!open} data-testid="card-body">
        {open && <CardBody sprint={sprint} />}
      </div>
    </article>
  );
}

/** How long a card that just turned Complete keeps its (now all green) status bar. */
export const COMPLETE_BAR_MS = 1_500;

/**
 * True for {@link COMPLETE_BAR_MS} after the card's state changes to
 * `complete` while it's on screen, so the bar is seen full and green before
 * it goes. A card that loads already complete never shows it. Set in a layout
 * effect, so the bar doesn't blink out for a frame first.
 */
function useJustCompleted(state: SprintState): boolean {
  const [just, setJust] = useState(false);
  const previous = useRef(state);
  useLayoutEffect(() => {
    const was = previous.current;
    previous.current = state;
    if (state !== 'complete' || was === 'complete') return;
    setJust(true);
    const timer = window.setTimeout(() => setJust(false), COMPLETE_BAR_MS);
    return () => {
      window.clearTimeout(timer);
      setJust(false);
    };
  }, [state]);
  return just;
}

/**
 * The open card's contents. Rendered only while open, so a closed card costs
 * nothing; the collapsed rows start closed each time the card opens.
 */
function CardBody({ sprint }: { sprint: RailSprint }) {
  const s = sprint.sprint;
  return (
    <>
      {sprint.goal !== null && sprint.goal !== '' && (
        <p className="card-desc" data-testid="card-goal">
          <Inline text={sprint.goal} />
        </p>
      )}
      <div className="card-sub">
        <span className="label">Tasks</span>
        <span>{doneOfEligible(sprint.progress)}</span>
      </div>
      <TasksTable tasks={s.tasks} live={liveTaskStates(sprint.run)} />
      {sprint.failure !== null && <FailureRow failure={sprint.failure} />}

      <div className="card-rows">
        <CardRow name="criteria" label="Acceptance criteria" end={countText(s.acceptanceCriteria.length)}>
          <CriteriaList criteria={s.acceptanceCriteria} />
        </CardRow>
        <CardRow name="dependencies" label="Dependencies" end={dependencyText(s)} textEnd>
          <DependencyList sprint={s} />
        </CardRow>
        <CardRow name="verification" label="Verification" end={countText(verificationRows(s.verification).length)}>
          <VerificationList verification={s.verification} />
        </CardRow>
        {sprint.runNotes.length > 0 && (
          <CardRow name="run-notes" label="Run notes" end={String(sprint.runNotes.length)}>
            {sprint.runNotes.map((note) => (
              <RunNoteView key={note.line} note={note} />
            ))}
          </CardRow>
        )}
      </div>
    </>
  );
}

/** A card's state badge: `.status` with an icon, or the plain tag for Not started. */
export function StateBadge({ state, text }: { state: SprintState; text: string }) {
  if (state === 'not-started') {
    return (
      <span className="tag" data-testid="card-state" data-state={state}>
        {text}
      </span>
    );
  }
  const kind = badgeKind(state);
  // A failed gate is still working (its retry is next): the spinner, in red.
  const icon: IconKind = kind === 'remaining' ? 'wait' : kind === 'fail' ? 'run' : kind;
  return (
    <span className={`status ${kind}`} data-testid="card-state" data-state={state}>
      <StatusIcon kind={icon} />
      {text}
    </span>
  );
}

/** A down chevron; closed rows and cards rotate it to point right. */
export function ChevronIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/**
 * One collapsed row at the foot of an open card (native `<details>`, closed
 * by default): chevron, label, and the count or text at the right.
 */
function CardRow({
  name,
  label,
  end,
  textEnd = false,
  children,
}: {
  name: string;
  label: string;
  end: string;
  textEnd?: boolean;
  children: ReactNode;
}) {
  return (
    <details className={name === 'run-notes' ? 'card-row run-notes' : 'card-row'} data-row={name}>
      <summary>
        <ChevronIcon />
        <span className="card-row-label">{label}</span>
        <span className={textEnd ? 'card-row-end text' : 'card-row-end'} data-testid="card-row-end">
          {end}
        </span>
      </summary>
      <div className="card-row-body">{children}</div>
    </details>
  );
}

function countText(n: number): string {
  return n === 0 ? 'None' : String(n);
}

function dependencyBullets(sprint: Sprint) {
  return sprint.dependencies.filter((d) => !d.none);
}

/**
 * Dependencies as one short line for the row: each bullet without its
 * trailing "(reason)" or inline-code backticks, joined ("Phase 1, Sprint
 * 1.2"), or "None".
 */
export function dependencyText(sprint: Sprint): string {
  const bullets = dependencyBullets(sprint);
  if (bullets.length === 0) return 'None';
  return bullets
    .map((d) => d.raw.replace(/\s*\([^)]*\)\s*$/, '').replace(/`/g, '').trim())
    .filter((t) => t !== '')
    .join(', ');
}

/** Dependency bullets as written, or "None". */
function DependencyList({ sprint }: { sprint: Sprint }) {
  const bullets = dependencyBullets(sprint);
  if (bullets.length === 0) {
    return (
      <ul className="plain">
        <li>None</li>
      </ul>
    );
  }
  return (
    <ul className="plain">
      {bullets.map((d) => (
        <li key={d.line}>
          <Inline text={d.raw} />
        </li>
      ))}
    </ul>
  );
}

/** The Verification block as key and value pairs, in the phase-builder key order. */
function verificationRows(v: VerificationConfig): [string, string][] {
  const rows: [string, string][] = [];
  if (v.cli !== undefined) rows.push(['cli', v.cli]);
  if (v.skipUi !== undefined) rows.push(['skip-ui', String(v.skipUi)]);
  if (v.ui.length > 0) rows.push(['ui', v.ui.join(', ')]);
  if (v.skills.length > 0) rows.push(['skills', v.skills.join(', ')]);
  if (v.viewports.length > 0) rows.push(['viewports', v.viewports.join(', ')]);
  for (const a of v.assert) rows.push(['assert', a]);
  for (const [key, value] of Object.entries(v.extra)) rows.push([key, value]);
  return rows;
}

/** The Verification block as key and value rows. */
function VerificationList({ verification }: { verification: VerificationConfig }) {
  const rows = verificationRows(verification);
  if (rows.length === 0) return <p className="none">None</p>;
  return (
    <ul className="rail-kv">
      {rows.map(([key, value], i) => (
        <li key={i}>
          <span className="k">{key}</span>
          <span>
            <Inline text={value} />
          </span>
        </li>
      ))}
    </ul>
  );
}

/**
 * The failure being retried, under the tasks table: what failed and why (red),
 * then where the retry has got to (amber).
 */
function FailureRow({ failure }: { failure: CurrentFailure }) {
  const { note } = failure;
  return (
    <div className="card-failure" data-testid="card-failure" data-gate={note.gate} data-attempt={note.attempt}>
      <p className="card-failure-why">
        <b>
          {note.title}
          {note.summary !== '' && '.'}
        </b>{' '}
        {note.summary}
        {note.time !== '' && <span className="when"> · {note.time}</span>}
      </p>
      {failure.statusText !== '' && (
        <p className="card-failure-next" data-testid="card-failure-next">
          {failure.statusText}
        </p>
      )}
    </div>
  );
}

/** One Run notes entry: a failed attempt (red rule) or a pass with notes (grey rule). */
function RunNoteView({ note }: { note: RunNote }) {
  const failed = note.kind === 'failed';
  return (
    <div
      className={failed ? 'run-note failed' : 'run-note notes'}
      data-testid="run-note"
      data-kind={note.kind}
      data-gate={note.gate}
      data-attempt={note.attempt}
      data-resolved={note.resolution !== null ? 'true' : 'false'}
    >
      <StatusIcon kind={failed ? 'fail' : 'pass'} />
      <b>
        {note.title} {note.time !== '' && <span className="when">· {note.time}</span>}
      </b>
      {note.summary !== '' && <code>{note.summary}</code>}
      {note.resolutionText !== null && <span className="then">{note.resolutionText}</span>}
    </div>
  );
}
