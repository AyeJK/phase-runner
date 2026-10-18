/**
 * The live line at the top of the pane (the status line before the pane had
 * it), through the loaded mod: what it shows as a run log grows, and when it
 * goes. The mod itself never sets a status line, only clears one an older
 * version left.
 */
import { expect, test } from 'claude-code/testing';

import { PHASE_4_PLAN, PHASE_4_RETRIES, PHASE_4_WAVE_1, PHASE_4_WAVE_2_END } from './fixtures.js';
import { PANE_ID, PHASE_4_LOG, ROOT, hud, kitPassesOptions, phase4 } from './harness.js';

const MINUTE = 60_000;

test('names the sprint and gate mid-verify, one poll after each append', async ($, on) => {
  const h = phase4(on);
  await h.start($);
  // implement pass 1/3, verify fail 1/3, implement pass 2/3: verify is running its second attempt.
  await h.replay(PHASE_4_LOG, PHASE_4_RETRIES.slice(0, 3));

  expect(h.lines).toEqual([
    'P4 · wave 1 · 4.1 done',
    'P4 · wave 2 · 4.2 verify 1/3',
    'P4 · wave 2 · 4.2 verify failed 1/3',
    'P4 · wave 2 · 4.2 verify 2/3',
  ]);
  expect(h.statuses).toEqual([undefined]);
});

test('follows a sprint through every gate, then goes when the phase completes', async ($, on) => {
  const h = phase4(on);
  await h.start($);
  await h.replay(PHASE_4_LOG, [...PHASE_4_RETRIES, ...PHASE_4_WAVE_2_END]);

  expect(h.lines).toEqual([
    'P4 · wave 1 · 4.1 done',
    'P4 · wave 2 · 4.2 verify 1/3',
    'P4 · wave 2 · 4.2 verify failed 1/3',
    'P4 · wave 2 · 4.2 verify 2/3',
    'P4 · wave 2 · 4.2 verify failed 2/3',
    'P4 · wave 2 · 4.2 verify 3/3',
    'P4 · wave 2 · 4.2 wave-test 1/3',
    'P4 · wave 2 · 4.2 doc-sync 1/1',
    // Sprint 4.2's doc-sync passed: every sprint in the phase file is done.
    undefined,
  ]);
});

test('shows an implementer starting, from its start line', async ($, on) => {
  const h = phase4(on);
  await h.start($);
  h.append(PHASE_4_LOG, h.line({ sprint: '4.2', gate: 'implement', result: 'start' }));
  await h.tick();

  expect(h.lines.at(-1)).toBe('P4 · wave 2 · 4.2 implement 1/3');
});

test('goes when the log goes stale, and comes back with the next event', async ($, on) => {
  const h = phase4(on);
  await h.start($);
  await h.replay(PHASE_4_LOG, PHASE_4_RETRIES.slice(0, 1));

  await h.clock.advance(29 * MINUTE);
  expect(await h.sample()).toBe('P4 · wave 2 · 4.2 verify 1/3');

  // 30 minutes after the last event.
  await h.clock.advance(MINUTE);
  expect(await h.sample()).toBeUndefined();

  h.append(PHASE_4_LOG, h.line({ sprint: '4.2', gate: 'verify', result: 'pass' }));
  await h.tick();
  expect(h.lines.at(-1)).toBe('P4 · wave 2 · 4.2 wave-test 1/3');
});

test('shows no live line for a log that was already stale when the session started', async ($, on) => {
  const h = phase4(on, Date.parse('2026-09-29T09:00:00Z'));
  await h.start($);
  await h.clock.advance(10_000);

  expect(await h.sample()).toBeUndefined();
  expect(h.lines).toEqual([]);
  // One call, clearing whatever an earlier version of the mod left up.
  expect(h.statuses).toEqual([undefined]);
  expect(h.toasts).toEqual([]);
});

test('keeps the pane closed at session start when no run is live', async ($, on) => {
  const h = phase4(on, Date.parse('2026-09-29T09:00:00Z'));
  await h.start($);
  await h.clock.advance(10_000);

  expect(h.opened).toEqual([]);
});

test('stays silent with no docs/phases/', async ($, on) => {
  const h = hud(on, Date.parse('2026-09-29T02:00:00Z'));
  h.write(`${ROOT}/README.md`, '# Not a Phase Runner project\n');
  await h.start($);
  await h.clock.advance(10_000);

  expect(h.opened).toEqual([]);
  expect(h.lines).toEqual([]);
  expect(h.toasts).toEqual([]);
  expect(h.sounds).toEqual([]);
});

test('wakes up when docs/phases/ appears later in the session', async ($, on) => {
  const h = hud(on, Date.parse('2026-09-29T02:00:00Z'));
  await h.start($);
  await h.tick();
  expect(h.opened).toEqual([]);

  h.write(`${ROOT}/docs/phases/Phase-4-Live-Run.md`, PHASE_4_PLAN);
  h.append(PHASE_4_LOG, h.line({ sprint: '4.1', gate: 'implement', result: 'start', wave: 1 }));
  await h.tick();
  // A run going live opens the pane.
  expect(h.opened).toEqual([PANE_ID]);
  expect(h.lines).toEqual(['P4 · wave 1 · 4.1 implement 1/3']);
});

test('reads the folder the workspace option names', { options: { workspace: '/elsewhere' } }, async ($, on) => {
  const h = hud(on, Date.parse('2026-09-29T01:52:00Z'));
  h.write('/elsewhere/docs/phases/Phase-4-Live-Run.md', PHASE_4_PLAN);
  h.write('/elsewhere/docs/phases/.runs/phase-4.jsonl', `${PHASE_4_WAVE_1.join('\n')}\n`);
  await h.start($);

  if (!kitPassesOptions($)) {
    // An older kit: the mod got its defaults, and the session's directory has no docs/phases/.
    expect(h.lines).toEqual([]);
    return;
  }
  expect(h.lines).toEqual(['P4 · wave 1 · 4.1 done']);
});

test('takes a relative workspace option from the session directory', { options: { workspace: 'client-a' } }, async ($, on) => {
  const h = hud(on, Date.parse('2026-09-29T01:52:00Z'));
  h.write(`${ROOT}/client-a/docs/phases/Phase-4-Live-Run.md`, PHASE_4_PLAN);
  h.write(`${ROOT}/client-a/docs/phases/.runs/phase-4.jsonl`, `${PHASE_4_WAVE_1.join('\n')}\n`);
  await h.start($);

  if (!kitPassesOptions($)) {
    // An older kit: the mod got its defaults, and the session's directory has no docs/phases/.
    expect(h.lines).toEqual([]);
    return;
  }
  expect(h.lines).toEqual(['P4 · wave 1 · 4.1 done']);
});
