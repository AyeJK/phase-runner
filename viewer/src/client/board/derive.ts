/**
 * Kanban and list-view derivation: a {@link Project} in, what the phase
 * kanban's lanes and phase cards and the list view's phase rows draw out
 * (design-system.md "Phase kanban", "List view"). Pure (no DOM, no React).
 *
 * The kanban has three lanes, left to right: Not started, In progress,
 * Complete. A phase is a card ({@link KanbanColumn}) in the lane of its
 * `phaseGroup`; the list view's filters use the same groups.
 *
 * Tile states are the rail's sprint card states (`rail/derive.ts`), so a
 * sprint reads the same on the board and in its panel.
 *
 * | Card treatment | When |
 * |----------------|------|
 * | Running | A sprint is in a gate state (Implementing, Verifying, Wave testing, Doc syncing, or a retry of one) or a failed one about to be retried (Verify failed, Wave test failed) |
 * | Not started (dashed) | `phaseGroup` is `future` |
 * | Default | Otherwise. Pink (or manual violet) is never a whole card, only a Needs you tile |
 */
import type { Phase, Progress, Project } from '../../core/model.js';
import { defaultPhase, notStartedTasks, phaseLabel, phaseRuns, type NotStarted } from '../data/status.js';
import { plural } from '../format.js';
import { phaseWarnings } from '../states/warnings.js';
import {
  isActiveState,
  PHASE_GROUP_LABEL,
  phaseGroup,
  sprintCardState,
  SPRINT_STATE_TEXT,
  type PhaseFilter,
  type PhaseGroup,
  type SprintState,
} from '../rail/derive.js';

/** A stretch phase keeps "(Stretch)" in its title as written in the file. */
export function isStretch(phase: Pick<Phase, 'title'>): boolean {
  return /\(stretch\)/i.test(phase.title);
}

/** One sprint tile on a phase card. */
export interface KanbanTile {
  id: string;
  title: string;
  state: SprintState;
  /** "Implementing", "Complete", … (sentence case). */
  stateText: string;
  /** In a gate state, or a failed gate about to be retried: a visible state badge (and the running or failed border). */
  running: boolean;
}

/** One phase: a card in a kanban lane, and a row of the list view's phase list. */
export interface KanbanColumn {
  number: number;
  /** Title as written ("" when the file has none). */
  title: string;
  /** "Phase 2: Core Model": the card link's accessible name. */
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
  /** Parse warnings on the phase file and its run log. */
  warnings: number;
  stretch: boolean;
  tiles: KanbanTile[];
}

/** A card for one phase. */
export function kanbanColumn(project: Project, phase: Phase): KanbanColumn {
  const progress = project.progress.byPhase[String(phase.number)];
  const done = progress?.done ?? 0;
  const eligible = progress?.eligible ?? 0;
  const tiles = phase.sprints.map((sprint): KanbanTile => {
    const state = sprintCardState(project, sprint);
    return { id: sprint.id, title: sprint.title, state, stateText: SPRINT_STATE_TEXT[state], running: isActiveState(state) };
  });
  return {
    number: phase.number,
    title: phase.title,
    label: phaseLabel(phase),
    group: phaseGroup(project, phase),
    running: tiles.some((t) => t.running),
    done,
    eligible,
    countText: `${done}/${plural(eligible, 'task')}`,
    progress,
    notStarted: notStartedTasks(project, phase),
    warnings: phaseWarnings(project.warnings, phase.file, phaseRuns(project, phase.number)?.file ?? null),
    stretch: isStretch(phase),
    tiles,
  };
}

/** Every phase's card, in phase order. */
export function kanbanColumns(project: Project): KanbanColumn[] {
  return project.phases.map((phase) => kanbanColumn(project, phase));
}

/** One lane of the kanban: the phases in one group. */
export interface KanbanLane {
  group: PhaseGroup;
  /** "Not started", "In progress" or "Complete". */
  label: string;
  /** Its phases' cards, in phase order. */
  columns: KanbanColumn[];
}

/** Lanes left to right, the way a board reads: to do, doing, done. */
const LANE_ORDER: readonly PhaseGroup[] = ['future', 'progress', 'complete'];

/** The kanban's three lanes. A lane with no phases stays, empty. */
export function kanbanLanes(project: Project): KanbanLane[] {
  const columns = kanbanColumns(project);
  return LANE_ORDER.map((group) => ({
    group,
    label: PHASE_GROUP_LABEL[group],
    columns: columns.filter((c) => c.group === group),
  }));
}

/** Whether a phase in `group` shows under `filter` (the list view). */
export function matchesFilter(group: PhaseGroup, filter: PhaseFilter): boolean {
  return filter === 'all' || filter === group;
}

/** The one line an empty filter shows in place of the phase list. */
export const EMPTY_FILTER_TEXT: Record<PhaseGroup, string> = {
  progress: 'No phases in progress',
  complete: 'No complete phases',
  future: 'No phases not started',
};

/** The first phase with a sprint in a gate state, or `null`. */
export function runningPhase(project: Project): number | null {
  const phase = project.phases.find((p) => p.sprints.some((s) => isActiveState(sprintCardState(project, s))));
  return phase?.number ?? null;
}

/**
 * The phase a view shows when the URL doesn't name one: the running phase,
 * else the default phase (most recent run activity, else the first with
 * work left). `null` when there are no phases.
 */
export function impliedPhase(project: Project): number | null {
  return runningPhase(project) ?? defaultPhase(project);
}
