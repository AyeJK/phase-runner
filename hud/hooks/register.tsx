/**
 * phase-runner-hud: the wiring between Claude Code and `hud.ts` / `pane.tsx`.
 *
 * - `session.start` registers `/phase-status`, takes down the status line an
 *   older version kept, opens the Phase Runner pane when the workspace has a
 *   `docs/phases/`, and starts a 2-second poll.
 * - Each poll lists `docs/phases/` and `docs/phases/.runs/`, reads the files
 *   that changed, rebuilds the project when anything did, and bumps
 *   `revision` so the pane draws again. It raises any toast that is due, and
 *   opens the pane again when a run goes live.
 * - `ui.render` on the pane draws phase-viewer's screens from the project.
 * - `command.run` opens the pane and answers `/phase-status` from the same
 *   files. No model call.
 *
 * Files are read through `$.fs` only (`exists`, `list`, `read`) and nothing is
 * ever written to the project. With no `docs/phases/` the mod raises nothing
 * and the pane, if opened, says where it looked.
 *
 * The engine wants every function that takes `$` declared at the top of this
 * file, so what one load of the mod remembers travels in a {@link Memory}.
 */
import { read, update, type Elements, type EngineInterface, type Register, type RenderElement } from 'claude-code';

import type { HudNav, HudSince, HudToasted, HudToggled } from '../types';
import {
  RUNS_DIR,
  buildView,
  completeKey,
  isAbsolutePath,
  isPhaseComplete,
  joinPath,
  lastEvent,
  newestRunLog,
  occurrences,
  phaseFileFor,
  readOptions,
  statusReport,
  statusText,
  workspaceFolder,
  type Entry,
  type HudOptions,
  type HudView,
} from './hud.js';
import { drawPane, hasRichText, makeKit, type ControlDrawer, type ControlLook, type LiveLine } from './pane.js';
import { assembleProject, phaseFileNumber, runLogNumber } from './project.js';
import type { Project } from './core/model.js';

/** How often the files are checked. */
const POLL_MS = 2000;
/** How often a live pane redraws with nothing changed, for its "N min so far". */
const LIVE_REDRAW_MS = 60_000;
/** How long a toast stays up. These ask for the user, so longer than the 4-second default. */
const TOAST_MS = 8000;
/** How many toast keys are kept, newest last. */
const KEPT_KEYS = 100;
/** The sound the `sound` option plays, a file of the mod. */
const SOUND = 'sounds/chime.wav';
/** The pane's id and tab title. */
const PANE = 'phase-runner';
const PANE_TITLE = 'Phase Runner';

const SINCE = { plugin: 'phase-runner-hud', key: 'since' } as const;
const TOASTED = { plugin: 'phase-runner-hud', key: 'toasted' } as const;
const NAV = { plugin: 'phase-runner-hud', key: 'nav' } as const;
const TOGGLED = { plugin: 'phase-runner-hud', key: 'toggled' } as const;
const REVISION = { plugin: 'phase-runner-hud', key: 'revision' } as const;

/** What a control looks like on the desktop, by its look. Theme keys, so it follows light and dark. */
const CONTROL_LOOKS: Record<ControlLook, { border?: string; hoverBorder?: string; fg: string; hoverFg: string; bold: boolean; underline?: 'hover'; size?: 'heading' }> = {
  pill: { border: 'inactive', hoverBorder: 'warning', fg: 'text', hoverFg: 'warning', bold: false },
  link: { fg: 'text', hoverFg: 'warning', bold: false, underline: 'hover', size: 'heading' },
};

/** The press of each control the pane last drew, by its key; `ui.message` runs it. */
const presses = new Map<string, () => void>();

/**
 * The desktop's controls: a rounded box (for a pill or a square) around a
 * `pill.tsx` Client that draws the label and posts a press. A plain Button
 * there is bare text, too small to read as a control. The Client is drawn
 * here, in the hooks module, where the engine reads its module's path.
 */
function pillDrawer(els: Elements['desktop'], isRichText: boolean): ControlDrawer {
  const { Box, Client } = els;
  return (key, label, onPress, look, lead) => {
    presses.set(key, onPress);
    // An engine older than rich text refuses a Client's tree over a Text that sets `size`.
    const l = isRichText ? CONTROL_LOOKS[look] : { ...CONTROL_LOOKS[look], size: undefined };
    // A heading-sized label runs wider than the 8 px cells the region is counted in.
    const leadCols = lead === undefined ? 0 : 3;
    const cols = Math.max(1, Math.ceil([...label].length * (l.size === 'heading' ? 1.2 : 1)) + leadCols + (look === 'link' ? 0 : 2));
    const pill = (
      <Client
        key={key}
        module="./pill.tsx"
        props={{ label, fg: l.fg, hoverFg: l.hoverFg, bold: l.bold, cols, ...(l.underline ? { underline: l.underline } : {}), ...(l.size ? { size: l.size } : {}), ...(lead !== undefined ? { lead } : {}) }}
        width={cols}
        height={1}
      />
    );
    // Positioned, so a control drawn after a card's click region is drawn over it and takes its own clicks.
    if (look === 'link') return <Box key={`ctl:${key}`} position="relative">{pill}</Box>;
    return (
      <Box key={`ctl:${key}`} position="relative" borderStyle="round" borderColor={l.border} paddingX={1} hover={{ borderColor: l.hoverBorder }}>
        {pill}
      </Box>
    );
  };
}

/**
 * The desktop's clickable cards: a clear `hit.tsx` Client, `cols` × `rows`
 * cells, laid over a card that clips it to its own edges; it posts a press on
 * a click.
 */
function hitDrawer(els: Elements['desktop']): (key: string, onPress: () => void, cols: number, rows: number) => RenderElement {
  const { Client } = els;
  return (key, onPress, cols, rows) => {
    presses.set(key, onPress);
    // In cells, as Eidola sizes its own: a percentage of the card doesn't take on the desktop.
    return <Client key={key} module="./hit.tsx" props={{ cols, rows }} width={cols} height={rows} />;
  };
}

/** What one load of the mod remembers between polls. A hot reload starts it over. */
interface Memory extends HudOptions {
  /** The session's directory as `session.start` gave it, for a build without `$.session.root`. */
  startDir: string;
  /** `true` while a poll is running, so a slow one is never doubled. */
  isPolling: boolean;
  /** File text by path, kept while the file's size and modified time stay the same. */
  texts: Map<string, { stamp: string; text: string }>;
  /** The last look at the workspace, kept while every file in it stays the same. */
  loaded: Loaded | null;
  /** Whether the last poll saw a live run, to open the pane when one starts. */
  wasLive: boolean;
  /** When the pane was last made to redraw with nothing changed. */
  redrawnAt: number;
  /** Whether this engine draws Text's `size`, `weight` and `mono`; `null` until asked. */
  isRichText: boolean | null;
  /** Copies of the two `$.state` values, used on a build that has no `$.state` yet. */
  since: HudSince | undefined;
  toasted: HudToasted;
}

/** What one look at the workspace found. */
interface Loaded {
  /** Names, sizes and times of every file read, to tell when anything changed. */
  stamp: string;
  /** The workspace folder: the one that should hold `docs/phases/`. */
  root: string;
  /** `false` when the workspace has no `docs/phases/`. */
  hasPhases: boolean;
  /** Every phase and run log, as phase-viewer builds them; `null` without `docs/phases/`. */
  project: Project | null;
  /** The newest run log's phase, for the live line and the toasts; `null` when there is no run log yet. */
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

async function readText($: EngineInterface, mem: Memory, path: string, entry: Entry): Promise<string> {
  const stamp = `${entry.mtimeMs}:${entry.size}`;
  const held = mem.texts.get(path);
  if (held?.stamp === stamp) return held.text;
  const text = await $.fs.read(path);
  mem.texts.set(path, { stamp, text });
  return text;
}

/** Look at the workspace: every phase file and run log, read again only when one changed. */
async function load($: EngineInterface, mem: Memory): Promise<Loaded> {
  const root = await workspaceRoot($, mem);
  const phasesDir = joinPath(root, 'docs', 'phases');
  if (!(await $.fs.exists(phasesDir))) {
    return { stamp: '', root, hasPhases: false, project: null, view: null };
  }

  const entries = await $.fs.list(phasesDir);
  const runsDir = joinPath(phasesDir, RUNS_DIR);
  const runEntries = entries.some((e) => e.name === RUNS_DIR && e.kind === 'dir') ? await $.fs.list(runsDir) : [];
  const phaseFiles = entries.filter((e) => e.kind === 'file' && phaseFileNumber(e.name) !== null);
  const runLogs = runEntries.filter((e) => e.kind === 'file' && runLogNumber(e.name) !== null);
  const stamp = [root, ...[...phaseFiles, ...runLogs].map((e) => `${e.name}:${e.mtimeMs}:${e.size}`)].join('|');
  if (mem.loaded?.stamp === stamp) return mem.loaded;

  const phaseTexts = [];
  for (const e of phaseFiles) phaseTexts.push({ name: e.name, text: await readText($, mem, joinPath(phasesDir, e.name), e) });
  const logTexts = [];
  for (const e of runLogs) logTexts.push({ name: e.name, text: await readText($, mem, joinPath(runsDir, e.name), e) });

  const project = assembleProject(root, phaseTexts, logTexts);
  const log = newestRunLog(runLogs);
  let view: HudView | null = null;
  if (log !== null) {
    const plan = phaseFileFor(phaseFiles, log.phase);
    const planText = plan ? (phaseTexts.find((p) => p.name === plan.name)?.text ?? null) : null;
    const logText = logTexts.find((l) => l.name === log.name)?.text ?? '';
    view = buildView(log.phase, logText, plan && planText !== null ? { file: plan.name, text: planText } : null);
  }
  mem.loaded = { stamp, root, hasPhases: true, project, view };
  return mem.loaded;
}

/** The run going on now, or `null`: the newest run log's last event is under 30 minutes old and its phase isn't complete. */
function liveLine(view: HudView | null, now: number): LiveLine | null {
  if (view === null) return null;
  const text = statusText(view, now);
  const last = lastEvent(view);
  if (text === undefined || last === null) return null;
  return { phase: view.phase, text, at: last.ts };
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

/** Whether this engine draws Text's `size`, `weight` and `mono` (see `hasRichText`). */
async function richText($: EngineInterface): Promise<boolean> {
  try {
    const v = await $.session.version();
    return hasRichText(v.base ?? v.version);
  } catch {
    return false;
  }
}

/** Ask the pane to draw again. */
async function redraw($: EngineInterface, mem: Memory, now: number): Promise<void> {
  mem.redrawnAt = now;
  try {
    await update($, REVISION, (n) => (n ?? 0) + 1);
  } catch {
    // A build without `$.state`.
    $.ui.invalidate('ui.render');
  }
}

async function openPane($: EngineInterface): Promise<void> {
  try {
    await $.ui.open({ id: PANE, title: PANE_TITLE });
  } catch {
    // A build or surface with no panes: the toasts and /phase-status still work.
  }
}

/** One poll: read what changed, redraw the pane, raise toasts, open the pane when a run starts. */
async function poll($: EngineInterface, mem: Memory): Promise<void> {
  if (mem.isPolling) return;
  mem.isPolling = true;
  try {
    const before = mem.loaded;
    const loaded = await load($, mem);
    const now = await $.clock.now();
    const isLive = liveLine(loaded.view, now) !== null;
    if (loaded !== before || isLive !== mem.wasLive || (isLive && now - mem.redrawnAt >= LIVE_REDRAW_MS)) {
      await redraw($, mem, now);
    }
    if (isLive && !mem.wasLive) await openPane($);
    mem.wasLive = isLive;
    if (loaded.view) await raiseToasts($, mem, loaded.view, now);
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
    texts: new Map(),
    loaded: null,
    wasLive: false,
    redrawnAt: 0,
    isRichText: null,
    since: undefined,
    toasted: [],
  };

  on('session.start', async ($, e, next) => {
    mem.startDir = e.cwd;
    // Earlier versions kept the run on the status line; the pane has it now.
    $.ui.status(undefined);
    await $.command.register({
      name: 'phase-status',
      description: 'Phase Runner: open the pane, and print the running phase, sprint progress, current gate and last event',
    });
    await markStart($, mem, await $.clock.now());
    await poll($, mem);
    if (mem.loaded?.hasPhases === true) await openPane($);
    $.clock.every(POLL_MS, () => {
      void poll($, mem);
    });
    return next(e);
  });

  on('command.run', { command: 'phase-status' }, async ($) => {
    await openPane($);
    return { text: await report($, mem) };
  });

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e);
    try {
      const nav: HudNav = (await read($, NAV)) ?? { screen: 'auto' };
      const toggled: HudToggled = (await read($, TOGGLED)) ?? {};
      await read($, REVISION);
      const loaded = mem.loaded ?? (await load($, mem));
      const now = await $.clock.now();
      mem.isRichText ??= await richText($);
      const kit = makeKit(
        // The terminal's table hands back an Svg that draws nothing; the bar is text there.
        { Box: els.Box, Text: els.Text, Button: els.Button, Svg: e.surface !== 'terminal' && 'Svg' in els ? els.Svg : undefined },
        mem.isRichText,
      );
      // The desktop draws controls as pills; every other surface as plain Buttons.
      presses.clear();
      if (e.surface === 'desktop') {
        kit.control = pillDrawer($.ui.resolve(e) as Elements['desktop'], mem.isRichText);
        kit.hit = hitDrawer($.ui.resolve(e) as Elements['desktop']);
      }
      return drawPane(kit, {
        project: loaded.project,
        root: loaded.root,
        nav,
        toggled,
        live: liveLine(loaded.view, now),
        now,
        columns: e.props.bodyColumns,
        actions: {
          go: (to) => {
            void update($, NAV, () => to);
          },
          toggle: (key, isOpen) => {
            void update($, TOGGLED, (all) => ({ ...(all ?? {}), [key]: !isOpen }));
          },
        },
      });
    } catch (err) {
      // Say so in the pane rather than leave it blank; the next poll or press draws again.
      const message = err instanceof Error ? err.message : String(err);
      return els.Text({ color: 'error', wrap: 'wrap', children: [`Phase Runner couldn't draw this: ${message}`] });
    }
  });

  // A pill's label, clicked: the press the pane last drew for that control.
  on('ui.message', async ($, e, next) => {
    const data = e.data as { press?: unknown } | null;
    const press = presses.get(e.element);
    if (press && data !== null && typeof data === 'object' && data.press === true) {
      press();
      return {};
    }
    return next(e);
  });
};
