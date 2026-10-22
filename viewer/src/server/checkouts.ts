/**
 * One project from every checkout: the main checkout plus each linked git
 * worktree of the project's repo (see `worktrees.ts`), merged phase by phase.
 *
 * A phase run in a worktree writes its run log and its phase-file status
 * edits inside that worktree. Each checkout is read into its own
 * {@link ProjectState} (`state.ts`, unchanged), and {@link mergeCheckouts}
 * picks one checkout per phase number:
 *
 * 1. **Candidates.** The base checkout (the main checkout; the root's own
 *    checkout when the main one has no `docs/phases/`) is a candidate when it
 *    has a run log for the phase. A linked worktree is a candidate when its
 *    log has an event at or after the worktree's creation time
 *    ({@link Checkout.createdMs}), compared in whole seconds, so an event in
 *    the same second as the creation counts. A log the worktree only
 *    inherited at checkout (a tracked `phase-15.jsonl`) has no such event and
 *    never wins.
 * 2. **Winner.** Among the candidates, the log whose last event has the latest
 *    `ts` wins. A tie goes to the base checkout, then to the first worktree
 *    by name.
 * 3. **Phase file.** The winner's copy of the phase file comes along with its
 *    log. When the winner has none, or no copy has a candidate log, the base
 *    checkout's copy is used. A phase file that exists only in worktrees is
 *    shown from the worktree whose copy is newest by mtime.
 *
 * Copies from a linked worktree carry {@link Phase.worktree} /
 * {@link PhaseRuns.worktree}. Every copy keeps its real absolute `file`, so a
 * phase moving between checkouts reaches clients as a `removed` update for
 * the old file plus a `phase` update for the new one (the client keys phases
 * and run logs by `file`), with no protocol change. `root`, `phasesDir`,
 * `hasDesignSystem` and the "no docs/phases/" warning come from the checkout
 * the viewer was started for; per-file warnings come from the files shown.
 * With a single checkout the merged project is that checkout's snapshot,
 * unchanged.
 *
 * {@link createCheckoutSet} keeps the merged project current and diffs it
 * against what clients last saw, the same way `state.ts` does.
 * {@link watchCheckouts} drives it: one {@link watchProject} per checkout,
 * plus a watcher on the git folder's `worktrees/` entries that loads a
 * worktree when it appears and drops it when it goes.
 *
 * Read-only: `stat`, `readdir` and `readFile` only, in the git folder
 * included. No git binary and no child process.
 */
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { watch, type FSWatcher } from 'chokidar';
import type { Phase, PhaseRuns, Project, Warning, WorktreeRef } from '../core/model.js';
import type { StateUpdate } from '../shared/protocol.js';
import { deriveProgress } from '../core/derive/progress.js';
import { normalizeRoot, sameRoot } from './instance.js';
import { createProjectState, type FileChange, type ProjectState } from './state.js';
import { DEFAULT_DEBOUNCE_MS, watchProject, type ProjectWatcher, type WatchOptions } from './watch.js';
import { findCheckouts, gitCommonDir, worktreesDir, type Checkout, type WorktreeOptions } from './worktrees.js';

/** One checkout's current project, as {@link mergeCheckouts} reads it. */
export interface CheckoutCopy {
  checkout: Checkout;
  project: Project;
}

/** The live merged project. */
export interface CheckoutSet {
  /** Absolute project folder the viewer was started for. */
  readonly root: string;
  /** The repo's git common dir, or `null` when the root isn't in a repo. */
  readonly commonDir: string | null;
  /** The checkouts currently loaded: the main checkout first, then linked worktrees by name. */
  checkouts(): Checkout[];
  /** The merged {@link Project}. Equal to `createProjectState(root).snapshot()` when there are no worktrees. Don't mutate it. */
  snapshot(): Project;
  /**
   * Re-read one changed file in whichever checkout's `docs/` holds it, re-merge,
   * and return what clients need, in this order: phase removals and updates,
   * run removals and updates, design, warnings. Empty when nothing visible
   * changed or no checkout holds the file.
   */
  apply(change: FileChange): Promise<StateUpdate[]>;
  /** Re-list the worktrees: load new ones, drop gone ones, re-merge. */
  rescan(): Promise<StateUpdate[]>;
  /** Re-read one checkout from scratch (after its watcher started), re-merge. */
  reload(checkoutRoot: string): Promise<StateUpdate[]>;
}

/** One loaded checkout. */
interface Member {
  checkout: Checkout;
  state: ProjectState;
  key: string;
}

/** What a client last saw for one file. */
interface Sent<T> {
  value: T;
  json: string;
  number: number;
}

/**
 * Load every checkout of `root`'s repo and merge them.
 *
 * @param root The project folder (the one holding `docs/phases/`); resolved
 *   to an absolute path.
 */
export async function createCheckoutSet(root: string, options: WorktreeOptions = {}): Promise<CheckoutSet> {
  const absRoot = path.resolve(root);
  const commonDir = await gitCommonDir(absRoot, options);
  let members: Member[] = [];
  for (const checkout of await listCheckouts()) members.push(await load(checkout));

  const sentPhases = new Map<string, Sent<Phase>>();
  const sentRuns = new Map<string, Sent<PhaseRuns>>();
  let project = await merge();
  for (const phase of project.phases) {
    sentPhases.set(phase.file, { value: phase, json: JSON.stringify(phase), number: phase.number });
  }
  for (const runs of project.runs) {
    sentRuns.set(runs.file, { value: runs, json: JSON.stringify(runs), number: runs.phase });
  }
  let warningsJson = JSON.stringify(project.warnings);
  let queue: Promise<unknown> = Promise.resolve();

  /** The checkouts, with the start root spelled exactly as given (so `Project.root` matches it). */
  async function listCheckouts(): Promise<Checkout[]> {
    const found = await findCheckouts(absRoot, options);
    return found.map((c) => (sameRoot(c.root, absRoot) ? { ...c, root: absRoot } : c));
  }

  async function load(checkout: Checkout): Promise<Member> {
    return { checkout, state: await createProjectState(checkout.root), key: normalizeRoot(checkout.root) };
  }

  /** Merge the members' snapshots, with mtimes for phase files only worktrees have. */
  async function merge(): Promise<Project> {
    const copies = members.map((m) => ({ checkout: m.checkout, project: m.state.snapshot() }));
    const mtimes = new Map<string, number>();
    const base = baseCopy(copies, absRoot);
    if (base !== undefined && copies.length > 1) {
      const baseNumbers = new Set(base.project.phases.map((p) => p.number));
      for (const copy of copies) {
        if (copy === base) continue;
        for (const phase of copy.project.phases) {
          if (!baseNumbers.has(phase.number)) mtimes.set(phase.file, await mtimeOf(phase.file));
        }
      }
    }
    return mergeCheckouts(copies, absRoot, (file) => mtimes.get(file) ?? 0);
  }

  /** Re-merge and diff against what clients last saw. */
  async function remerge(): Promise<StateUpdate[]> {
    const previous = project;
    project = await merge();
    const updates: StateUpdate[] = [];

    // Phases: removals first, so a phase moving between checkouts reads as
    // `removed` (old file) then `phase` (new file).
    const phaseFiles = new Set(project.phases.map((p) => p.file));
    for (const [file, sent] of sentPhases) {
      if (phaseFiles.has(file)) continue;
      sentPhases.delete(file);
      updates.push({ type: 'removed', kind: 'phase', file, number: sent.number, progress: project.progress });
    }
    for (const phase of project.phases) {
      const sent = sentPhases.get(phase.file);
      if (sent?.value === phase) continue;
      const json = JSON.stringify(phase);
      sentPhases.set(phase.file, { value: phase, json, number: phase.number });
      if (sent?.json !== json) updates.push({ type: 'phase', file: phase.file, phase, progress: project.progress });
    }

    // Run logs, the same way.
    const runFiles = new Set(project.runs.map((r) => r.file));
    for (const [file, sent] of sentRuns) {
      if (runFiles.has(file)) continue;
      sentRuns.delete(file);
      updates.push({ type: 'removed', kind: 'run', file, number: sent.number, progress: project.progress });
    }
    for (const runs of project.runs) {
      const sent = sentRuns.get(runs.file);
      if (sent?.value === runs) continue;
      const json = JSON.stringify(runs);
      sentRuns.set(runs.file, { value: runs, json, number: runs.phase });
      if (sent?.json !== json) updates.push({ type: 'run', file: runs.file, runs });
    }

    if (project.hasDesignSystem !== previous.hasDesignSystem) {
      updates.push({ type: 'design', hasDesignSystem: project.hasDesignSystem });
    }

    const json = JSON.stringify(project.warnings);
    if (json !== warningsJson) {
      warningsJson = json;
      updates.push({ type: 'warnings', warnings: project.warnings });
    }
    return updates;
  }

  /** The member whose `docs/` folder holds `file` (the deepest one, should checkouts nest). */
  function owner(file: string): Member | undefined {
    let best: Member | undefined;
    for (const m of members) {
      const rel = path.relative(path.join(m.state.root, 'docs'), file);
      if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) continue;
      if (best === undefined || m.state.root.length > best.state.root.length) best = m;
    }
    return best;
  }

  async function applyNow(change: FileChange): Promise<StateUpdate[]> {
    const member = owner(path.resolve(change.file));
    if (member === undefined) return [];
    await member.state.apply(change);
    return remerge();
  }

  async function rescanNow(): Promise<StateUpdate[]> {
    const next: Member[] = [];
    for (const checkout of await listCheckouts()) {
      const key = normalizeRoot(checkout.root);
      const existing = members.find((m) => m.key === key && m.checkout.createdMs === checkout.createdMs);
      next.push(existing ? { ...existing, checkout } : await load(checkout));
    }
    members = next;
    return remerge();
  }

  async function reloadNow(checkoutRoot: string): Promise<StateUpdate[]> {
    const key = normalizeRoot(checkoutRoot);
    const index = members.findIndex((m) => m.key === key);
    const member = members[index];
    if (member === undefined) return [];
    const fresh = await load(member.checkout);
    // A rescan may have replaced the list meanwhile; only swap the same entry.
    if (members[index] === member) members[index] = fresh;
    return remerge();
  }

  /** Run one operation after the previous ones, never rejecting. */
  function enqueue(run: () => Promise<StateUpdate[]>): Promise<StateUpdate[]> {
    const result = queue.then(run).catch((): StateUpdate[] => []);
    queue = result;
    return result;
  }

  return {
    root: absRoot,
    commonDir,
    checkouts: () => members.map((m) => m.checkout),
    snapshot: () => project,
    apply: (change) => enqueue(() => applyNow(change)),
    rescan: () => enqueue(rescanNow),
    reload: (checkoutRoot) => enqueue(() => reloadNow(checkoutRoot)),
  };
}

// ---------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------

/**
 * Build one {@link Project} from every checkout's snapshot by the rule in the
 * module comment.
 *
 * @param copies Every checkout with its snapshot (main checkout first, as
 *   `findCheckouts` lists them). Must not be empty.
 * @param startRoot The project folder the viewer was started for: its
 *   checkout supplies `root`, `phasesDir`, `hasDesignSystem` and the folder
 *   warning.
 * @param mtimeMs Modification time of a phase file, used only for a phase
 *   whose file exists in worktrees alone. Default: `0` for every file.
 */
export function mergeCheckouts(
  copies: readonly CheckoutCopy[],
  startRoot: string,
  mtimeMs: (file: string) => number = () => 0,
): Project {
  const start = copies.find((c) => sameRoot(c.checkout.root, startRoot)) ?? copies[0];
  if (start === undefined) throw new Error('mergeCheckouts needs at least one checkout');
  if (copies.length === 1) return start.project;
  const base = baseCopy(copies, startRoot) ?? start;

  const byPhase = copies.map((c) => groupBy(c.project.phases, (p) => p.number));
  const byRuns = copies.map((c) => new Map(c.project.runs.map((r) => [r.phase, r] as const)));
  const baseIndex = copies.indexOf(base);

  const numbers = new Set<number>();
  for (const c of copies) {
    for (const p of c.project.phases) numbers.add(p.number);
    for (const r of c.project.runs) numbers.add(r.phase);
  }

  /** Per phase number: which copy supplies its phase files and which its run log. */
  const picks: { number: number; phaseFrom: number; runFrom: number }[] = [];
  for (const n of [...numbers].sort((a, b) => a - b)) {
    // The winning run log.
    let runFrom = -1;
    let latest = -Infinity;
    if (byRuns[baseIndex]?.has(n)) {
      runFrom = baseIndex;
      latest = lastEventSeconds(byRuns[baseIndex]?.get(n));
    }
    copies.forEach((copy, i) => {
      if (i === baseIndex) return;
      const runs = byRuns[i]?.get(n);
      if (runs === undefined || !isCandidate(runs, copy.checkout)) return;
      const ts = lastEventSeconds(runs);
      if (runFrom === -1 || ts > latest) {
        runFrom = i;
        latest = ts;
      }
    });

    // The phase file: the winner's, else the base checkout's, else the newest worktree copy.
    let phaseFrom = -1;
    if (runFrom !== -1 && byPhase[runFrom]?.has(n)) phaseFrom = runFrom;
    else if (byPhase[baseIndex]?.has(n)) phaseFrom = baseIndex;
    else {
      let newest = -Infinity;
      copies.forEach((_, i) => {
        const files = byPhase[i]?.get(n);
        if (files === undefined) return;
        const mtime = Math.max(...files.map((p) => mtimeMs(p.file)));
        if (phaseFrom === -1 || mtime > newest) {
          phaseFrom = i;
          newest = mtime;
        }
      });
    }
    picks.push({ number: n, phaseFrom, runFrom });
  }

  // Everything from the start checkout, and it's the main one: its snapshot as is.
  const startIndex = copies.indexOf(start);
  if (
    start.checkout.main &&
    picks.every((p) => (p.phaseFrom === -1 || p.phaseFrom === startIndex) && (p.runFrom === -1 || p.runFrom === startIndex))
  ) {
    return start.project;
  }

  const phases: Phase[] = [];
  const runs: PhaseRuns[] = [];
  const shown: { copy: CheckoutCopy; file: string }[] = [];
  for (const pick of picks) {
    const from = copies[pick.phaseFrom];
    if (from !== undefined) {
      for (const phase of byPhase[pick.phaseFrom]?.get(pick.number) ?? []) {
        phases.push(tagged(phase, from.checkout));
        shown.push({ copy: from, file: phase.file });
      }
    }
  }
  for (const pick of picks) {
    const from = copies[pick.runFrom];
    const log = byRuns[pick.runFrom]?.get(pick.number);
    if (from !== undefined && log !== undefined) {
      runs.push(tagged(log, from.checkout));
      shown.push({ copy: from, file: log.file });
    }
  }

  // Warnings: the start checkout's own (not about a phase file or run log,
  // e.g. "no docs/phases/ folder"), then each shown file's, phase files first.
  const startFiles = new Set([...start.project.phases.map((p) => p.file), ...start.project.runs.map((r) => r.file)]);
  const warnings: Warning[] = start.project.warnings.filter((w) => !startFiles.has(w.file));
  const byFile = new Map<CheckoutCopy, Map<string, Warning[]>>();
  for (const { copy, file } of shown) {
    let grouped = byFile.get(copy);
    if (grouped === undefined) {
      grouped = groupBy(copy.project.warnings, (w) => w.file);
      byFile.set(copy, grouped);
    }
    warnings.push(...(grouped.get(file) ?? []));
  }

  return {
    root: start.project.root,
    phasesDir: start.project.phasesDir,
    phases,
    runs,
    hasDesignSystem: start.project.hasDesignSystem,
    progress: deriveProgress(phases),
    warnings,
  };
}

/** The main checkout's copy; the start checkout's when the main one isn't loaded. */
function baseCopy(copies: readonly CheckoutCopy[], startRoot: string): CheckoutCopy | undefined {
  return copies.find((c) => c.checkout.main) ?? copies.find((c) => sameRoot(c.checkout.root, startRoot)) ?? copies[0];
}

/**
 * `true` when a worktree's log has an event at or after the worktree's
 * creation, in whole seconds (event `ts` has second precision; `createdMs`
 * is floored to its second). Events that don't parse don't count.
 */
export function isCandidate(runs: PhaseRuns, checkout: Checkout): boolean {
  if (checkout.main) return true;
  const created = Math.floor(checkout.createdMs / 1000);
  return runs.events.some((e) => tsSeconds(e.ts) >= created);
}

/** Whole seconds of the log's last event `ts`; `-Infinity` when it has none or it doesn't parse. */
function lastEventSeconds(runs: PhaseRuns | undefined): number {
  const last = runs?.events[runs.events.length - 1];
  return last === undefined ? -Infinity : tsSeconds(last.ts);
}

/** Whole seconds since the epoch for an event `ts`; `-Infinity` when it doesn't parse. */
function tsSeconds(ts: string): number {
  const ms = Date.parse(ts);
  return Number.isNaN(ms) ? -Infinity : Math.floor(ms / 1000);
}

/** Cached tagged copies, so an unchanged source keeps one identity across merges. */
const tagCache = new WeakMap<object, { key: string; value: object }>();

/** `value` as is for the main checkout; else a copy with `worktree` set. */
function tagged<T extends Phase | PhaseRuns>(value: T, checkout: Checkout): T {
  if (checkout.main) return value;
  const ref: WorktreeRef = {
    name: checkout.name ?? path.basename(checkout.root),
    branch: checkout.branch,
    path: checkout.root,
  };
  const key = JSON.stringify(ref);
  const cached = tagCache.get(value);
  if (cached?.key === key) return cached.value as T;
  const copy = { ...value, worktree: ref };
  tagCache.set(value, { key, value: copy });
  return copy;
}

function groupBy<T, K>(items: readonly T[], keyOf: (item: T) => K): Map<K, T[]> {
  const map = new Map<K, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    const list = map.get(key);
    if (list) list.push(item);
    else map.set(key, [item]);
  }
  return map;
}

/** A file's mtime in ms; `0` when it can't be read. */
async function mtimeOf(file: string): Promise<number> {
  try {
    return (await stat(file)).mtimeMs;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Watching
// ---------------------------------------------------------------------------

/**
 * Watch every checkout in `set`, and the git folder's `worktrees/` entries.
 *
 * - One {@link watchProject} per checkout; each settled change is applied to
 *   the set and its updates passed to `onUpdates`.
 * - One watcher on the git common dir, filtered to `worktrees/` and the files
 *   directly in each `worktrees/{name}/` (so it works before the first
 *   worktree ever exists). Any change there re-lists the worktrees after
 *   `debounceMs`; a new worktree is loaded and watched (and re-read once its
 *   watcher is ready, to catch files written meanwhile), and a gone one is
 *   dropped, its phases falling back to the main checkout.
 *
 * If the git folder can't be watched, errors go to `onError` and the
 * checkouts found at start keep working.
 *
 * @param onUpdates Called with each non-empty batch of updates. Exceptions it
 *   throws are passed to `onError`.
 */
export function watchCheckouts(
  set: CheckoutSet,
  onUpdates: (updates: StateUpdate[]) => void,
  options: WatchOptions = {},
): ProjectWatcher {
  const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const onError = options.onError ?? (() => undefined);
  const watchers = new Map<string, ProjectWatcher>();
  let closed = false;
  let rescanTimer: NodeJS.Timeout | undefined;

  const emit = (updates: StateUpdate[]): void => {
    if (closed || updates.length === 0) return;
    try {
      onUpdates(updates);
    } catch (err) {
      onError(err instanceof Error ? err : new Error(String(err)));
    }
  };

  const start = (checkout: Checkout): ProjectWatcher =>
    watchProject(
      checkout.root,
      (change) => {
        void set.apply(change).then(emit);
      },
      { debounceMs, usePolling: options.usePolling, onError },
    );

  /** Start watchers for new checkouts and close the ones for gone checkouts. */
  const sync = (): void => {
    if (closed) return;
    const current = new Map(set.checkouts().map((c) => [watchKey(c), c] as const));
    for (const [key, watcher] of watchers) {
      if (current.has(key)) continue;
      watchers.delete(key);
      void watcher.close();
    }
    for (const [key, checkout] of current) {
      if (watchers.has(key)) continue;
      const watcher = start(checkout);
      watchers.set(key, watcher);
      void watcher.ready.then(() => {
        if (closed || watchers.get(key) !== watcher) return;
        return set.reload(checkout.root).then(emit);
      });
    }
  };

  const initial: Promise<void>[] = [];
  for (const checkout of set.checkouts()) {
    const watcher = start(checkout);
    watchers.set(watchKey(checkout), watcher);
    initial.push(watcher.ready);
  }

  let gitWatcher: FSWatcher | null = null;
  if (set.commonDir !== null) {
    const common = path.resolve(set.commonDir);
    const entries = worktreesDir(common);
    gitWatcher = watch(common, {
      ignoreInitial: true,
      persistent: true,
      usePolling: options.usePolling ?? false,
      depth: 2,
      ignored: (p: string) => !inWorktreesTree(common, entries, p),
    });
    gitWatcher.on('all', () => {
      if (closed) return;
      if (rescanTimer) clearTimeout(rescanTimer);
      rescanTimer = setTimeout(() => {
        rescanTimer = undefined;
        if (closed) return;
        void set.rescan().then((updates) => {
          emit(updates);
          sync();
        });
      }, debounceMs);
    });
    gitWatcher.on('error', (err) => onError(err instanceof Error ? err : new Error(String(err))));
    const ready = gitWatcher;
    initial.push(new Promise<void>((resolve) => ready.once('ready', () => resolve())));
  }

  let resolveReady: () => void = () => undefined;
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });
  void Promise.all(initial).then(() => resolveReady());

  return {
    ready,
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      if (rescanTimer) clearTimeout(rescanTimer);
      resolveReady();
      const all = [...watchers.values()];
      watchers.clear();
      await Promise.all([...all.map((w) => w.close()), gitWatcher?.close()]);
    },
  };
}

/** Watcher identity: a recreated worktree at the same path gets a fresh watcher. */
function watchKey(checkout: Checkout): string {
  return `${normalizeRoot(checkout.root)}|${checkout.createdMs}`;
}

/** `true` for the common dir itself, `worktrees/`, each `worktrees/{name}/` and the files directly in it. */
function inWorktreesTree(common: string, entries: string, p: string): boolean {
  const abs = path.resolve(p);
  if (path.relative(common, abs) === '') return true;
  const rel = path.relative(entries, abs);
  if (rel === '') return true;
  if (rel.startsWith('..') || path.isAbsolute(rel)) return false;
  return rel.split(/[\\/]+/).filter((s) => s !== '').length <= 2;
}
