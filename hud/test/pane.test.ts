/**
 * The Phase Runner pane, through the loaded mod and drawn on the terminal and
 * the desktop: the phase list, a phase's rail with its waves and sprint cards,
 * the banners, and the presses that move between them. The pure parts of
 * `pane.tsx` and `project.ts` are called directly at the end.
 */
import { describe, expect, test } from 'claude-code/testing';

import { barCells, barSvg, hasRichText, segments } from '../hooks/pane.js';
import { assembleProject } from '../hooks/project.js';
import { PHASE_4_PLAN, PHASE_4_RETRIES, PHASE_4_WAVE_1, PHASE_4_WAVE_2_END } from './fixtures.js';
import { PHASES, PHASE_4_LOG, ROOT, act, hud, labelOf, phase4 } from './harness.js';

const SURFACES = ['terminal', 'desktop'] as const;

/** A second phase with nothing run yet. */
const PHASE_5_PLAN = PHASE_4_PLAN.replace('# Phase 4 — Live Run', '# Phase 5 — Polish')
  .replace(/Sprint 4\./g, 'Sprint 5.')
  .replace(/\| x \|/g, '| — |');

/** Long after the Phase 4 log's last line: nothing is live. */
const QUIET = Date.parse('2026-09-29T09:00:00Z');

test('lists the phases by group, and a press opens one', async ($, on) => {
  const h = phase4(on, QUIET);
  h.write(`${PHASES}/Phase-5-Polish.md`, PHASE_5_PLAN);
  await h.start($);

  for (const surface of SURFACES) {
    const ui = await h.pane($, surface);
    expect(await ui.find({ text: 'IN PROGRESS · 1' })).toBeDefined();
    expect(await ui.find({ text: 'NOT STARTED · 1' })).toBeDefined();
    // A whole card opens its phase: a clear region over it on the desktop, a Button on the terminal.
    expect(await ui.find({ key: 'open:phase:4' })).toBeDefined();
    expect(await ui.find({ key: 'open:phase:5' })).toBeDefined();
    if (surface === 'terminal') expect(await labelOf(ui, 'open:phase:4')).toBe('Open Live Run');
    expect(await ui.find({ key: 'back' })).toBeUndefined();

    await act(ui, 'open:phase:4');
    expect(await ui.find({ key: 'back' })).toBeDefined();
    expect(await ui.find({ text: 'PHASE 4' })).toBeDefined();
    expect(await ui.find({ key: 'card:4.1' })).toBeDefined();
    expect(await ui.find({ key: 'card:4.2' })).toBeDefined();

    await act(ui, 'back');
    expect(await ui.find({ key: 'open:phase:4' })).toBeDefined();
    await ui.unmount();
  }
});

test("a phase that isn't running opens on a click to its sprints, and a card to its tasks", async ($, on) => {
  const h = phase4(on, QUIET);
  h.write(`${PHASES}/Phase-5-Polish.md`, PHASE_5_PLAN);
  await h.start($);

  for (const surface of SURFACES) {
    const ui = await h.pane($, surface);
    expect(await ui.find({ key: 'open:phase:5' })).toBeDefined();
    await act(ui, 'open:phase:5');
    expect(await ui.find({ text: 'PHASE 5' })).toBeDefined();
    expect(await ui.find({ text: 'No run log' })).toBeDefined();
    // Nothing is running, so every card starts closed.
    expect(await ui.find({ text: 'Router and layout' })).toBeUndefined();

    await act(ui, 'card:5.2');
    expect(await ui.find({ text: 'Router and layout' })).toBeDefined();
    expect(await ui.find({ text: /#1 · Not started/ })).toBeDefined();
    await act(ui, 'card:5.2');
    expect(await ui.find({ text: 'Router and layout' })).toBeUndefined();

    await act(ui, 'back');
    await ui.unmount();
  }
});

test('follows the live phase, with the old status line on top', async ($, on) => {
  const h = phase4(on);
  await h.start($);
  await h.replay(PHASE_4_LOG, PHASE_4_RETRIES.slice(0, 2));

  for (const surface of SURFACES) {
    const ui = await h.pane($, surface);
    expect((await labelOf(ui, 'live'))).toBe('P4 · wave 2 · 4.2 verify failed 1/3');
    // `auto` shows the live phase's rail.
    expect(await ui.find({ text: 'PHASE 4' })).toBeDefined();
    expect(await ui.find({ text: /^WAVE 2$/ })).toBeDefined();
    await ui.unmount();
  }
});

test("a running sprint's card starts open on the failure being retried, and a press closes it", async ($, on) => {
  const h = phase4(on);
  await h.start($);
  await h.replay(PHASE_4_LOG, PHASE_4_RETRIES.slice(0, 2));

  for (const surface of SURFACES) {
    const ui = await h.pane($, surface);
    expect(await ui.find({ text: /VERIFY FAILED/ })).toBeDefined();
    expect(await ui.find({ text: /Verify attempt 1 failed/ })).toBeDefined();
    expect(await ui.find({ text: /Retry next · 2 attempts left/ })).toBeDefined();
    expect(await ui.find({ text: 'Router and layout' })).toBeDefined();
    // The finished sprint's card starts closed.
    expect(await ui.find({ text: 'Vite and React scaffold' })).toBeUndefined();

    await act(ui, 'card:4.2');
    expect(await ui.find({ text: /Verify attempt 1 failed/ })).toBeUndefined();
    await act(ui, 'card:4.2');
    expect(await ui.find({ text: /Verify attempt 1 failed/ })).toBeDefined();
    await ui.unmount();
  }
});

test("a card's rows open on a press: acceptance criteria, verification, run notes", async ($, on) => {
  const h = phase4(on);
  await h.start($);
  await h.replay(PHASE_4_LOG, PHASE_4_RETRIES.slice(0, 2));

  const ui = await h.pane($, 'desktop');
  // On the desktop the chevron is drawn apart from the words, outside their underline.
  expect((await labelOf(ui, '4.2:criteria'))).toBe('Acceptance criteria · 1');
  expect((await ui.find({ key: '4.2:criteria' }))?.props['props']).toMatchObject({ lead: '▶' });
  expect(await ui.find({ text: /No horizontal page scroll/ })).toBeUndefined();
  await act(ui, '4.2:criteria');
  expect(await ui.find({ text: /No horizontal page scroll at 375 px/ })).toBeDefined();

  await act(ui, '4.2:verify');
  expect(await ui.find({ text: 'cli: npm run check' })).toBeDefined();
  expect(await ui.find({ text: 'ui: /, /phase/1' })).toBeDefined();

  await act(ui, '4.2:notes');
  expect(await ui.find({ text: /tsconfig lib is ES2022/ })).toBeDefined();
  await ui.unmount();
});

test('an escalation shows its banner on the rail', async ($, on) => {
  const h = phase4(on);
  await h.start($);
  await h.replay(PHASE_4_LOG, PHASE_4_RETRIES.slice(0, 4));
  h.append(PHASE_4_LOG, h.line({ sprint: '4.2', gate: 'implement', result: 'pass', attempt: 3 }));
  h.append(PHASE_4_LOG, h.line({ sprint: '4.2', gate: 'verify', result: 'fail', attempt: 3, summary: 'still overflowing' }));
  await h.tick();

  for (const surface of SURFACES) {
    const ui = await h.pane($, surface);
    expect(await ui.find({ text: /Verify retry limit reached \(3\/3\) on sprint 4\.2/ })).toBeDefined();
    expect(await ui.find({ text: /Waiting on you in the Claude Code session/ })).toBeDefined();
    await ui.unmount();
  }
});

test('a finished run ends the rail with its banner, and the live line goes', async ($, on) => {
  const h = phase4(on);
  await h.start($);
  await h.replay(PHASE_4_LOG, [...PHASE_4_RETRIES, ...PHASE_4_WAVE_2_END]);
  // What doc-sync writes: Sprint 4.2's built tasks marked done.
  h.write(`${PHASES}/Phase-4-Live-Run.md`, PHASE_4_PLAN.replace(/\| — \|/g, '| x |'));
  await h.tick();

  const ui = await h.pane($, 'desktop');
  expect(await ui.find({ key: 'live' })).toBeUndefined();
  // Nothing is live, so `auto` shows the list.
  await act(ui, 'open:phase:4');
  expect(await ui.find({ text: /Phase run complete/ })).toBeDefined();
  // The manual task left in Sprint 4.2 is the one thing that needs you.
  expect(await ui.find({ text: /1 task needs your attention/ })).toBeDefined();
  await ui.unmount();
});

test('draws status bars as SVG on the desktop and as text on the terminal', async ($, on) => {
  const h = phase4(on, QUIET);
  await h.start($);

  const desktop = await h.pane($, 'desktop');
  const svgs = await desktop.findAll({ type: 'Svg' });
  expect(svgs.length).toBeGreaterThan(0);
  const alts = svgs.map((svg) => svg.props['alt']);
  expect(alts).toContain('2 complete, 3 not started, 1 cut');
  // Headings are SVG text too, named for a reader that can't see them.
  expect(alts).toContain('Live Run');
  await desktop.unmount();

  const terminal = await h.pane($, 'terminal');
  expect(await terminal.findAll({ type: 'Svg' })).toEqual([]);
  expect(await terminal.find({ text: /^━+$/ })).toBeDefined();
  await terminal.unmount();
});

test('says where it looked when there are no phase plans', async ($, on) => {
  const h = hud(on, QUIET);
  await h.start($);

  const ui = await h.pane($, 'desktop');
  expect(await ui.find({ text: 'No phase plans found' })).toBeDefined();
  expect(await ui.find({ text: new RegExp(`${ROOT}/docs/phases/`) })).toBeDefined();
  await ui.unmount();
});

test('/phase-status opens the pane', async ($, on) => {
  const h = phase4(on, QUIET);
  await h.start($);
  await h.phaseStatus($);

  expect(h.opened).toEqual(['phase-runner', 'phase-runner']);
});

describe('pure parts', () => {
  test('the project holds every phase in number order and every run log', () => {
    const project = assembleProject(
      '/work',
      [
        { name: 'Phase-10-Later.md', text: PHASE_5_PLAN.replace('# Phase 5', '# Phase 10').replace(/Sprint 5\./g, 'Sprint 10.') },
        { name: 'Phase-4-Live-Run.md', text: PHASE_4_PLAN },
        { name: 'notes.md', text: '# Not a phase' },
      ],
      [
        { name: 'phase-4.jsonl', text: PHASE_4_WAVE_1.map((l) => `${l}\n`).join('') },
        { name: 'phase-4.jsonl.bak', text: '' },
      ],
    );
    expect(project.phases.map((p) => p.number)).toEqual([4, 10]);
    expect(project.runs.map((r) => r.phase)).toEqual([4]);
    expect(project.runs[0]?.waves).toHaveLength(1);
    expect(project.progress.overall).toMatchObject({ done: 2, eligible: 10 });
    expect(project.phases[0]?.file).toBe('/work/docs/phases/Phase-4-Live-Run.md');
  });

  test('a status bar turns its to-do tasks amber once anything is done', () => {
    const progress = {
      total: 5,
      eligible: 4,
      done: 2,
      percent: 50,
      byStatus: { todo: 1, active: 0, done: 2, blocked: 1, manual: 0, cut: 1, deferred: 0, unknown: 0 },
    };
    const { parts, isStarted } = segments(progress);
    expect(isStarted).toBe(true);
    expect(parts).toEqual([
      { kind: 'done', n: 2 },
      { kind: 'blocked', n: 1 },
      { kind: 'todo', n: 1 },
      { kind: 'cut', n: 1 },
    ]);
    expect(barSvg(parts, isStarted, 200)).toContain('.todo{fill:#ffb000}');
    expect(barCells(parts, isStarted, 20).reduce((n, c) => n + c.cells, 0)).toBe(20);
    expect(barCells([], false, 12)).toEqual([{ cells: 12, color: 'inactive' }]);
  });

  test('rich text is drawn from Claude Code 2.1.299', () => {
    expect(hasRichText('2.1.299')).toBe(true);
    expect(hasRichText('2.1.300-dev.20261001.t101500.sha1a2b3c4')).toBe(true);
    expect(hasRichText('2.2.0')).toBe(true);
    expect(hasRichText('2.1.289')).toBe(false);
    expect(hasRichText('1.9.999')).toBe(false);
    expect(hasRichText('')).toBe(false);
  });
});

