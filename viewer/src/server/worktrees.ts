/**
 * Worktree discovery: every checkout of the project's git repo that has the
 * project's `docs/phases/` folder.
 *
 * A phase run in a linked worktree (a desktop side session, or phase-builder's
 * worktree mode) writes its run log and phase-file edits inside that worktree.
 * To show those runs live, the viewer needs the list of checkouts, which this
 * module reads straight from the repo's git folder:
 *
 * 1. Walk up from the project root to the first `.git`. A folder is the git
 *    common dir. A file (`gitdir: …/.git/worktrees/{name}`) means the root is
 *    inside a linked worktree; that folder's `commondir` file names the common
 *    dir. No `.git` up to the filesystem root (or the `ceiling` option) means
 *    "not a repo", and the list is the root alone.
 * 2. The main checkout is the common dir's parent. Each linked worktree is the
 *    `dirname` of the path in `{common}/worktrees/{name}/gitdir`.
 * 3. The project root inside each checkout is that checkout joined with the
 *    root's path relative to its own checkout (so `repo/app/docs/phases` in the
 *    main checkout maps to `{worktree}/app/docs/phases`). A checkout whose
 *    project root has no `docs/phases/` is skipped, which also skips a stale
 *    entry whose path is gone or comes from another machine (`/sessions/…`).
 *
 * Read-only and never throws: `stat`, `readdir` and `readFile` only, with no
 * git binary and no child process. Any unreadable piece of a linked worktree's
 * metadata drops that worktree.
 */
import type { Stats } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { hasPhasesDir } from './detect.js';
import { normalizeRoot } from './instance.js';

/** One checkout of the project's repo. */
export interface Checkout {
  /** Absolute project root (the folder holding `docs/phases/`) inside this checkout. */
  root: string;
  /** `true` for the main checkout (or for the root alone when it isn't in a repo). */
  main: boolean;
  /** The worktree's folder name under `{common}/worktrees/`; `null` for the main checkout. */
  name: string | null;
  /** Checked-out branch without `refs/heads/`; `null` when detached or unknown. */
  branch: string | null;
  /** When git created the worktree (mtime of its `commondir` file); `0` for the main checkout. */
  createdMs: number;
}

/** Where the git folder for a project root is. */
export interface GitLocation {
  /** The git common dir (the main checkout's `.git` folder, usually). */
  commonDir: string;
  /** Top of the checkout the root is in (the folder holding `.git`). */
  top: string;
  /** Top of the main checkout. */
  mainTop: string;
  /** Linked worktree name when the root is inside one, else `null`. */
  worktree: string | null;
}

/** Options shared by the lookups. */
export interface WorktreeOptions {
  /**
   * Highest folder the `.git` walk may check; folders above it are not
   * looked at. Defaults to the filesystem root. Tests use it to make
   * "not a repo" deterministic inside a temp dir.
   */
  ceiling?: string;
}

/** `{common}/worktrees`: the folder holding one entry per linked worktree. */
export function worktreesDir(commonDir: string): string {
  return path.join(commonDir, 'worktrees');
}

/**
 * Find the git folder for `root` by walking up to the first `.git`.
 * `null` when there is none (or it can't be read).
 */
export async function locateGit(root: string, options: WorktreeOptions = {}): Promise<GitLocation | null> {
  const start = path.resolve(root);
  const ceiling = options.ceiling === undefined ? null : normalizeRoot(options.ceiling);
  let dir = start;
  for (;;) {
    const dotGit = path.join(dir, '.git');
    const info = await statOrNull(dotGit);
    if (info?.isDirectory()) {
      return { commonDir: dotGit, top: dir, mainTop: dir, worktree: null };
    }
    if (info?.isFile()) return linkedLocation(dir, dotGit);
    if (ceiling !== null && normalizeRoot(dir) === ceiling) return null;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** The git common dir for `root`, or `null` when it isn't in a repo. Sprint 10.2 watches {@link worktreesDir} of it. */
export async function gitCommonDir(root: string, options: WorktreeOptions = {}): Promise<string | null> {
  return (await locateGit(root, options))?.commonDir ?? null;
}

/**
 * Every checkout of `root`'s repo that has a `docs/phases/` folder at the
 * matching place: the main checkout first, then linked worktrees by name.
 * The checkout `root` itself is in is always listed. Not in a repo: the
 * root alone.
 */
export async function findCheckouts(root: string, options: WorktreeOptions = {}): Promise<Checkout[]> {
  const resolved = path.resolve(root);
  const loc = await locateGit(resolved, options);
  if (loc === null) return [{ root: resolved, main: true, name: null, branch: null, createdMs: 0 }];

  const rel = path.relative(loc.top, resolved);
  const checkouts: Checkout[] = [];

  const mainProject = path.join(loc.mainTop, rel);
  if (loc.worktree === null || (await hasPhasesDir(mainProject))) {
    checkouts.push({
      root: loc.worktree === null ? resolved : mainProject,
      main: true,
      name: null,
      branch: await readBranch(path.join(loc.commonDir, 'HEAD')),
      createdMs: 0,
    });
  }

  const linked: Checkout[] = [];
  for (const name of await listNames(worktreesDir(loc.commonDir))) {
    const checkout = await readWorktree(loc.commonDir, name, rel);
    if (checkout !== null) linked.push(checkout);
  }
  linked.sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''));

  const seen = new Set(checkouts.map((c) => normalizeRoot(c.root)));
  for (const checkout of linked) {
    const key = normalizeRoot(checkout.root);
    if (seen.has(key)) continue;
    seen.add(key);
    checkouts.push(checkout);
  }

  // The root's own checkout is always shown, even if its metadata is unreadable.
  if (!seen.has(normalizeRoot(resolved))) {
    checkouts.push({ root: resolved, main: loc.worktree === null, name: loc.worktree, branch: null, createdMs: 0 });
  }
  return checkouts;
}

/**
 * The main checkout's project root matching `root`, when `root` is inside a
 * linked worktree and that main-checkout folder has `docs/phases/`.
 * Otherwise `root` unchanged.
 */
export async function mainRoot(root: string, options: WorktreeOptions = {}): Promise<string> {
  const resolved = path.resolve(root);
  const loc = await locateGit(resolved, options);
  if (loc === null || loc.worktree === null) return root;
  const candidate = path.join(loc.mainTop, path.relative(loc.top, resolved));
  return (await hasPhasesDir(candidate)) ? candidate : root;
}

/** Location for a checkout whose `.git` is a file (`gitdir: …`). */
async function linkedLocation(top: string, dotGitFile: string): Promise<GitLocation | null> {
  const text = await readOrNull(dotGitFile);
  const target = text === null ? null : /^gitdir:\s*(.+)$/m.exec(text)?.[1]?.trim();
  if (target === undefined || target === null || target === '') return null;
  const gitDir = resolveGitPath(top, target);

  const commonText = await readOrNull(path.join(gitDir, 'commondir'));
  if (commonText === null || commonText.trim() === '') {
    // No `commondir`: a separate git dir (a submodule, `--separate-git-dir`),
    // which is its own common dir with this folder as its main checkout.
    if (!(await statOrNull(gitDir))?.isDirectory()) return null;
    return { commonDir: gitDir, top, mainTop: top, worktree: null };
  }
  const commonDir = resolveGitPath(gitDir, commonText.trim());
  if (!(await statOrNull(commonDir))?.isDirectory()) return null;
  return { commonDir, top, mainTop: path.dirname(commonDir), worktree: path.basename(gitDir) };
}

/** A linked worktree entry `{common}/worktrees/{name}`, or `null` when any piece is missing or unreadable. */
async function readWorktree(commonDir: string, name: string, rel: string): Promise<Checkout | null> {
  const entry = path.join(worktreesDir(commonDir), name);
  const gitdirText = await readOrNull(path.join(entry, 'gitdir'));
  if (gitdirText === null || gitdirText.trim() === '') return null;
  const top = path.dirname(resolveGitPath(entry, gitdirText.trim()));

  const created = await statOrNull(path.join(entry, 'commondir'));
  if (created === null) return null;

  const headText = await readOrNull(path.join(entry, 'HEAD'));
  if (headText === null) return null;

  const root = path.join(top, rel);
  if (!(await hasPhasesDir(root))) return null;

  return { root, main: false, name, branch: parseBranch(headText), createdMs: created.mtimeMs };
}

/** Branch named by a HEAD file, or `null` when detached or unreadable. */
async function readBranch(headFile: string): Promise<string | null> {
  const text = await readOrNull(headFile);
  return text === null ? null : parseBranch(text);
}

/** `ref: refs/heads/x` → `x`; anything else (a detached sha) → `null`. */
function parseBranch(head: string): string | null {
  const match = /^ref:\s*refs\/heads\/(.+)$/m.exec(head.trim());
  return match?.[1]?.trim() || null;
}

/**
 * Resolve a path git wrote into a metadata file. Relative paths are relative
 * to `base`. On Windows, forward slashes and drive letters are handled by
 * `path.resolve`, and an MSYS-style `/c/…` is read as `C:/…`.
 */
function resolveGitPath(base: string, written: string): string {
  let p = written;
  if (process.platform === 'win32') {
    const msys = /^\/([a-zA-Z])(\/.*)?$/.exec(p);
    if (msys?.[1] !== undefined) p = `${msys[1].toUpperCase()}:${msys[2] ?? '/'}`;
  }
  return path.resolve(base, p);
}

/** Names of the subfolders of `dir`, or `[]` when it can't be read. */
async function listNames(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

async function readOrNull(file: string): Promise<string | null> {
  try {
    return await readFile(file, 'utf8');
  } catch {
    return null;
  }
}

async function statOrNull(p: string): Promise<Stats | null> {
  try {
    return await stat(p);
  } catch {
    return null;
  }
}
