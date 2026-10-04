/**
 * `scripts/simulate-run.ts`: the fixture copy, timestamp freshness, and that
 * each script writes run-log v1 lines the real reader accepts without a
 * warning, ending in the state the script promises.
 */
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadProject } from '../../src/core/load.js';
import {
  buildScript,
  DEFAULT_FIXTURE,
  FRESHNESS_AGE_MS,
  blockedTasks,
  fillTasks,
  paceSteps,
  prepareFixture,
  prepareReplay,
  readReplay,
  readSprintTasks,
  simulateRun,
  startSimulatedProject,
  type PreparedFixture,
  type SimulatedProject,
} from '../../scripts/simulate-run.js';
import { TRAIL_LOG, TRAIL_LOG_RUN_LOGS } from '../fixtures/index.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

async function prepared(options: Parameters<typeof prepareFixture>[0] = {}): Promise<PreparedFixture> {
  const fx = await prepareFixture(options);
  cleanups.push(() => fx.cleanup());
  return fx;
}

async function simulated(options: Parameters<typeof startSimulatedProject>[0]): Promise<SimulatedProject> {
  const sim = await startSimulatedProject(options);
  cleanups.push(() => sim.close());
  return sim;
}

/** Every `ts` in a `.jsonl` file, in ms. */
async function times(file: string): Promise<number[]> {
  const text = await readFile(file, 'utf8');
  return text
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => Date.parse((JSON.parse(l) as { ts: string }).ts));
}

describe('the trail-log fixture', () => {
  it('loads with no warnings', async () => {
    const project = await loadProject(TRAIL_LOG.root);
    expect(project.warnings).toEqual([]);
    expect(project.phases.map((p) => p.number)).toEqual([1, 2, 3]);
    expect(project.runs.map((r) => r.phase)).toEqual([1, 2]);
    expect(project.runs[0]!.events).toHaveLength(9);
    expect(project.runs[1]!.events).toHaveLength(4);
  });
});

describe('prepareFixture', () => {
  it('copies the fixture into a folder named after it and cleans up', async () => {
    const fx = await prepared({ freshness: 'as-is' });
    expect(fx.name).toBe(DEFAULT_FIXTURE);
    expect(path.basename(fx.root)).toBe(DEFAULT_FIXTURE);
    expect(existsSync(path.join(fx.phasesDir, 'Phase-2-Trip-Journal.md'))).toBe(true);
    expect(await readFile(path.join(fx.runsDir, 'phase-2.jsonl'), 'utf8')).toBe(await readFile(TRAIL_LOG_RUN_LOGS.phase2, 'utf8'));
    await fx.cleanup();
    expect(existsSync(fx.root)).toBe(false);
  });

  it('shifts timestamps so the latest event is fresh or stale, keeping the gaps', async () => {
    const now = new Date('2026-10-01T12:00:00Z');
    const original = [...(await times(TRAIL_LOG_RUN_LOGS.phase1)), ...(await times(TRAIL_LOG_RUN_LOGS.phase2))];

    for (const freshness of ['fresh', 'stale'] as const) {
      const fx = await prepared({ freshness, preparedAt: now });
      const shifted = [
        ...(await times(path.join(fx.runsDir, 'phase-1.jsonl'))),
        ...(await times(path.join(fx.runsDir, 'phase-2.jsonl'))),
      ];
      expect(Math.max(...shifted)).toBe(now.getTime() - FRESHNESS_AGE_MS[freshness]);
      const offset = shifted[0]! - original[0]!;
      expect(shifted.map((t) => t - offset)).toEqual(original);
    }
  });

  it('refuses to overwrite an existing copy', async () => {
    const first = await prepared({ freshness: 'as-is' });
    await expect(prepareFixture({ dir: path.dirname(first.root) })).rejects.toThrow(/already exists/);
  });
});

describe('simulateRun', () => {
  it('retry: plays wave 2 with a verify retry, then wave 3, all tasks done', async () => {
    const sim = await simulated({ freshness: 'as-is', script: 'retry', intervalMs: 1, startDelayMs: 0 });
    await sim.simulation.done;

    const project = await loadProject(sim.fixture.root);
    expect(project.warnings).toEqual([]);
    const runs = project.runs.find((r) => r.phase === 2)!;
    expect(runs.waves.map((w) => w.wave)).toEqual([1, 2, 3]);
    expect(runs.escalations).toEqual([]);
    const wave2 = runs.waves[1]!;
    expect(wave2.sprints.map((s) => s.sprint)).toEqual(['2.2', '2.3']);
    expect(wave2.sprints.find((s) => s.sprint === '2.3')!.steps.filter((s) => s.gate === 'verify').map((s) => s.result)).toEqual([
      'fail',
      'pass',
    ]);
    expect(wave2.endedAt).not.toBeNull();
    expect(project.progress.byPhase['2']!.percent).toBe(100);
  });

  it('escalation: ends with sprint 2.4 escalated at verify attempt 3 of 3', async () => {
    const sim = await simulated({ freshness: 'as-is', script: 'escalation', intervalMs: 1, startDelayMs: 0 });
    await sim.simulation.done;

    const project = await loadProject(sim.fixture.root);
    expect(project.warnings).toEqual([]);
    const runs = project.runs.find((r) => r.phase === 2)!;
    expect(runs.escalations).toHaveLength(1);
    expect(runs.escalations[0]).toMatchObject({ sprint: '2.4', gate: 'verify', attempt: 3, max: 3 });
    expect(project.progress.bySprint['2.4']!.done).toBe(0);
    expect(project.progress.bySprint['2.3']!.percent).toBe(100);
  });

  it('stamps each step with the clock and stops early on stop()', async () => {
    const fx = await prepared({ freshness: 'as-is' });
    const steps = buildScript('retry');
    let written = 0;
    const sim = simulateRun({
      root: fx.root,
      steps,
      intervalMs: 5,
      startDelayMs: 0,
      now: () => new Date('2026-10-01T09:30:00Z'),
      onStep: () => {
        written++;
        if (written === 2) sim.stop();
      },
    });
    await sim.done;
    expect(written).toBe(2);
    const text = await readFile(path.join(fx.runsDir, 'phase-2.jsonl'), 'utf8');
    const lines = text.trimEnd().split('\n');
    expect(lines).toHaveLength(4 + steps[0]!.events.length + steps[1]!.events.length);
    expect(lines.at(-1)).toContain('"ts":"2026-10-01T09:30:00Z"');
    expect(text.endsWith('\n')).toBe(true);
  });

  it('replay: resets the phase, seeds the steps before startAt, then plays the rest keeping the logged gaps', async () => {
    const fx = await prepared({ freshness: 'as-is' });
    const steps = await readReplay(TRAIL_LOG_RUN_LOGS.phase2);
    expect(steps.map((s) => s.events.length)).toEqual([1, 1, 1, 1]);
    expect(steps[3]!.markDone).toEqual(['2.1']);

    const phaseFile = path.join(fx.phasesDir, 'Phase-2-Trip-Journal.md');
    const origin = Date.parse('2026-10-01T09:00:00Z');
    const rest = await prepareReplay(fx.root, steps, { startAt: '2026-09-28T13:09:00Z', origin });
    expect(rest).toHaveLength(2);
    // Seeded before the first step still to play (13:09:48), on the same clock: 5 min 36 s and 4 min 17 s earlier.
    expect(await times(path.join(fx.runsDir, 'phase-2.jsonl'))).toEqual([origin - 336_000, origin - 257_000]);
    expect(await readFile(phaseFile, 'utf8')).not.toMatch(/^\| x \|/m);

    const sim = simulateRun({ root: fx.root, steps: rest, speed: 1_000_000, origin, startDelayMs: 0 });
    await sim.done;
    const written = await times(path.join(fx.runsDir, 'phase-2.jsonl'));
    expect(written.map((t) => t - written[0]!)).toEqual((await times(TRAIL_LOG_RUN_LOGS.phase2)).map((t, _, all) => t - all[0]!));
    expect(written[2]).toBe(origin);
    const project = await loadProject(fx.root);
    expect(project.warnings).toEqual([]);
    expect(project.progress.bySprint['2.1']!.percent).toBe(100);
    expect(project.progress.bySprint['2.2']!.done).toBe(0);
  });

  it('replay: fills a sprint task by task while implementing, then doc sync marks the blocked task BLOCKED', async () => {
    const fx = await prepared({ freshness: 'as-is' });
    const line = (min: number, gate: string, result: string, summary = '') =>
      JSON.stringify({ v: 1, ts: `2026-09-28T14:${String(min).padStart(2, '0')}:00Z`, phase: 2, wave: 2, sprint: '2.2', gate, result, attempt: 1, max: gate === 'doc_sync' ? 1 : 3, summary });
    const file = path.join(fx.root, 'replay.jsonl');
    await writeFile(
      file,
      [
        line(0, 'implement', 'start'),
        line(8, 'implement', 'blocked', 'done 1,3; blocked 2 — needs a product call'),
        line(9, 'verify', 'partial', 'criteria 1/2 met; 1 unverified'),
        line(10, 'doc_sync', 'pass', '3 tasks updated'),
      ].join('\n'),
      'utf8',
    );
    expect(blockedTasks('done 1,3; blocked 2 — needs a product call')).toEqual([2]);
    expect(blockedTasks('done 1,2 — blocked by nothing')).toEqual([]);

    const origin = Date.parse('2026-10-01T09:00:00Z');
    const logged = await prepareReplay(fx.root, await readReplay(file), { origin, resetLater: true });
    const steps = await fillTasks(fx.root, logged);
    // Tasks 1 and 3 fill at 1/3 and 2/3 of the implement gap; task 2 is left for the blocker.
    expect(steps.map((s) => (s.filler ? `~${s.tasks![0]!.task}` : s.events[0]!.result))).toEqual(['start', '~1', '~3', 'blocked', 'partial', 'pass']);
    // At 60×: 8 min of implementing is capped at 4 s, the fillers split it; verify and doc sync 1 s each.
    expect(paceSteps(steps, 60, 4_000).map((w) => Math.round(w))).toEqual([0, 1_333, 2_667, 4_000, 5_000, 6_000]);
    // A step's own maxGapMs replaces the cap on the wait before it, and its fillers spread over the longer wait.
    const lingering = steps.map((s, i) => (i === 3 ? { ...s, maxGapMs: 6_000 } : s));
    expect(paceSteps(lingering, 60, 4_000).map((w) => Math.round(w))).toEqual([0, 2_000, 4_000, 6_000, 7_000, 8_000]);

    const phaseFile = path.join(fx.phasesDir, 'Phase-2-Trip-Journal.md');
    const sim = simulateRun({ root: fx.root, steps: steps.slice(0, 3), speed: 1_000_000, origin, startDelayMs: 0 });
    await sim.done;
    expect(await readSprintTasks(fx.phasesDir, '2.2')).toEqual([
      { task: 1, status: '~' },
      { task: 2, status: '—' },
      { task: 3, status: '~' },
    ]);
    await simulateRun({ root: fx.root, steps: steps.slice(3), speed: 1_000_000, origin, startDelayMs: 0 }).done;
    expect(await readSprintTasks(fx.phasesDir, '2.2')).toEqual([
      { task: 1, status: 'x' },
      { task: 2, status: 'BLOCKED' },
      { task: 3, status: 'x' },
    ]);
    expect(await readFile(phaseFile, 'utf8')).toContain('| BLOCKED | 2 |');

    // resetLater: phase 3 is back to not started with no run log; phase 1 is untouched.
    const project = await loadProject(fx.root);
    expect(project.warnings).toEqual([]);
    expect(project.progress.byPhase['3']!.done).toBe(0);
    expect(project.runs.map((r) => r.phase)).toEqual([1, 2]);
    expect(project.progress.byPhase['1']!.percent).toBe(100);
  });

  it('none: writes nothing', async () => {
    const sim = await simulated({ freshness: 'as-is', script: 'none' });
    await sim.simulation.done;
    expect(await readFile(path.join(sim.fixture.runsDir, 'phase-2.jsonl'), 'utf8')).toBe(await readFile(TRAIL_LOG_RUN_LOGS.phase2, 'utf8'));
  });
});
