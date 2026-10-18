/**
 * Toasts, through the loaded mod: one per escalation, blocker and completed
 * phase, and none for anything else.
 */
import { expect, test } from 'claude-code/testing';

import { PHASE_4_RETRIES, PHASE_4_WAVE_2_END, PHASE_7_BLOCKED, tsOf } from './fixtures.js';
import { PHASES, PHASE_4_LOG, kitPassesOptions, phase4 } from './harness.js';

const PHASE_7_LOG = `${PHASES}/.runs/phase-7.jsonl`;

test('verify failing twice and then passing raises no toast (the real Phase 4 run)', async ($, on) => {
  const h = phase4(on);
  await h.start($);
  await h.replay(PHASE_4_LOG, PHASE_4_RETRIES);
  await h.clock.advance(10_000);

  expect(h.toasts).toEqual([]);
  expect(h.sounds).toEqual([]);
});

test('a third verify failure at max 3 raises one toast', async ($, on) => {
  // The real run up to its third attempt, which this time fails too.
  const h = phase4(on, tsOf(PHASE_4_RETRIES[4]!) + 10_000, PHASE_4_RETRIES.slice(0, 5));
  await h.start($);
  await h.tick();
  expect(h.toasts).toEqual([]);

  h.append(PHASE_4_LOG, h.line({ sprint: '4.2', gate: 'verify', result: 'fail', attempt: 3, max: 3, summary: 'still overflows at 375px' }));
  await h.tick();
  expect(h.toasts).toEqual(['Phase 4 needs you: sprint 4.2 verify failed 3/3.']);
  expect(h.lines.at(-1)).toBe('P4 · wave 2 · 4.2 verify failed 3/3');

  // It stays one toast however long the run waits.
  await h.clock.advance(60_000);
  expect(h.toasts).toHaveLength(1);
});

test('a second escalation after "continue retrying" raises its own toast', async ($, on) => {
  const h = phase4(on, tsOf(PHASE_4_RETRIES[4]!) + 10_000, PHASE_4_RETRIES.slice(0, 5));
  await h.start($);
  h.append(PHASE_4_LOG, h.line({ sprint: '4.2', gate: 'verify', result: 'fail', attempt: 3, max: 3 }));
  await h.tick();
  expect(h.toasts).toHaveLength(1);

  // The user picks "continue retrying": the counter resets and the sprint goes round again.
  for (const attempt of [1, 2, 3]) {
    h.append(PHASE_4_LOG, h.line({ sprint: '4.2', gate: 'implement', result: 'start', attempt }));
    await h.tick();
    h.append(PHASE_4_LOG, h.line({ sprint: '4.2', gate: 'implement', result: 'pass', attempt }));
    await h.tick();
    expect(h.toasts).toHaveLength(1);
    h.append(PHASE_4_LOG, h.line({ sprint: '4.2', gate: 'verify', result: 'fail', attempt }));
    await h.tick();
  }

  expect(h.toasts).toEqual([
    'Phase 4 needs you: sprint 4.2 verify failed 3/3.',
    'Phase 4 needs you: sprint 4.2 verify failed 3/3.',
  ]);
});

test('two sprints failing the same verify at the limit share one toast', async ($, on) => {
  const h = phase4(on);
  await h.start($);
  h.append(PHASE_4_LOG, h.line({ sprint: '4.2', gate: 'verify', result: 'fail', attempt: 3 }));
  // The second sprint's line lands a poll later.
  await h.tick();
  h.append(PHASE_4_LOG, h.line({ sprint: '4.3', gate: 'verify', result: 'fail', attempt: 3 }));
  await h.tick();

  expect(h.toasts).toEqual(['Phase 4 needs you: sprint 4.2 verify failed 3/3.']);
});

test('a run with no retry limit never escalates', async ($, on) => {
  const h = phase4(on);
  await h.start($);
  h.append(PHASE_4_LOG, h.line({ sprint: '4.2', gate: 'verify', result: 'fail', attempt: 5, max: 0 }));
  await h.tick();

  expect(h.toasts).toEqual([]);
  expect(h.lines.at(-1)).toBe('P4 · wave 2 · 4.2 verify failed 5');
});

test('a failed doc-sync raises a toast: it never retries on its own', async ($, on) => {
  const h = phase4(on);
  await h.start($);
  await h.replay(PHASE_4_LOG, [...PHASE_4_RETRIES, PHASE_4_WAVE_2_END[0]!]);
  h.append(PHASE_4_LOG, h.line({ sprint: '4.2', gate: 'doc_sync', result: 'fail', attempt: 1, max: 1 }));
  await h.tick();

  expect(h.toasts).toEqual(['Phase 4 needs you: sprint 4.2 doc-sync failed 1/1.']);
});

test('an escalation from before the session started raises nothing', async ($, on) => {
  const failed = '{"v":1,"ts":"2026-09-29T02:12:00Z","phase":4,"wave":2,"sprint":"4.2","gate":"verify","result":"fail","attempt":3,"max":3,"summary":"left over"}';
  const h = phase4(on, Date.parse('2026-09-29T02:20:00Z'), [...PHASE_4_RETRIES.slice(0, 5), failed]);
  await h.start($);
  await h.clock.advance(10_000);

  expect(h.lines).toEqual(['P4 · wave 2 · 4.2 verify failed 3/3']);
  expect(h.toasts).toEqual([]);
});

test('a blocked implementer raises one toast (the real Phase 7 line)', async ($, on) => {
  const h = phase4(on, tsOf(PHASE_7_BLOCKED) - 60_000);
  await h.start($);
  await h.replay(PHASE_7_LOG, [PHASE_7_BLOCKED]);

  expect(h.toasts).toEqual(['Phase 7 needs you: sprint 7.5 has a blocked task.']);
  // Phase 7's log is now the newest, so the status line follows it. It has no phase file here.
  expect(h.lines.at(-1)).toBe('P7 · wave 5 · 7.5 verify 1/3');

  // Verify fails and the retry reports the same blocked task: still the one pause, one toast.
  h.append(PHASE_7_LOG, h.line({ phase: 7, wave: 5, sprint: '7.5', gate: 'verify', result: 'fail' }));
  await h.tick();
  h.append(PHASE_7_LOG, h.line({ phase: 7, wave: 5, sprint: '7.5', gate: 'implement', result: 'blocked', attempt: 2 }));
  await h.tick();
  await h.clock.advance(10_000);
  expect(h.toasts).toHaveLength(1);
});

test('a completed phase raises one toast', async ($, on) => {
  const h = phase4(on);
  await h.start($);
  await h.replay(PHASE_4_LOG, [...PHASE_4_RETRIES, ...PHASE_4_WAVE_2_END]);
  await h.clock.advance(60_000);

  expect(h.toasts).toEqual(['Phase 4 is complete. The run is at its checkpoint.']);
});

test('a phase that runs again and completes again raises a new toast', async ($, on) => {
  const h = phase4(on);
  await h.start($);
  await h.replay(PHASE_4_LOG, [...PHASE_4_RETRIES, ...PHASE_4_WAVE_2_END]);
  expect(h.toasts).toHaveLength(1);

  // A new run of the phase re-implements Sprint 4.2 (wave numbers restart at 1).
  h.append(PHASE_4_LOG, h.line({ sprint: '4.2', gate: 'implement', result: 'start', wave: 1 }));
  await h.tick();
  expect(h.lines.at(-1)).toBe('P4 · wave 1 · 4.2 implement 1/3');
  expect(h.toasts).toHaveLength(1);

  for (const gate of ['implement', 'verify', 'wave_test']) {
    h.append(PHASE_4_LOG, h.line({ sprint: '4.2', gate, result: 'pass', wave: 1 }));
    await h.tick();
  }
  h.append(PHASE_4_LOG, h.line({ sprint: '4.2', gate: 'doc_sync', result: 'pass', wave: 1, max: 1 }));
  await h.tick();
  expect(h.toasts).toHaveLength(2);
});

test('plays no sound by default', async ($, on) => {
  const h = phase4(on);
  await h.start($);
  h.append(PHASE_4_LOG, h.line({ sprint: '4.2', gate: 'verify', result: 'fail', attempt: 3 }));
  await h.tick();

  expect(h.toasts).toHaveLength(1);
  expect(h.sounds).toEqual([]);
});

test('plays the chime with each toast when the sound option is on', { options: { sound: true } }, async ($, on) => {
  const h = phase4(on);
  await h.start($);
  h.append(PHASE_4_LOG, h.line({ sprint: '4.2', gate: 'verify', result: 'fail', attempt: 3 }));
  await h.tick();
  await h.clock.advance(10_000);

  expect(h.toasts).toHaveLength(1);
  // An older kit doesn't pass the option on, so the mod keeps its default: no sound.
  expect(h.sounds).toEqual(kitPassesOptions($) ? ['sounds/chime.wav'] : []);
});
