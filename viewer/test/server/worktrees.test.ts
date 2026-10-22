import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findCheckouts, gitCommonDir, locateGit, mainRoot, worktreesDir } from '../../src/server/worktrees.js';

// Synthetic git folders: plain files laid out the way git writes them, so
// no git binary is needed. `ceiling: tmp` keeps the `.git` walk inside the
// temp dir, whatever sits above it on this machine.

let tmp: string;
let opts: { ceiling: string };

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'phase-viewer-worktrees-'));
  opts = { ceiling: tmp };
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const T33 = new Date('2026-10-22T08:28:27Z');
const T35 = new Date('2026-10-22T09:00:00Z');

/** Forward-slash form of a path, the way Git for Windows writes it. */
function fwd(p: string): string {
  return p.split(path.sep).join('/');
}

/** Create `{tmp}/{parts}/docs/phases/` and return the project folder. */
function project(...parts: string[]): string {
  const folder = path.join(tmp, ...parts);
  mkdirSync(path.join(folder, 'docs', 'phases'), { recursive: true });
  return folder;
}

/** A main checkout at `{tmp}/{name}` with a `.git` folder on `branch`. Returns the checkout top. */
function repo(name: string, branch = 'master'): string {
  const top = path.join(tmp, name);
  mkdirSync(path.join(top, '.git'), { recursive: true });
  writeFileSync(path.join(top, '.git', 'HEAD'), `ref: refs/heads/${branch}\n`);
  return top;
}

interface WorktreeSpec {
  /** Checkout folder; when it's created, its `.git` file is written. `null` = never created. */
  top: string | null;
  /** Override for the text of `{entry}/gitdir`. */
  gitdir?: string;
  /** Branch, or a sha for a detached HEAD. */
  head: string;
  created?: Date;
}

/** Register a linked worktree `name` under `{mainTop}/.git/worktrees/`. Returns the worktree's checkout top. */
function worktree(mainTop: string, name: string, spec: WorktreeSpec): string | null {
  const common = path.join(mainTop, '.git');
  const entry = path.join(worktreesDir(common), name);
  mkdirSync(entry, { recursive: true });
  const gitdir = spec.gitdir ?? `${fwd(spec.top ?? path.join(tmp, 'gone', name))}/.git`;
  writeFileSync(path.join(entry, 'gitdir'), `${gitdir}\n`);
  writeFileSync(path.join(entry, 'commondir'), '../..\n');
  writeFileSync(path.join(entry, 'HEAD'), /^[0-9a-f]{40}$/.test(spec.head) ? `${spec.head}\n` : `ref: refs/heads/${spec.head}\n`);
  if (spec.created !== undefined) utimesSync(path.join(entry, 'commondir'), spec.created, spec.created);
  if (spec.top !== null) {
    mkdirSync(spec.top, { recursive: true });
    writeFileSync(path.join(spec.top, '.git'), `gitdir: ${fwd(entry)}\n`);
  }
  return spec.top;
}

/** malk-repo's layout: main checkout, two desktop worktrees under `.claude/worktrees/`, and a `/sessions/…` entry. */
function malkLayout() {
  const main = repo('malk-repo');
  project('malk-repo');
  const wtBase = path.join(main, '.claude', 'worktrees');
  const wt33 = path.join(wtBase, 'phase-33-watching-now-e0037f');
  const wt35 = path.join(wtBase, 'phase-35-station-page-cede9e');
  worktree(main, 'phase-33-watching-now-e0037f', { top: wt33, head: 'claude/phase-33-watching-now-e0037f', created: T33 });
  worktree(main, 'phase-35-station-page-cede9e', { top: wt35, head: 'claude/phase-35-station-page-cede9e', created: T35 });
  mkdirSync(path.join(wt33, 'docs', 'phases'), { recursive: true });
  mkdirSync(path.join(wt35, 'docs', 'phases'), { recursive: true });
  worktree(main, 'malk-keyword-lane', {
    top: null,
    gitdir: '/sessions/rcw-013ctu9ak18q8ldrypwph4aa/mnt/malk/malk-keyword-lane/.git',
    head: '3c400020e1092e70ee6a686587fa760d53ac89c1',
  });
  writeFileSync(path.join(main, '.git', 'worktrees', 'malk-keyword-lane', 'locked'), '');
  return { main, wt33, wt35 };
}

describe('findCheckouts', () => {
  it('lists the main checkout alone when the repo has no worktrees', async () => {
    const main = repo('app', 'main');
    project('app');
    await expect(findCheckouts(main, opts)).resolves.toEqual([
      { root: main, main: true, name: null, branch: 'main', createdMs: 0 },
    ]);
  });

  it('lists malk-repo with its phase-33 and phase-35 worktrees and skips the /sessions/… entry', async () => {
    const { main, wt33, wt35 } = malkLayout();
    await expect(findCheckouts(main, opts)).resolves.toEqual([
      { root: main, main: true, name: null, branch: 'master', createdMs: 0 },
      {
        root: wt33,
        main: false,
        name: 'phase-33-watching-now-e0037f',
        branch: 'claude/phase-33-watching-now-e0037f',
        createdMs: T33.getTime(),
      },
      {
        root: wt35,
        main: false,
        name: 'phase-35-station-page-cede9e',
        branch: 'claude/phase-35-station-page-cede9e',
        createdMs: T35.getTime(),
      },
    ]);
  });

  it('lists the same checkouts when the root is inside a worktree', async () => {
    const { main, wt33, wt35 } = malkLayout();
    const list = await findCheckouts(wt35, opts);
    expect(list.map((c) => [c.root, c.main, c.name])).toEqual([
      [main, true, null],
      [wt33, false, 'phase-33-watching-now-e0037f'],
      [wt35, false, 'phase-35-station-page-cede9e'],
    ]);
  });

  it('lists the main checkout alone when the worktrees have no docs/phases/', async () => {
    const main = repo('repo');
    project('repo'); // untracked docs/phases/: worktrees don't get a copy
    worktree(main, 'wt-a', { top: path.join(tmp, 'wt-a'), head: 'feature-a' });
    worktree(main, 'wt-b', { top: path.join(tmp, 'wt-b'), head: 'feature-b' });
    const list = await findCheckouts(main, opts);
    expect(list).toEqual([{ root: main, main: true, name: null, branch: 'master', createdMs: 0 }]);
  });

  it("returns the root alone in phase-runner's split layout (docs/phases/ outside the repo)", async () => {
    const coord = project('phase-runner');
    const inner = repo(path.join('phase-runner', 'phase-runner-repo'));
    worktree(inner, 'wt', { top: path.join(tmp, 'wt'), head: 'x' });
    await expect(findCheckouts(coord, opts)).resolves.toEqual([
      { root: coord, main: true, name: null, branch: null, createdMs: 0 },
    ]);
    await expect(gitCommonDir(coord, opts)).resolves.toBeNull();
  });

  it('skips a worktree whose path is missing', async () => {
    const main = repo('repo');
    project('repo');
    worktree(main, 'gone', { top: null, head: 'old-branch' });
    const live = worktree(main, 'live', { top: path.join(tmp, 'live'), head: 'new-branch' })!;
    mkdirSync(path.join(live, 'docs', 'phases'), { recursive: true });
    const list = await findCheckouts(main, opts);
    expect(list.map((c) => c.name)).toEqual([null, 'live']);
  });

  it('gives a detached worktree a null branch', async () => {
    const main = repo('repo');
    project('repo');
    const wt = worktree(main, 'detached', { top: path.join(tmp, 'detached'), head: 'a'.repeat(40) })!;
    mkdirSync(path.join(wt, 'docs', 'phases'), { recursive: true });
    const list = await findCheckouts(main, opts);
    expect(list[1]).toMatchObject({ root: wt, main: false, name: 'detached', branch: null });
  });

  it('maps a root nested below the repo top (repo/app/docs/phases) into each worktree', async () => {
    const main = repo('repo');
    const appRoot = project('repo', 'app');
    const wtWith = worktree(main, 'with-app', { top: path.join(tmp, 'with-app'), head: 'a' })!;
    mkdirSync(path.join(wtWith, 'app', 'docs', 'phases'), { recursive: true });
    const wtTopOnly = worktree(main, 'top-only', { top: path.join(tmp, 'top-only'), head: 'b' })!;
    mkdirSync(path.join(wtTopOnly, 'docs', 'phases'), { recursive: true }); // wrong place: skipped
    const list = await findCheckouts(appRoot, opts);
    expect(list.map((c) => c.root)).toEqual([appRoot, path.join(wtWith, 'app')]);
  });

  it('resolves a relative gitdir and an absolute one written with forward slashes', async () => {
    const main = repo('repo');
    project('repo');
    const rel = worktree(main, 'rel', { top: path.join(tmp, 'rel'), gitdir: '../../../../rel/.git', head: 'r' })!;
    mkdirSync(path.join(rel, 'docs', 'phases'), { recursive: true });
    const list = await findCheckouts(main, opts);
    expect(list.map((c) => c.root)).toEqual([main, rel]);
  });

  it('drops a worktree whose metadata is incomplete', async () => {
    const main = repo('repo');
    project('repo');
    const wt = worktree(main, 'broken', { top: path.join(tmp, 'broken'), head: 'b' })!;
    mkdirSync(path.join(wt, 'docs', 'phases'), { recursive: true });
    rmSync(path.join(main, '.git', 'worktrees', 'broken', 'commondir'));
    const list = await findCheckouts(main, opts);
    expect(list.map((c) => c.name)).toEqual([null]);
  });

  it('never throws on an unreadable .git file', async () => {
    const root = project('odd');
    writeFileSync(path.join(root, '.git'), 'not a gitdir line\n');
    await expect(findCheckouts(root, opts)).resolves.toEqual([
      { root, main: true, name: null, branch: null, createdMs: 0 },
    ]);
  });
});

describe('locateGit', () => {
  it('finds the common dir from the main checkout and from a worktree', async () => {
    const { main, wt33 } = malkLayout();
    const common = path.join(main, '.git');
    await expect(locateGit(main, opts)).resolves.toEqual({ commonDir: common, top: main, mainTop: main, worktree: null });
    await expect(locateGit(path.join(wt33, 'docs'), opts)).resolves.toEqual({
      commonDir: common,
      top: wt33,
      mainTop: main,
      worktree: 'phase-33-watching-now-e0037f',
    });
    await expect(gitCommonDir(wt33, opts)).resolves.toBe(common);
  });
});

describe('mainRoot', () => {
  it("maps a worktree root to the main checkout's root", async () => {
    const { main, wt33 } = malkLayout();
    await expect(mainRoot(wt33, opts)).resolves.toBe(main);
  });

  it('leaves the main checkout, a non-repo root, and a worktree whose main has no docs/phases/ unchanged', async () => {
    const { main } = malkLayout();
    await expect(mainRoot(main, opts)).resolves.toBe(main);

    const plain = project('plain');
    await expect(mainRoot(plain, opts)).resolves.toBe(plain);

    const bare = repo('no-phases');
    const wt = worktree(bare, 'wt', { top: path.join(tmp, 'wt-only'), head: 'w' })!;
    mkdirSync(path.join(wt, 'docs', 'phases'), { recursive: true });
    await expect(mainRoot(wt, opts)).resolves.toBe(wt);
  });
});

describe('worktrees module', () => {
  it('uses no git binary or child process', () => {
    const source = readFileSync(fileURLToPath(new URL('../../src/server/worktrees.ts', import.meta.url)), 'utf8');
    expect(source).not.toMatch(/child_process|execFile|spawn\(/);
  });
});
