/**
 * The Phase Runner pane: phase-viewer's screens, drawn with a surface's own
 * elements. Pure: a {@link Project} and what the person has opened in, a tree
 * out. `register.ts` makes every `$` call and hands in the handlers.
 *
 * Two screens, as the viewer's list view has them:
 *
 * - **Phases**: every phase, grouped In progress / Not started / Complete,
 *   each with its badge, task count and status bar. Pressing one opens it.
 * - **Phase**: the viewer's phase rail. The heading and badge, escalation and
 *   parse-warning banners, the status bar, then each wave of the latest run
 *   with its sprint cards, and the run-end banner. A card opens in place, the
 *   running ones from the start: goal, tasks, the failure being retried, and
 *   rows for acceptance criteria, dependencies, verification and run notes.
 *
 * Above both, while a run is live, the line the HUD used to keep on the status
 * line: `P9 · wave 2 · 9.2 verify 2/3`, with the time of the last event.
 *
 * Every word and state comes from the viewer's own derivations, copied into
 * `client/` (sprint states, badges, wave rows, run notes, run end), so the
 * pane and the viewer never disagree. Colors follow the viewer's tokens:
 * theme keys where the person's theme has one that means the same, mid-tone
 * colors that read on light and dark otherwise, and in the status bar's SVG
 * the viewer's own light and dark values.
 */
import type { Elements, RenderElement } from 'claude-code';

import type { HudNav } from '../types';

import type { Phase, Progress, Project, Task, TaskStatus } from './core/model.js';
import type { IconKind } from './client/components/iconKind.js';
import { notStartedTasks, phaseRuns, type NotStarted } from './client/data/status.js';
import { formatTime, plural } from './client/format.js';
import { escalationTitle } from './client/live/derive.js';
import {
  PHASE_GROUP_LABEL,
  isActiveState,
  isFailedState,
  isGateState,
  phaseGroup,
  railView,
  runEnd,
  type PhaseGroup,
  type RailRow,
  type RailSprint,
  type RunEnd,
  type SprintState,
} from './client/rail/derive.js';
import { phaseBadge, liveTaskCounts, liveTaskStates, taskRow, type BadgeView, type LiveTaskCounts } from './client/sprint/status.js';
import { phaseWarnings } from './client/states/warnings.js';

// ---------------------------------------------------------------------------
// What the pane is showing
// ---------------------------------------------------------------------------

/**
 * Where the person is. `auto` follows the run: the live phase while one is
 * live, else the phase list.
 */
export type PaneNav = HudNav;

/** The run going on now, as the status line used to say it. */
export interface LiveLine {
  phase: number;
  /** `P9 · wave 2 · 9.2 verify 2/3`. */
  text: string;
  /** The last event's `ts`. */
  at: string;
}

/** What a press does. Made by `register.ts`, which holds `$`. */
export interface PaneActions {
  go: (nav: PaneNav) => void;
  /** Flip an open/closed row; `isOpen` is how it is drawn now. */
  toggle: (key: string, isOpen: boolean) => void;
}

/** Everything one drawing needs. */
export interface PaneInput {
  project: Project | null;
  /** The workspace folder, for the empty state. */
  root: string;
  nav: PaneNav;
  /** Rows the person opened or closed, by key; the rest take their default. */
  toggled: Readonly<Record<string, boolean>>;
  live: LiveLine | null;
  now: number;
  /** Cells across the pane body. */
  columns: number;
  actions: PaneActions;
}

/** The screen `nav` resolves to: `auto` and a phase that no longer exists fall back. */
export function screenOf(input: Pick<PaneInput, 'project' | 'nav' | 'live'>): { screen: 'phases' } | { screen: 'phase'; phase: Phase } {
  const phases = input.project?.phases ?? [];
  const find = (n: number | undefined): Phase | undefined => phases.find((p) => p.number === n);
  if (input.nav.screen === 'phase') {
    const phase = find(input.nav.phase);
    if (phase) return { screen: 'phase', phase };
  }
  if (input.nav.screen === 'auto') {
    const phase = find(input.live?.phase);
    if (phase) return { screen: 'phase', phase };
  }
  return { screen: 'phases' };
}

// ---------------------------------------------------------------------------
// Colors, icons and the status bar
// ---------------------------------------------------------------------------

/** Text colors by meaning (the viewer's tokens). */
const COLOR = {
  pass: 'success',
  fail: 'error',
  run: '#2aa9c4',
  needs: '#e0529f',
  manual: '#8b6cf0',
  accent: 'warning',
  text: 'text',
  sub: 'subtle',
  dim: 'inactive',
} as const;

type Tone = 'pass' | 'run' | 'fail' | 'needs' | 'manual' | 'accent' | 'dim';

const ICON: Record<IconKind, string> = {
  pass: '✓',
  run: '↻',
  built: '✓',
  wait: '○',
  fail: '✕',
  needs: '!',
  manual: '◆',
  warn: '▲',
};

const ICON_TONE: Record<IconKind, Tone> = {
  pass: 'pass',
  run: 'run',
  built: 'run',
  wait: 'accent',
  fail: 'fail',
  needs: 'needs',
  manual: 'manual',
  warn: 'accent',
};

/** A sprint state's badge tone, as `SprintCard.tsx` picks it. */
function stateTone(state: SprintState): Tone {
  if (isGateState(state)) return 'run';
  if (isFailedState(state)) return 'fail';
  if (state === 'complete') return 'pass';
  if (state === 'needs-you') return 'needs';
  if (state === 'manual') return 'manual';
  if (state === 'waiting') return 'accent';
  return 'dim';
}

function stateIcon(state: SprintState): string {
  const tone = stateTone(state);
  if (tone === 'run') return ICON.run;
  if (tone === 'fail') return ICON.fail;
  if (tone === 'pass') return ICON.pass;
  if (tone === 'needs') return ICON.needs;
  if (tone === 'manual') return ICON.manual;
  return ICON.wait;
}

/** One stretch of a status bar. */
export type SegmentKind = TaskStatus | 'built' | 'future';
export interface Segment {
  kind: SegmentKind;
  n: number;
}

const SEGMENT_ORDER: readonly SegmentKind[] = ['done', 'built', 'active', 'blocked', 'manual', 'todo', 'future', 'unknown', 'deferred', 'cut'];

/**
 * A status bar's stretches, as `StatusSegments.tsx` counts them: one per task
 * status, as long as its count, in a fixed order. Once anything is done or
 * running the bar is started and its to-do tasks show amber; tasks in sprints
 * not started yet stay grey (`future`).
 */
export function segments(progress: Progress | undefined, notStarted?: NotStarted, live?: LiveTaskCounts): { parts: Segment[]; isStarted: boolean } {
  const allTodo = progress?.byStatus.todo ?? 0;
  const built = Math.min(live?.built ?? 0, allTodo);
  const running = Math.min(live?.running ?? 0, allTodo - built);
  const active = (progress?.byStatus.active ?? 0) + running;
  const isStarted = (progress?.done ?? 0) + active + built > 0;
  const todo = allTodo - built - running;
  const manual = progress?.byStatus.manual ?? 0;
  const quietTodo = Math.min(notStarted?.todo ?? 0, todo);
  const quietManual = Math.min(notStarted?.manual ?? 0, manual);
  const counts: Partial<Record<SegmentKind, number>> = isStarted
    ? { todo: todo - quietTodo, future: quietTodo + quietManual }
    : { todo: todo + quietManual, future: 0 };
  counts.manual = manual - quietManual;
  counts.active = active;
  counts.built = built;
  const count = (kind: SegmentKind): number =>
    counts[kind] ?? (kind === 'future' ? 0 : (progress?.byStatus[kind as TaskStatus] ?? 0));
  const parts = SEGMENT_ORDER.map((kind) => ({ kind, n: count(kind) })).filter((p) => p.n > 0);
  return { parts, isStarted };
}

/** The viewer's segment colors, light then dark (`styles/app.css`, `styles/tokens.css`). */
const SEGMENT_FILL: Record<SegmentKind | 'track', readonly [string, string]> = {
  done: ['#15803d', '#4cd480'],
  built: ['#0e7490', '#5ccfe6'],
  active: ['#0e7490', '#5ccfe6'],
  blocked: ['#be185d', '#f472c6'],
  manual: ['#6d28d9', '#a78bfa'],
  todo: ['#cfc8bc', '#423d36'],
  future: ['#cfc8bc', '#423d36'],
  unknown: ['#cfc8bc', '#423d36'],
  deferred: ['#756d63', '#8a837a'],
  cut: ['#e4dfd6', '#2e2b27'],
  track: ['#f2efe9', '#221f1c'],
};
const STARTED_TODO: readonly [string, string] = ['#ffb000', '#ffb000'];

/** Bar height in px, and the height of its SVG. */
export const BAR_HEIGHT = 6;
/** Px per cell when sizing an SVG to the pane's columns. */
const PX_PER_COLUMN = 8;

/**
 * A status bar as SVG: rounded stretches with 2 px gaps, each as wide as its
 * share (4 px at least). Fills come from a style block that follows the
 * reader's light or dark scheme, with mid-tone fills as attributes beneath it.
 */
export function barSvg(parts: readonly Segment[], isStarted: boolean, width: number, gapAbove = 0, gapBelow = 0): string {
  const h = BAR_HEIGHT + gapAbove + gapBelow;
  const y = gapAbove;
  const fills = (kind: SegmentKind | 'track'): readonly [string, string] =>
    kind === 'todo' && isStarted ? STARTED_TODO : SEGMENT_FILL[kind];
  const kinds = new Set<SegmentKind | 'track'>(parts.length === 0 ? ['track'] : parts.map((p) => p.kind));
  const style =
    [...kinds].map((k) => `.${k}{fill:${fills(k)[0]}}`).join('') +
    `@media (prefers-color-scheme: dark){${[...kinds].map((k) => `.${k}{fill:${fills(k)[1]}}`).join('')}}`;
  const out = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${h}" viewBox="0 0 ${width} ${h}">`,
    `<style>${style}</style>`,
  ];
  if (parts.length === 0) {
    out.push(`<rect class="track" x="0" y="${y}" width="${width}" height="${BAR_HEIGHT}" rx="3" fill="#8a837a" opacity="0.35"/>`);
  } else {
    const gap = 2;
    const room = Math.max(parts.length * 4, width - gap * (parts.length - 1));
    const total = parts.reduce((n, p) => n + p.n, 0);
    let x = 0;
    parts.forEach((p, i) => {
      const w = i === parts.length - 1 ? Math.max(4, width - x) : Math.max(4, Math.round((room * p.n) / total));
      const mid = fills(p.kind)[1];
      out.push(`<rect class="${p.kind}" x="${x}" y="${y}" width="${w}" height="${BAR_HEIGHT}" rx="3" fill="${mid}"${p.kind === 'cut' ? ' opacity="0.5"' : ''}/>`);
      x += w + gap;
    });
  }
  out.push('</svg>');
  return out.join('');
}

/** What a status bar says, for a reader that can't see it: `3 complete, 2 running`. */
export function barAlt(parts: readonly Segment[]): string {
  if (parts.length === 0) return 'No tasks';
  const words: Record<SegmentKind, string> = {
    done: 'complete',
    built: 'built',
    active: 'running',
    blocked: 'blocked',
    manual: 'manual',
    todo: 'not started',
    future: 'not started',
    unknown: 'unknown',
    deferred: 'deferred',
    cut: 'cut',
  };
  return parts.map((p) => `${p.n} ${words[p.kind]}`).join(', ');
}

/** Each stretch of a text bar: how many cells and its color, for the terminal. */
export function barCells(parts: readonly Segment[], isStarted: boolean, columns: number): { cells: number; color: string }[] {
  if (parts.length === 0) return [{ cells: columns, color: COLOR.dim }];
  const total = parts.reduce((n, p) => n + p.n, 0);
  const tone: Record<SegmentKind, string> = {
    done: COLOR.pass,
    built: COLOR.run,
    active: COLOR.run,
    blocked: COLOR.needs,
    manual: COLOR.manual,
    todo: isStarted ? COLOR.accent : COLOR.dim,
    future: COLOR.dim,
    unknown: COLOR.dim,
    deferred: COLOR.dim,
    cut: COLOR.dim,
  };
  let used = 0;
  return parts.map((p, i) => {
    const cells = i === parts.length - 1 ? Math.max(1, columns - used) : Math.max(1, Math.round((columns * p.n) / total));
    used += cells;
    return { cells, color: tone[p.kind] };
  });
}

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------

/** How a control looks: a bordered pill, or underlined words. */
export type ControlLook = 'pill' | 'link';

/** Draws one control: what `register.tsx` hands in on the desktop, where controls are `pill.tsx` Clients. */
export type ControlDrawer = (key: string, label: string, onPress: () => void, look: ControlLook, lead?: string) => RenderElement;

/**
 * The elements a drawing uses; `Svg` where the surface has it (not the
 * terminal), and `control` where controls are drawn as pills (the desktop).
 */
export type Kit = Pick<Elements['terminal'], 'Box' | 'Text' | 'Button'> & {
  Svg?: Elements['desktop']['Svg'];
  control?: ControlDrawer;
  /** A clear `hit.tsx` region, `cols` × `rows` until laid out, that presses on a click (the desktop). */
  hit?: (key: string, onPress: () => void, cols: number, rows: number) => RenderElement;
};

/**
 * A control: a pill on the desktop, a plain Button elsewhere. Its `key` is
 * what a press names. `lead` (a chevron) is drawn larger before the label and
 * left out of a link's underline.
 */
function control(kit: Kit, key: string, label: string, onPress: () => void, look: ControlLook = 'pill', lead?: string): RenderElement {
  if (kit.control) return kit.control(key, label, onPress, look, lead);
  const { Button } = kit;
  return <Button key={key} label={lead === undefined ? label : `${lead} ${label}`} plain onPress={onPress} />;
}

/**
 * Something pressed by a click anywhere on it: `children`, with a clear hit
 * region laid over them where the surface has one (the desktop). Elsewhere a
 * plain Button labelled `label` follows them, so the terminal can press it too.
 * The region is sized in cells, more than the children need, and clipped to
 * them. It comes first and the children after it, so a control among them
 * that is positioned (every pill and link is) is drawn over the region and
 * takes its own clicks, as an open card's rows do.
 */
function clickable(
  kit: Kit,
  key: string,
  label: string,
  onPress: () => void,
  rows: number,
  columns: number,
  children: readonly (RenderElement | false)[],
): RenderElement {
  const { Box, Button } = kit;
  if (!kit.hit) {
    return (
      <Box key={`click:${key}`} flexDirection="column">
        {children}
        <Button key={key} label={label} plain onPress={onPress} />
      </Box>
    );
  }
  return (
    <Box key={`click:${key}`} flexDirection="column" position="relative" overflow="hidden">
      <Box key={`hit:${key}`} position="absolute" top={0} left={0} right={0} bottom={0}>
        {kit.hit(key, onPress, columns, rows)}
      </Box>
      {children}
    </Box>
  );
}

/** Heading sizes in px, drawn as SVG text where the surface has it. */
const HEADING_PX = { screen: 20, phase: 17 } as const;

/** Text escaped for an Svg's markup. */
function svgEscape(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * A heading larger than a `Text` draws: one line of bold SVG text, `px` tall,
 * cut with an ellipsis to fit `columns`, in the viewer's text color for light
 * and dark, with `gapBelow` px of space under it. A plain bold Text where the
 * surface has no Svg.
 */
export function heading(kit: Kit, key: string, text: string, px: number, columns: number, gapBelow = 0): RenderElement {
  const { Svg, Text } = kit;
  if (!Svg) {
    return (
      <Text weight="semibold" wrap="truncate-end">
        {text}
      </Text>
    );
  }
  const width = Math.max(48, columns * PX_PER_COLUMN);
  // A system font's bold glyph averages a little over half its size across.
  const fits = Math.max(4, Math.floor(width / (px * 0.56)));
  const shown = [...text].length > fits ? `${[...text].slice(0, fits - 1).join('')}…` : text;
  const height = Math.round(px * 1.35) + gapBelow;
  const source =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    `<style>text{fill:#1f1c18}@media (prefers-color-scheme: dark){text{fill:#ece8e1}}</style>` +
    `<text x="0" y="${Math.round(px * 1.02)}" font-family="system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif" font-size="${px}" font-weight="650" fill="#ece8e1">${svgEscape(shown)}</text></svg>`;
  return <Svg key={key} source={source} alt={text} width={width} height={height} />;
}

/** The first Claude Code release this mod knows draws Text's `size`, `weight` and `mono`. */
const RICH_TEXT_SINCE = [2, 1, 299] as const;

/** Whether an engine version (`2.1.299`, `2.1.300-dev…`) draws Text's `size`, `weight` and `mono`. */
export function hasRichText(version: string): boolean {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!m) return false;
  const parts = [Number(m[1]), Number(m[2]), Number(m[3])];
  for (const [i, since] of RICH_TEXT_SINCE.entries()) {
    const part = parts[i] ?? 0;
    if (part !== since) return part > since;
  }
  return true;
}

/**
 * The kit for a surface. An engine older than {@link RICH_TEXT_SINCE} refuses
 * a whole tree over a Text that sets `size`, `weight` or `mono`, so there the
 * Text drops them, a semibold or bold weight drawn as `bold`.
 */
export function makeKit(els: Kit, isRichText: boolean): Kit {
  if (isRichText) return els;
  const Text: Kit['Text'] = ({ size: _size, weight, mono: _mono, tabular: _tabular, ...rest }) =>
    els.Text(weight === 'semibold' || weight === 'bold' ? { ...rest, bold: true } : rest);
  return { ...els, Text };
}

/** Draw the pane. */
export function drawPane(kit: Kit, given: PaneInput): RenderElement {
  const { Box, Text } = kit;
  // The desktop's frame keeps a strip down the body's right edge; a column on
  // the left evens the margins out. Svg is the desktop's sign here.
  const pad = kit.Svg ? 1 : 0;
  const input: PaneInput = { ...given, columns: given.columns - pad };
  const at = screenOf(input);
  return (
    <Box flexDirection="column" gap={1} paddingLeft={pad}>
      {liveStrip(kit, input)}
      {input.project === null || input.project.phases.length === 0 ? (
        <Box flexDirection="column">
          <Text weight="semibold">No phase plans found</Text>
          <Text color={COLOR.sub} wrap="wrap">
            {`Phase Runner looks for Phase-{N}-*.md files in ${input.root}/docs/phases/.`}
          </Text>
        </Box>
      ) : at.screen === 'phase' ? (
        phaseScreen(kit, input, input.project, at.phase)
      ) : (
        phasesScreen(kit, input, input.project)
      )}
    </Box>
  );
}

/**
 * Columns inside a card: less its padding, and its border where the border
 * takes a cell (the terminal). On the desktop a border is a 1 px line.
 */
function cardInner(kit: Kit, columns: number): number {
  return Math.max(8, columns - (kit.Svg ? 2 : 4));
}

function label(kit: Kit, text: string, color: string = COLOR.dim): RenderElement {
  const { Text } = kit;
  return (
    <Text size="footnote" weight="semibold" mono color={color}>
      {text.toUpperCase()}
    </Text>
  );
}

function badge(kit: Kit, b: BadgeView): RenderElement {
  const { Text } = kit;
  if (b.kind === 'tag') return label(kit, b.text, COLOR.dim);
  const tone: Tone = b.kind === 'run' ? 'run' : b.kind === 'fail' ? 'fail' : b.kind === 'pass' ? 'pass' : b.kind;
  return (
    <Text size="footnote" weight="semibold" mono color={COLOR[tone]}>
      {`${ICON[b.kind]} ${b.text.toUpperCase()}`}
    </Text>
  );
}

/** A status bar; `gapAbove` and `gapBelow` px of space around it on the desktop, drawn in the SVG (a row of the cell grid is 19 px, too much). */
function bar(kit: Kit, columns: number, parts: readonly Segment[], isStarted: boolean, key: string, gapAbove = 0, gapBelow = 0): RenderElement {
  const { Box, Text, Svg } = kit;
  if (Svg) {
    const width = Math.max(48, columns * PX_PER_COLUMN);
    return <Svg key={key} source={barSvg(parts, isStarted, width, gapAbove, gapBelow)} alt={barAlt(parts)} width={width} height={BAR_HEIGHT + gapAbove + gapBelow} />;
  }
  return (
    <Box flexDirection="row">
      {barCells(parts, isStarted, Math.max(4, columns)).map((c) => (
        <Text color={c.color}>{'━'.repeat(c.cells)}</Text>
      ))}
    </Box>
  );
}

/** The old status line, at the top of the pane while a run is live. Pressing it opens the live phase. */
function liveStrip(kit: Kit, input: PaneInput): RenderElement | false {
  const live = input.live;
  if (live === null) return false;
  const { Box, Text } = kit;
  const time = formatTime(live.at);
  return (
    <Box borderStyle="round" borderColor={COLOR.run} paddingX={1} flexDirection="column">
      <Box flexDirection="row" justifyContent="space-between" gap={1}>
        <Text size="footnote" weight="semibold" mono color={COLOR.run}>{`${ICON.run} LIVE · PHASE ${live.phase}`}</Text>
        {time !== '' && (
          <Text color={COLOR.dim}>
            {time}
          </Text>
        )}
      </Box>
      <Box flexDirection="row">
        {control(kit, 'live', live.text, () => input.actions.go({ screen: 'phase', phase: live.phase }), 'link')}
      </Box>
    </Box>
  );
}

/** `Sequential · 15 min · 1 retry`, as the viewer's wave cell reads. */
function waveMeta(row: RailRow): string {
  return [row.parallel ? '∥ Parallel' : 'Sequential', row.metaText].filter((s) => s !== null && s !== '').join(' · ');
}

// -- Phases -----------------------------------------------------------------

/** The viewer's escalation line without its second sentence, which is about the viewer. */
const ESCALATION_HERE = 'Waiting on you in the Claude Code session running the phase.';

const GROUP_ORDER: readonly PhaseGroup[] = ['progress', 'future', 'complete'];

function phasesScreen(kit: Kit, input: PaneInput, project: Project): RenderElement {
  const { Box, Text } = kit;
  const overall = project.progress.overall;
  const groups = GROUP_ORDER.map((group) => ({
    group,
    phases: project.phases.filter((p) => phaseGroup(project, p) === group),
  })).filter((g) => g.phases.length > 0);
  const folder = project.root.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? project.root;
  const quiet = project.phases.map((p) => notStartedTasks(project, p));
  const all = segments(overall, { todo: quiet.reduce((n, q) => n + q.todo, 0), manual: quiet.reduce((n, q) => n + q.manual, 0) });
  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="column">
        <Box flexDirection="row" justifyContent="space-between" alignItems="center" gap={1}>
          {heading(kit, 'title:project', 'Phase Runner', HEADING_PX.screen, Math.max(12, input.columns - [...folder].length - 2), 6)}
          <Text color={COLOR.dim} wrap="truncate-start">
            {folder}
          </Text>
        </Box>
        <Text color={COLOR.sub}>{`${overall.done}/${overall.eligible} tasks · ${plural(project.phases.length, 'phase')}`}</Text>
        {bar(kit, input.columns, all.parts, all.isStarted, 'bar:project')}
      </Box>
      {groups.map((g) => (
        <Box key={`group:${g.group}`} flexDirection="column" gap={1} paddingTop={1}>
          {label(kit, `${PHASE_GROUP_LABEL[g.group]} · ${g.phases.length}`)}
          {g.phases.map((phase) => phaseCard(kit, input, project, phase, g.group === 'complete'))}
        </Box>
      ))}
    </Box>
  );
}

/**
 * A phase on the list: a card with its number, task count, title, badge and
 * status bar, as on the viewer's board. A complete one is shorter: no bar.
 * A click anywhere on it opens the phase.
 */
function phaseCard(kit: Kit, input: PaneInput, project: Project, phase: Phase, isComplete: boolean): RenderElement {
  const { Box, Text } = kit;
  const progress = project.progress.byPhase[String(phase.number)];
  const { parts, isStarted } = segments(progress, notStartedTasks(project, phase));
  const warnings = phaseWarnings(project.warnings, phase.file, phaseRuns(project, phase.number)?.file ?? null);
  const b = phaseBadge(project, phase);
  const tone = b.kind === 'tag' ? 'dim' : b.kind;
  const inner = cardInner(kit, input.columns);
  return (
    <Box
      key={`box:phase:${phase.number}`}
      flexDirection="column"
      borderStyle="round"
      borderColor={tone === 'dim' || tone === 'pass' ? COLOR.dim : COLOR[tone]}
      borderDimColor={tone === 'dim' || tone === 'pass'}
      paddingX={1}
      hover={{ borderColor: COLOR.accent }}
    >
      {clickable(kit, `open:phase:${phase.number}`, `Open ${phaseTitle(phase)}`, () => openPhase(input, phase), 12, inner, [
        <Box flexDirection="row" justifyContent="space-between" gap={1}>
          {label(kit, `Phase ${phase.number}`, COLOR.accent)}
          <Text color={COLOR.dim}>{`${progress?.done ?? 0}/${progress?.eligible ?? 0} tasks`}</Text>
        </Box>,
        heading(kit, `title:phase:${phase.number}`, phaseTitle(phase), HEADING_PX.phase, inner),
        <Box flexDirection="row" gap={1} flexWrap="wrap">
          {badge(kit, b)}
          {warnings > 0 && <Text color={COLOR.accent}>{`${ICON.warn} ${plural(warnings, 'warning')}`}</Text>}
        </Box>,
        !isComplete && bar(kit, inner, parts, isStarted, `bar:phase:${phase.number}`, 8),
      ])}
    </Box>
  );
}

function openPhase(input: PaneInput, phase: Phase): void {
  input.actions.go({ screen: 'phase', phase: phase.number });
}

function phaseTitle(phase: Phase): string {
  return phase.title === '' ? `Phase ${phase.number}` : phase.title;
}

// -- Phase rail -------------------------------------------------------------

function phaseScreen(kit: Kit, input: PaneInput, project: Project, phase: Phase): RenderElement {
  const { Box, Text } = kit;
  const view = railView(project, phase, input.now);
  const end = runEnd(view);
  const runs = phaseRuns(project, phase.number);
  const progress = project.progress.byPhase[String(phase.number)];
  const { parts, isStarted } = segments(progress, notStartedTasks(project, phase));
  const warnings = phaseWarnings(project.warnings, phase.file, runs?.file ?? null);
  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="row">{control(kit, 'back', '‹ All phases', () => input.actions.go({ screen: 'phases' }))}</Box>
      <Box flexDirection="column">
        <Box flexDirection="row" justifyContent="space-between" gap={1}>
          {label(kit, `Phase ${phase.number}`, COLOR.accent)}
          <Text color={COLOR.dim}>{`${progress?.done ?? 0}/${progress?.eligible ?? 0} tasks`}</Text>
        </Box>
        {heading(kit, `title:rail:${phase.number}`, phaseTitle(phase), HEADING_PX.screen, input.columns, 14)}
        {badge(kit, phaseBadge(project, phase))}
      </Box>
      {(runs?.escalations ?? []).map((esc) =>
        banner(kit, 'needs', `${ICON.needs} ${escalationTitle(esc)}`, [ESCALATION_HERE], `esc:${esc.line}`),
      )}
      {warnings > 0 &&
        banner(kit, 'accent', `${ICON.warn} ${plural(warnings, 'line')} couldn't be read`, ['Everything else is shown. phase-viewer lists them.'], 'warnings')}
      {bar(kit, input.columns, parts, isStarted, `bar:rail:${phase.number}`, 0, 10)}
      <Box flexDirection="row" gap={1}>
        {label(kit, 'Sprints')}
        <Text color={COLOR.dim}>{view.summaryText ?? 'No run log'}</Text>
      </Box>
      {view.rows.map((row) => railRow(kit, input, row, view.hasRunLog))}
      {end && runEndBanner(kit, end)}
    </Box>
  );
}

function banner(kit: Kit, tone: Tone, title: string, lines: readonly string[], key: string): RenderElement {
  const { Box, Text } = kit;
  return (
    <Box key={key} flexDirection="column" borderStyle="round" borderColor={COLOR[tone]} paddingX={1}>
      <Text color={COLOR[tone]} weight="semibold" wrap="wrap">
        {title}
      </Text>
      {lines.map((line) => (
        <Text color={COLOR.sub} wrap="wrap">
          {line}
        </Text>
      ))}
    </Box>
  );
}

function runEndBanner(kit: Kit, end: RunEnd): RenderElement {
  const tone: Tone = end.kind === 'pass' ? 'pass' : end.kind;
  const title = `${ICON[end.kind]} ${end.title}${end.attentionText !== null ? ` · ${end.attentionText}` : ''}`;
  return banner(kit, tone, title, end.items, 'run-end');
}

/** A wave and its cards. With no run log at all there is one group, and "No run log" above already names it. */
function railRow(kit: Kit, input: PaneInput, row: RailRow, hasRunLog: boolean): RenderElement {
  const { Box, Text } = kit;
  const isWave = row.kind === 'wave';
  return (
    <Box key={`row:${row.key}`} flexDirection="column" gap={1}>
      {(isWave || hasRunLog) && (
      <Box flexDirection="row" justifyContent="space-between" gap={1}>
        <Box flexDirection="row" gap={1} flexShrink={0}>
          {isWave && <Text color={row.state === 'done' ? COLOR.pass : COLOR.run}>{row.state === 'done' ? ICON.pass : ICON.run}</Text>}
          {label(kit, row.label, isWave ? COLOR.text : COLOR.dim)}
        </Box>
        {isWave && (
          <Text color={COLOR.dim} wrap="truncate-end">
            {waveMeta(row)}
          </Text>
        )}
      </Box>
      )}
      {row.sprints.map((sprint) => sprintCard(kit, input, sprint, row.kind === 'not-run'))}
    </Box>
  );
}

const CARD_BORDER: Record<Tone, string> = {
  run: COLOR.run,
  fail: COLOR.fail,
  needs: COLOR.needs,
  manual: COLOR.manual,
  accent: COLOR.accent,
  pass: COLOR.dim,
  dim: COLOR.dim,
};

function sprintCard(kit: Kit, input: PaneInput, card: RailSprint, isDashed: boolean): RenderElement {
  const { Box, Text } = kit;
  const key = `card:${card.id}`;
  const isOpen = input.toggled[key] ?? isActiveState(card.state);
  const tone = stateTone(card.state);
  const live = liveTaskStates(card.run);
  const { parts, isStarted } = segments(card.progress, undefined, liveTaskCounts(card.sprint.tasks, live));
  // Inside the border and its padding.
  const inner = cardInner(kit, input.columns);
  return (
    <Box
      key={`box:${key}`}
      flexDirection="column"
      borderStyle={isDashed ? 'dashed' : 'round'}
      borderColor={CARD_BORDER[tone]}
      borderDimColor={tone === 'dim' || tone === 'pass'}
      paddingX={1}
      hover={{ borderColor: COLOR.accent }}
    >
      {clickable(kit, key, `${isOpen ? '▾' : '▸'} ${card.title}`, () => input.actions.toggle(key, isOpen), cardRows(card, isOpen), inner, [
        <Box flexDirection="row" justifyContent="space-between" gap={1}>
          {label(kit, `Sprint ${card.id}`, COLOR.accent)}
          <Text color={COLOR.dim}>{`${card.progress.done}/${card.progress.eligible} tasks`}</Text>
        </Box>,
        heading(kit, `title:${key}`, card.title, HEADING_PX.phase, inner),
        <Text size="footnote" weight="semibold" mono color={tone === 'dim' ? COLOR.dim : COLOR[tone]}>
          {`${stateIcon(card.state)} ${card.stateText.toUpperCase()}`}
        </Text>,
        card.state !== 'complete' && bar(kit, inner, parts, isStarted, `bar:${key}`, 8),
        isOpen && cardBody(kit, input, card, live),
      ])}
    </Box>
  );
}

/**
 * Rows enough to cover a card, for its click region: well over what it takes,
 * since the card clips the region to itself and a short one leaves its foot dead.
 */
function cardRows(card: RailSprint, isOpen: boolean): number {
  if (!isOpen) return 12;
  const s = card.sprint;
  const items = s.tasks.length * 4 + s.acceptanceCriteria.length * 3 + s.dependencies.length * 3 + card.runNotes.length * 6;
  return Math.min(400, 40 + items * 2);
}

function cardBody(kit: Kit, input: PaneInput, card: RailSprint, live: ReturnType<typeof liveTaskStates>): RenderElement {
  const { Box, Text } = kit;
  const sprint = card.sprint;
  const v = sprint.verification;
  const verification: string[] = [
    ...(v.cli ? [`cli: ${v.cli}`] : []),
    ...(v.ui.length > 0 ? [`ui: ${v.ui.join(', ')}`] : []),
    ...(v.skipUi ? ['skip-ui: true'] : []),
    ...(v.skills.length > 0 ? [`skills: ${v.skills.join(', ')}`] : []),
    ...(v.viewports.length > 0 ? [`viewports: ${v.viewports.join(', ')}`] : []),
    ...v.assert.map((a) => `assert: ${a}`),
    ...Object.entries(v.extra).map(([k, val]) => `${k}: ${val}`),
  ];
  const deps = sprint.dependencies.filter((d) => !d.none).map((d) => d.raw);
  const isStarted = card.progress.done + card.progress.byStatus.active > 0 || live.size > 0;
  return (
    <Box flexDirection="column" gap={1} marginTop={1}>
      {sprint.goal !== null && sprint.goal !== '' && (
        <Text size="heading" color={COLOR.sub} wrap="wrap">
          {sprint.goal}
        </Text>
      )}
      {card.failure && (
        <Box flexDirection="column" borderStyle="round" borderColor={COLOR.fail} paddingX={1}>
          <Text color={COLOR.fail} weight="semibold" wrap="wrap">
            {`${ICON.fail} ${card.failure.note.title} · ${card.failure.note.time}`}
          </Text>
          {card.failure.note.summary !== '' && (
            <Text color={COLOR.sub} mono wrap="wrap">
              {card.failure.note.summary}
            </Text>
          )}
          {card.failure.statusText !== '' && <Text color={COLOR.accent}>{card.failure.statusText}</Text>}
        </Box>
      )}
      <Box flexDirection="column" gap={1}>
        {label(kit, `Tasks ${card.progress.done}/${card.progress.eligible}`)}
        {sprint.tasks.length === 0 && <Text color={COLOR.dim}>No tasks</Text>}
        {sprint.tasks.map((task) => taskLine(kit, task, live, isStarted))}
      </Box>
      <Box flexDirection="column" gap={1}>
      {section(kit, input, `${card.id}:criteria`, 'Acceptance criteria', sprint.acceptanceCriteria.length, () =>
        sprint.acceptanceCriteria.map((c) => (
          <Text size="heading" color={COLOR.text} wrap="wrap">{`${c.checked === true ? '☑' : '☐'} ${c.text}`}</Text>
        )),
      )}
      {section(kit, input, `${card.id}:deps`, 'Dependencies', deps.length, () =>
        deps.map((d) => <Text size="heading" color={COLOR.text} wrap="wrap">{`· ${d}`}</Text>),
      )}
      {section(kit, input, `${card.id}:verify`, 'Verification', verification.length, () =>
        verification.map((line) => (
          <Text color={COLOR.text} mono wrap="wrap">
            {line}
          </Text>
        )),
      )}
      {section(kit, input, `${card.id}:notes`, 'Run notes', card.runNotes.length, () =>
        card.runNotes.map((note) => (
          <Box flexDirection="column">
            <Text size="heading" color={note.kind === 'failed' ? COLOR.fail : COLOR.sub} weight="semibold" wrap="wrap">
              {`${note.title} · ${note.time}`}
            </Text>
            {note.summary !== '' && (
              <Text color={COLOR.sub} mono wrap="wrap">
                {note.summary}
              </Text>
            )}
            {note.resolutionText !== null && (
              <Text color={COLOR.pass} wrap="wrap">
                {note.resolutionText}
              </Text>
            )}
          </Box>
        )),
      )}
      </Box>
    </Box>
  );
}

function taskLine(kit: Kit, task: Task, live: ReturnType<typeof liveTaskStates>, isStarted: boolean): RenderElement {
  const { Box, Text } = kit;
  const row = taskRow(task, live);
  const tone = row.icon === 'wait' && !isStarted ? 'dim' : ICON_TONE[row.icon];
  const isGone = task.status === 'cut' || task.status === 'deferred';
  return (
    <Box flexDirection="row" gap={1}>
      <Text size="heading" color={COLOR[tone]}>
        {ICON[row.icon]}
      </Text>
      <Box flexDirection="column" flexShrink={1}>
        <Text size="heading" color={isGone ? COLOR.dim : COLOR.text} strikethrough={isGone} wrap="wrap">
          {task.text}
        </Text>
        <Text color={COLOR[tone]}>
          {`${task.number !== null ? `#${task.number} · ` : ''}${row.words}`}
        </Text>
        {task.status === 'blocked' && <Text color={COLOR.needs}>Blocked: waiting on you.</Text>}
      </Box>
    </Box>
  );
}

/** A closed-by-default row of a card; left out when it has nothing to show. */
function section(kit: Kit, input: PaneInput, key: string, title: string, count: number, body: () => RenderElement[]): RenderElement | false {
  const { Box } = kit;
  const isOpen = input.toggled[key] ?? false;
  if (count === 0) return false;
  return (
    <Box flexDirection="column">
      <Box flexDirection="row">{control(kit, key, `${title} · ${count}`, () => input.actions.toggle(key, isOpen), 'link', isOpen ? '▼' : '▶')}</Box>
      {isOpen && (
        <Box flexDirection="column" gap={1} paddingLeft={2} marginTop={1}>
          {body()}
        </Box>
      )}
    </Box>
  );
}
