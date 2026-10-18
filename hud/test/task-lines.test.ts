/**
 * The run log's `task` lines (an implementer starting and finishing each
 * task): they change neither the status line's text nor any toast.
 */
import { describe, expect, test } from 'claude-code/testing';

import { buildView, current, occurrences, statusReport, statusText } from '../hooks/hud.js';
import { PHASE_4_PLAN, PHASE_4_RETRIES, PHASE_4_WAVE_1, PHASE_4_WAVE_2_END, tsOf } from './fixtures.js';
import { PHASE_4_LOG, phase4, type Hud } from './harness.js';

const PLAN = { file: 'Phase-4-Live-Run.md', text: PHASE_4_PLAN };
const log = (lines: readonly string[]): string => lines.map((line) => `${line}\n`).join('');

/** A run-log line of Phase 4, wave 2, Sprint 4.2 at a fixed time. */
function line(ts: string, gate: string, result: string, attempt: number, summary = ''): string {
  return JSON.stringify({ v: 1, ts, phase: 4, wave: 2, sprint: '4.2', gate, result, attempt, max: 3, summary });
}

/**
 * Wave 2 of the real Phase 4 run ({@link PHASE_4_RETRIES}, then the wave test
 * and doc-sync) as an implementer logs it now: a start line before each
 * implementation run, and `task` lines for the tasks it works on.
 */
const WITH_TASK_LINES: readonly string[] = [
  line('2026-09-29T01:52:00Z', 'implement', 'start', 1),
  line('2026-09-29T01:52:30Z', 'task', 'start', 1, '1'),
  line('2026-09-29T01:57:10Z', 'task', 'pass', 1, '1'),
  line('2026-09-29T01:57:10Z', 'task', 'start', 1, '2'),
  line('2026-09-29T02:01:45Z', 'task', 'pass', 1, '2'),
  PHASE_4_RETRIES[0]!,
  PHASE_4_RETRIES[1]!,
  line('2026-09-29T02:04:10Z', 'implement', 'start', 2),
  line('2026-09-29T02:04:20Z', 'task', 'start', 2, '1'),
  line('2026-09-29T02:05:30Z', 'task', 'pass', 2, '1'),
  PHASE_4_RETRIES[2]!,
  PHASE_4_RETRIES[3]!,
  line('2026-09-29T02:08:30Z', 'implement', 'start', 3),
  line('2026-09-29T02:08:40Z', 'task', 'start', 3, '2'),
  line('2026-09-29T02:10:10Z', 'task', 'pass', 3, '2'),
  PHASE_4_RETRIES[4]!,
  PHASE_4_RETRIES[5]!,
  ...PHASE_4_WAVE_2_END,
];

const isTaskLine = (text: string): boolean => (JSON.parse(text) as { gate: string }).gate === 'task';

/** The same run with its `task` lines taken out. */
const WITHOUT_TASK_LINES = WITH_TASK_LINES.filter((text) => !isTaskLine(text));

/** Replay the lines into the Phase 4 run log, one poll after each, then let the mod settle. */
async function run(h: Hud, lines: readonly string[]): Promise<void> {
  await h.replay(PHASE_4_LOG, lines);
  await h.clock.advance(10_000);
}

describe('through the loaded mod', () => {
  test('the status line reads the same with task lines in the log as without them', async ($, on) => {
    const h = phase4(on, tsOf(WITH_TASK_LINES[0]!) - 20_000);
    await h.start($);
    await run(h, WITH_TASK_LINES);

    // One entry per change of text: the 8 task lines add none.
    expect(h.lines).toEqual([
      'P4 · wave 1 · 4.1 done',
      'P4 · wave 2 · 4.2 implement 1/3',
      'P4 · wave 2 · 4.2 verify 1/3',
      'P4 · wave 2 · 4.2 verify failed 1/3',
      'P4 · wave 2 · 4.2 implement 2/3',
      'P4 · wave 2 · 4.2 verify 2/3',
      'P4 · wave 2 · 4.2 verify failed 2/3',
      'P4 · wave 2 · 4.2 implement 3/3',
      'P4 · wave 2 · 4.2 verify 3/3',
      'P4 · wave 2 · 4.2 wave-test 1/3',
      'P4 · wave 2 · 4.2 doc-sync 1/1',
      undefined,
    ]);
  });

  test('the same run without its task lines shows the same status line', async ($, on) => {
    expect(WITH_TASK_LINES.length - WITHOUT_TASK_LINES.length).toBe(8);
    const h = phase4(on, tsOf(WITHOUT_TASK_LINES[0]!) - 20_000);
    await h.start($);
    await run(h, WITHOUT_TASK_LINES);

    expect(h.lines).toEqual([
      'P4 · wave 1 · 4.1 done',
      'P4 · wave 2 · 4.2 implement 1/3',
      'P4 · wave 2 · 4.2 verify 1/3',
      'P4 · wave 2 · 4.2 verify failed 1/3',
      'P4 · wave 2 · 4.2 implement 2/3',
      'P4 · wave 2 · 4.2 verify 2/3',
      'P4 · wave 2 · 4.2 verify failed 2/3',
      'P4 · wave 2 · 4.2 implement 3/3',
      'P4 · wave 2 · 4.2 verify 3/3',
      'P4 · wave 2 · 4.2 wave-test 1/3',
      'P4 · wave 2 · 4.2 doc-sync 1/1',
      undefined,
    ]);
  });

  test('task lines raise no toast: only the completed phase does, once', async ($, on) => {
    const h = phase4(on, tsOf(WITH_TASK_LINES[0]!) - 20_000);
    await h.start($);
    // Up to the third verify: two failures with retries left, 8 task lines, no toast.
    await run(h, WITH_TASK_LINES.slice(0, -3));
    expect(h.toasts).toEqual([]);
    expect(h.sounds).toEqual([]);

    await run(h, WITH_TASK_LINES.slice(-3));
    expect(h.toasts).toEqual(['Phase 4 is complete. The run is at its checkpoint.']);
  });

  test('a task line never reads as a gate result, whatever it carries', async ($, on) => {
    const h = phase4(on);
    await h.start($);
    h.append(PHASE_4_LOG, h.line({ sprint: '4.2', gate: 'implement', result: 'start' }));
    await h.tick();
    const before = [...h.lines];
    expect(before.at(-1)).toBe('P4 · wave 2 · 4.2 implement 1/3');

    // Not results an implementer writes on a task line; the mod must still not act on them.
    for (const result of ['start', 'pass', 'fail', 'blocked']) {
      h.append(PHASE_4_LOG, h.line({ sprint: '4.2', gate: 'task', result, attempt: 3, max: 3, summary: '1' }));
      await h.tick();
    }
    // A task line with no number is skipped by the reader.
    h.append(PHASE_4_LOG, h.line({ sprint: '4.2', gate: 'task', result: 'pass', summary: 'task one' }));
    await h.tick();
    await h.clock.advance(10_000);

    expect(h.lines).toEqual(before);
    expect(h.toasts).toEqual([]);
  });

  test('a task line for a sprint with no other line shows nothing new', async ($, on) => {
    const h = phase4(on);
    await h.start($);
    const before = [...h.lines];
    h.append(PHASE_4_LOG, h.line({ sprint: '4.2', gate: 'task', result: 'start', summary: '1' }));
    await h.tick();

    expect(h.lines).toEqual(before);
    expect(h.toasts).toEqual([]);
  });
});

describe('the read model', () => {
  test('at every line of the run, the status text and the toasts match the log without task lines', () => {
    for (let n = 1; n <= WITH_TASK_LINES.length; n++) {
      const lines = WITH_TASK_LINES.slice(0, n);
      const now = tsOf(lines.at(-1)!) + 1000;
      const since = tsOf(WITH_TASK_LINES[0]!) - 60_000;
      const withTasks = buildView(4, log([...PHASE_4_WAVE_1, ...lines]), PLAN);
      const without = buildView(4, log([...PHASE_4_WAVE_1, ...lines.filter((text) => !isTaskLine(text))]), PLAN);

      expect(statusText(withTasks, now)).toBe(statusText(without, now));
      expect(current(withTasks)).toEqual(current(without));
      expect(occurrences(withTasks, since).map((o) => o.text)).toEqual(occurrences(without, since).map((o) => o.text));
      // `/phase-status`: the same phase, task counts and current gate.
      expect(statusReport(withTasks, now, 0).split('\n').slice(0, 3)).toEqual(statusReport(without, now, 0).split('\n').slice(0, 3));
    }
  });

  test('task lines are in no wave or sprint, and count no attempt', () => {
    const view = buildView(4, log([...PHASE_4_WAVE_1, ...WITH_TASK_LINES]), PLAN);
    expect(view.events.filter((e) => e.gate === 'task')).toHaveLength(8);
    expect(view.waves.flatMap((w) => w.events).some((e) => e.gate === 'task')).toBe(false);
    const sprint = view.history['4.2']!.at(-1)!;
    expect(sprint.events.some((e) => e.gate === 'task')).toBe(false);
    expect(sprint.attempts).toEqual({ implement: 3, verify: 3, wave_test: 1, doc_sync: 1 });
    expect(sprint.state).toBe('done');
  });
});
