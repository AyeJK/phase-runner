/**
 * `suite` lines in the run derivation (`src/core/derive/run.ts`): the
 * phase-end full test suite. Markers that change nothing about waves, steps
 * or escalations, and give each run that reached the suite a `SuiteRun`.
 */
import { describe, expect, it } from 'vitest';
import type { RunEvent } from '../../src/core/model.js';
import { deriveRun, isSuiteLine } from '../../src/core/derive/run.js';
import { readRunLog } from '../../src/core/runlog/read.js';
import { events, type EventSpec } from './helpers.js';

/** A two-wave run, every gate passing: 2.1 in wave 1, 2.2 in wave 2. */
const RUN: EventSpec[] = [
  [1, '2.1', 'implement', 'start', 1],
  [1, '2.1', 'implement', 'pass', 1],
  [1, '2.1', 'verify', 'pass', 1],
  [1, '2.1', 'doc_sync', 'pass', 1],
  [2, '2.2', 'implement', 'start', 1],
  [2, '2.2', 'implement', 'pass', 1],
  [2, '2.2', 'verify', 'pass', 1],
  [2, '2.2', 'doc_sync', 'pass', 1],
];

/** The suite's own wave number: the last wave's + 1. */
const SW = 3;

/** One suite attempt's lines for both sprints: start, then results (`fail` for the sprints named). */
function attempt(n: number, failing: string[] = [], max = 3): EventSpec[] {
  const result = (s: string): 'fail' | 'pass' => (failing.includes(s) ? 'fail' : 'pass');
  return [
    [SW, '2.1', 'suite', 'start', n, max],
    [SW, '2.2', 'suite', 'start', n, max],
    [SW, '2.1', 'suite', result('2.1'), n, max],
    [SW, '2.2', 'suite', result('2.2'), n, max],
  ];
}

/** A suite retry of one sprint, logged on the suite's number: implementer start and task lines, then verify's implement line. */
function retry(sprint: string, n: number): EventSpec[] {
  return [
    [SW, sprint, 'implement', 'start', n],
    [SW, sprint, 'task', 'start', n],
    [SW, sprint, 'task', 'pass', n],
    [SW, sprint, 'implement', 'pass', n],
  ];
}

/** Events with a per-line summary override. */
function withSummaries(list: RunEvent[], summaries: Record<number, string>): RunEvent[] {
  return list.map((e, i) => (i in summaries ? { ...e, summary: summaries[i]! } : e));
}

describe('deriveRun: suite lines', () => {
  it('leave waves, sprint history and escalations exactly as without them', () => {
    const plain = deriveRun(events(...RUN));
    const withSuite = deriveRun(events(...RUN, ...attempt(1, ['2.1']), ...attempt(2)));
    // Line numbers differ only after the run's own lines, so the waves compare equal.
    expect(withSuite.waves).toEqual(plain.waves);
    expect(withSuite.sprintHistory).toEqual(plain.sprintHistory);
    expect(withSuite.escalations).toEqual(plain.escalations);
    expect(plain.suites).toEqual([]);
  });

  it('reads running while only start lines are logged', () => {
    const { suites } = deriveRun(events(...RUN, ...attempt(1).slice(0, 2)));
    expect(suites).toHaveLength(1);
    expect(suites[0]).toMatchObject({ run: 1, escalated: false, latest: { result: 'running', attempt: 1, summary: '', failures: [] } });
  });

  it('keeps every attempt, each sprint failure with its own summary, and the pass that fixed it', () => {
    const list = withSummaries(events(...RUN, ...attempt(1, ['2.1', '2.2']), ...attempt(2)), {
      10: 'parser.test.ts: 2 failing',
      11: 'cli.test.ts: timeout',
      14: '412/412 passed',
    });
    const [suite] = deriveRun(list).suites;
    expect(suite!.history.map((a) => [a.attempt, a.result])).toEqual([
      [1, 'fail'],
      [2, 'pass'],
    ]);
    expect(suite!.history[0]!.failures).toEqual([
      { sprint: '2.1', summary: 'parser.test.ts: 2 failing' },
      { sprint: '2.2', summary: 'cli.test.ts: timeout' },
    ]);
    expect(suite!.latest).toMatchObject({ result: 'pass', summary: '412/412 passed', line: 13, lastLine: 16 });
  });

  it('escalates a fail at the retry limit with nothing after it, and not once a later line is logged', () => {
    const atLimit = [...RUN, ...attempt(1, ['2.1']), ...attempt(2, ['2.1']), ...attempt(3, ['2.1'])];
    expect(deriveRun(events(...atLimit)).suites[0]!.escalated).toBe(true);
    expect(deriveRun(events(...atLimit, [1, '2.1', 'implement', 'start', 1])).suites[0]!.escalated).toBe(false);
    expect(deriveRun(events(...RUN, ...attempt(1, ['2.1'], 0))).suites[0]!.escalated).toBe(false);
  });

  it('splits attempts on a repeated sprint result when no start lines were logged', () => {
    const noStarts = [...attempt(1, ['2.1']), ...attempt(2)].filter(([, , , result]) => result !== 'start');
    const [suite] = deriveRun(events(...RUN, ...noStarts)).suites;
    expect(suite!.history.map((a) => a.result)).toEqual(['fail', 'pass']);
  });

  it('keeps a retry on the suite number out of the waves, and follows it from re-implementing to the re-check', () => {
    const failed = [...RUN, ...attempt(1, ['2.1'])];
    const plain = deriveRun(events(...RUN));

    const implementing = deriveRun(events(...failed, ...retry('2.1', 2).slice(0, 2)));
    expect(implementing.waves).toEqual(plain.waves);
    expect(implementing.sprintHistory).toEqual(plain.sprintHistory);
    expect(implementing.suites[0]).toMatchObject({ retrying: [{ sprint: '2.1', state: 'implementing', attempt: 2 }], retries: 1 });

    const implemented = deriveRun(events(...failed, ...retry('2.1', 2)));
    expect(implemented.waves).toEqual(plain.waves);
    expect(implemented.suites[0]!.retrying).toEqual([{ sprint: '2.1', state: 'implemented', attempt: 2 }]);

    const rechecking = deriveRun(events(...failed, ...retry('2.1', 2), ...attempt(2).slice(0, 2)));
    expect(rechecking.suites[0]).toMatchObject({ retrying: [], retries: 1, latest: { result: 'running', retried: ['2.1'] } });

    const passed = deriveRun(events(...failed, ...retry('2.1', 2), ...attempt(2)));
    expect(passed.suites[0]!.history.map((a) => [a.result, a.retried])).toEqual([
      ['fail', []],
      ['pass', ['2.1']],
    ]);
    expect(passed.waves).toEqual(plain.waves);
  });

  it('a retry after the limit clears the escalation ("continue retrying")', () => {
    const atLimit = [...RUN, ...attempt(1, ['2.1']), ...attempt(2, ['2.1']), ...attempt(3, ['2.1'])];
    expect(deriveRun(events(...atLimit, ...retry('2.1', 1).slice(0, 1))).suites[0]!.escalated).toBe(false);
  });

  it('starts a new run after the suite as usual: its wave 1 lines form waves', () => {
    const next: EventSpec[] = [
      [1, '2.1', 'implement', 'start', 1],
      [1, '2.1', 'implement', 'pass', 1],
    ];
    const d = deriveRun(events(...RUN, ...attempt(1), ...next));
    expect(d.waves.map((w) => [w.run, w.wave])).toEqual([
      [1, 1],
      [1, 2],
      [2, 1],
    ]);
    expect(d.suites.map((s) => s.run)).toEqual([1]);
  });

  it('gives each run its own suite', () => {
    const { suites } = deriveRun(events(...RUN, ...attempt(1, ['2.2']), ...RUN, ...attempt(1)));
    expect(suites.map((s) => [s.run, s.latest.result])).toEqual([
      [1, 'fail'],
      [2, 'pass'],
    ]);
  });

  it('isSuiteLine matches only suite lines', () => {
    const [start, , verify] = events([1, '2.1', 'suite', 'start', 1], [1, '2.1', 'suite', 'pass', 1], [1, '2.1', 'verify', 'pass', 1]);
    expect(isSuiteLine(start!)).toBe(true);
    expect(isSuiteLine(verify!)).toBe(false);
  });
});

describe('readRunLog: suite lines', () => {
  it('reads suite start and result lines with no warnings, defaulting max to 3', () => {
    const text = [
      '{"v":1,"ts":"2026-11-16T10:00:00Z","phase":2,"wave":2,"sprint":"2.1","gate":"suite","result":"start","attempt":1,"max":3,"summary":""}',
      '{"v":1,"ts":"2026-11-16T10:04:00Z","phase":2,"wave":2,"sprint":"2.1","gate":"suite","result":"pass","attempt":1,"summary":"412/412 passed"}',
    ]
      .map((l) => `${l}\n`)
      .join('');
    const { events: read, warnings } = readRunLog(text, 'phase-2.jsonl');
    expect(warnings).toEqual([]);
    expect(read.map((e) => [e.gate, e.result, e.max])).toEqual([
      ['suite', 'start', 3],
      ['suite', 'pass', 3],
    ]);
  });
});
