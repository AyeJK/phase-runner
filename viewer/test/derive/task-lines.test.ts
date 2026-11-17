/**
 * `task` lines in the run derivation (`src/core/derive/run.ts`): markers that
 * change nothing about waves, gate steps, attempts, retries or escalations,
 * and give each sprint run its task progress.
 */
import { describe, expect, it } from 'vitest';
import type { RunEvent, SprintRun, TaskProgress } from '../../src/core/model.js';
import { deriveRun, isTaskLine, taskLineProgress, type RunDerivation } from '../../src/core/derive/run.js';
import { MULTI_PHASE_RUN_LOGS, RUN_LOGS, TASK_LINES, TRAIL_LOG_RUN_LOGS } from '../fixtures/index.js';
import { events, fixtureEvents } from './helpers.js';

/** `[task, state]` per entry. */
function states(tasks: TaskProgress[] | undefined): Array<[number, string]> {
  return (tasks ?? []).map((t) => [t.task, t.state]);
}

/** The derivation with every sprint run's `tasks` removed. */
function withoutTasks(d: RunDerivation): RunDerivation {
  const strip = (sr: SprintRun): SprintRun => {
    const { tasks: _tasks, ...rest } = sr;
    return rest;
  };
  return {
    waves: d.waves.map((w) => ({ ...w, sprints: w.sprints.map(strip) })),
    escalations: d.escalations,
    sprintHistory: Object.fromEntries(Object.entries(d.sprintHistory).map(([id, runs]) => [id, runs.map(strip)])),
    suites: d.suites,
  };
}

/** Hand-built `task` lines on top of {@link events}: `[index of the event to change, task number]`. */
function asTasks(list: RunEvent[], numbers: Record<number, number>): RunEvent[] {
  return list.map((e, i) => (i in numbers ? { ...e, task: numbers[i]!, summary: String(numbers[i]) } : e));
}

describe('deriveRun: a log with no task lines', () => {
  const logs = [
    ...Object.values(RUN_LOGS).filter((file) => file !== RUN_LOGS.taskLines && file !== RUN_LOGS.binaryGarbage),
    ...Object.values(MULTI_PHASE_RUN_LOGS),
    ...Object.values(TRAIL_LOG_RUN_LOGS),
  ];

  it('gives no sprint run a tasks field', () => {
    for (const file of logs) {
      const d = deriveRun(fixtureEvents(file));
      for (const wave of d.waves) for (const sr of wave.sprints) expect('tasks' in sr).toBe(false);
      for (const runs of Object.values(d.sprintHistory)) for (const sr of runs) expect('tasks' in sr).toBe(false);
    }
  });

  it('derives the same with or without the task-number option', () => {
    for (const file of logs) {
      const log = fixtureEvents(file);
      expect(deriveRun(log, { sprintTasks: { '2.4': [1, 2] } })).toEqual(deriveRun(log));
    }
  });
});

describe('deriveRun: the task-lines fixture', () => {
  const log = fixtureEvents(RUN_LOGS.taskLines);
  const gates = log.filter((e) => !isTaskLine(e));
  const d = deriveRun(log);

  it('derives exactly what the same log without its task lines derives, apart from tasks', () => {
    expect(log.length - gates.length).toBe(15);
    expect(withoutTasks(d)).toEqual(deriveRun(gates));
  });

  it('keeps task lines out of wave events, sprint events, steps and attempts', () => {
    // Wave 2's start marker sits on a line between wave 1's, so compare in line order.
    expect(d.waves.flatMap((w) => w.events).sort((a, b) => a.line - b.line)).toEqual(gates);
    for (const wave of d.waves) {
      for (const sr of wave.sprints) {
        expect(sr.events.some(isTaskLine)).toBe(false);
        expect(sr.steps.some((s) => s.gate === 'task')).toBe(false);
        expect('task' in sr.attempts).toBe(false);
        expect(sr.lastEvent!.gate).not.toBe('task');
      }
    }
  });

  it('cuts the same two waves, with the same start, end and state', () => {
    expect(d.waves.map((w) => [w.run, w.wave, w.sprints.map((s) => s.sprint)])).toEqual([
      [1, 1, ['3.1', '3.2']],
      [1, 2, ['3.3']],
    ]);
    const [one, two] = d.waves;
    expect(one!.startedAt).toBe('2026-09-28T10:00:00Z');
    expect(one!.endedAt).toBe('2026-09-28T10:16:30Z');
    expect(one!.events.at(-1)!.line).toBe(TASK_LINES.waveOneEnd);
    expect(one!.sprints.map((s) => s.state)).toEqual(['done', 'done']);
    // Wave 2 has only its start marker: implementing, however many task lines follow it.
    expect(two!.events.map((e) => e.line)).toEqual([TASK_LINES.nextWaveStart]);
    expect(two!.startedAt).toBe('2026-09-28T10:15:40Z');
    expect(two!.endedAt).toBeNull();
    expect(two!.sprints[0]!.state).toBe('implementing');
    expect(two!.sprints[0]!.updatedAt).toBe('2026-09-28T10:15:40Z');
    expect(d.escalations).toEqual([]);
  });

  it('counts attempts from the gate lines only', () => {
    const s31 = d.sprintHistory['3.1']![0]!;
    expect(s31.attempts).toEqual({ implement: 2, verify: 2, doc_sync: 1 });
    expect(s31.steps.map((s) => `${s.gate}:${s.result}`)).toEqual([
      'implement:pass',
      'verify:fail',
      'implement:pass',
      'verify:pass',
      'doc_sync:pass',
    ]);
  });

  it('gives each sprint run the latest line per task number, in its own wave', () => {
    const [one, two] = d.waves;
    const s31 = one!.sprints[0]!;
    const s32 = one!.sprints[1]!;
    expect(states(s31.tasks)).toEqual([
      [1, 'built'],
      [2, 'built'],
    ]);
    // The retry logged task 2 again: its later line wins.
    expect(s31.tasks![1]).toMatchObject({ task: 2, attempt: 2, line: TASK_LINES.retryTaskPass, ts: '2026-09-28T10:13:30Z' });
    expect(s31.tasks![0]).toMatchObject({ task: 1, attempt: 1, line: 5 });
    // A blocked task has a start and no pass: still running, as far as the log says.
    expect(states(s32.tasks)).toEqual([
      [1, 'built'],
      [2, 'built'],
      [3, 'running'],
    ]);
    expect(s32.tasks![2]!.line).toBe(TASK_LINES.blockedTaskStart);
    // Wave 2's task lines sit on both sides of wave 1's doc sync and still land in wave 2.
    expect(states(two!.sprints[0]!.tasks)).toEqual([
      [1, 'built'],
      [2, 'running'],
      [9, 'running'],
    ]);
  });

  it('ignores a task number the sprint does not have', () => {
    const known = deriveRun(log, { sprintTasks: { '3.1': [1, 2], '3.2': [1, 2, 3], '3.3': [1, 2, 3] } });
    expect(states(known.waves[1]!.sprints[0]!.tasks)).toEqual([
      [1, 'built'],
      [2, 'running'],
    ]);
    expect(states(known.waves[0]!.sprints[1]!.tasks)).toEqual([
      [1, 'built'],
      [2, 'built'],
      [3, 'running'],
    ]);
    // A sprint the option does not list keeps every number; one listed with no tasks keeps none.
    const partial = deriveRun(log, { sprintTasks: { '3.1': [] } });
    expect('tasks' in partial.waves[0]!.sprints[0]!).toBe(false);
    expect(states(partial.waves[1]!.sprints[0]!.tasks).map(([n]) => n)).toEqual([1, 2, 9]);
    // Nothing else moves.
    expect(withoutTasks(known)).toEqual(deriveRun(gates));
  });

  it('shows each task running, then built, as the log grows', () => {
    const seen = log.map((_, i) => states(deriveRun(log.slice(0, i + 1)).sprintHistory['3.1']?.[0]?.tasks));
    expect(seen[1]).toEqual([]);
    expect(seen[2]).toEqual([[1, 'running']]);
    expect(seen[4]).toEqual([[1, 'built']]);
    expect(seen[5]).toEqual([
      [1, 'built'],
      [2, 'running'],
    ]);
    expect(seen[8]).toEqual([
      [1, 'built'],
      [2, 'built'],
    ]);
    // The retry starts task 2 again.
    expect(seen[TASK_LINES.retryStart]).toEqual([
      [1, 'built'],
      [2, 'running'],
    ]);
    expect(seen.at(-1)).toEqual([
      [1, 'built'],
      [2, 'built'],
    ]);
  });

  it('is plain JSON', () => {
    expect(JSON.parse(JSON.stringify(d))).toEqual(d);
  });
});

describe('deriveRun: task lines at the edges', () => {
  it('never open a wave or a sprint run on their own', () => {
    // A task line with nothing else of its wave logged (the start line's append failed).
    const only = asTasks(events([1, '5.1', 'task', 'start', 1]), { 0: 1 });
    expect(deriveRun(only)).toEqual({ waves: [], escalations: [], sprintHistory: {}, suites: [] });

    // Wave 2's task line after wave 1 finished: wave 2 still has no events, so it is left out.
    const next = asTasks(
      events([1, '5.1', 'implement', 'pass', 1], [1, '5.1', 'verify', 'pass', 1], [1, '5.1', 'doc_sync', 'pass', 1], [2, '5.2', 'task', 'start', 1]),
      { 3: 1 },
    );
    const d = deriveRun(next);
    expect(d.waves.map((w) => w.wave)).toEqual([1]);
    expect(d.waves[0]!.endedAt).not.toBeNull();
    expect('5.2' in d.sprintHistory).toBe(false);

    // A sibling's task line doesn't put that sibling in the wave.
    const sibling = asTasks(events([1, '5.1', 'implement', 'start', 1], [1, '5.2', 'task', 'start', 1]), { 1: 1 });
    expect(deriveRun(sibling).waves[0]!.sprints.map((s) => s.sprint)).toEqual(['5.1']);
  });

  it('attach once the wave has a gate line, even without a start marker', () => {
    const log = asTasks(
      events([1, '5.1', 'task', 'start', 1], [1, '5.1', 'task', 'pass', 1], [1, '5.1', 'implement', 'pass', 1]),
      { 0: 1, 1: 1 },
    );
    const sr = deriveRun(log).waves[0]!.sprints[0]!;
    expect(states(sr.tasks)).toEqual([[1, 'built']]);
    // The wave starts at its first gate line, not at the task line before it.
    expect(sr.startedAt).toBe(log[2]!.ts);
    expect(sr.state).toBe('verifying');
  });

  it('never start a new run, and land in the run their wave number says', () => {
    // Run 1: waves 1 and 2. Run 2 starts at wave 1 again; its task lines belong to run 2.
    const log = asTasks(
      events(
        [1, '5.1', 'implement', 'pass', 1],
        [1, '5.1', 'doc_sync', 'pass', 1],
        [2, '5.2', 'implement', 'pass', 1],
        [2, '5.2', 'task', 'pass', 1],
        [2, '5.2', 'doc_sync', 'pass', 1],
        [1, '5.1', 'implement', 'start', 1],
        [1, '5.1', 'task', 'start', 1],
      ),
      { 3: 4, 6: 2 },
    );
    const d = deriveRun(log);
    expect(d.waves.map((w) => [w.run, w.wave])).toEqual([
      [1, 1],
      [1, 2],
      [2, 1],
    ]);
    expect('tasks' in d.waves[0]!.sprints[0]!).toBe(false);
    expect(states(d.waves[1]!.sprints[0]!.tasks)).toEqual([[4, 'built']]);
    expect(states(d.waves[2]!.sprints[0]!.tasks)).toEqual([[2, 'running']]);
  });

  it('never clear or cause an escalation', () => {
    const fails = events(
      [1, '5.1', 'implement', 'pass', 1],
      [1, '5.1', 'verify', 'fail', 1],
      [1, '5.1', 'implement', 'pass', 2],
      [1, '5.1', 'verify', 'fail', 2],
      [1, '5.1', 'implement', 'pass', 3],
      [1, '5.1', 'verify', 'fail', 3],
      [1, '5.1', 'task', 'start', 3],
      [1, '5.1', 'task', 'fail', 3],
    );
    const d = deriveRun(asTasks(fails, { 6: 1, 7: 1 }));
    expect(d.escalations).toHaveLength(1);
    expect(d.escalations[0]).toMatchObject({ gate: 'verify', attempt: 3, max: 3 });
    expect(d.waves[0]!.sprints[0]!.state).toBe('failed');
    // `fail` isn't a task result: the line is ignored and the start before it stands.
    expect(states(d.waves[0]!.sprints[0]!.tasks)).toEqual([[1, 'running']]);
  });
});

describe('taskLineProgress', () => {
  it('skips lines with no task number, another gate or another result', () => {
    const list = asTasks(
      events([1, '5.1', 'task', 'start', 1], [1, '5.1', 'task', 'pass', 1], [1, '5.1', 'verify', 'pass', 1], [1, '5.1', 'task', 'blocked', 1]),
      { 1: 3, 2: 4, 3: 3 },
    );
    expect(states(taskLineProgress(list))).toEqual([[3, 'built']]);
    expect(taskLineProgress([])).toEqual([]);
  });

  it('orders by task number, whatever order the lines came in', () => {
    const list = asTasks(events([1, '5.1', 'task', 'start', 1], [1, '5.1', 'task', 'pass', 1], [1, '5.1', 'task', 'start', 1]), { 0: 7, 1: 2, 2: 5 });
    expect(taskLineProgress(list).map((t) => t.task)).toEqual([2, 5, 7]);
  });
});
