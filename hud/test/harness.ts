/**
 * What every HUD test stands on: a clock the test moves, a folder tree in
 * memory answering `$.fs`, and a record of what the mod showed.
 *
 * The test's hooks sit beneath the mod, so each `$` call the mod makes lands
 * here. Nothing touches the real file system.
 */
import type { On } from 'claude-code';
import { mock, type Engine, type MockClock, type Mounted } from 'claude-code/testing';

import { PHASE_4_PLAN, PHASE_4_RETRIES, PHASE_4_WAVE_1, tsOf } from './fixtures.js';

/** The session's directory in every test. */
export const ROOT = '/work';
/**
 * Press one of the pane's controls, as a person would: a Button on the
 * terminal, a pill on the desktop (a `pill.tsx` Client posting its press).
 */
export async function act<S extends 'terminal' | 'desktop'>(ui: Mounted<S, 'Pane'>, key: string): Promise<void> {
  if (ui.surface === 'desktop') await (ui as unknown as Mounted<'desktop', 'Pane'>).post({ press: true }, { in: key });
  else await (ui as unknown as Mounted<'terminal', 'Pane'>).press({ key });
}

/** The words on one of the pane's controls: a Button's label, or the label a pill's Client draws. */
export async function labelOf<S extends 'terminal' | 'desktop'>(ui: Mounted<S, 'Pane'>, key: string): Promise<string | undefined> {
  const found = await ui.find({ key });
  if (!found) return undefined;
  const props = found.props as { label?: string; props?: { label?: string } };
  return props.label ?? props.props?.label;
}

/** The pane's id, as the mod opens it. */
export const PANE_ID = 'phase-runner';
/** Where the phase files live under {@link ROOT}. */
export const PHASES = `${ROOT}/docs/phases`;

/** The fields of a run-log event a test sets; the rest are filled in. */
export interface EventFields {
  phase?: number;
  wave?: number;
  sprint: string;
  gate: string;
  result: string;
  attempt?: number;
  max?: number;
  summary?: string;
}

export interface Hud {
  clock: MockClock;
  /**
   * The pane's live line (`P4 · wave 2 · 4.2 verify 2/3`) each time it
   * changed, read after the session starts and after each poll; `undefined`
   * once it has gone. Nothing is recorded until it first shows.
   */
  lines: (string | undefined)[];
  /** Every `$.ui.status` call, in order. The mod only ever clears it. */
  statuses: (string | undefined)[];
  /** The id of every pane the mod opened, in order. */
  opened: string[];
  /** Every toast's text, in order. */
  toasts: string[];
  /** The asset of every sound played. */
  sounds: string[];
  /** Slash commands the mod registered. */
  commands: string[];
  /** Create or replace a file (path as the mod would spell it, with `/`). */
  write: (path: string, text: string) => void;
  /** Append one line to a file, as a run-log writer does. */
  append: (path: string, line: string) => void;
  /** A run-log line stamped with the clock's time. */
  line: (fields: EventFields) => string;
  /** Start the session, as Claude Code does once the mod has loaded. */
  start: ($: Engine) => Promise<void>;
  /** Type `/phase-status` at the prompt and return what it printed. */
  phaseStatus: ($: Engine) => Promise<string | undefined>;
  /** Move the clock on by one poll, then read the live line. */
  tick: () => Promise<void>;
  /** Read the live line now, recording it in {@link lines} when it changed. */
  sample: () => Promise<string | undefined>;
  /** Draw the pane on a surface and hand back the drawing. */
  pane: <S extends 'terminal' | 'desktop'>($: Engine, surface: S, columns?: number) => Promise<Mounted<S, 'Pane'>>;
  /** Append each line at its own `ts` (never moving the clock back), with one poll after each. */
  replay: (path: string, lines: readonly string[]) => Promise<void>;
}

/**
 * Whether this build's test kit hands `test(name, { options }, body)` to the
 * mod. The kit in Claude Code 2.1.277 ignores `options`, so the mod gets its
 * manifest defaults; the one in 2.1.287 passes them on. Nothing says so
 * directly, so this looks for `$.classic`, which the newer kit's engine has
 * and the older one's doesn't.
 *
 * A test that sets options checks the mod's defaults on the older kit.
 * `readOptions` and `workspaceFolder` are tested directly on every build.
 */
export function kitPassesOptions($: Engine): boolean {
  return (($ as { classic?: unknown }).classic ?? null) !== null;
}

/** The Phase 4 phase file and run log every Phase 4 test uses. */
export const PHASE_4_FILE = `${PHASES}/Phase-4-Live-Run.md`;
export const PHASE_4_LOG = `${PHASES}/.runs/phase-4.jsonl`;

/**
 * A workspace holding the Phase 4 plan and a run log with wave 1 finished.
 *
 * @param on The test's `on`.
 * @param now Where the clock starts. Defaults to a minute before wave 2's first line.
 * @param logged Lines already in the log after wave 1, before the session starts.
 */
export function phase4(on: On, now?: number, logged: readonly string[] = []): Hud {
  const h = hud(on, now ?? tsOf(PHASE_4_RETRIES[0]!) - 60_000);
  h.write(PHASE_4_FILE, PHASE_4_PLAN);
  h.write(PHASE_4_LOG, [...PHASE_4_WAVE_1, ...logged].map((line) => `${line}\n`).join(''));
  return h;
}

/** Spell a path the way the tests do, whatever the platform made of it. */
function norm(path: string): string {
  return path
    .replace(/\\/g, '/')
    .replace(/^[A-Za-z]:/, '')
    .replace(/\/+$/, '');
}

/**
 * Set the world up beneath the mod.
 *
 * @param on The test's `on`.
 * @param now Where the clock starts, in milliseconds since the epoch.
 */
export function hud(on: On, now: number): Hud {
  const clock = mock.clock(on, { now });
  const files = new Map<string, { text: string; mtimeMs: number }>();
  const lines: (string | undefined)[] = [];
  const statuses: (string | undefined)[] = [];
  const opened: string[] = [];
  const toasts: string[] = [];
  let engine: Engine | null = null;
  const sounds: string[] = [];
  const commands: string[] = [];

  on('session.start', (_$, e) => ({ cwd: e.cwd }));
  on('session.root', () => ({ value: ROOT }));
  on('command.register', (_$, e) => {
    commands.push(e.name);
    return { value: { command: e.name } };
  });
  on('ui.status', (_$, e) => {
    statuses.push(e.text);
    return { value: undefined };
  });
  on('ui.open', (_$, e) => {
    opened.push(e.id);
    return { value: { isPlaced: true } };
  });
  on('ui.toast', (_$, e) => {
    toasts.push(e.text);
    return { value: undefined };
  });
  on('audio.play', (_$, e) => {
    sounds.push(e.clip.asset ?? '(not an asset)');
    return { value: undefined };
  });

  on('fs.exists', (_$, e) => {
    const path = norm(e.path);
    return { value: [...files.keys()].some((file) => file === path || file.startsWith(`${path}/`)) };
  });
  on('fs.list', (_$, e) => {
    const dir = norm(e.path);
    const entries = new Map<string, { name: string; kind: 'file' | 'dir'; size: number; mtimeMs: number; isLink: boolean }>();
    for (const [file, held] of files) {
      if (!file.startsWith(`${dir}/`)) continue;
      const rest = file.slice(dir.length + 1);
      const name = rest.split('/')[0] ?? rest;
      if (rest.includes('/')) entries.set(name, { name, kind: 'dir', size: 0, mtimeMs: 0, isLink: false });
      else entries.set(name, { name, kind: 'file', size: held.text.length, mtimeMs: held.mtimeMs, isLink: false });
    }
    if (entries.size === 0) throw new Error(`ENOENT: ${e.path}`);
    return { value: [...entries.values()] };
  });
  on('fs.read', (_$, e) => {
    const held = files.get(norm(e.path));
    if (!held) throw new Error(`ENOENT: ${e.path}`);
    return { value: held.text };
  });

  const write = (path: string, text: string): void => {
    files.set(norm(path), { text, mtimeMs: clock.now() });
  };
  const append = (path: string, line: string): void => {
    write(path, `${files.get(norm(path))?.text ?? ''}${line}\n`);
  };
  const pane = async <S extends 'terminal' | 'desktop'>($: Engine, surface: S, columns = 60): Promise<Mounted<S, 'Pane'>> =>
    $.ui.mount({
      plugin: 'phase-runner-hud',
      surface,
      component: 'Pane',
      requestId: PANE_ID,
      props: {
        title: 'Phase Runner',
        isFocused: false,
        bodyColumns: columns,
        placement: 'dock',
        scroll: { offset: 0, bodyRows: 40 },
        view: {},
      },
      viewport: { columns: columns + 40, rows: 50, isFullscreen: true },
    });
  const sample = async (): Promise<string | undefined> => {
    if (engine === null || opened.length === 0) return undefined;
    const ui = await pane(engine, 'terminal');
    const found = await ui.find({ key: 'live' });
    await ui.unmount();
    const text = found?.text.replace(/^\S+ LIVE /, '');
    const last = lines.length > 0 ? lines[lines.length - 1] : undefined;
    if (text !== last) lines.push(text);
    return text;
  };
  const tick = async (): Promise<void> => {
    await clock.advance(2000);
    await sample();
  };

  return {
    clock,
    lines,
    statuses,
    opened,
    sample,
    pane,
    toasts,
    sounds,
    commands,
    write,
    append,
    tick,
    line: (fields) =>
      JSON.stringify({
        v: 1,
        ts: new Date(clock.now()).toISOString().replace(/\.\d{3}Z$/, 'Z'),
        phase: fields.phase ?? 4,
        wave: fields.wave ?? 2,
        sprint: fields.sprint,
        gate: fields.gate,
        result: fields.result,
        attempt: fields.attempt ?? 1,
        max: fields.max ?? 3,
        summary: fields.summary ?? '',
      }),
    start: async ($) => {
      engine = $;
      await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true });
      await sample();
    },
    phaseStatus: async ($) => {
      const answer = await $.command.run({
        command: 'phase-status',
        args: '',
        origin: { kind: 'composer' },
        presentation: { isFullscreen: false, columns: 120 },
      });
      return answer.text;
    },
    replay: async (path, lines) => {
      for (const line of lines) {
        const at = Date.parse((JSON.parse(line) as { ts: string }).ts);
        if (at > clock.now()) await clock.set(at);
        append(path, line);
        await tick();
      }
    },
  };
}
