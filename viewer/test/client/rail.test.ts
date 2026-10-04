/**
 * The rail derivation (`src/client/rail/derive.ts`) and the run log's
 * `implement` `start` markers (`core/model.ts`, `runlog/read.ts`,
 * `derive/run.ts`): rail rows, wave durations and retries, sprint card
 * states, run notes and filter groups. Real logs of this project's Phases
 * 1, 2 and 4 are copied into `test/fixtures/runs/`; everything else is a
 * small in-memory project.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { deriveProgress } from '../../src/core/derive/progress.js';
import { deriveRun } from '../../src/core/derive/run.js';
import { uiSprintIds } from '../../src/core/load.js';
import type { Phase, PhaseRuns, Project, Warning } from '../../src/core/model.js';
import { parsePhaseFile } from '../../src/core/parser/phase.js';
import { readRunLog } from '../../src/core/runlog/read.js';
import { formatTime } from '../../src/client/format.js';
import {
  phaseGroup,
  phaseGroupCounts,
  railView,
  runEnd,
  sprintCardState,
  type RailSprint,
  type RailView,
} from '../../src/client/rail/derive.js';
import { kanbanColumn, kanbanLanes } from '../../src/client/board/derive.js';
import { notStartedTasks } from '../../src/client/data/status.js';
import { phaseBadge, taskIcon } from '../../src/client/sprint/status.js';
import { RUN_LOGS } from '../fixtures/index.js';

// ---------------------------------------------------------------------------
// In-memory projects
// ---------------------------------------------------------------------------

/** `[id, statuses]`: one task per status character (`x` done, `-` todo, `~` active, `B` blocked, `M` manual). */
type SprintSpec = [id: string, statuses: string, extra?: string];

/** A phase file with the given sprints. Every sprint has `skip-ui: true` unless `extra` says otherwise. */
function phaseMd(n: number, sprints: SprintSpec[]): string {
  const status = (c: string): string => ({ x: 'x', '-': '—', '~': '~', B: 'BLOCKED', M: 'MANUAL' })[c] ?? c;
  const blocks = sprints.map(([id, statuses, extra]) =>
    [
      `# Sprint ${id} — Sprint ${id} title`,
      '',
      '### Goal',
      '',
      `Goal of ${id}.`,
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
      extra ?? '- skip-ui: true',
      '',
      '---',
      '',
    ].join('\n'),
  );
  return [`# Phase ${n} — Phase ${n} title`, '', 'Intro.', '', '---', '', ...blocks].join('\n');
}

interface PhaseInput {
  n: number;
  sprints: SprintSpec[];
  /** Run-log text; absent for a phase with no run log. */
  log?: string;
}

/** A {@link Project} built the way `loadProject` builds one, without touching the disk. */
function makeProject(inputs: PhaseInput[]): Project {
  const phases: Phase[] = inputs.map((p) => parsePhaseFile(phaseMd(p.n, p.sprints), `/p/docs/phases/Phase-${p.n}-X.md`).phase);
  const uiSprints = uiSprintIds(phases);
  const runs: PhaseRuns[] = [];
  const warnings: Warning[] = [];
  for (const p of inputs) {
    if (p.log === undefined) continue;
    const file = `/p/docs/phases/.runs/phase-${p.n}.jsonl`;
    const read = readRunLog(p.log, file);
    warnings.push(...read.warnings);
    runs.push({ phase: p.n, file, events: read.events, ...deriveRun(read.events, { uiSprints }) });
  }
  return {
    root: '/p',
    phasesDir: '/p/docs/phases',
    phases,
    runs,
    hasDesignSystem: false,
    progress: deriveProgress(phases),
    warnings,
  };
}

/** `[minute, wave, sprint, gate, result, attempt, summary?]`: one log line, `minute` minutes after 10:00 UTC. */
type LineSpec = [number, number, string, string, string, number, string?];

function jsonl(lines: LineSpec[]): string {
  return lines
    .map(([min, wave, sprint, gate, result, attempt, summary]) => {
      const ts = new Date(Date.UTC(2026, 8, 28, 10, min, 0)).toISOString().replace('.000Z', 'Z');
      const phase = Number(sprint.split('.')[0]);
      const max = gate === 'doc_sync' ? 1 : 3;
      return JSON.stringify({ v: 1, ts, phase, wave, sprint, gate, result, attempt, max, summary: summary ?? `${gate} ${result}` });
    })
    .map((l) => `${l}\n`)
    .join('');
}

/** Minutes after 10:00 UTC on the synthetic logs' day, as epoch ms. */
function at(min: number): number {
  return Date.UTC(2026, 8, 28, 10, min, 0);
}

const fixture = (file: string): string => readFileSync(file, 'utf8');

function rail(project: Project, n: number, now?: number): RailView {
  return railView(project, project.phases.find((p) => p.number === n)!, now);
}

/** `[label, sprint ids]` per row. */
function rows(v: RailView): Array<[string, string[]]> {
  return v.rows.map((r): [string, string[]] => [r.label, r.sprints.map((s) => s.id)]);
}

function card(v: RailView, id: string): RailSprint {
  for (const r of v.rows) {
    const s = r.sprints.find((x) => x.id === id);
    if (s) return s;
  }
  throw new Error(`no card for ${id}`);
}

const PHASE_2: PhaseInput = {
  n: 2,
  sprints: [
    ['2.1', 'xxxxxx'],
    ['2.2', 'xxxxxx'],
    ['2.3', 'xxxxx'],
    ['2.4', 'xxxxx'],
    ['2.5', 'xxxxxx'],
  ],
};

const PHASE_4: PhaseInput = {
  n: 4,
  sprints: [
    ['4.1', 'xxxxx', '- ui: /'],
    ['4.2', 'xxxxxx', '- ui: /live'],
    ['4.3', 'xxxxxxxx', '- ui: /live'],
  ],
};

// ---------------------------------------------------------------------------
// Real logs
// ---------------------------------------------------------------------------

describe('the real Phase 2 log', () => {
  const project = makeProject([{ ...PHASE_2, log: fixture(RUN_LOGS.realPhase2Full) }]);
  const v = rail(project, 2);

  it('reads with zero warnings (no implement start lines)', () => {
    expect(project.warnings).toEqual([]);
  });

  it('gives four wave rows, wave 2 parallel', () => {
    expect(rows(v)).toEqual([
      ['Wave 1', ['2.1']],
      ['Wave 2', ['2.2', '2.3']],
      ['Wave 3', ['2.4']],
      ['Wave 4', ['2.5']],
    ]);
    expect(v.rows.map((r) => r.parallel)).toEqual([false, true, false, false]);
    expect(v.rows.every((r) => r.state === 'done')).toBe(true);
  });

  it('times each wave from the previous wave end; the first has no start', () => {
    expect(v.rows.map((r) => r.durationText)).toEqual(['start not logged', '15 min', '13 min', '16 min']);
    expect(v.rows[1]!.startedAt).toBe('2026-09-28T23:54:59Z');
    expect(v.rows[1]!.endedAt).toBe('2026-09-29T00:09:29Z');
    expect(v.rows.map((r) => r.retries)).toEqual([0, 0, 0, 0]);
    expect(v.summaryText).toBe('4 waves · 0 retries');
  });

  it('keeps a partial verify as a "passed with notes" run note', () => {
    const notes = card(v, '2.3').runNotes;
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({
      kind: 'notes',
      gate: 'verify',
      result: 'partial',
      title: 'Verify attempt 1 passed with notes',
      summary: 'criteria 4/4 met; scope note: model.ts, fixtures/index.ts, .gitattributes outside declared Module cells',
      time: formatTime('2026-09-29T00:07:57Z'),
      resolution: null,
    });
    expect(card(v, '2.2').runNotes).toEqual([]);
  });

  it('shows every sprint complete', () => {
    expect(v.rows.flatMap((r) => r.sprints.map((s) => s.stateText))).toEqual(Array(5).fill('Complete'));
  });
});

describe('the real Phase 4 log (verify fails twice, then passes)', () => {
  const project = makeProject([{ ...PHASE_4, log: fixture(RUN_LOGS.realPhase4) }]);
  const v = rail(project, 4);

  it('gives wave 2 as 27 min with 2 retries', () => {
    expect(project.warnings).toEqual([]);
    expect(rows(v)).toEqual([
      ['Wave 1', ['4.1']],
      ['Wave 2', ['4.2']],
      ['Wave 3', ['4.3']],
    ]);
    expect(v.rows[1]!.metaText).toBe('27 min · 2 retries');
    expect(v.rows[1]!.retries).toBe(2);
    expect(v.rows[0]!.metaText).toBe('start not logged');
    expect(v.summaryText).toBe('3 waves · 2 retries');
  });

  it('gives 4.2 two failed-verify run notes, the second fixed by implement attempt 3', () => {
    const notes = card(v, '4.2').runNotes;
    expect(notes.map((n) => [n.kind, n.gate, n.attempt])).toEqual([
      ['failed', 'verify', 1],
      ['failed', 'verify', 2],
    ]);
    expect(notes[0]!.title).toBe('Verify attempt 1 failed');
    expect(notes[0]!.summary).toMatch(/^npm run check fails/);
    expect(notes[0]!.time).toBe(formatTime('2026-09-29T02:03:59Z'));
    expect(notes[1]!.resolution).toEqual({
      implementAttempt: 3,
      gate: 'verify',
      attempt: 3,
      ts: '2026-09-29T02:11:06Z',
    });
    expect(notes[1]!.resolutionText).toBe(
      `Fixed in implement attempt 3; verify passed at ${formatTime('2026-09-29T02:11:06Z')}.`,
    );
  });
});

// ---------------------------------------------------------------------------
// Groups without events
// ---------------------------------------------------------------------------

describe('sprints without events', () => {
  it('puts sprints that ran before the log in a leading "No run log" row', () => {
    const project = makeProject([
      {
        n: 1,
        sprints: [
          ['1.1', 'xxx'],
          ['1.2', 'xx'],
          ['1.3', 'xxxx'],
          ['1.4', 'xxxxx'],
        ],
        log: fixture(RUN_LOGS.realPhase1),
      },
    ]);
    const v = rail(project, 1);
    expect(rows(v)).toEqual([
      ['No run log', ['1.1', '1.2', '1.3']],
      ['Wave 1', ['1.4']],
    ]);
    expect(v.rows[0]).toMatchObject({ kind: 'no-run-log', wave: null, durationText: null, metaText: null });
    expect(v.summaryText).toBe('1 wave · 0 retries');
    // 1.4's verify was partial.
    expect(card(v, '1.4').runNotes.map((n) => n.title)).toEqual(['Verify attempt 1 passed with notes']);
  });

  it('puts a sprint added after the run in a trailing "Not run yet" row', () => {
    const project = makeProject([
      {
        n: 3,
        sprints: [
          ['3.1', 'xx'],
          ['3.2', '--'],
          ['3.3', 'xx'],
        ],
        log: jsonl([
          [0, 1, '3.1', 'implement', 'pass', 1],
          [2, 1, '3.1', 'verify', 'pass', 1],
          [3, 1, '3.1', 'doc_sync', 'pass', 1],
          [5, 2, '3.3', 'implement', 'pass', 1],
          [6, 2, '3.3', 'verify', 'pass', 1],
          [8, 2, '3.3', 'doc_sync', 'pass', 1],
        ]),
      },
    ]);
    const v = rail(project, 3);
    expect(rows(v)).toEqual([
      ['Wave 1', ['3.1']],
      ['Wave 2', ['3.3']],
      ['Not run yet', ['3.2']],
    ]);
    expect(card(v, '3.2').stateText).toBe('Not started');
  });

  it('gives a phase with no run log one "Not run yet" row with every sprint in plan order', () => {
    const project = makeProject([
      {
        n: 5,
        sprints: [
          ['5.1', 'xx'],
          ['5.2', 'x-'],
          ['5.3', '--'],
        ],
      },
    ]);
    const v = rail(project, 5);
    expect(v.hasRunLog).toBe(false);
    expect(rows(v)).toEqual([['Not run yet', ['5.1', '5.2', '5.3']]]);
    expect(v.rows[0]!.kind).toBe('not-run');
    expect(v.waves).toBe(0);
    expect(v.summaryText).toBeNull();
    expect(v.rows[0]!.sprints.map((s) => s.stateText)).toEqual(['Complete', 'Waiting', 'Not started']);
    expect(v.rows[0]!.sprints.every((s) => s.runNotes.length === 0)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Wave start, running waves and implement start markers
// ---------------------------------------------------------------------------

describe('wave start', () => {
  it('uses the first implement start marker of the first wave', () => {
    const log = jsonl([
      [0, 1, '6.1', 'implement', 'start', 1],
      [9, 1, '6.1', 'implement', 'pass', 1],
      [10, 1, '6.1', 'verify', 'pass', 1],
      [12, 1, '6.1', 'doc_sync', 'pass', 1],
    ]);
    const project = makeProject([{ n: 6, sprints: [['6.1', 'xx']], log }]);
    expect(project.warnings).toEqual([]);
    const v = rail(project, 6);
    expect(v.rows[0]!.startedAt).toBe('2026-09-28T10:00:00Z');
    expect(v.rows[0]!.durationText).toBe('12 min');
  });

  it('reads "start not logged" for a first wave without one', () => {
    const log = jsonl([
      [9, 1, '6.1', 'implement', 'pass', 1],
      [10, 1, '6.1', 'verify', 'pass', 1],
      [12, 1, '6.1', 'doc_sync', 'pass', 1],
    ]);
    const v = rail(makeProject([{ n: 6, sprints: [['6.1', 'xx']], log }]), 6);
    expect(v.rows[0]!.startedAt).toBeNull();
    expect(v.rows[0]!.durationText).toBe('start not logged');
  });

  it('places a next-wave start marker logged before the previous doc sync in its own wave', () => {
    const log = jsonl([
      [0, 1, '6.1', 'implement', 'start', 1],
      [9, 1, '6.1', 'implement', 'pass', 1],
      [10, 1, '6.1', 'verify', 'pass', 1],
      [11, 2, '6.2', 'implement', 'start', 1],
      [12, 1, '6.1', 'doc_sync', 'pass', 1],
      [20, 2, '6.2', 'implement', 'pass', 1],
      [21, 2, '6.2', 'verify', 'pass', 1],
      [23, 2, '6.2', 'doc_sync', 'pass', 1],
    ]);
    const project = makeProject([{ n: 6, sprints: [['6.1', 'xx'], ['6.2', 'xx']], log }]);
    const runs = project.runs[0]!;
    expect(runs.waves.map((w) => [w.run, w.wave])).toEqual([
      [1, 1],
      [1, 2],
    ]);
    const v = rail(project, 6);
    expect(v.rows.map((r) => r.durationText)).toEqual(['12 min', '12 min']);
    expect(v.rows.map((r) => r.state)).toEqual(['done', 'done']);
  });

  it('keeps start markers out of steps, attempts and retries', () => {
    const log = jsonl([
      [0, 1, '6.1', 'implement', 'start', 1],
      [5, 1, '6.1', 'implement', 'pass', 1],
      [6, 1, '6.1', 'verify', 'fail', 1],
      [7, 1, '6.1', 'implement', 'start', 2],
      [9, 1, '6.1', 'implement', 'pass', 2],
      [10, 1, '6.1', 'verify', 'pass', 2],
      [11, 1, '6.1', 'doc_sync', 'pass', 1],
    ]);
    const project = makeProject([{ n: 6, sprints: [['6.1', 'xx']], log }]);
    const sr = project.runs[0]!.sprintHistory['6.1']![0]!;
    expect(sr.events).toHaveLength(7);
    expect(sr.steps.map((s) => `${s.gate}:${s.result}#${s.seq}`)).toEqual([
      'implement:pass#1',
      'verify:fail#1',
      'implement:pass#2',
      'verify:pass#2',
      'doc_sync:pass#1',
    ]);
    const v = rail(project, 6);
    expect(v.rows[0]!.metaText).toBe('11 min · 1 retry');
    expect(card(v, '6.1').runNotes.map((n) => n.resolutionText)).toEqual([
      `Fixed in implement attempt 2; verify passed at ${formatTime('2026-09-28T10:10:00Z')}.`,
    ]);
  });
});

describe('a running wave', () => {
  const done: LineSpec[] = [
    [0, 1, '7.1', 'implement', 'pass', 1],
    [1, 1, '7.1', 'verify', 'pass', 1],
    [2, 1, '7.1', 'doc_sync', 'pass', 1],
  ];

  it('reads "N min so far" from the previous wave end', () => {
    const project = makeProject([
      {
        n: 7,
        sprints: [['7.1', 'xx'], ['7.2', '--'], ['7.3', '--']],
        log: jsonl([...done, [10, 2, '7.2', 'implement', 'pass', 1], [10, 2, '7.3', 'implement', 'pass', 1]]),
      },
    ]);
    const v = rail(project, 7, at(14));
    const wave2 = v.rows[1]!;
    expect(wave2).toMatchObject({ label: 'Wave 2', state: 'running', parallel: true, endedAt: null });
    expect(wave2.durationText).toBe('12 min so far');
    expect(card(v, '7.2').stateText).toBe('Verifying');
  });

  it('reads "Implementing" after a start marker, and from the marker time', () => {
    const project = makeProject([
      {
        n: 7,
        sprints: [['7.1', 'xx'], ['7.2', '--']],
        log: jsonl([...done, [3, 2, '7.2', 'implement', 'start', 1]]),
      },
    ]);
    const v = rail(project, 7, at(8));
    expect(rows(v)).toEqual([
      ['Wave 1', ['7.1']],
      ['Wave 2', ['7.2']],
    ]);
    expect(v.rows[1]!.durationText).toBe('5 min so far');
    expect(card(v, '7.2').stateText).toBe('Implementing');
    expect(phaseGroup(project, project.phases[0]!)).toBe('progress');
  });
});

// ---------------------------------------------------------------------------
// Sprint card states
// ---------------------------------------------------------------------------

describe('sprint card states', () => {
  const head: LineSpec[] = [
    [0, 1, '8.1', 'implement', 'pass', 1],
    [2, 1, '8.1', 'verify', 'pass', 1],
  ];

  it('reads Verifying mid-verify, then Waiting after doc sync with a manual task left', () => {
    const mid = makeProject([{ n: 8, sprints: [['8.1', '---']], log: jsonl(head.slice(0, 1)) }]);
    expect(sprintCardState(mid, mid.phases[0]!.sprints[0]!)).toBe('verifying');
    expect(card(rail(mid, 8), '8.1').stateText).toBe('Verifying');

    const after = makeProject([
      { n: 8, sprints: [['8.1', 'xx-']], log: jsonl([...head, [3, 1, '8.1', 'doc_sync', 'pass', 1]]) },
    ]);
    expect(card(rail(after, 8), '8.1').stateText).toBe('Waiting');
  });

  it('reads Doc syncing for a data wave and Wave testing for a UI wave after verify', () => {
    const data = makeProject([{ n: 8, sprints: [['8.1', '--']], log: jsonl(head) }]);
    expect(card(rail(data, 8), '8.1').stateText).toBe('Doc syncing');
    const ui = makeProject([{ n: 8, sprints: [['8.1', '--', '- ui: /']], log: jsonl(head) }]);
    expect(card(rail(ui, 8), '8.1').stateText).toBe('Wave testing');
  });

  it('reads Verify failed, then Re-implementing and Re-verifying while a failed verify is retried, counting the retry from its start line', () => {
    const failed: LineSpec[] = [head[0]!, [2, 1, '8.1', 'verify', 'fail', 1, 'test: 2 failing']];
    const project = makeProject([{ n: 8, sprints: [['8.1', '--']], log: jsonl(failed) }]);
    const v = rail(project, 8);
    expect(card(v, '8.1').state).toBe('verify-failed');
    expect(card(v, '8.1').stateText).toBe('Verify failed');
    expect(card(v, '8.1').failure).toMatchObject({
      note: { gate: 'verify', attempt: 1, title: 'Verify attempt 1 failed', summary: 'test: 2 failing' },
      statusText: 'Retry next · 2 attempts left',
    });
    expect(v.rows[0]!.retries).toBe(0);
    expect(runEnd(v)).toBeNull();
    expect(phaseGroup(project, project.phases[0]!)).toBe('progress');
    expect(kanbanColumn(project, project.phases[0]!).tiles[0]).toMatchObject({ state: 'verify-failed', running: true });

    const retrying = makeProject([{ n: 8, sprints: [['8.1', '--']], log: jsonl([...failed, [3, 1, '8.1', 'implement', 'start', 2]]) }]);
    const r = rail(retrying, 8);
    expect(card(r, '8.1').stateText).toBe('Re-implementing');
    expect(card(r, '8.1').failure?.statusText).toBe('Retrying with the failure attached');
    expect(r.rows[0]!.retries).toBe(1);

    const retried = makeProject([
      { n: 8, sprints: [['8.1', '--']], log: jsonl([...failed, [3, 1, '8.1', 'implement', 'start', 2], [5, 1, '8.1', 'implement', 'pass', 2]]) },
    ]);
    const rv = rail(retried, 8);
    expect(card(rv, '8.1').stateText).toBe('Re-verifying');
    expect(card(rv, '8.1').failure?.statusText).toBe('Verifying the retry');
    expect(rv.rows[0]!.retries).toBe(1);

    // Verify passes: the failure is fixed, so the open card no longer shows it (Run notes keeps it).
    const fixed = makeProject([
      {
        n: 8,
        sprints: [['8.1', '--']],
        log: jsonl([...failed, [3, 1, '8.1', 'implement', 'start', 2], [5, 1, '8.1', 'implement', 'pass', 2], [6, 1, '8.1', 'verify', 'pass', 2]]),
      },
    ]);
    expect(card(rail(fixed, 8), '8.1').stateText).toBe('Doc syncing');
    expect(card(rail(fixed, 8), '8.1').failure).toBeNull();
    expect(card(rail(fixed, 8), '8.1').runNotes).toHaveLength(1);
  });

  it('reads Wave test failed, then the retry through Re-verifying and Wave retesting', () => {
    const ui: SprintSpec = ['8.1', '--', '- ui: /'];
    const failed: LineSpec[] = [...head, [3, 1, '8.1', 'wave_test', 'fail', 1, 'banner scrolls sideways at 375px']];
    const state = (lines: LineSpec[]): string => card(rail(makeProject([{ n: 8, sprints: [ui], log: jsonl(lines) }]), 8), '8.1').stateText;
    expect(state(head)).toBe('Wave testing');
    expect(state(failed)).toBe('Wave test failed');
    const retry: LineSpec[] = [...failed, [4, 1, '8.1', 'implement', 'start', 2]];
    expect(state(retry)).toBe('Re-implementing');
    expect(state([...retry, [5, 1, '8.1', 'implement', 'pass', 2]])).toBe('Re-verifying');
    const retest: LineSpec[] = [...retry, [5, 1, '8.1', 'implement', 'pass', 2], [6, 1, '8.1', 'verify', 'pass', 2]];
    expect(state(retest)).toBe('Wave retesting');
    const v = rail(makeProject([{ n: 8, sprints: [ui], log: jsonl(retest) }]), 8);
    expect(card(v, '8.1').failure?.note.gate).toBe('wave_test');
  });

  it('reads Needs you, not Verify failed, once verify fails at the retry limit', () => {
    const lines: LineSpec[] = [head[0]!, [2, 1, '8.1', 'verify', 'fail', 3]];
    const v = rail(makeProject([{ n: 8, sprints: [['8.1', '--']], log: jsonl(lines) }]), 8);
    expect(card(v, '8.1').state).toBe('needs-you');
    expect(card(v, '8.1').failure).toBeNull();
  });

  it('runEnd: nothing while a gate runs; "Phase run complete" once done; what needs you when a task is blocked', () => {
    const wave1: LineSpec[] = [
      [0, 1, '8.1', 'implement', 'start', 1],
      [5, 1, '8.1', 'implement', 'pass', 1],
      [6, 1, '8.1', 'verify', 'pass', 1],
    ];
    const running = makeProject([{ n: 8, sprints: [['8.1', '--']], log: jsonl(wave1) }]);
    expect(runEnd(rail(running, 8))).toBeNull();

    const done = makeProject([{ n: 8, sprints: [['8.1', 'xx']], log: jsonl([...wave1, [7, 1, '8.1', 'doc_sync', 'pass', 1]]) }]);
    expect(runEnd(rail(done, 8))).toEqual({ kind: 'pass', title: 'Phase run complete', attentionText: null, items: [] });

    const blocked = makeProject([
      {
        n: 8,
        sprints: [['8.1', 'xx'], ['8.2', 'xBx']],
        log: jsonl([
          ...wave1,
          [7, 1, '8.1', 'doc_sync', 'pass', 1],
          [8, 2, '8.2', 'implement', 'start', 1],
          [12, 2, '8.2', 'implement', 'blocked', 1, 'done 1,3; blocked 2 — needs a call'],
          [13, 2, '8.2', 'verify', 'partial', 1],
          [14, 2, '8.2', 'doc_sync', 'pass', 1],
        ]),
      },
    ]);
    expect(runEnd(rail(blocked, 8))).toEqual({
      kind: 'needs',
      title: 'Phase run complete',
      attentionText: '1 task needs your attention',
      items: ['Sprint 8.2 · task 2 blocked'],
    });

    // Stopped with a sprint left and nothing blocked: no line.
    const stopped = makeProject([{ n: 8, sprints: [['8.1', 'xx'], ['8.2', '--']], log: jsonl([...wave1, [7, 1, '8.1', 'doc_sync', 'pass', 1]]) }]);
    expect(runEnd(rail(stopped, 8))).toBeNull();
  });

  it('notStartedTasks: counts only the to-do and manual tasks of sprints that have not started', () => {
    const project = makeProject([
      { n: 8, sprints: [['8.1', 'x-M'], ['8.2', '--M'], ['8.3', '~-']], log: jsonl([[0, 1, '8.1', 'implement', 'start', 1]]) },
    ]);
    expect(notStartedTasks(project, project.phases[0]!)).toEqual({ todo: 2, manual: 1 });
    expect(kanbanColumn(project, project.phases[0]!).notStarted).toEqual({ todo: 2, manual: 1 });
  });

  it('reads Waiting for a sprint that passed verify while its parallel sibling retries, then Doc syncing once both pass', () => {
    const wave: LineSpec[] = [
      [0, 1, '8.1', 'implement', 'start', 1],
      [0, 1, '8.2', 'implement', 'start', 1],
      [5, 1, '8.1', 'implement', 'pass', 1],
      [5, 1, '8.2', 'implement', 'pass', 1],
      [6, 1, '8.1', 'verify', 'pass', 1],
      [6, 1, '8.2', 'verify', 'fail', 1],
      [7, 1, '8.2', 'implement', 'start', 2],
    ];
    const sprints: SprintSpec[] = [['8.1', '--'], ['8.2', '--']];
    const retrying = makeProject([{ n: 8, sprints, log: jsonl(wave) }]);
    expect(card(rail(retrying, 8), '8.1').stateText).toBe('Waiting');
    expect(card(rail(retrying, 8), '8.2').stateText).toBe('Re-implementing');
    expect(sprintCardState(retrying, retrying.phases[0]!.sprints[0]!)).toBe('waiting');
    expect(phaseGroup(retrying, retrying.phases[0]!)).toBe('progress');

    const reverifying = makeProject([{ n: 8, sprints, log: jsonl([...wave, [9, 1, '8.2', 'implement', 'pass', 2]]) }]);
    expect(card(rail(reverifying, 8), '8.1').stateText).toBe('Waiting');
    expect(card(rail(reverifying, 8), '8.2').stateText).toBe('Re-verifying');

    const passed = makeProject([
      {
        n: 8,
        sprints,
        log: jsonl([...wave, [9, 1, '8.2', 'implement', 'pass', 2], [10, 1, '8.1', 'verify', 'pass', 2], [10, 1, '8.2', 'verify', 'pass', 2]]),
      },
    ]);
    expect(card(rail(passed, 8), '8.1').stateText).toBe('Doc syncing');
    expect(card(rail(passed, 8), '8.2').stateText).toBe('Doc syncing');
  });

  it('reads Needs you for a blocked task or an open escalation', () => {
    const blocked = makeProject([{ n: 8, sprints: [['8.1', 'xB']] }]);
    expect(card(rail(blocked, 8), '8.1').stateText).toBe('Needs you');

    const escalated = makeProject([
      {
        n: 8,
        sprints: [['8.1', '--']],
        log: jsonl([
          [0, 1, '8.1', 'implement', 'pass', 1],
          [1, 1, '8.1', 'verify', 'fail', 1],
          [2, 1, '8.1', 'implement', 'pass', 2],
          [3, 1, '8.1', 'verify', 'fail', 2],
          [4, 1, '8.1', 'implement', 'pass', 3],
          [5, 1, '8.1', 'verify', 'fail', 3],
        ]),
      },
    ]);
    const v = rail(escalated, 8, at(9));
    expect(card(v, '8.1').stateText).toBe('Needs you');
    expect(card(v, '8.1').runNotes.map((n) => [n.title, n.resolution])).toEqual([
      ['Verify attempt 1 failed', null],
      ['Verify attempt 2 failed', null],
      ['Verify attempt 3 failed', null],
    ]);
    expect(v.rows[0]!.metaText).toBe('start not logged · 2 retries');
    expect(v.rows[0]!.retries).toBe(2);
  });
});

describe('manual tasks', () => {
  it('read Needs you in the violet manual state once they are all that is left in a started sprint', () => {
    const project = makeProject([{ n: 8, sprints: [['8.1', 'xM'], ['8.2', 'xxMM']] }]);
    const v = rail(project, 8);
    expect(card(v, '8.1').state).toBe('manual');
    expect(card(v, '8.1').stateText).toBe('Needs you');
    expect(card(v, '8.2').state).toBe('manual');
    // The kanban tile follows the card.
    expect(kanbanColumn(project, project.phases[0]!).tiles.map((t) => t.state)).toEqual(['manual', 'manual']);
    // The phase badge reads Needs you in violet.
    expect(phaseBadge(project, project.phases[0]!)).toEqual({ kind: 'manual', text: 'Needs you' });
  });

  it('do not read Needs you while another task is left for the agents', () => {
    const project = makeProject([{ n: 8, sprints: [['8.1', 'x-M'], ['8.2', '~M']] }]);
    const v = rail(project, 8);
    expect(card(v, '8.1').state).toBe('waiting');
    expect(card(v, '8.2').state).toBe('not-started');
    expect(phaseBadge(project, project.phases[0]!).kind).not.toBe('manual');
  });

  it('read the running gate, not Needs you, while the sprint is being built', () => {
    const sprints: SprintSpec[] = [['8.1', '--M'], ['8.2', '--M']];
    const started: LineSpec[] = [
      [0, 1, '8.1', 'implement', 'start', 1],
      [0, 1, '8.2', 'implement', 'start', 1],
    ];
    const implementing = makeProject([{ n: 8, sprints, log: jsonl(started) }]);
    expect(rail(implementing, 8).rows.flatMap((r) => r.sprints.map((s) => s.stateText))).toEqual(['Implementing', 'Implementing']);
    expect(phaseBadge(implementing, implementing.phases[0]!)).toEqual({ kind: 'run', text: 'Running · wave 1 of 1' });

    // Doc sync has ticked the tasks but its line isn't logged yet: still the gate.
    const gates: LineSpec[] = [
      ...started,
      [5, 1, '8.1', 'implement', 'pass', 1],
      [5, 1, '8.2', 'implement', 'pass', 1],
      [6, 1, '8.1', 'verify', 'pass', 1],
      [6, 1, '8.2', 'verify', 'pass', 1],
    ];
    const done: SprintSpec[] = [['8.1', 'xxM'], ['8.2', 'xxM']];
    const syncing = makeProject([{ n: 8, sprints: done, log: jsonl(gates) }]);
    expect(card(rail(syncing, 8), '8.1').stateText).toBe('Doc syncing');

    // The wave is done and only the manual tasks are left: Needs you.
    const synced = makeProject([
      { n: 8, sprints: done, log: jsonl([...gates, [7, 1, '8.1', 'doc_sync', 'pass', 1], [7, 1, '8.2', 'doc_sync', 'pass', 1]]) },
    ]);
    expect(rail(synced, 8).rows.flatMap((r) => r.sprints.map((s) => s.state))).toEqual(['manual', 'manual']);
    expect(phaseBadge(synced, synced.phases[0]!)).toEqual({ kind: 'manual', text: 'Needs you' });
  });

  it('give way to pink when the sprint also has a blocked task', () => {
    const project = makeProject([{ n: 8, sprints: [['8.1', 'xBM']] }]);
    const v = rail(project, 8);
    expect(card(v, '8.1').state).toBe('needs-you');
    expect(card(v, '8.1').stateText).toBe('Needs you');
    expect(kanbanColumn(project, project.phases[0]!).tiles.map((t) => t.state)).toEqual(['needs-you']);
    expect(phaseBadge(project, project.phases[0]!)).toEqual({ kind: 'needs', text: '1 task blocked' });
  });

  it('give way to pink in the phase badge when another sprint is blocked or escalated', () => {
    const blocked = makeProject([{ n: 8, sprints: [['8.1', 'xM'], ['8.2', 'xB']] }]);
    expect(rail(blocked, 8).rows.flatMap((r) => r.sprints.map((s) => s.state))).toEqual(['manual', 'needs-you']);
    expect(phaseBadge(blocked, blocked.phases[0]!).kind).toBe('needs');

    const escalated = makeProject([
      {
        n: 8,
        sprints: [['8.1', 'xM'], ['8.2', '--']],
        log: jsonl([
          [0, 1, '8.2', 'implement', 'pass', 1],
          [1, 1, '8.2', 'verify', 'fail', 1],
          [2, 1, '8.2', 'implement', 'pass', 2],
          [3, 1, '8.2', 'verify', 'fail', 2],
          [4, 1, '8.2', 'implement', 'pass', 3],
          [5, 1, '8.2', 'verify', 'fail', 3],
        ]),
      },
    ]);
    expect(phaseBadge(escalated, escalated.phases[0]!)).toEqual({ kind: 'needs', text: 'Needs you' });
  });

  it('get their own icon in the tasks table, apart from blocked', () => {
    expect(taskIcon('manual')).toBe('manual');
    expect(taskIcon('blocked')).toBe('needs');
  });

  it('read Needs you (manual) when the sprint has run events, even with nothing done', () => {
    const project = makeProject([
      {
        n: 8,
        sprints: [['8.1', 'M']],
        log: jsonl([
          [0, 1, '8.1', 'implement', 'pass', 1],
          [1, 1, '8.1', 'verify', 'pass', 1],
          [2, 1, '8.1', 'doc_sync', 'pass', 1],
        ]),
      },
    ]);
    expect(sprintCardState(project, project.phases[0]!.sprints[0]!)).toBe('manual');
  });

  it('leave a sprint that has not started Not started', () => {
    const project = makeProject([{ n: 8, sprints: [['8.1', 'M-'], ['8.2', 'M']] }]);
    const v = rail(project, 8);
    expect(card(v, '8.1').state).toBe('not-started');
    expect(card(v, '8.2').state).toBe('not-started');
    expect(kanbanColumn(project, project.phases[0]!).tiles.map((t) => t.state)).toEqual(['not-started', 'not-started']);
    // Not work: the sprints stay in "Not run yet", not "No run log".
    expect(rows(v)).toEqual([['Not run yet', ['8.1', '8.2']]]);
  });

  it('keep a sprint with only manual tasks left from Complete', () => {
    const project = makeProject([{ n: 8, sprints: [['8.1', 'xxM']] }]);
    expect(card(rail(project, 8), '8.1').stateText).toBe('Needs you');
  });

  it('keep a phase with only manual tasks left in progress', () => {
    const project = makeProject([
      { n: 1, sprints: [['1.1', 'xxM']] },
      { n: 2, sprints: [['2.1', 'xx'], ['2.2', 'M']] },
    ]);
    expect(phaseGroup(project, project.phases[0]!)).toBe('progress');
    expect(phaseGroup(project, project.phases[1]!)).toBe('progress');
    // The unstarted manual sprint in an otherwise complete phase reads Not started.
    expect(card(rail(project, 2), '2.2').state).toBe('not-started');
  });

  it('do not count as work started: manual and todo with nothing done is future', () => {
    const project = makeProject([
      { n: 3, sprints: [['3.1', 'M-'], ['3.2', '--']] },
      { n: 4, sprints: [['4.1', 'MM']] },
    ]);
    expect(phaseGroup(project, project.phases[0]!)).toBe('future');
    expect(phaseGroup(project, project.phases[1]!)).toBe('future');
    expect(phaseGroupCounts(project)).toEqual({ all: 2, progress: 0, complete: 0, future: 2 });
  });
});

// ---------------------------------------------------------------------------
// Filter groups
// ---------------------------------------------------------------------------

describe('filter groups', () => {
  it('sorts phases into complete, in progress and not started, with counts', () => {
    const project = makeProject([
      { ...PHASE_2, log: fixture(RUN_LOGS.realPhase2Full) },
      { n: 3, sprints: [['3.1', 'x-']] },
      { n: 5, sprints: [['5.1', '--']] },
      { n: 6, sprints: [['6.1', '--']], log: jsonl([[0, 1, '6.1', 'implement', 'pass', 1]]) },
      { n: 7, sprints: [['7.1', '-B']] },
    ]);
    const groups = Object.fromEntries(project.phases.map((p) => [p.number, phaseGroup(project, p)]));
    expect(groups).toEqual({ 2: 'complete', 3: 'progress', 5: 'future', 6: 'progress', 7: 'progress' });
    expect(phaseGroupCounts(project)).toEqual({ all: 5, progress: 3, complete: 1, future: 1 });
    // The kanban's lanes, left to right: not started, in progress, complete.
    expect(kanbanLanes(project).map((l) => [l.label, l.columns.map((c) => c.number)])).toEqual([
      ['Not started', [5]],
      ['In progress', [3, 6, 7]],
      ['Complete', [2]],
    ]);
  });

  it('keeps a lane with no phases, empty', () => {
    const project = makeProject([{ n: 3, sprints: [['3.1', 'x-']] }]);
    expect(kanbanLanes(project).map((l) => [l.group, l.columns.length])).toEqual([
      ['future', 0],
      ['progress', 1],
      ['complete', 0],
    ]);
  });

  it('keeps a complete phase with a sprint implementing again in progress', () => {
    const project = makeProject([
      {
        n: 9,
        sprints: [['9.1', 'xx']],
        log: jsonl([
          [0, 1, '9.1', 'implement', 'pass', 1],
          [1, 1, '9.1', 'verify', 'pass', 1],
          [2, 1, '9.1', 'doc_sync', 'pass', 1],
          [5, 1, '9.1', 'implement', 'start', 1],
        ]),
      },
    ]);
    // Same wave number, no drop: it reads as a continuation of wave 1, as other lines do.
    expect(project.runs[0]!.waves.map((w) => [w.run, w.wave, w.events.length])).toEqual([[1, 1, 4]]);
    expect(project.runs[0]!.sprintHistory['9.1']![0]!.state).toBe('implementing');
    expect(phaseGroup(project, project.phases[0]!)).toBe('progress');
  });
});

// ---------------------------------------------------------------------------
// Run log: implement start
// ---------------------------------------------------------------------------

describe('implement start lines', () => {
  it('read without warnings on implement, as markers', () => {
    const { events, warnings } = readRunLog(jsonl([[0, 1, '6.1', 'implement', 'start', 1]]), 'x.jsonl');
    expect(warnings).toEqual([]);
    expect(events[0]).toMatchObject({ gate: 'implement', result: 'start', rawResult: 'start' });
  });

  it('warn and read as unknown on any other gate', () => {
    const { events, warnings } = readRunLog(jsonl([[0, 1, '6.1', 'verify', 'start', 1]]), 'x.jsonl');
    expect(events[0]!.result).toBe('unknown');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.message).toMatch(/only used on implement/);
  });

  it('leave logs without them unchanged', () => {
    for (const file of [RUN_LOGS.realPhase1, RUN_LOGS.realPhase2Full, RUN_LOGS.realPhase4]) {
      const { events, warnings } = readRunLog(fixture(file), file);
      expect(warnings).toEqual([]);
      const derived = deriveRun(events);
      expect(derived.waves.flatMap((w) => w.events)).toEqual(events);
    }
  });
});
