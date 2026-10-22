/**
 * One project from every checkout (`checkouts.ts`), on synthetic git folders
 * in a temp dir: plain files laid out the way git writes them, as in
 * `worktrees.test.ts`, so no git binary is needed. `ceiling: tmp` keeps the
 * `.git` walk inside the temp dir.
 *
 * The live test wires `watchCheckouts` to a set the way the server does,
 * adds and removes a worktree on disk, and folds the updates with the
 * client's own `applyToProject`, which must end equal to the set's snapshot.
 */
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Phase, PhaseRuns, Project } from '../../src/core/model.js';
import { applyToProject } from '../../src/client/data/applyUpdate.js';
import { createCheckoutSet, isCandidate, watchCheckouts, type CheckoutSet } from '../../src/server/checkouts.js';
import { createProjectState, type StateUpdate } from '../../src/server/state.js';
import type { ProjectWatcher } from '../../src/server/watch.js';
import { worktreesDir, type Checkout } from '../../src/server/worktrees.js';
import { MULTI_PHASE } from '../fixtures/index.js';

let tmp: string;
let opts: { ceiling: string };
const watchers: ProjectWatcher[] = [];

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'phase-viewer-checkouts-'));
  opts = { ceiling: tmp };
});

afterEach(async () => {
  for (const w of watchers.splice(0)) await w.close();
  rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

/** When the worktrees were created (their `commondir` mtime). */
const CREATED = new Date('2026-10-22T08:28:27Z');
/** Before any worktree existed: what an inherited (tracked) log holds. */
const OLD = ['2026-10-01T10:00:00Z', '2026-10-01T10:05:00Z'];
const SLEEP = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Forward-slash form of a path, the way Git for Windows writes it. */
function fwd(p: string): string {
  return p.split(path.sep).join('/');
}

/** A main checkout at `{tmp}/{name}` with `.git/` and `docs/phases/`. Returns its top. */
function repo(name = 'repo'): string {
  const top = path.join(tmp, name);
  mkdirSync(path.join(top, '.git'), { recursive: true });
  writeFileSync(path.join(top, '.git', 'HEAD'), 'ref: refs/heads/master\n');
  mkdirSync(path.join(top, 'docs', 'phases', '.runs'), { recursive: true });
  return top;
}

/** The checkout folder for worktree `name`: `{main}/.claude/worktrees/{name}`, with `docs/phases/.runs/`. */
function checkoutDir(main: string, name: string): string {
  const top = path.join(main, '.claude', 'worktrees', name);
  mkdirSync(path.join(top, 'docs', 'phases', '.runs'), { recursive: true });
  return top;
}

/** Register `top` as linked worktree `name` on `branch`, created at `created`. */
function register(main: string, name: string, top: string, created: Date = CREATED, branch = `claude/${name}`): void {
  const entry = path.join(worktreesDir(path.join(main, '.git')), name);
  mkdirSync(entry, { recursive: true });
  writeFileSync(path.join(entry, 'gitdir'), `${fwd(top)}/.git\n`);
  writeFileSync(path.join(entry, 'HEAD'), `ref: refs/heads/${branch}\n`);
  writeFileSync(path.join(entry, 'commondir'), '../..\n');
  utimesSync(path.join(entry, 'commondir'), created, created);
  writeFileSync(path.join(top, '.git'), `gitdir: ${fwd(entry)}\n`);
}

/** A linked worktree with its checkout folder. Returns the checkout (project) folder. */
function worktree(main: string, name: string, created: Date = CREATED): string {
  const top = checkoutDir(main, name);
  register(main, name, top, created);
  return top;
}

/** A one-sprint phase file whose task 1 has `status`. */
function phaseText(n: number, status: string): string {
  return [
    `# Phase ${n} — Thing ${n}`,
    '',
    `# Sprint ${n}.1 — Only`,
    '',
    '### Tasks',
    '',
    '| Status | # | Task | Module | Reference |',
    '|--------|---|------|--------|-----------|',
    `| ${status} | 1 | A task | src/a.ts |`,
    '',
  ].join('\n');
}

/** Appended to a {@link phaseText}: a dependency on a phase that doesn't exist, which the loader warns about. */
const BAD_DEPENDENCY = ['### Dependencies', '', '- Phase 99', ''].join('\n');

function phaseFile(root: string, n: number): string {
  return path.join(root, 'docs', 'phases', `Phase-${n}-Thing.md`);
}

function logFile(root: string, n: number): string {
  return path.join(root, 'docs', 'phases', '.runs', `phase-${n}.jsonl`);
}

function writePhase(root: string, n: number, status = '—', mtime?: Date): string {
  const file = phaseFile(root, n);
  writeFileSync(file, phaseText(n, status));
  if (mtime) utimesSync(file, mtime, mtime);
  return file;
}

function eventLine(n: number, ts: string, gate = 'implement', result = 'start'): string {
  return `${JSON.stringify({ v: 1, ts, phase: n, wave: 1, sprint: `${n}.1`, gate, result, attempt: 1, max: 3, summary: '' })}\n`;
}

function writeLog(root: string, n: number, stamps: readonly string[]): string {
  const file = logFile(root, n);
  writeFileSync(file, stamps.map((ts) => eventLine(n, ts)).join(''));
  return file;
}

function phaseOf(project: Project, n: number): Phase | undefined {
  return project.phases.find((p) => p.number === n);
}

function runsOf(project: Project, n: number): PhaseRuns | undefined {
  return project.runs.find((r) => r.phase === n);
}

async function setFor(root: string): Promise<CheckoutSet> {
  return createCheckoutSet(root, opts);
}

describe('createCheckoutSet', () => {
  it('equals createProjectState when the repo has no worktrees', async () => {
    const main = repo();
    cpSync(MULTI_PHASE.root, main, { recursive: true });
    const set = await setFor(main);
    expect(set.checkouts()).toHaveLength(1);
    expect(set.snapshot()).toEqual((await createProjectState(main)).snapshot());
  });

  it('equals createProjectState when the folder is not in a repo', async () => {
    const root = path.join(tmp, 'plain');
    cpSync(MULTI_PHASE.root, root, { recursive: true });
    const set = await setFor(root);
    expect(set.commonDir).toBeNull();
    expect(set.snapshot()).toEqual((await createProjectState(root)).snapshot());
  });

  it('equals the main checkout when worktrees only carry inherited copies', async () => {
    const main = repo();
    writePhase(main, 15, 'x');
    writeLog(main, 15, OLD);
    const wt = worktree(main, 'phase-33');
    writePhase(wt, 15, 'x');
    writeLog(wt, 15, OLD);
    const set = await setFor(main);
    expect(set.checkouts()).toHaveLength(2);
    expect(set.snapshot()).toEqual((await createProjectState(main)).snapshot());
  });

  it('shows phase 33 from a worktree whose log has events after its creation, phase file included', async () => {
    const main = repo();
    writePhase(main, 33, '—');
    const wt = worktree(main, 'phase-33-watching-now-e0037f');
    const wtPhase = writePhase(wt, 33, '~');
    const wtLog = writeLog(wt, 33, ['2026-10-22T08:30:00Z', '2026-10-22T08:41:12Z']);

    const project = (await setFor(main)).snapshot();
    const ref = { name: 'phase-33-watching-now-e0037f', branch: 'claude/phase-33-watching-now-e0037f', path: wt };
    const phase = phaseOf(project, 33);
    expect(phase?.file).toBe(wtPhase);
    expect(phase?.worktree).toEqual(ref);
    expect(phase?.sprints[0]?.tasks[0]?.status).toBe('active');
    const runs = runsOf(project, 33);
    expect(runs?.file).toBe(wtLog);
    expect(runs?.worktree).toEqual(ref);
    expect(project.phases).toHaveLength(1);
    expect(project.root).toBe(main);
    expect(project.phasesDir).toBe(path.join(main, 'docs', 'phases'));
  });

  it('never lets an inherited log win (phase 15 stays on main while phase 33 runs in the worktree)', async () => {
    const main = repo();
    const mainPhase15 = writePhase(main, 15, 'x');
    const mainLog15 = writeLog(main, 15, OLD);
    writePhase(main, 33, '—');
    const wt = worktree(main, 'phase-33');
    writePhase(wt, 15, '~'); // even a different copy of the phase file stays put
    writeLog(wt, 15, [...OLD, '2026-10-01T10:09:00Z']); // all before the worktree was created
    writePhase(wt, 33, '~');
    writeLog(wt, 33, ['2026-10-22T09:00:00Z']);

    const project = (await setFor(main)).snapshot();
    expect(phaseOf(project, 15)?.file).toBe(mainPhase15);
    expect(phaseOf(project, 15)?.worktree).toBeUndefined();
    expect(runsOf(project, 15)?.file).toBe(mainLog15);
    expect(runsOf(project, 15)?.worktree).toBeUndefined();
    expect(phaseOf(project, 33)?.worktree?.name).toBe('phase-33');
  });

  it('gives a tie to the main checkout', async () => {
    const main = repo();
    const mainPhase = writePhase(main, 33, 'x');
    const mainLog = writeLog(main, 33, ['2026-10-22T09:00:00Z']);
    const wt = worktree(main, 'phase-33');
    writePhase(wt, 33, '~');
    writeLog(wt, 33, ['2026-10-22T08:59:00Z', '2026-10-22T09:00:00Z']);

    const project = (await setFor(main)).snapshot();
    expect(phaseOf(project, 33)?.file).toBe(mainPhase);
    expect(runsOf(project, 33)?.file).toBe(mainLog);
  });

  it('compares creation and event times in whole seconds', async () => {
    const created = new Date('2026-10-22T08:28:27.600Z');
    const checkout: Checkout = { root: tmp, main: false, name: 'wt', branch: null, createdMs: created.getTime() };
    const runs = (stamps: string[]): PhaseRuns => ({
      phase: 1,
      file: 'x',
      events: stamps.map((ts, i) => ({
        v: 1, ts, phase: 1, wave: 1, sprint: '1.1', gate: 'implement', rawGate: 'implement',
        result: 'start', rawResult: 'start', attempt: 1, max: 3, summary: '', line: i + 1,
      })),
      waves: [],
      escalations: [],
      sprintHistory: {},
    });
    expect(isCandidate(runs(['2026-10-22T08:28:27Z']), checkout)).toBe(true); // same second
    expect(isCandidate(runs(['2026-10-22T08:28:26Z']), checkout)).toBe(false); // the second before
    expect(isCandidate(runs(['2026-10-22T08:28:26Z', 'garbage']), checkout)).toBe(false);

    // The same through a whole set: an event in the creation second wins.
    const main = repo();
    writePhase(main, 4, '—');
    const wt = worktree(main, 'same-second', created);
    const wtPhase = writePhase(wt, 4, '~');
    writeLog(wt, 4, ['2026-10-22T08:28:27Z']);
    expect(phaseOf((await setFor(main)).snapshot(), 4)?.file).toBe(wtPhase);
  });

  it('shows a phase file that exists only in a worktree, from the newest copy', async () => {
    const main = repo();
    writePhase(main, 1, 'x');
    const older = worktree(main, 'a-older');
    const newer = worktree(main, 'b-newer');
    writePhase(older, 36, '—', new Date('2026-10-22T09:00:00Z'));
    const newest = writePhase(newer, 36, '~', new Date('2026-10-22T10:00:00Z'));
    writePhase(older, 37, '—');

    const project = (await setFor(main)).snapshot();
    expect(project.phases.map((p) => p.number)).toEqual([1, 36, 37]);
    expect(phaseOf(project, 36)?.file).toBe(newest);
    expect(phaseOf(project, 36)?.worktree?.name).toBe('b-newer');
    expect(phaseOf(project, 37)?.worktree?.name).toBe('a-older');
    expect(phaseOf(project, 1)?.worktree).toBeUndefined();
  });

  it('keeps a hand-edited worktree phase without a run log on the main copy', async () => {
    const main = repo();
    const mainPhase = writePhase(main, 20, '—');
    const wt = worktree(main, 'edits');
    writePhase(wt, 20, 'x');
    expect(phaseOf((await setFor(main)).snapshot(), 20)?.file).toBe(mainPhase);
  });

  it('picks the worktree whose log has the newest last event when two run the same phase', async () => {
    const main = repo();
    writePhase(main, 33, '—');
    writeLog(main, 33, OLD);
    const first = worktree(main, 'first');
    writePhase(first, 33, '~');
    writeLog(first, 33, ['2026-10-22T09:00:00Z', '2026-10-22T09:30:00Z']);
    const second = worktree(main, 'second');
    const secondPhase = writePhase(second, 33, 'x');
    const secondLog = writeLog(second, 33, ['2026-10-22T09:10:00Z', '2026-10-22T09:45:00Z']);

    const project = (await setFor(main)).snapshot();
    expect(phaseOf(project, 33)?.file).toBe(secondPhase);
    expect(runsOf(project, 33)?.file).toBe(secondLog);
    expect(runsOf(project, 33)?.worktree?.name).toBe('second');
  });

  it('keeps root, phasesDir and warnings to the start checkout plus the files shown', async () => {
    const main = repo();
    writeFileSync(phaseFile(main, 33), `${phaseText(33, '—')}${BAD_DEPENDENCY}`); // a warning on main's copy
    const wt = worktree(main, 'phase-33');
    const wtPhase = writePhase(wt, 33, '~');
    writeLog(wt, 33, ['2026-10-22T09:00:00Z']);
    appendFileSync(logFile(wt, 33), 'not json\n'); // a warning on the shown log
    writeFileSync(phaseFile(wt, 34), `${phaseText(34, '—')}${BAD_DEPENDENCY}`); // shown: the only copy

    const project = (await setFor(main)).snapshot();
    expect(project.warnings.some((w) => w.file === phaseFile(main, 33))).toBe(false);
    expect(project.warnings.some((w) => w.file === logFile(wt, 33))).toBe(true);
    expect(project.warnings.some((w) => w.file === phaseFile(wt, 34))).toBe(true);
    expect(phaseOf(project, 33)?.file).toBe(wtPhase);
  });

  it('applies a change inside a worktree to the merged project', async () => {
    const main = repo();
    writePhase(main, 33, '—');
    const wt = worktree(main, 'phase-33');
    writePhase(wt, 33, '~');
    const wtLog = writeLog(wt, 33, ['2026-10-22T09:00:00Z']);
    const set = await setFor(main);

    appendFileSync(wtLog, eventLine(33, '2026-10-22T09:05:00Z', 'implement', 'pass'));
    const updates = await set.apply({ kind: 'run', file: wtLog });
    expect(updates.map((u) => u.type)).toEqual(['run']);
    const run = updates[0];
    expect(run?.type === 'run' && run.file).toBe(wtLog);
    expect(run?.type === 'run' && run.runs.worktree?.name).toBe('phase-33');
    expect(runsOf(set.snapshot(), 33)?.events).toHaveLength(2);

    // A file outside every checkout's docs/ is ignored.
    await expect(set.apply({ kind: 'run', file: path.join(tmp, 'elsewhere', 'phase-1.jsonl') })).resolves.toEqual([]);
  });

  it('serves the start root when the viewer is started inside a worktree', async () => {
    const main = repo();
    writePhase(main, 15, 'x');
    const wt = worktree(main, 'phase-35');
    const wtPhase = writePhase(wt, 35, '~');
    writeLog(wt, 35, ['2026-10-22T09:00:00Z']);
    const project = (await setFor(wt)).snapshot();
    expect(project.root).toBe(wt);
    expect(phaseOf(project, 15)?.worktree).toBeUndefined();
    expect(phaseOf(project, 35)?.file).toBe(wtPhase);
    expect(phaseOf(project, 35)?.worktree?.path).toBe(wt);
  });
});

describe('watchCheckouts', () => {
  /** Poll until `check` is true, or fail after `timeoutMs`. */
  async function waitFor(check: () => boolean, what: string, timeoutMs = 5_000): Promise<void> {
    const start = Date.now();
    while (!check()) {
      if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${what}`);
      await SLEEP(20);
    }
  }

  it('loads a worktree that appears and drops one that goes, as updates', { timeout: 20_000 }, async () => {
    const main = repo();
    writePhase(main, 15, 'x');
    writeLog(main, 15, OLD);
    const mainPhase33 = writePhase(main, 33, '—');

    const set = await setFor(main);
    let client = set.snapshot();
    const received: StateUpdate[] = [];
    const errors: Error[] = [];
    const watcher = watchCheckouts(
      set,
      (updates) => {
        for (const u of updates) {
          received.push(u);
          client = applyToProject(client, u);
        }
      },
      { debounceMs: 50, onError: (err) => errors.push(err) },
    );
    watchers.push(watcher);
    await watcher.ready;
    await SLEEP(150);

    // A worktree session starts: the checkout is written, then git registers it.
    const name = 'phase-33-watching-now-e0037f';
    const wt = checkoutDir(main, name);
    const wtPhase33 = writePhase(wt, 33, '~');
    writePhase(wt, 15, 'x');
    writeLog(wt, 15, OLD); // inherited
    const now = new Date(Math.floor(Date.now() / 1000) * 1000);
    const wtLog33 = writeLog(wt, 33, [new Date(now.getTime() + 2_000).toISOString().replace(/\.\d+Z$/, 'Z')]);
    register(main, name, wt, now);

    await waitFor(() => phaseOf(client, 33)?.file === wtPhase33 && runsOf(client, 33)?.file === wtLog33, 'the worktree to load');
    expect(received).toContainEqual(expect.objectContaining({ type: 'removed', kind: 'phase', file: mainPhase33, number: 33 }));
    expect(received).toContainEqual(expect.objectContaining({ type: 'phase', file: wtPhase33 }));
    expect(received).toContainEqual(expect.objectContaining({ type: 'run', file: wtLog33 }));
    expect(phaseOf(client, 33)?.worktree).toEqual({ name, branch: `claude/${name}`, path: wt });
    expect(phaseOf(client, 15)?.worktree).toBeUndefined();
    expect(set.checkouts()).toHaveLength(2);

    // The worktree's own files are watched now.
    await SLEEP(300);
    appendFileSync(wtLog33, eventLine(33, '2026-12-01T00:00:00Z', 'implement', 'pass'));
    await waitFor(() => (runsOf(client, 33)?.events.length ?? 0) === 2, 'the worktree log append');

    // The worktree is removed: git drops its entry, then the folder goes.
    received.length = 0;
    rmSync(path.join(worktreesDir(path.join(main, '.git')), name), { recursive: true, force: true });
    await waitFor(() => phaseOf(client, 33)?.file === mainPhase33 && runsOf(client, 33) === undefined, 'the fallback to main');
    expect(received).toContainEqual(expect.objectContaining({ type: 'removed', kind: 'phase', file: wtPhase33 }));
    expect(received).toContainEqual(expect.objectContaining({ type: 'removed', kind: 'run', file: wtLog33 }));
    expect(received).toContainEqual(expect.objectContaining({ type: 'phase', file: mainPhase33 }));
    expect(set.checkouts()).toHaveLength(1);
    await SLEEP(200);
    rmSync(path.join(main, '.claude'), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });

    await SLEEP(300);
    expect(client).toEqual(set.snapshot());
    expect(set.snapshot()).toEqual((await createProjectState(main)).snapshot());
    expect(errors).toEqual([]);
  });
});
