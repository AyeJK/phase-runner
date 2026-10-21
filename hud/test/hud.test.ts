/**
 * The read model and texts in `hooks/hud.ts`, called directly: plain data in,
 * strings out.
 */
import { describe, expect, test } from 'claude-code/testing';

import {
  buildView,
  current,
  formatAgo,
  formatTime,
  isPhaseComplete,
  newestRunLog,
  occurrences,
  phaseFileFor,
  readOptions,
  statusReport,
  workspaceFolder,
  type Entry,
} from '../hooks/hud.js';
import { PHASE_4_PLAN, PHASE_4_RETRIES, PHASE_4_WAVE_1, PHASE_4_WAVE_2_END } from './fixtures.js';

const file = (name: string, mtimeMs: number): Entry => ({ name, kind: 'file', size: 10, mtimeMs });
const log = (lines: readonly string[]): string => lines.map((line) => `${line}\n`).join('');
const PLAN = { file: 'Phase-4-Live-Run.md', text: PHASE_4_PLAN };

describe('options', () => {
  test('are read as given, and a value of the wrong type counts as unset', () => {
    expect(readOptions({ workspace: '  ../client-a ', sound: true })).toEqual({ workspace: '../client-a', hasSound: true });
    expect(readOptions({ workspace: '', sound: false })).toEqual({ workspace: '', hasSound: false });
    expect(readOptions({ workspace: 3, sound: 'yes' })).toEqual({ workspace: '', hasSound: false });
    expect(readOptions({})).toEqual({ workspace: '', hasSound: false });
  });

  test('the workspace is the option when absolute, under the session directory when relative', () => {
    expect(workspaceFolder('/work', '')).toBe('/work');
    expect(workspaceFolder('/work', '/elsewhere')).toBe('/elsewhere');
    expect(workspaceFolder('/work', 'client-a')).toBe('/work/client-a');
    expect(workspaceFolder('/work/', 'client-a')).toBe('/work/client-a');
    expect(workspaceFolder('C:\\work', 'D:\\projects\\app')).toBe('D:\\projects\\app');
    expect(workspaceFolder('C:\\work\\', 'client-a')).toBe('C:\\work/client-a');
  });
});

describe('finding files', () => {
  test('the newest run log is the one modified last', () => {
    const entries: Entry[] = [
      file('phase-3.jsonl', 300),
      file('phase-8.jsonl', 200),
      file('phase-08.jsonl', 900),
      file('notes.txt', 999),
      { name: 'screenshots', kind: 'dir', size: 0, mtimeMs: 0 },
    ];
    expect(newestRunLog(entries)?.phase).toBe(3);
    expect(newestRunLog([file('phase-3.jsonl', 300), file('phase-8.jsonl', 300)])?.phase).toBe(8);
    expect(newestRunLog([file('readme.md', 1)])).toBeNull();
  });

  test('the phase file is matched by number, not by prefix', () => {
    const entries = [file('Phase-10-Later.md', 1), file('Phase-1-Groundwork.md', 1), file('Phase-1-notes.txt', 1)];
    expect(phaseFileFor(entries, 1)?.name).toBe('Phase-1-Groundwork.md');
    expect(phaseFileFor(entries, 10)?.name).toBe('Phase-10-Later.md');
    expect(phaseFileFor(entries, 2)).toBeNull();
  });
});

describe('reading the log', () => {
  test('a line still being written and a garbled line are skipped', () => {
    const text = `${log([...PHASE_4_WAVE_1, PHASE_4_RETRIES[0]!])}{"v":1,"ts":"2026-09-29T02:03:59Z","phase":4,"wa\nnot json\n{"v":1,"ts":"2026-09-29T02:04:10Z","phase":4,"wave":2,"sprint":"4.2","gate":"verify","result":"fai`;
    const view = buildView(4, text, PLAN);

    expect(view.events).toHaveLength(5);
    expect(current(view)).toEqual({ wave: 2, sprint: '4.2', step: 'verify 1/3' });
  });

  test("the next wave's start line can land before the previous wave's doc-sync", () => {
    const start = '{"v":1,"ts":"2026-09-29T01:51:20Z","phase":4,"wave":2,"sprint":"4.2","gate":"implement","result":"start","attempt":1,"max":3,"summary":""}';
    const during = buildView(4, log([...PHASE_4_WAVE_1.slice(0, 3), start]), PLAN);
    // Wave 1 still has its doc-sync to go, but wave 2's implementer is the newest thing running.
    expect(current(during)).toEqual({ wave: 2, sprint: '4.2', step: 'implement 1/3' });

    const after = buildView(4, log([...PHASE_4_WAVE_1.slice(0, 3), start, PHASE_4_WAVE_1[3]!]), PLAN);
    expect(current(after)).toEqual({ wave: 2, sprint: '4.2', step: 'implement 1/3' });
    expect(after.waves).toHaveLength(2);
  });

  test('a drop in wave starts a new run, and the status follows the new run', () => {
    const rerun = '{"v":1,"ts":"2026-09-29T03:00:00Z","phase":4,"wave":1,"sprint":"4.2","gate":"implement","result":"pass","attempt":1,"max":3,"summary":""}';
    const view = buildView(4, log([...PHASE_4_WAVE_1, ...PHASE_4_RETRIES.slice(0, 2), rerun]), PLAN);

    expect(view.waves.map((w) => `${w.run}.${w.wave}`)).toEqual(['1.1', '1.2', '2.1']);
    expect(current(view)).toEqual({ wave: 1, sprint: '4.2', step: 'verify 1/3' });
  });
});

describe('phase complete', () => {
  test('needs every sprint in the phase file done', () => {
    const all = [...PHASE_4_WAVE_1, ...PHASE_4_RETRIES, ...PHASE_4_WAVE_2_END];
    expect(isPhaseComplete(buildView(4, log(all.slice(0, -1)), PLAN))).toBe(false);
    expect(isPhaseComplete(buildView(4, log(all), PLAN))).toBe(true);
  });

  test('counts a sprint with every eligible task x, even with no doc-sync logged', () => {
    const done = PHASE_4_PLAN.replace(/\| — \|/g, '| x |').replace('| MANUAL |', '| x |');
    const view = buildView(4, log(PHASE_4_WAVE_1), { file: PLAN.file, text: done });
    expect(isPhaseComplete(view)).toBe(true);
  });

  test('is never reached without the phase file', () => {
    const all = [...PHASE_4_WAVE_1, ...PHASE_4_RETRIES, ...PHASE_4_WAVE_2_END];
    expect(isPhaseComplete(buildView(4, log(all), null))).toBe(false);
  });
});

describe('toasts', () => {
  test('nothing older than the session raises one', () => {
    const all = [...PHASE_4_WAVE_1, ...PHASE_4_RETRIES, ...PHASE_4_WAVE_2_END];
    const view = buildView(4, log(all), PLAN);
    expect(occurrences(view, Date.parse('2026-09-29T02:18:47Z'))).toEqual([
      { key: 'complete:4', text: 'Phase 4 is complete. The run is at its checkpoint.' },
    ]);
    expect(occurrences(view, Date.parse('2026-09-29T02:18:49Z'))).toEqual([]);
  });
});

describe('times', () => {
  const at = Date.parse('2026-09-29T02:05:42Z');

  test('are 12-hour, in the offset given', () => {
    expect(formatTime(at, at, -420)).toBe('7:05 PM');
    expect(formatTime(at, at, 0)).toBe('2:05 AM');
    expect(formatTime(Date.parse('2026-09-29T12:00:00Z'), at, 0)).toBe('12:00 PM');
    expect(formatTime(Date.parse('2026-09-29T00:07:00Z'), at, 0)).toBe('12:07 AM');
  });

  test('carry the date when it is not today', () => {
    expect(formatTime(at, at + 24 * 3_600_000, -420)).toBe('Sep 28, 7:05 PM');
  });

  test('how long ago, in words', () => {
    expect(formatAgo(20_000)).toBe('just now');
    expect(formatAgo(3 * 60_000 + 20_000)).toBe('3 min ago');
    expect(formatAgo(2 * 3_600_000)).toBe('2 h ago');
    expect(formatAgo(2 * 3_600_000 + 5 * 60_000)).toBe('2 h 5 min ago');
    expect(formatAgo(26 * 3_600_000)).toBe('1 day ago');
  });

  test('the report puts the last event in the offset given', () => {
    const view = buildView(4, log([...PHASE_4_WAVE_1, ...PHASE_4_RETRIES.slice(0, 3)]), PLAN);
    expect(statusReport(view, at + 3 * 60_000, -420).split('\n').at(-1)).toBe('Last event: 7:05 PM, 3 min ago');
  });
});
