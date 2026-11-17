import { describe, expect, it } from 'vitest';
import type { WaveRun } from '../../src/core/model.js';
import { deriveRun, sprintState } from '../../src/core/derive/run.js';
import { RUN_LOGS } from '../fixtures/index.js';
import { events, fixtureEvents, seq } from './helpers.js';

/** `[run, wave, sprint ids]` per wave. */
function shape(waves: WaveRun[]): Array<[number, number, string[]]> {
  return waves.map((w) => [w.run, w.wave, w.sprints.map((s) => s.sprint)]);
}

describe('deriveRun: fail → retry → pass (failRetryPass)', () => {
  const log = fixtureEvents(RUN_LOGS.failRetryPass);
  const d = deriveRun(log);
  const wave = d.waves[0]!;
  const sr = wave.sprints[0]!;

  it('is one wave with one sprint', () => {
    expect(shape(d.waves)).toEqual([[1, 3, ['2.4']]]);
  });

  it('orders the gate steps with attempt numbers: verify #1 fail, verify #2 pass, doc_sync pass', () => {
    expect(seq(sr.steps)).toEqual([
      ['implement', 'pass', 1],
      ['verify', 'fail', 1],
      ['implement', 'pass', 2],
      ['verify', 'pass', 2],
      ['doc_sync', 'pass', 1],
    ]);
    expect(sr.steps.map((s) => s.seq)).toEqual([1, 1, 2, 2, 1]);
    expect(sr.steps[1]!.summary).toBe('typecheck: 2 errors in src/parser.ts');
    expect(sr.attempts).toEqual({ implement: 2, verify: 2, doc_sync: 1 });
    expect(sr.events).toEqual(log);
  });

  it('ends done with no escalation', () => {
    expect(sr.state).toBe('done');
    expect(sr.escalation).toBeNull();
    expect(d.escalations).toEqual([]);
    expect(wave.escalated).toBe(false);
  });

  it('derives wave start and end from the events', () => {
    expect(wave.startedAt).toBe('2026-09-28T13:20:05Z');
    expect(wave.endedAt).toBe('2026-09-28T13:40:00Z');
    expect(sr.startedAt).toBe('2026-09-28T13:20:05Z');
    expect(sr.updatedAt).toBe('2026-09-28T13:40:00Z');
  });

  it('carries the doc_sync files', () => {
    expect(wave.files).toEqual(['src/parser/tables.ts', 'src/parser/tables.test.ts']);
    expect(sr.files).toEqual(wave.files);
    expect(sr.steps[4]!.files).toEqual(wave.files);
  });

  it('shows each state along the way', () => {
    const states = log.map((_, i) => deriveRun(log.slice(0, i + 1)).waves[0]!.sprints[0]!.state);
    expect(states).toEqual(['verifying', 'failed', 'verifying', 'syncing', 'done']);
    for (let i = 0; i < log.length - 1; i++) {
      expect(deriveRun(log.slice(0, i + 1)).waves[0]!.endedAt).toBeNull();
    }
  });

  it('is plain JSON', () => {
    expect(JSON.parse(JSON.stringify(d))).toEqual(d);
  });
});

describe('deriveRun: real smoke log', () => {
  it('reads as fail → retry → pass, done, no escalation', () => {
    const d = deriveRun(fixtureEvents(RUN_LOGS.realSmoke));
    const sr = d.waves[0]!.sprints[0]!;
    expect(seq(sr.steps).map(([g, r]) => `${g}:${r}`)).toEqual([
      'implement:pass',
      'verify:fail',
      'implement:pass',
      'verify:pass',
      'doc_sync:pass',
    ]);
    expect(sr.state).toBe('done');
    expect(d.escalations).toEqual([]);
    expect(d.waves[0]!.endedAt).toBe('2026-09-28T23:25:28Z');
  });
});

describe('deriveRun: escalation', () => {
  const log = fixtureEvents(RUN_LOGS.escalation);
  const d = deriveRun(log);
  const wave = d.waves[0]!;
  const sr = wave.sprints[0]!;

  it('three verify fails ending at attempt 3 of 3 produce one escalation', () => {
    expect(d.escalations).toHaveLength(1);
    const esc = d.escalations[0]!;
    expect(esc).toMatchObject({
      phase: 2,
      run: 1,
      wave: 2,
      sprint: '2.5',
      gate: 'verify',
      attempt: 3,
      max: 3,
      summary: 'test: 1 failing in test/derive.test.ts',
      ts: '2026-09-28T11:19:33Z',
      line: 6,
    });
    expect(sr.escalation).toEqual(esc);
    expect(wave.escalated).toBe(true);
  });

  it("carries every attempt's summary for the gate", () => {
    expect(d.escalations[0]!.history).toEqual([
      { attempt: 1, result: 'fail', summary: 'test: 3 failing in test/derive.test.ts', ts: '2026-09-28T11:01:30Z', line: 2 },
      { attempt: 2, result: 'fail', summary: 'test: 1 failing in test/derive.test.ts', ts: '2026-09-28T11:10:40Z', line: 4 },
      { attempt: 3, result: 'fail', summary: 'test: 1 failing in test/derive.test.ts', ts: '2026-09-28T11:19:33Z', line: 6 },
    ]);
  });

  it('leaves the sprint failed and the wave open', () => {
    expect(sr.state).toBe('failed');
    expect(wave.endedAt).toBeNull();
  });

  it('does not escalate before the limit', () => {
    expect(deriveRun(log.slice(0, 4)).escalations).toEqual([]);
    expect(deriveRun(log.slice(0, 4)).waves[0]!.sprints[0]!.state).toBe('failed');
  });

  it('a later implement event removes it', () => {
    const next = events([2, '2.5', 'implement', 'pass', 1]).map((e) => ({ ...e, line: 7 }));
    const d2 = deriveRun([...log, ...next]);
    expect(d2.escalations).toEqual([]);
    expect(d2.waves[0]!.escalated).toBe(false);
    expect(d2.waves[0]!.sprints[0]!.escalation).toBeNull();
    expect(d2.waves[0]!.sprints[0]!.state).toBe('verifying');
  });
});

describe('deriveRun: continued after escalation', () => {
  const log = fixtureEvents(RUN_LOGS.continuedAfterEscalation);
  const d = deriveRun(log);
  const sr = d.waves[0]!.sprints[0]!;

  it('has no escalation once the sprint continues', () => {
    expect(d.escalations).toEqual([]);
    expect(sr.escalation).toBeNull();
    expect(d.waves[0]!.escalated).toBe(false);
  });

  it('removes the escalation as soon as the implement line lands', () => {
    expect(deriveRun(log.slice(0, 6)).escalations).toHaveLength(1);
    const after = deriveRun(log.slice(0, 7));
    expect(after.escalations).toEqual([]);
    expect(after.waves[0]!.sprints[0]!.state).toBe('verifying');
  });

  it('keeps the whole retry story, with the attempt counter reset', () => {
    expect(sr.steps.filter((s) => s.gate === 'verify').map((s) => [s.result, s.attempt, s.seq])).toEqual([
      ['fail', 1, 1],
      ['fail', 2, 2],
      ['fail', 3, 3],
      ['pass', 1, 4],
    ]);
    expect(sr.attempts.verify).toBe(3);
  });

  it('ends done, closing the wave', () => {
    expect(sr.state).toBe('done');
    expect(d.waves[0]!.endedAt).toBe('2026-09-28T11:34:15Z');
    expect(d.waves[0]!.files).toEqual(['src/core/derive/run.ts', 'test/derive/run.test.ts']);
  });

  it('escalates again after a second cycle at the limit, with the full history', () => {
    const again = deriveRun(
      events(
        [1, '2.5', 'verify', 'fail', 1],
        [1, '2.5', 'verify', 'fail', 2],
        [1, '2.5', 'verify', 'fail', 3],
        [1, '2.5', 'implement', 'pass', 1],
        [1, '2.5', 'verify', 'fail', 1],
        [1, '2.5', 'verify', 'fail', 2],
        [1, '2.5', 'verify', 'fail', 3],
      ),
    );
    expect(again.escalations).toHaveLength(1);
    expect(again.escalations[0]!.line).toBe(7);
    expect(again.escalations[0]!.history.map((h) => h.attempt)).toEqual([1, 2, 3, 1, 2, 3]);
  });
});

describe('deriveRun: parallel wave', () => {
  const log = fixtureEvents(RUN_LOGS.parallelWave);
  const d = deriveRun(log);

  it('groups by wave, then by sprint in first-seen order', () => {
    expect(shape(d.waves)).toEqual([
      [1, 1, ['3.1', '3.2']],
      [1, 2, ['3.3']],
    ]);
    expect(d.waves[0]!.events.map((e) => e.line)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(d.waves[1]!.events.map((e) => e.line)).toEqual([7, 8, 9]);
  });

  it('uses line order, not ts, despite clock skew', () => {
    const s32 = d.waves[0]!.sprints[1]!;
    expect(s32.events.map((e) => e.line)).toEqual([2, 4, 6]);
    expect(seq(s32.steps)).toEqual([
      ['implement', 'blocked', 1],
      ['verify', 'partial', 1],
      ['doc_sync', 'pass', 1],
    ]);
    // Line 4 has an earlier ts than line 3; the wave still starts at line 1.
    expect(d.waves[0]!.startedAt).toBe('2026-09-28T10:02:00Z');
  });

  it('finishes both waves', () => {
    for (const w of d.waves) for (const s of w.sprints) expect(s.state).toBe('done');
    expect(d.waves.map((w) => w.endedAt)).toEqual(['2026-09-28T10:06:30Z', '2026-09-28T10:18:00Z']);
    expect(d.escalations).toEqual([]);
  });

  it('unions the doc_sync files without repeats', () => {
    expect(d.waves[0]!.files).toEqual(['src/share/model.ts', 'src/share/invite.ts', 'test/share.test.ts']);
    expect(d.waves[1]!.files).toEqual(['src/share/links.ts']);
  });

  it('does not end the wave until every sprint has a passing doc_sync', () => {
    const partial = deriveRun(log.slice(0, 5));
    expect(partial.waves[0]!.sprints.map((s) => s.state)).toEqual(['done', 'syncing']);
    expect(partial.waves[0]!.endedAt).toBeNull();
  });

  it('a blocked implement still moves the sprint to verifying', () => {
    const early = deriveRun(log.slice(0, 2));
    expect(early.waves[0]!.sprints.map((s) => s.state)).toEqual(['verifying', 'verifying']);
  });

  it('marks a UI wave as testing after verify', () => {
    const ui = deriveRun(log.slice(0, 4), { uiSprints: ['3.2'] });
    expect(ui.waves[0]!.sprints.map((s) => s.state)).toEqual(['testing', 'testing']);
  });

  it('keeps sprintHistory per sprint', () => {
    expect(Object.keys(d.sprintHistory).sort()).toEqual(['3.1', '3.2', '3.3']);
    expect(d.sprintHistory['3.2']![0]).toBe(d.waves[0]!.sprints[1]);
  });
});

describe('deriveRun: real Phase 2 log (parallel wave 2)', () => {
  it('reads three finished waves', () => {
    const d = deriveRun(fixtureEvents(RUN_LOGS.realPhase2));
    expect(shape(d.waves)).toEqual([
      [1, 1, ['2.1']],
      [1, 2, ['2.2', '2.3']],
      [1, 3, ['2.4']],
    ]);
    expect(d.waves.every((w) => w.endedAt !== null)).toBe(true);
    expect(d.waves[1]!.files).toHaveLength(31);
    expect(d.escalations).toEqual([]);
  });
});

describe('deriveRun: stopped run', () => {
  const d = deriveRun(fixtureEvents(RUN_LOGS.stoppedRun));
  const sr = d.waves[0]!.sprints[0]!;

  it('shows a failed gate with no later event as failed, not escalated', () => {
    expect(sr.state).toBe('failed');
    expect(sr.escalation).toBeNull();
    expect(d.escalations).toEqual([]);
    expect(d.waves[0]!.endedAt).toBeNull();
    expect(sr.lastEvent?.summary).toBe('build: cannot find module ./server.js');
  });
});

describe('deriveRun: wave-test retry', () => {
  const log = fixtureEvents(RUN_LOGS.waveTestRetry);

  it('counts the true sequence even though verify repeats attempt 1', () => {
    const sr = deriveRun(log).waves[0]!.sprints[0]!;
    expect(sr.steps.filter((s) => s.gate === 'verify').map((s) => [s.attempt, s.seq])).toEqual([
      [1, 1],
      [1, 2],
    ]);
    expect(sr.steps.filter((s) => s.gate === 'wave_test').map((s) => [s.result, s.attempt, s.seq])).toEqual([
      ['fail', 1, 1],
      ['pass', 2, 2],
    ]);
    expect(sr.state).toBe('done');
  });

  it('walks testing → failed → verifying → testing → syncing → done', () => {
    const states = log.map((_, i) => deriveRun(log.slice(0, i + 1), { uiSprints: ['4.2'] }).waves[0]!.sprints[0]!.state);
    expect(states).toEqual(['verifying', 'testing', 'failed', 'verifying', 'testing', 'syncing', 'done']);
  });

  it('treats a wave with a wave_test line as a UI wave even without uiSprints', () => {
    expect(deriveRun(log.slice(0, 5)).waves[0]!.sprints[0]!.state).toBe('testing');
    expect(deriveRun(log.slice(0, 2)).waves[0]!.sprints[0]!.state).toBe('syncing');
  });

  it('escalates a wave_test fail at the limit', () => {
    const d = deriveRun(
      events(
        [1, '4.2', 'verify', 'pass', 1],
        [1, '4.2', 'wave_test', 'fail', 1],
        [1, '4.2', 'wave_test', 'fail', 2],
        [1, '4.2', 'wave_test', 'fail', 3],
      ),
    );
    expect(d.escalations).toHaveLength(1);
    expect(d.escalations[0]!.gate).toBe('wave_test');
    expect(d.escalations[0]!.history.map((h) => h.attempt)).toEqual([1, 2, 3]);
  });
});

describe('deriveRun: runs and edge cases', () => {
  it('returns nothing for no events', () => {
    expect(deriveRun([])).toEqual({ waves: [], escalations: [], sprintHistory: {}, suites: [] });
  });

  it('starts a new run when the wave number drops', () => {
    const d = deriveRun(
      events(
        [1, '2.1', 'implement', 'pass', 1],
        [2, '2.2', 'implement', 'pass', 1],
        [1, '2.1', 'implement', 'pass', 1],
        [2, '2.2', 'implement', 'pass', 1],
        [3, '2.3', 'implement', 'pass', 1],
        [1, '2.1', 'implement', 'pass', 1],
      ),
    );
    expect(shape(d.waves)).toEqual([
      [1, 1, ['2.1']],
      [1, 2, ['2.2']],
      [2, 1, ['2.1']],
      [2, 2, ['2.2']],
      [2, 3, ['2.3']],
      [3, 1, ['2.1']],
    ]);
    expect(d.sprintHistory['2.1']!.map((s) => s.run)).toEqual([1, 2, 3]);
    expect(d.waves.every((w) => w.sprints.every((s) => s.run === w.run))).toBe(true);
  });

  it('reads a run resumed inside the same wave as a continuation', () => {
    const d = deriveRun(
      events(
        [1, '2.1', 'implement', 'pass', 1],
        [1, '2.1', 'verify', 'fail', 1],
        [1, '2.1', 'implement', 'pass', 1],
      ),
    );
    expect(shape(d.waves)).toEqual([[1, 1, ['2.1']]]);
  });

  it('clears an escalation when the sprint shows up in a later run', () => {
    const d = deriveRun(
      events(
        [2, '2.5', 'verify', 'fail', 3],
        [1, '2.5', 'implement', 'pass', 1],
      ),
    );
    expect(d.escalations).toEqual([]);
    expect(d.sprintHistory['2.5']![0]!.escalation).toBeNull();
    expect(d.sprintHistory['2.5']![0]!.state).toBe('failed');
  });

  it("keeps an escalation when only other sprints' events follow", () => {
    const d = deriveRun(
      events(
        [1, '2.5', 'verify', 'fail', 3],
        [1, '2.6', 'verify', 'pass', 1],
        [1, '2.6', 'doc_sync', 'pass', 1],
      ),
    );
    expect(d.escalations.map((e) => e.sprint)).toEqual(['2.5']);
    expect(d.waves[0]!.escalated).toBe(true);
    expect(d.waves[0]!.endedAt).toBeNull();
  });

  it('never escalates with max 0 (no limit)', () => {
    const d = deriveRun(events([1, '2.1', 'verify', 'fail', 7, 0]));
    expect(d.escalations).toEqual([]);
    expect(d.waves[0]!.sprints[0]!.state).toBe('failed');
  });

  it('escalates at attempt >= max, honoring a custom max', () => {
    expect(deriveRun(events([1, '2.1', 'verify', 'fail', 4, 3])).escalations).toHaveLength(1);
    expect(deriveRun(events([1, '2.1', 'verify', 'fail', 3, 5])).escalations).toEqual([]);
    expect(deriveRun(events([1, '2.1', 'verify', 'fail', 5, 5])).escalations[0]!.max).toBe(5);
  });

  it('never escalates implement or doc_sync; a doc_sync fail is failed', () => {
    const d = deriveRun(
      events(
        [1, '2.1', 'verify', 'pass', 1],
        [1, '2.1', 'doc_sync', 'fail', 1],
      ),
    );
    expect(d.escalations).toEqual([]);
    expect(d.waves[0]!.sprints[0]!.state).toBe('failed');
  });

  it('skips unknown gates when deriving state', () => {
    expect(deriveRun(events([1, '6.1', 'unknown', 'pass', 1])).waves[0]!.sprints[0]!.state).toBe('implementing');
    const d = deriveRun(
      events(
        [1, '6.1', 'doc_sync', 'pass', 1],
        [1, '6.1', 'unknown', 'fail', 3],
      ),
    );
    expect(d.waves[0]!.sprints[0]!.state).toBe('done');
    expect(d.escalations).toEqual([]);
  });

  it('sprintState handles an empty list', () => {
    expect(sprintState([], false)).toBe('implementing');
  });
});
