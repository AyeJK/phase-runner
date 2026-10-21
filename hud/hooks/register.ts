/**
 * phase-runner-hud: the wiring between Claude Code and `hud.ts`.
 *
 * - `session.start` registers `/phase-status` and starts a 2-second poll.
 * - Each poll lists `docs/phases/` and `docs/phases/.runs/`, reads the newest
 *   run log and its phase file when either changed, and raises any toast that
 *   is due.
 * - `command.run` answers `/phase-status` from the same files. No model call.
 *
 * The mod draws nothing: no pane, no status line, no band. phase-viewer is the
 * dashboard. Files are read through `$.fs` only (`exists`, `list`, `read`) and
 * nothing is ever written to the project. With no `docs/phases/` the mod
 * raises nothing.
 *
 * The engine wants every function that takes `$` declared at the top of this
 * file, so what one load of the mod remembers travels in a {@link Memory}.
 */
import type { EngineInterface, Register } from 'claude-code';

import type { HudSince, HudToasted } from '../types';
import {
  RUNS_DIR,
  buildView,
  completeKey,
  isAbsolutePath,
  isPhaseComplete,
  joinPath,
  newestRunLog,
  occurrences,
  phaseFileFor,
  readOptions,
  statusReport,
  workspaceFolder,
  type Entry,
  type HudOptions,
  type HudView,
} from './hud.js';

/** How often the files are checked. */
const POLL_MS = 2000;
/** How long a toast stays up. These ask for the user, so longer than the 4-second default. */
const TOAST_MS = 8000;
/** How many toast keys are kept, newest last. */
const KEPT_KEYS = 100;
/** The sound the `sound` option plays, a file of the mod. */
const SOUND = 'sounds/chime.wav';

const SINCE = { plugin: 'phase-runner-hud', key: 'since' } as const;
const TOASTED = { plugin: 'phase-runner-hud', key: 'toasted' } as const;

/** What one load of the mod remembers between polls. A hot reload starts it over. */
interface Memory extends HudOptions {
  /** The session's directory as `session.start` gave it, for a build without `$.session.root`. */
  startDir: string;
  /** `true` while a poll is running, so a slow one is never doubled. */
  isPolling: boolean;
  /** The last look at the workspace, kept while the files it read stay the same. */
  loaded: Loaded | null;
  /** Copies of the two `$.state` values, used on a build that has no `$.state` yet. */
  since: HudSince | undefined;
  toasted: HudToasted;
}

/** What one look at the workspace found. */
interface Loaded {
  /** Names, sizes and times of the files read, to tell when anything changed. */
  stamp: string;
  /** The workspace folder: the one that should hold `docs/phases/`. */
  root: string;
  /** `false` when the workspace has no `docs/phases/`. */
  hasPhases: boolean;
  /** The newest run log's phase; `null` without `docs/phases/` or with no run log yet. */
  view: HudView | null;
}

/** The folder that should hold `docs/phases/`: the `workspace` option, or the session's directory. */
async function workspaceRoot($: EngineInterface, mem: Memory): Promise<string> {
  let dir = mem.startDir;
  if (!isAbsolutePath(mem.workspace)) {
    try {
      dir = await $.session.root();
    } catch {
      // Keep the directory the session started in.
    }
  }
  return workspaceFolder(dir, mem.workspace);
}

const stampOf = (e: Entry | null): string => (e === null ? '-' : `${e.name}:${e.mtimeMs}:${e.size}`);

/** Look at the workspace: the newest run log and its phase file, read again only when either changed. */
async function load($: EngineInterface, mem: Memory): Promise<Loaded> {
  const root = await workspaceRoot($, mem);
  const phasesDir = joinPath(root, 'docs', 'phases');
  if (!(await $.fs.exists(phasesDir))) {
    return { stamp: '', root, hasPhases: false, view: null };
  }

  const entries = await $.fs.list(phasesDir);
  const runsDir = joinPath(phasesDir, RUNS_DIR);
  const runEntries = entries.some((e) => e.name === RUNS_DIR && e.kind === 'dir') ? await $.fs.list(runsDir) : [];
  const log = newestRunLog(runEntries);
  const plan = log === null ? null : phaseFileFor(entries, log.phase);
  const stamp = [root, stampOf(log), stampOf(plan)].join('|');
  if (mem.loaded?.stamp === stamp) return mem.loaded;

  let view: HudView | null = null;
  if (log !== null) {
    const logText = await $.fs.read(joinPath(runsDir, log.name));
    const planText = plan === null ? null : await $.fs.read(joinPath(phasesDir, plan.name));
    view = buildView(log.phase, logText, plan !== null && planText !== null ? { file: plan.name, text: planText } : null);
  }
  mem.loaded = { stamp, root, hasPhases: true, view };
  return mem.loaded;
}

/** Record when the mod first started in this session. Later loads keep the first time. */
async function markStart($: EngineInterface, mem: Memory, now: number): Promise<void> {
  mem.since ??= now;
  try {
    if ((await $.state.get(SINCE)).value === undefined) await $.state.set(SINCE, now);
  } catch {
    // A build without `$.state`: the copy in memory stands in.
  }
}

async function readSince($: EngineInterface, mem: Memory, now: number): Promise<HudSince> {
  try {
    return (await $.state.get(SINCE)).value ?? mem.since ?? now;
  } catch {
    return mem.since ?? now;
  }
}

async function readToasted($: EngineInterface, mem: Memory): Promise<HudToasted> {
  try {
    return (await $.state.get(TOASTED)).value ?? mem.toasted;
  } catch {
    return mem.toasted;
  }
}

async function writeToasted($: EngineInterface, mem: Memory, toasted: HudToasted): Promise<void> {
  mem.toasted = toasted;
  try {
    await $.state.set(TOASTED, toasted);
  } catch {
    // A build without `$.state`: the copy in memory stands in.
  }
}

/** Raise each toast that is due and hasn't been raised yet. */
async function raiseToasts($: EngineInterface, mem: Memory, view: HudView, now: number): Promise<void> {
  const since = await readSince($, mem, now);
  const toasted = await readToasted($, mem);

  const due = occurrences(view, since).filter((o) => !toasted.includes(o.key));
  // A phase seen incomplete again can complete again, and gets a new toast then.
  const kept = isPhaseComplete(view) ? toasted : toasted.filter((key) => key !== completeKey(view.phase));
  if (due.length === 0 && kept.length === toasted.length) return;

  // Record first, so a failure below can't raise the same toast twice.
  await writeToasted($, mem, [...kept, ...due.map((o) => o.key)].slice(-KEPT_KEYS));

  for (const o of due) $.ui.toast(o.text, { timeoutMs: TOAST_MS });
  if (mem.hasSound && due.length > 0) {
    try {
      await $.audio.play({ asset: SOUND });
    } catch {
      // No player on this platform, or the clip couldn't play: the toast is enough.
    }
  }
}

/** One poll: read what changed and raise any toast that is due. */
async function poll($: EngineInterface, mem: Memory): Promise<void> {
  if (mem.isPolling) return;
  mem.isPolling = true;
  try {
    const loaded = await load($, mem);
    if (loaded.view) await raiseToasts($, mem, loaded.view, await $.clock.now());
  } catch {
    // A file caught mid-write or a folder that vanished: the next poll reads again.
  } finally {
    mem.isPolling = false;
  }
}

/** The `/phase-status` answer. */
async function report($: EngineInterface, mem: Memory): Promise<string> {
  let loaded: Loaded;
  try {
    loaded = await load($, mem);
  } catch {
    return 'Phase Runner: could not read docs/phases/ just now. Try again.';
  }
  if (!loaded.hasPhases) return `Phase Runner: no docs/phases/ folder in ${loaded.root}.`;
  if (loaded.view === null) return 'Phase Runner: no run log in docs/phases/.runs/ yet.';
  const now = await $.clock.now();
  return statusReport(loaded.view, now, -new Date(now).getTimezoneOffset());
}

export const register: Register = (on, options) => {
  const mem: Memory = {
    ...readOptions(options),
    startDir: '',
    isPolling: false,
    loaded: null,
    since: undefined,
    toasted: [],
  };

  on('session.start', async ($, e, next) => {
    mem.startDir = e.cwd;
    await $.command.register({
      name: 'phase-status',
      description: 'Phase Runner: print the running phase, sprint progress, current gate and last event',
    });
    await markStart($, mem, await $.clock.now());
    await poll($, mem);
    $.clock.every(POLL_MS, () => {
      void poll($, mem);
    });
    return next(e);
  });

  on('command.run', { command: 'phase-status' }, async ($) => ({ text: await report($, mem) }));
};
