/**
 * List-view derivation: a {@link Project} in, the phase list's rows and the
 * phase a bare `/` shows (design-system.md "Calmer layout"). Pure (no DOM,
 * no React).
 *
 * Each phase row carries its group (`phaseGroup`: complete, in progress or
 * not started), its task count and status bar data, and each sprint's card
 * state from the rail (`rail/derive.ts`), so a sprint reads the same in the
 * phase list and on the phase page.
 */
import type { Phase, Progress, Project } from '../../core/model.js';
import { defaultPhase, notStartedTasks, phaseLabel, type NotStarted } from '../data/status.js';
import { plural } from '../format.js';
import {
  isActiveState,
  phaseGroup,
  sprintCardState,
  type PhaseFilter,
  type PhaseGroup,
  type SprintState,
} from '../rail/derive.js';

/** One sprint of a phase row. */
export interface PhaseRowSprint {
  id: string;
  title: string;
  state: SprintState;
  /** In a gate state, or a failed gate about to be retried. */
  running: boolean;
}

/** One phase in the phase list. */
export interface PhaseRow {
  number: number;
  /** Title as written ("" when the file has none). */
  title: string;
  /** "Phase 2: Core Model": the row link's accessible name. */
  label: string;
  group: PhaseGroup;
  /** A sprint is in a gate state. */
  running: boolean;
  done: number;
  eligible: number;
  /** "18/19 tasks": done over eligible, cut and deferred left out. */
  countText: string;
  /** The phase's task counts, for its status bar. */
  progress: Progress | undefined;
  /** To-do and manual tasks in sprints that haven't started: the bar's grey "not started" part. */
  notStarted: NotStarted;
  /** Each sprint's card state, in plan order. */
  sprints: PhaseRowSprint[];
  /** What the row shows at its right end. See {@link phaseEnd}. */
  end: PhaseEnd;
}

/**
 * A phase row's end item (design-system.md "Calmer layout", Sidebar): the
 * `pass` icon when complete, the `run` icon while a sprint runs, `needs` when
 * a sprint needs you, `manual` when only manual tasks do, else the task count.
 */
export type PhaseEnd = 'pass' | 'run' | 'needs' | 'manual' | 'count';

/** The end item for a phase in `group` with these sprints. See {@link PhaseEnd}. */
export function phaseEnd(group: PhaseGroup, sprints: readonly PhaseRowSprint[]): PhaseEnd {
  if (group === 'complete') return 'pass';
  if (sprints.some((s) => s.running)) return 'run';
  if (sprints.some((s) => s.state === 'needs-you')) return 'needs';
  if (sprints.some((s) => s.state === 'manual')) return 'manual';
  return 'count';
}

/** The row for one phase. */
export function phaseRow(project: Project, phase: Phase): PhaseRow {
  const progress = project.progress.byPhase[String(phase.number)];
  const done = progress?.done ?? 0;
  const eligible = progress?.eligible ?? 0;
  const sprints = phase.sprints.map((sprint): PhaseRowSprint => {
    const state = sprintCardState(project, sprint);
    return { id: sprint.id, title: sprint.title, state, running: isActiveState(state) };
  });
  const group = phaseGroup(project, phase);
  return {
    number: phase.number,
    title: phase.title,
    label: phaseLabel(phase),
    group,
    running: sprints.some((s) => s.running),
    done,
    eligible,
    countText: `${done}/${plural(eligible, 'task')}`,
    progress,
    notStarted: notStartedTasks(project, phase),
    sprints,
    end: phaseEnd(group, sprints),
  };
}

/** Every phase's row, in phase order. */
export function phaseRows(project: Project): PhaseRow[] {
  return project.phases.map((phase) => phaseRow(project, phase));
}

/** The rows a filter shows: every row for All, else the rows in its group. */
export function filterPhaseRows(rows: readonly PhaseRow[], show: PhaseFilter): readonly PhaseRow[] {
  return show === 'all' ? rows : rows.filter((row) => row.group === show);
}

/** The first phase with a sprint in a gate state, or `null`. */
export function runningPhase(project: Project): number | null {
  const phase = project.phases.find((p) => p.sprints.some((s) => isActiveState(sprintCardState(project, s))));
  return phase?.number ?? null;
}

/**
 * The phase `/` shows (the URL names none): the running phase, else the
 * default phase (most recent run activity, else the first with work left).
 * `null` when there are no phases.
 */
export function impliedPhase(project: Project): number | null {
  return runningPhase(project) ?? defaultPhase(project);
}
