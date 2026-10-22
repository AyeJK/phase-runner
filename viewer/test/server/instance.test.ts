import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findFreePort, HOST, runCli, type CliIo, type CliResult, type StartupJson } from '../../src/cli.js';
import {
  defaultInstanceDir,
  findRunningInstance,
  INSTANCE_DIR_ENV,
  instanceFile,
  instanceKey,
  isProcessAlive,
  probeInstance,
  readInstance,
  writeInstance,
  type InstanceInfo,
} from '../../src/server/instance.js';
import { APP_ROOT } from '../fixtures/index.js';

/** Child-process tests start the real CLI under tsx; give them room on a cold machine. */
const CHILD_TIMEOUT = 30_000;

let tmp: string;
/** Instance folder for this test, so nothing touches os.tmpdir()/phase-viewer. */
let dir: string;
const running: CliResult[] = [];
const children: ChildProcess[] = [];

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'phase-viewer-instance-'));
  dir = path.join(tmp, 'instances');
});

afterEach(async () => {
  for (const r of running.splice(0)) await r.server?.close();
  for (const child of children.splice(0)) await killChild(child);
  rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

/** Create `{tmp}/{name}/docs/phases/` and return the project folder. */
function project(name: string): string {
  const root = path.join(tmp, name);
  mkdirSync(path.join(root, 'docs', 'phases'), { recursive: true });
  return root;
}

/** Run the CLI in-process with the real server and this test's instance folder. */
async function cli(argv: string[], cwd: string = tmp) {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = {
    cwd,
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    instanceDir: dir,
    // Keep the `.git` walk inside the temp dir, whatever sits above it on this machine.
    worktrees: { ceiling: tmp },
  };
  const result = await runCli(argv, io);
  running.push(result);
  return { result, out, err };
}

/** A port with nothing listening on it. */
async function deadPort(): Promise<number> {
  return findFreePort(20_000 + Math.floor(Math.random() * 20_000));
}

/** The pid of a process that has already exited. */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', '0'], { stdio: 'ignore' });
  const pid = child.pid!;
  await new Promise((resolve) => child.once('exit', resolve));
  return pid;
}

describe('instance file', () => {
  it('is keyed by a hash of the root: stable, per root, and case-insensitive on Windows', () => {
    const a = path.join(tmp, 'a');
    const b = path.join(tmp, 'b');
    expect(instanceKey(a)).toMatch(/^[0-9a-f]{16}$/);
    expect(instanceKey(a)).toBe(instanceKey(`${a}${path.sep}`));
    expect(instanceKey(a)).not.toBe(instanceKey(b));
    if (process.platform === 'win32') expect(instanceKey(a.toUpperCase())).toBe(instanceKey(a));
    expect(instanceFile(a, dir)).toBe(path.join(dir, `${instanceKey(a)}.json`));
  });

  it('lives in os.tmpdir()/phase-viewer unless the env override names another folder', () => {
    expect(defaultInstanceDir({})).toBe(path.join(tmpdir(), 'phase-viewer'));
    expect(defaultInstanceDir({ [INSTANCE_DIR_ENV]: dir })).toBe(path.resolve(dir));
  });

  it('writes { pid, port, root, version }, reads it back, and release removes it', () => {
    const root = project('p');
    const info: InstanceInfo = { pid: process.pid, port: 4800, root, version: '1.2.3' };
    const handle = writeInstance(info, dir);
    expect(JSON.parse(readFileSync(handle.file, 'utf8'))).toEqual(info);
    expect(readInstance(root, dir)).toEqual(info);
    expect(readdirSync(dir)).toEqual([path.basename(handle.file)]); // no temp file left behind
    handle.release();
    expect(existsSync(handle.file)).toBe(false);
    handle.release(); // twice is safe
  });

  it("release leaves a successor's file alone", () => {
    const root = project('p');
    const old = writeInstance({ pid: process.pid, port: 4800, root, version: 'x' }, dir);
    const successor: InstanceInfo = { pid: process.pid, port: 4801, root, version: 'x' };
    writeInstance(successor, dir);
    old.release();
    expect(readInstance(root, dir)).toEqual(successor);
  });

  it('ignores unreadable or foreign content', () => {
    const root = project('p');
    mkdirSync(dir, { recursive: true });
    writeFileSync(instanceFile(root, dir), 'not json');
    expect(readInstance(root, dir)).toBeNull();
    writeFileSync(instanceFile(root, dir), JSON.stringify({ pid: 'x', port: 1, root }));
    expect(readInstance(root, dir)).toBeNull();
    writeFileSync(instanceFile(root, dir), JSON.stringify({ pid: process.pid, port: 4800, root: path.join(tmp, 'other'), version: 'x' }));
    expect(readInstance(root, dir)).toBeNull();
  });

  it('isProcessAlive: this process is, an exited one is not', async () => {
    expect(isProcessAlive(process.pid)).toBe(true);
    expect(isProcessAlive(await deadPid())).toBe(false);
    expect(isProcessAlive(0)).toBe(false);
    expect(isProcessAlive(-1)).toBe(false);
  });
});

describe('reuse', () => {
  it('a second start for the same root prints the same URL, exits 0 and starts nothing', async () => {
    const root = project('proj');
    const first = await cli(['--dir', root, '--port', String(await deadPort())]);
    expect(first.result.exitCode).toBe(0);
    const port = first.result.server!.port;
    expect(first.result.instance?.info).toMatchObject({ pid: process.pid, port, root });
    expect(readInstance(root, dir)).toMatchObject({ pid: process.pid, port, root });

    const second = await cli(['--dir', root]);
    expect(second.result.exitCode).toBe(0);
    expect(second.result.server).toBeUndefined();
    expect(second.result.reused).toMatchObject({ port, root });
    const urlLine = `phase-viewer → http://localhost:${port}`;
    expect(first.out[0]?.split('\n')[0]).toBe(urlLine);
    expect(second.out).toHaveLength(1);
    expect(second.out[0]?.split('\n')).toEqual([urlLine, `root: ${root}`, `already running (pid ${process.pid}), reusing it`]);
    expect(second.err).toEqual([]);

    // Detection finding the same root (no --dir) reuses it too.
    const third = await cli(['--json'], root);
    expect(JSON.parse(third.out[0]!)).toEqual({ url: `http://localhost:${port}`, reused: true, root });
  });

  it('closing the server removes its instance file, and the next start is fresh', async () => {
    const root = project('proj');
    const first = await cli(['--dir', root, '--port', String(await deadPort())]);
    await first.result.server!.close();
    expect(existsSync(instanceFile(root, dir))).toBe(false);

    const next = await cli(['--dir', root, '--json']);
    expect(next.result.server).toBeDefined();
    expect(JSON.parse(next.out[0]!)).toMatchObject({ reused: false, root });
  });

  it('two roots get two instances', async () => {
    const a = project('a');
    const b = project('b');
    const start = await deadPort();
    const runA = await cli(['--dir', a, '--port', String(start)]);
    const runB = await cli(['--dir', b, '--port', String(start)]);
    expect(runA.result.server).toBeDefined();
    expect(runB.result.server).toBeDefined();
    expect(runB.result.server!.port).not.toBe(runA.result.server!.port);
    expect(readdirSync(dir).sort()).toEqual([`${instanceKey(a)}.json`, `${instanceKey(b)}.json`].sort());

    const againA = await cli(['--dir', a, '--json']);
    const againB = await cli(['--dir', b, '--json']);
    expect(JSON.parse(againA.out[0]!)).toEqual({ url: `http://localhost:${runA.result.server!.port}`, reused: true, root: a });
    expect(JSON.parse(againB.out[0]!)).toEqual({ url: `http://localhost:${runB.result.server!.port}`, reused: true, root: b });
  });
});

describe('from a git worktree', () => {
  /**
   * A main checkout `{tmp}/repo` (a `.git` folder) with one linked worktree at
   * `repo/.claude/worktrees/phase-33-watching-now-e0037f`, laid out the way
   * git writes it (no git binary). Both have `docs/phases/`.
   */
  function repoWithWorktree() {
    const main = project('repo');
    const common = path.join(main, '.git');
    const name = 'phase-33-watching-now-e0037f';
    const entry = path.join(common, 'worktrees', name);
    const wt = path.join(main, '.claude', 'worktrees', name);
    mkdirSync(entry, { recursive: true });
    mkdirSync(path.join(wt, 'docs', 'phases'), { recursive: true });
    writeFileSync(path.join(common, 'HEAD'), 'ref: refs/heads/master\n');
    writeFileSync(path.join(entry, 'gitdir'), `${path.join(wt, '.git')}\n`);
    writeFileSync(path.join(entry, 'commondir'), '../..\n');
    writeFileSync(path.join(entry, 'HEAD'), `ref: refs/heads/claude/${name}\n`);
    writeFileSync(path.join(wt, '.git'), `gitdir: ${entry}\n`);
    return { main, wt };
  }

  it("starting inside a worktree reports the main checkout's viewer and writes no second instance file", async () => {
    const { main, wt } = repoWithWorktree();
    const port = await deadPort();
    const first = await cli(['--dir', main, '--port', String(port)]);
    expect(first.result.server?.port).toBe(port);

    // Detected from the worktree's folder, and named with --dir: both reuse the main viewer.
    const detected = await cli(['--json'], wt);
    expect(detected.result.server).toBeUndefined();
    expect(JSON.parse(detected.out[0]!)).toEqual({ url: `http://localhost:${port}`, reused: true, root: main });
    const named = await cli(['--dir', wt, '--json']);
    expect(JSON.parse(named.out[0]!)).toEqual({ url: `http://localhost:${port}`, reused: true, root: main });

    expect(readdirSync(dir)).toEqual([`${instanceKey(main)}.json`]);
  });

  it('with no viewer running, starting inside a worktree starts the main checkout\'s viewer', async () => {
    const { main, wt } = repoWithWorktree();
    const run = await cli(['--json'], wt);
    expect(run.result.server).toBeDefined();
    expect(JSON.parse(run.out[0]!)).toMatchObject({ reused: false, root: main });
    expect(readInstance(main, dir)).toMatchObject({ root: main });
    expect(readdirSync(dir)).toEqual([`${instanceKey(main)}.json`]);

    // The main checkout then finds that same viewer.
    const again = await cli(['--dir', main, '--json']);
    expect(JSON.parse(again.out[0]!)).toEqual({ url: `http://localhost:${run.result.server!.port}`, reused: true, root: main });
  });

  it('a worktree whose main checkout has no docs/phases/ keeps its own root', async () => {
    const { main, wt } = repoWithWorktree();
    rmSync(path.join(main, 'docs'), { recursive: true, force: true });
    const run = await cli(['--json'], wt);
    expect(JSON.parse(run.out[0]!)).toMatchObject({ reused: false, root: wt });
  });
});

describe('stale instance file', () => {
  it('a dead pid is replaced', async () => {
    const root = project('proj');
    writeInstance({ pid: await deadPid(), port: await deadPort(), root, version: 'old' }, dir);
    const run = await cli(['--dir', root, '--json']);
    expect(run.result.server).toBeDefined();
    expect(JSON.parse(run.out[0]!)).toMatchObject({ reused: false, root });
    expect(readInstance(root, dir)).toMatchObject({ pid: process.pid, port: run.result.server!.port });
  });

  it('a live pid with nothing answering on its port is replaced', async () => {
    const root = project('proj');
    writeInstance({ pid: process.pid, port: await deadPort(), root, version: 'old' }, dir);
    await expect(findRunningInstance(root, dir)).resolves.toBeNull();
    expect(existsSync(instanceFile(root, dir))).toBe(false);

    writeInstance({ pid: process.pid, port: await deadPort(), root, version: 'old' }, dir);
    const run = await cli(['--dir', root, '--json']);
    expect(JSON.parse(run.out[0]!)).toMatchObject({ reused: false, root });
    expect(readInstance(root, dir)?.port).toBe(run.result.server!.port);
  });

  it('a port that answers for another root is replaced', async () => {
    const a = project('a');
    const b = project('b');
    const runA = await cli(['--dir', a, '--port', String(await deadPort())]);
    const portA = runA.result.server!.port;
    // B's file points at A's live server (a port reused by another project's viewer).
    const bogus: InstanceInfo = { pid: process.pid, port: portA, root: b, version: 'old' };
    expect(await probeInstance(bogus)).toBe(false);
    expect(await probeInstance({ ...bogus, root: a })).toBe(true);
    writeInstance(bogus, dir);

    const runB = await cli(['--dir', b, '--json']);
    expect(runB.result.server).toBeDefined();
    expect(runB.result.server!.port).not.toBe(portA);
    expect(JSON.parse(runB.out[0]!)).toMatchObject({ reused: false, root: b });
    expect(readInstance(b, dir)?.port).toBe(runB.result.server!.port);
  });
});

describe('--json', () => {
  it('prints exactly one JSON line with url, reused and root', async () => {
    const root = project('proj');
    const run = await cli(['--dir', root, '--json', '--port', String(await deadPort())]);
    expect(run.out).toHaveLength(1);
    expect(run.out[0]).not.toMatch(/\n/);
    const parsed = JSON.parse(run.out[0]!) as StartupJson;
    expect(parsed).toEqual({ url: `http://localhost:${run.result.server!.port}`, reused: false, root });
    expect(run.err).toEqual([]);
  });

  it('reports root null and writes no instance file when detection finds no project', async () => {
    const cwd = path.join(tmp, 'empty');
    mkdirSync(cwd);
    const run = await cli(['--json', '--port', String(await deadPort())], cwd);
    expect(JSON.parse(run.out[0]!)).toEqual({ url: `http://localhost:${run.result.server!.port}`, reused: false, root: null });
    expect(run.result.instance).toBeUndefined();
    expect(existsSync(dir)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The real command, as separate processes
// ---------------------------------------------------------------------------

/** Start `src/cli.ts` under tsx with this test's instance folder. */
function startCli(args: string[]): ChildProcess {
  const child = spawn(process.execPath, ['--import', 'tsx', path.join(APP_ROOT, 'src', 'cli.ts'), ...args], {
    cwd: APP_ROOT,
    env: { ...process.env, [INSTANCE_DIR_ENV]: dir },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  children.push(child);
  return child;
}

/** Everything the child writes to stdout until it exits, plus its exit code. */
function runToExit(child: ChildProcess): Promise<{ code: number | null; stdout: string; stderr: string }> {
  let stdout = '';
  let stderr = '';
  child.stdout!.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
  child.stderr!.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
  return new Promise((resolve) => child.once('exit', (code) => resolve({ code, stdout, stderr })));
}

/** The first stdout line of a child that keeps running. */
function firstLine(child: ChildProcess): Promise<string> {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    child.stderr!.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
    child.stdout!.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk;
      const end = stdout.indexOf('\n');
      if (end !== -1) resolve(stdout.slice(0, end).replace(/\r$/, ''));
    });
    child.once('exit', (code) => reject(new Error(`phase-viewer exited ${code} before printing: ${stderr}`)));
  });
}

/** Hard-kill a child (TerminateProcess on Windows, SIGTERM elsewhere) and wait for it to go. */
async function killChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill();
  await exited;
}

describe('the command, as processes', () => {
  it(
    'a second run reuses the first; after the first is killed, its leftover file does not block the next start',
    { timeout: CHILD_TIMEOUT },
    async () => {
      const root = project('proj');
      const port = await deadPort();

      const server = startCli(['--dir', root, '--port', String(port), '--json']);
      const first = JSON.parse(await firstLine(server)) as StartupJson;
      expect(first).toEqual({ url: `http://localhost:${port}`, reused: false, root });
      expect(readInstance(root, dir)).toMatchObject({ pid: server.pid, port, root });

      // Same project again: same URL, one JSON line and nothing else on stdout, exit 0.
      const again = await runToExit(startCli(['--dir', root, '--json']));
      expect(again.code).toBe(0);
      expect(again.stdout.split(/\r?\n/)).toEqual([JSON.stringify({ url: first.url, reused: true, root }), '']);
      expect(again.stderr).toBe('');

      // Kill it. On Windows no exit handler runs, so the file is left behind.
      await killChild(server);
      await expect(fetch(`http://${HOST}:${port}/api/health`)).rejects.toThrow();

      const next = startCli(['--dir', root, '--port', String(port), '--json']);
      const fresh = JSON.parse(await firstLine(next)) as StartupJson;
      expect(fresh.reused).toBe(false);
      expect(fresh.root).toBe(root);
      expect(readInstance(root, dir)).toMatchObject({ pid: next.pid, root });
      await killChild(next);
    },
  );
});
