/**
 * Live task progress in the tasks table (`src/client/sprint/status.ts`,
 * design-system.md "Tasks table"): a row whose phase-file status is `—`
 * reads Running after its `task` `start` line and Built after its `pass`
 * line, until the sprint's doc sync is logged. The sprint card's status bar
 * counts the same rows (`liveTaskCounts`). Nothing else reads the `task`
 * lines: task counts, the progress behind every bar, card states, the kanban
 * tile, the phase badge, wave retries and durations stay as they are without
 * them.
 */
import { describe, expect, it } from 'vitest';
import { deriveProgress } from '../../src/core/derive/progress.js';
import { deriveRun } from '../../src/core/derive/run.js';
import { sprintTaskNumbers, uiSprintIds } from '../../src/core/load.js';
import type { Phase, PhaseRuns, Project, Sprint } from '../../src/core/model.js';
import { parsePhaseFile } from '../../src/core/parser/phase.js';
import { readRunLog } from '../../src/core/runlog/read.js';
import { kanbanColumn } from '../../src/client/board/derive.js';
import { currentSprintRun, phaseRuns } from '../../src/client/data/status.js';
import { railView, type RailSprint, type RailView } from '../../src/client/rail/derive.js';
import { liveTaskCounts, liveTaskStates, phaseBadge, taskRow } from '../../src/client/sprint/status.js';

// ---------------------------------------------------------------------------
// An in-memory project
// ---------------------------------------------------------------------------

/** One task per status character (`x` done, `-` todo, `~` active, `B` blocked, `M` manual, `C` cut). */
function phaseMd(n: number, sprints: Array<[id: string, statuses: string]>): string {
  const status = (c: string): string => ({ x: 'x', '-': '—', '~': '~', B: 'BLOCKED', M: 'MANUAL', C: 'CUT' })[c] ?? c;
  const blocks = sprints.map(([id, statuses]) =>
    [
      `# Sprint ${id} — Sprint ${id} title`,
      '',
      '### Tasks',
      '',
      '| Status | # | Task | Module |',
      '|--------|---|------|--------|',
      ...[...statuses].map((c, i) => `| ${status(c)} | ${i + 1} | Task ${i + 1} | src/s${id}.ts |`),
      '',
      '### Verification',
      '',
      '- cli: npm run check',
      '- skip-ui: true',
      '',
      '---',
      '',
    ].join('\n'),
  );
  return [`# Phase ${n} — Phase ${n} title`, '', 'Intro.', '', '---', '', ...blocks].join('\n');
}

/** `[minute, wave, sprint, gate, result, attempt, summary?]`: one log line, `minute` minutes after 10:00 UTC. */
type LineSpec = [number, number, string, string, string, number, string?];

function jsonl(lines: LineSpec[]): string {
  return lines
    .map(([min, wave, sprint, gate, result, attempt, summary]) => {
      const ts = new Date(Date.UTC(2026, 8, 28, 10, min, 0)).toISOString().replace('.000Z', 'Z');
      const max = gate === 'doc_sync' ? 1 : 3;
      return `${JSON.stringify({ v: 1, ts, phase: Number(sprint.split('.')[0]), wave, sprint, gate, result, attempt, max, summary: summary ?? '' })}\n`;
    })
    .join('');
}

/** A `task` line: `[minute, wave, sprint, 'start' | 'pass', task number, attempt?]`. */
function task(min: number, wave: number, sprint: string, result: 'start' | 'pass', n: number, attempt = 1): LineSpec {
  return [min, wave, sprint, 'task', result, attempt, String(n)];
}

/** A {@link Project} built the way `loadProject` builds one, without touching the disk. */
function makeProject(n: number, sprints: Array<[string, string]>, lines: LineSpec[]): Project {
  const phases: Phase[] = [parsePhaseFile(phaseMd(n, sprints), `/p/docs/phases/Phase-${n}-X.md`).phase];
  const file = `/p/docs/phases/.runs/phase-${n}.jsonl`;
  const read = readRunLog(jsonl(lines), file);
  const derived = deriveRun(read.events, { uiSprints: uiSprintIds(phases), sprintTasks: sprintTaskNumbers(phases) });
  const runs: PhaseRuns[] = [{ phase: n, file, events: read.events, ...derived }];
  return {
    root: '/p',
    phasesDir: '/p/docs/phases',
    phases,
    runs,
    hasDesignSystem: false,
    progress: deriveProgress(phases),
    warnings: read.warnings,
  };
}

function sprintOf(project: Project, id: string): Sprint {
  return project.phases.flatMap((p) => p.sprints).find((s) => s.id === id)!;
}

/** The status word of every row of a sprint's tasks table, as the open card shows them. */
function words(project: Project, id: string): string[] {
  const sprint = sprintOf(project, id);
  const live = liveTaskStates(currentSprintRun(phaseRuns(project, sprint.phase), id));
  return sprint.tasks.map((t) => taskRow(t, live).words);
}

function rail(project: Project, now?: number): RailView {
  return railView(project, project.phases[0]!, now);
}

function card(v: RailView, id: string): RailSprint {
  return v.rows.flatMap((r) => r.sprints).find((s) => s.id === id)!;
}

/**
 * Everything outside the tasks table that a `task` line must not move. Run
 * notes are compared without their `line` (a React key): taking the `task`
 * lines out of a log renumbers the lines after them.
 */
function outside(project: Project): unknown {
  const phase = project.phases[0]!;
  const v = rail(project, Date.UTC(2026, 8, 28, 11, 0, 0));
  const unkeyed = <T extends { line: number }>(note: T): Omit<T, 'line'> => {
    const { line: _line, ...rest } = note;
    return rest;
  };
  return {
    progress: project.progress,
    badge: phaseBadge(project, phase),
    tiles: kanbanColumn(project, phase).tiles.map((t) => [t.id, t.state]),
    summary: v.summaryText,
    rows: v.rows.map((r) => ({
      key: r.key,
      state: r.state,
      startedAt: r.startedAt,
      endedAt: r.endedAt,
      retries: r.retries,
      durationText: r.durationText,
      metaText: r.metaText,
      parallel: r.parallel,
      cards: r.sprints.map((s) => ({
        id: s.id,
        state: s.state,
        progress: s.progress,
        notes: s.runNotes.map(unkeyed),
        failure: s.failure && { statusText: s.failure.statusText, note: unkeyed(s.failure.note) },
      })),
    })),
  };
}

// ---------------------------------------------------------------------------
// One sprint, start to doc sync
// ---------------------------------------------------------------------------

describe('a row follows its task lines', () => {
  const todo: Array<[string, string]> = [['9.1', '---']];
  const implementing: LineSpec[] = [[0, 1, '9.1', 'implement', 'start', 1]];

  it('reads Not started until its start line, then Running, then Built', () => {
    expect(words(makeProject(9, todo, implementing), '9.1')).toEqual(['Not started', 'Not started', 'Not started']);

    const one = [...implementing, task(1, 1, '9.1', 'start', 1)];
    expect(words(makeProject(9, todo, one), '9.1')).toEqual(['Running', 'Not started', 'Not started']);

    const two = [...one, task(3, 1, '9.1', 'pass', 1), task(3, 1, '9.1', 'start', 2)];
    expect(words(makeProject(9, todo, two), '9.1')).toEqual(['Built', 'Running', 'Not started']);

    const three = [...two, task(5, 1, '9.1', 'pass', 2), task(5, 1, '9.1', 'start', 3), task(8, 1, '9.1', 'pass', 3)];
    expect(words(makeProject(9, todo, three), '9.1')).toEqual(['Built', 'Built', 'Built']);
  });

  it('gives Running the run icon and Built its own icon, apart from Complete', () => {
    const project = makeProject(9, [['9.1', '--x']], [...implementing, task(1, 1, '9.1', 'pass', 1), task(1, 1, '9.1', 'start', 2)]);
    const sprint = sprintOf(project, '9.1');
    const live = liveTaskStates(currentSprintRun(phaseRuns(project, 9), '9.1'));
    expect(sprint.tasks.map((t) => taskRow(t, live))).toEqual([
      { icon: 'built', words: 'Built', live: 'built' },
      { icon: 'run', words: 'Running', live: 'running' },
      { icon: 'pass', words: 'Complete', live: null },
    ]);
    // Without the overlay every row is its phase-file status.
    expect(sprint.tasks.map((t) => taskRow(t))).toEqual([
      { icon: 'wait', words: 'Not started', live: null },
      { icon: 'wait', words: 'Not started', live: null },
      { icon: 'pass', words: 'Complete', live: null },
    ]);
  });

  it('stays Built through verify, then shows the phase file once doc sync is logged', () => {
    const built: LineSpec[] = [
      ...implementing,
      task(1, 1, '9.1', 'start', 1),
      task(2, 1, '9.1', 'pass', 1),
      task(2, 1, '9.1', 'start', 2),
      task(4, 1, '9.1', 'pass', 2),
      task(4, 1, '9.1', 'start', 3),
      task(6, 1, '9.1', 'pass', 3),
      [7, 1, '9.1', 'implement', 'pass', 1, 'done 1,2,3'],
    ];
    expect(words(makeProject(9, todo, built), '9.1')).toEqual(['Built', 'Built', 'Built']);

    const verified: LineSpec[] = [...built, [9, 1, '9.1', 'verify', 'pass', 1]];
    expect(words(makeProject(9, todo, verified), '9.1')).toEqual(['Built', 'Built', 'Built']);

    // Doc sync edits the phase file before it logs its line: the rows it marked are Complete already.
    expect(words(makeProject(9, [['9.1', 'xx-']], verified), '9.1')).toEqual(['Complete', 'Complete', 'Built']);

    // Its line lands: every row is the phase file's status, and none reads Built.
    const synced: LineSpec[] = [...verified, [10, 1, '9.1', 'doc_sync', 'pass', 1]];
    expect(words(makeProject(9, [['9.1', 'xxx']], synced), '9.1')).toEqual(['Complete', 'Complete', 'Complete']);
    expect(words(makeProject(9, [['9.1', 'xx-']], synced), '9.1')).toEqual(['Complete', 'Complete', 'Not started']);
    expect(words(makeProject(9, todo, synced), '9.1')).toEqual(['Not started', 'Not started', 'Not started']);
    // A failed doc sync ends it too: its line landed.
    const failed: LineSpec[] = [...verified, [10, 1, '9.1', 'doc_sync', 'fail', 1]];
    expect(words(makeProject(9, todo, failed), '9.1')).toEqual(['Not started', 'Not started', 'Not started']);
  });

  it('drops a Running row with no pass line once the implement result lands; a retry brings it back', () => {
    const lines: LineSpec[] = [
      ...implementing,
      task(1, 1, '9.1', 'start', 1),
      task(2, 1, '9.1', 'pass', 1),
      task(2, 1, '9.1', 'start', 2),
    ];
    expect(words(makeProject(9, todo, lines), '9.1')).toEqual(['Built', 'Running', 'Not started']);

    // Implementing is over and the log never said task 2 was built.
    const over: LineSpec[] = [...lines, [5, 1, '9.1', 'implement', 'blocked', 1, 'done 1; blocked 2']];
    expect(words(makeProject(9, todo, over), '9.1')).toEqual(['Built', 'Not started', 'Not started']);

    const retry: LineSpec[] = [
      ...over,
      [6, 1, '9.1', 'verify', 'fail', 1],
      [7, 1, '9.1', 'implement', 'start', 2],
      task(8, 1, '9.1', 'start', 2, 2),
    ];
    expect(words(makeProject(9, todo, retry), '9.1')).toEqual(['Built', 'Running', 'Not started']);
    expect(words(makeProject(9, todo, [...retry, task(9, 1, '9.1', 'pass', 2, 2)]), '9.1')).toEqual(['Built', 'Built', 'Not started']);
  });

  it('starts again for task lines logged after a doc sync in the same wave', () => {
    const lines: LineSpec[] = [
      ...implementing,
      task(1, 1, '9.1', 'pass', 1),
      [2, 1, '9.1', 'implement', 'pass', 1],
      [3, 1, '9.1', 'verify', 'pass', 1],
      [4, 1, '9.1', 'doc_sync', 'pass', 1],
      [5, 1, '9.1', 'implement', 'start', 1],
      task(6, 1, '9.1', 'start', 2),
    ];
    expect(words(makeProject(9, todo, lines), '9.1')).toEqual(['Not started', 'Running', 'Not started']);
  });
});

// ---------------------------------------------------------------------------
// Rows that are never overlaid
// ---------------------------------------------------------------------------

describe('rows with any other status', () => {
  it('are never overlaid: done, manual, blocked, active and cut rows keep their status', () => {
    const lines: LineSpec[] = [[0, 1, '9.1', 'implement', 'start', 1]];
    for (let n = 1; n <= 6; n++) lines.push(task(n, 1, '9.1', n % 2 === 0 ? 'start' : 'pass', n));
    const project = makeProject(9, [['9.1', 'xMB~C-']], lines);
    expect(currentSprintRun(phaseRuns(project, 9), '9.1')!.tasks).toHaveLength(6);
    expect(words(project, '9.1')).toEqual(['Complete', 'Manual', 'Blocked', 'Running', 'Cut', 'Running']);
    const sprint = sprintOf(project, '9.1');
    const live = liveTaskStates(currentSprintRun(phaseRuns(project, 9), '9.1'));
    expect(sprint.tasks.map((t) => taskRow(t, live).live)).toEqual([null, null, null, null, null, 'running']);
    // The manual row keeps its own icon, and the done row its ringed check.
    expect(taskRow(sprint.tasks[1]!, live).icon).toBe('manual');
    expect(taskRow(sprint.tasks[0]!, live).icon).toBe('pass');
  });

  it('a MANUAL or x row with a pass line never reads Built', () => {
    const lines: LineSpec[] = [[0, 1, '9.1', 'implement', 'start', 1], task(1, 1, '9.1', 'pass', 1), task(1, 1, '9.1', 'pass', 2), task(1, 1, '9.1', 'pass', 3)];
    expect(words(makeProject(9, [['9.1', 'xM-']], lines), '9.1')).toEqual(['Complete', 'Manual', 'Built']);
  });

  it('a row with no task number, or a number the log never names, is left alone', () => {
    const project = makeProject(9, [['9.1', '--']], [[0, 1, '9.1', 'implement', 'start', 1], task(1, 1, '9.1', 'start', 7)]);
    // Task 7 isn't in the sprint: the derivation drops the line.
    expect(currentSprintRun(phaseRuns(project, 9), '9.1')!.tasks).toBeUndefined();
    expect(words(project, '9.1')).toEqual(['Not started', 'Not started']);
    expect(taskRow({ status: 'todo', rawStatus: '—', number: null }, new Map([[1, 'built' as const]])).words).toBe('Not started');
  });
});

// ---------------------------------------------------------------------------
// Which run
// ---------------------------------------------------------------------------

describe('the overlay source', () => {
  it('is the sprint own run: a sibling in a parallel wave does not move its rows', () => {
    const lines: LineSpec[] = [
      [0, 1, '9.1', 'implement', 'start', 1],
      [0, 1, '9.2', 'implement', 'start', 1],
      task(1, 1, '9.1', 'start', 1),
      task(1, 1, '9.2', 'start', 2),
      task(2, 1, '9.2', 'pass', 2),
    ];
    const project = makeProject(9, [['9.1', '--'], ['9.2', '--']], lines);
    expect(words(project, '9.1')).toEqual(['Running', 'Not started']);
    expect(words(project, '9.2')).toEqual(['Not started', 'Built']);
  });

  it('is the phase latest run only: an older run task lines never show', () => {
    const lines: LineSpec[] = [
      [0, 1, '9.1', 'implement', 'start', 1],
      task(1, 1, '9.1', 'pass', 1),
      [2, 1, '9.1', 'implement', 'pass', 1],
      [3, 2, '9.2', 'implement', 'start', 1],
      // A new run of the phase starts at wave 1 with 9.2; 9.1 is not in it.
      [10, 1, '9.2', 'implement', 'start', 1],
      task(11, 1, '9.2', 'start', 1),
    ];
    const project = makeProject(9, [['9.1', '--'], ['9.2', '--']], lines);
    expect(currentSprintRun(phaseRuns(project, 9), '9.1')).toBeNull();
    expect(words(project, '9.1')).toEqual(['Not started', 'Not started']);
    expect(words(project, '9.2')).toEqual(['Running', 'Not started']);
  });

  it('is empty with no run, no task lines, or a null run', () => {
    expect(liveTaskStates(null).size).toBe(0);
    const project = makeProject(9, [['9.1', '--']], [[0, 1, '9.1', 'implement', 'start', 1]]);
    expect(liveTaskStates(currentSprintRun(phaseRuns(project, 9), '9.1')).size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The sprint card's status bar
// ---------------------------------------------------------------------------

describe('the card status bar counts the overlaid rows', () => {
  /** What the card's bar is given for a sprint: its running and built tasks. */
  function counts(project: Project, id: string): { running: number; built: number } {
    const sprint = sprintOf(project, id);
    return liveTaskCounts(sprint.tasks, liveTaskStates(currentSprintRun(phaseRuns(project, sprint.phase), id)));
  }
  const implementing: LineSpec[] = [[0, 1, '9.1', 'implement', 'start', 1]];

  it('fills a task at a time while the sprint is implemented, and empties at doc sync', () => {
    const todo: Array<[string, string]> = [['9.1', '---']];
    expect(counts(makeProject(9, todo, implementing), '9.1')).toEqual({ running: 0, built: 0 });

    const one = [...implementing, task(1, 1, '9.1', 'start', 1)];
    expect(counts(makeProject(9, todo, one), '9.1')).toEqual({ running: 1, built: 0 });

    const two = [...one, task(3, 1, '9.1', 'pass', 1), task(3, 1, '9.1', 'start', 2)];
    expect(counts(makeProject(9, todo, two), '9.1')).toEqual({ running: 1, built: 1 });

    const built: LineSpec[] = [...two, task(5, 1, '9.1', 'pass', 2), task(5, 1, '9.1', 'start', 3), task(8, 1, '9.1', 'pass', 3), [9, 1, '9.1', 'implement', 'pass', 1, 'done 1,2,3']];
    expect(counts(makeProject(9, todo, built), '9.1')).toEqual({ running: 0, built: 3 });

    // Doc sync is logged: the bar is the phase file's again.
    const synced: LineSpec[] = [...built, [10, 1, '9.1', 'verify', 'pass', 1], [11, 1, '9.1', 'doc_sync', 'pass', 1]];
    expect(counts(makeProject(9, [['9.1', 'xxx']], synced), '9.1')).toEqual({ running: 0, built: 0 });
  });

  it('counts only rows the phase file has as not started', () => {
    const lines: LineSpec[] = [...implementing];
    for (let n = 1; n <= 6; n++) lines.push(task(n, 1, '9.1', n % 2 === 0 ? 'start' : 'pass', n));
    // Tasks 1 to 5 are done, manual, blocked, active and cut in the phase file; only task 6 is overlaid.
    expect(counts(makeProject(9, [['9.1', 'xMB~C-']], lines), '9.1')).toEqual({ running: 1, built: 0 });
    expect(liveTaskCounts(sprintOf(makeProject(9, [['9.1', '--']], implementing), '9.1').tasks)).toEqual({ running: 0, built: 0 });
  });
});

// ---------------------------------------------------------------------------
// Everything else stays put
// ---------------------------------------------------------------------------

describe('task lines change nothing outside the tasks table', () => {
  const sprints: Array<[string, string]> = [['9.1', '---'], ['9.2', '--M'], ['9.3', '--']];
  /** A parallel wave with a retry, then the next wave starting: gate and start lines only. */
  const gates: LineSpec[] = [
    [0, 1, '9.1', 'implement', 'start', 1],
    [0, 1, '9.2', 'implement', 'start', 1],
    [10, 1, '9.1', 'implement', 'pass', 1, 'done 1,2,3'],
    [10, 1, '9.2', 'implement', 'pass', 1, 'done 1,2'],
    [12, 1, '9.1', 'verify', 'fail', 1, 'test: 1 failing'],
    [12, 1, '9.2', 'verify', 'pass', 1],
    [13, 1, '9.1', 'implement', 'start', 2],
    [16, 1, '9.1', 'implement', 'pass', 2, 'done 2'],
    [18, 1, '9.1', 'verify', 'pass', 2],
    [18, 1, '9.2', 'verify', 'pass', 2],
    [19, 2, '9.3', 'implement', 'start', 1],
    [20, 1, '9.1', 'doc_sync', 'pass', 1],
    [20, 1, '9.2', 'doc_sync', 'pass', 1],
  ];
  /** The same log with the implementers' task lines in it. */
  const withTasks: LineSpec[] = [
    ...gates.slice(0, 2),
    task(1, 1, '9.1', 'start', 1),
    task(1, 1, '9.2', 'start', 1),
    task(4, 1, '9.1', 'pass', 1),
    task(4, 1, '9.1', 'start', 2),
    task(5, 1, '9.2', 'pass', 1),
    task(5, 1, '9.2', 'start', 2),
    task(7, 1, '9.1', 'pass', 2),
    task(7, 1, '9.1', 'start', 3),
    task(9, 1, '9.2', 'pass', 2),
    task(9, 1, '9.1', 'pass', 3),
    ...gates.slice(2, 7),
    task(14, 1, '9.1', 'start', 2, 2),
    task(15, 1, '9.1', 'pass', 2, 2),
    ...gates.slice(7, 11),
    task(19, 2, '9.3', 'start', 1),
    ...gates.slice(11),
    task(21, 2, '9.3', 'pass', 1),
    task(21, 2, '9.3', 'start', 2),
  ];

  it('at every point of the run: counts, bars, card states, tiles, the badge, retries and durations', () => {
    expect(withTasks.filter((l) => l[3] !== 'task')).toEqual(gates);
    // Before doc sync the phase file is all to-do; after it, the tasks are done.
    for (const statuses of [sprints, [['9.1', 'xxx'], ['9.2', 'xxM'], ['9.3', '--']] as Array<[string, string]>]) {
      for (let cut = 1; cut <= withTasks.length; cut++) {
        const lines = withTasks.slice(0, cut);
        const plain = lines.filter((l) => l[3] !== 'task');
        if (plain.length === 0) continue;
        expect(outside(makeProject(9, statuses, lines)), `after line ${cut}`).toEqual(outside(makeProject(9, statuses, plain)));
      }
    }
  });

  it('keeps the wave at one retry and its logged duration', () => {
    const project = makeProject(9, [['9.1', 'xxx'], ['9.2', 'xxM'], ['9.3', '--']], withTasks);
    expect(project.warnings).toEqual([]);
    const v = rail(project, Date.UTC(2026, 8, 28, 10, 30, 0));
    expect(v.summaryText).toBe('2 waves · 1 retry');
    expect(v.rows[0]).toMatchObject({ label: 'Wave 1', state: 'done', retries: 1, durationText: '20 min', metaText: '20 min · 1 retry' });
    // Wave 2 started at its start marker (10:19), not at a task line.
    expect(v.rows[1]).toMatchObject({ label: 'Wave 2', state: 'running', durationText: '11 min so far' });
    expect(card(v, '9.3').stateText).toBe('Implementing');
    expect(card(v, '9.1').stateText).toBe('Complete');
    expect(card(v, '9.2').state).toBe('manual');
    // The count is the phase file's: two tasks of 9.3 to do, however far its task lines got.
    expect(card(v, '9.3').progress).toMatchObject({ done: 0, eligible: 2 });
    expect(words(project, '9.3')).toEqual(['Built', 'Running']);
    // Wave 1 is synced: its rows are the phase file's.
    expect(words(project, '9.1')).toEqual(['Complete', 'Complete', 'Complete']);
    expect(words(project, '9.2')).toEqual(['Complete', 'Complete', 'Manual']);
  });
});
