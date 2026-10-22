#!/usr/bin/env node
/**
 * `phase-viewer` command-line entry.
 *
 *     phase-viewer [--dir <path>] [--port <n>] [--json]
 *
 * 1. Parse arguments ({@link parseCliArgs}). `--help` and `--version` print
 *    and exit 0; a bad argument prints one line to stderr and exits 1.
 * 2. Settle the workspace ({@link resolveWorkspace}). `--dir` skips detection
 *    and must name an existing folder, otherwise one line to stderr and exit 1.
 *    Without `--dir`, {@link detectWorkspace} runs; when it finds nothing or
 *    several candidates the CLI still starts, and the server carries that
 *    result so the UI can show its empty or pick-a-folder state.
 * 3. A root inside a linked git worktree becomes the main checkout's
 *    matching project folder ({@link toMainCheckout}), which already shows
 *    every worktree's runs, so the next step finds the main viewer.
 * 4. One viewer per project (`server/instance.ts`): when the root is settled
 *    and a live viewer for it is recorded in its instance file, print that
 *    viewer's URL and exit 0 without starting anything. A stale instance
 *    file is deleted and replaced.
 * 5. Start the server on the first free port from `--port` (default
 *    {@link DEFAULT_PORT}) upward, bound to {@link HOST} only, write the
 *    instance file, and print the URL of the port actually bound plus the
 *    resolved root. With `--json`, stdout gets exactly one line instead,
 *    `{"url","reused","root"}` ({@link StartupJson}); errors still go to
 *    stderr.
 *
 * Everything the command does lives in {@link runCli}, which takes its cwd,
 * output and server starter as arguments and returns an exit code, so tests
 * can drive it in-process. Importing this module starts nothing: the process
 * entry at the bottom runs only when this file is the program Node started.
 */
import { readFileSync, realpathSync, type Stats } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { detectWorkspace, type Workspace, type WorkspaceFound } from './server/detect.js';
import { startViewerServer } from './server/http.js';
import {
  defaultInstanceDir,
  findRunningInstance,
  releaseOnExit,
  STOP_SIGNALS,
  writeInstance,
  type InstanceHandle,
  type InstanceInfo,
} from './server/instance.js';
import { HOST, MAX_PORT } from './server/port.js';
import { mainRoot, type WorktreeOptions } from './server/worktrees.js';

// Port binding lives in server/port.ts (shared with the HTTP server); the CLI
// re-exports it so callers keep one import site.
export { findFreePort, HOST, listenOnFreePort, PORT_ATTEMPTS } from './server/port.js';

/** Port tried first when `--port` isn't given. */
export const DEFAULT_PORT = 4747;

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

/** Parsed command-line options. */
export interface CliOptions {
  /** `--dir`, exactly as given (not yet resolved or checked). */
  dir?: string;
  /** `--port`, or {@link DEFAULT_PORT}. The first port tried, not necessarily the one bound. */
  port: number;
  help: boolean;
  version: boolean;
  /** `--json`: print one JSON line (see {@link StartupJson}) instead of the banner. */
  json: boolean;
}

/** {@link parseCliArgs} result: options, or a one-line error. */
export type ParsedArgs = { ok: true; options: CliOptions } | { ok: false; error: string };

/** Parse `argv` (without the node and script entries). Never throws. */
export function parseCliArgs(argv: readonly string[]): ParsedArgs {
  let values: { dir?: string; port?: string; help?: boolean; version?: boolean; json?: boolean };
  try {
    ({ values } = parseArgs({
      args: [...argv],
      options: {
        dir: { type: 'string', short: 'd' },
        port: { type: 'string', short: 'p' },
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' },
        json: { type: 'boolean' },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (err) {
    return { ok: false, error: `${oneLine(err instanceof Error ? err.message : String(err))} (see --help)` };
  }

  const options: CliOptions = {
    port: DEFAULT_PORT,
    help: values.help === true,
    version: values.version === true,
    json: values.json === true,
  };

  if (values.dir !== undefined) {
    if (values.dir.trim() === '') return { ok: false, error: '--dir needs a path' };
    options.dir = values.dir;
  }

  if (values.port !== undefined) {
    const port = parsePort(values.port);
    if (port === null) {
      return { ok: false, error: `--port must be a whole number from 1 to ${MAX_PORT} (got "${oneLine(values.port)}")` };
    }
    options.port = port;
  }

  return { ok: true, options };
}

/** A port number from `--port`, or `null` when it isn't 1–65535 written in digits. */
function parsePort(raw: string): number | null {
  if (!/^\d{1,5}$/.test(raw.trim())) return null;
  const port = Number(raw.trim());
  return port >= 1 && port <= MAX_PORT ? port : null;
}

/** `--help` text. */
export function usage(): string {
  return [
    'Usage: phase-viewer [--dir <path>] [--port <n>] [--json]',
    '',
    'Live, read-only dashboard for phase-runner builds.',
    '',
    'Options:',
    '  -d, --dir <path>  Project folder (the one holding docs/phases/). Skips detection.',
    `  -p, --port <n>    First port to try (default ${DEFAULT_PORT}); the next free port is used if it's taken.`,
    '      --json        Print one JSON line {"url","reused","root"} and nothing else on stdout.',
    '  -h, --help        Show this help.',
    '  -v, --version     Show the version.',
    '',
    'Without --dir, looks for docs/phases/ in the current folder, then one level up,',
    'then in each immediate subfolder.',
    '',
    'One viewer runs per project: if one is already running for the same folder,',
    'its URL is printed and the command exits without starting another.',
    "Started inside a git worktree, it uses the main checkout's viewer, which",
    'shows phases running in worktrees too.',
  ].join('\n');
}

/**
 * The package version from `package.json` next to `src/` (or `dist/`), read at
 * run time. `unknown` when it can't be read.
 */
export function readVersion(): string {
  try {
    const pkg: unknown = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    const version = typeof pkg === 'object' && pkg !== null ? (pkg as { version?: unknown }).version : undefined;
    return typeof version === 'string' && version !== '' ? version : 'unknown';
  } catch {
    return 'unknown';
  }
}

// ---------------------------------------------------------------------------
// Workspace
// ---------------------------------------------------------------------------

/** A settled workspace, or a one-line error that means exit 1. */
export type ResolvedWorkspace = { ok: true; workspace: Workspace } | { ok: false; error: string };

/**
 * The workspace for these options: `--dir` when given (see
 * {@link resolveDirOption}), otherwise {@link detectWorkspace} from `cwd`.
 * Only a bad `--dir` is an error; detection finding nothing or several
 * candidates is a valid workspace.
 */
export async function resolveWorkspace(options: Pick<CliOptions, 'dir'>, cwd: string): Promise<ResolvedWorkspace> {
  if (options.dir !== undefined) return resolveDirOption(options.dir, cwd);
  return { ok: true, workspace: await detectWorkspace(cwd) };
}

/**
 * `--dir`, resolved against `cwd` and checked to be an existing folder. It is
 * used as the project folder as-is, with no detection; a folder without
 * `docs/phases/` still loads (the loader reports that as a warning).
 */
export async function resolveDirOption(
  dir: string,
  cwd: string,
): Promise<{ ok: true; workspace: WorkspaceFound } | { ok: false; error: string }> {
  const root = path.resolve(cwd, dir);
  let st: Stats;
  try {
    st = await stat(root);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return {
      ok: false,
      error: code === 'ENOENT' || code === 'ENOTDIR' ? `--dir ${root} does not exist` : `--dir ${root} can't be read (${code ?? 'error'})`,
    };
  }
  if (!st.isDirectory()) return { ok: false, error: `--dir ${root} is not a folder` };
  return { ok: true, workspace: { kind: 'found', root, source: 'dir' } };
}

/**
 * A found root inside a linked git worktree becomes the main checkout's
 * matching project folder ({@link mainRoot}), when that folder has
 * `docs/phases/`. The viewer for the main checkout already shows every
 * worktree's runs, so starting from a worktree reuses (or becomes) that
 * viewer instead of starting a second one. Anything else is unchanged.
 */
export async function toMainCheckout(workspace: Workspace, options?: WorktreeOptions): Promise<Workspace> {
  if (workspace.kind !== 'found') return workspace;
  const root = await mainRoot(workspace.root, options);
  return root === workspace.root ? workspace : { ...workspace, root };
}

// ---------------------------------------------------------------------------
// Server seam
// ---------------------------------------------------------------------------

/** What the CLI hands the server. */
export interface StartServerOptions {
  /** First port to try; the server falls through to the next free one. */
  port: number;
  host: string;
  /** The settled workspace, carried in the snapshot so the UI can show its state. */
  workspace: Workspace;
}

/** A listening server. */
export interface RunningServer {
  /** The port actually bound (what the printed URL uses). */
  port: number;
  close(): Promise<void>;
}

/**
 * Starts the viewer server. {@link runCli} takes one so tests can swap it;
 * the default is `startViewerServer` (`server/http.ts`).
 */
export type StartServer = (options: StartServerOptions) => Promise<RunningServer>;

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

/** Where {@link runCli} runs and writes. */
export interface CliIo {
  /** Folder detection starts from, and `--dir` resolves against. */
  cwd: string;
  /** One chunk of standard output (the CLI adds no trailing newline). */
  stdout(text: string): void;
  /** One chunk of standard error (the CLI adds no trailing newline). */
  stderr(text: string): void;
  /** Defaults to `startViewerServer`, the HTTP + SSE server. */
  startServer?: StartServer;
  /** Folder for instance files. Defaults to {@link defaultInstanceDir} (`os.tmpdir()/phase-viewer`). */
  instanceDir?: string;
  /** Options for the git-folder walk in {@link toMainCheckout} (tests pass a `ceiling`). */
  worktrees?: WorktreeOptions;
}

/**
 * {@link runCli} result. `server` is set when the command left a server
 * running; `reused` when it found one already running for the root and
 * started nothing.
 */
export interface CliResult {
  exitCode: number;
  server?: RunningServer;
  /** The workspace the server was started with (or the reused one serves). */
  workspace?: Workspace;
  /** The instance file this run wrote; `server.close()` removes it. */
  instance?: InstanceHandle;
  /** The already-running instance whose URL was printed instead of starting a server. */
  reused?: InstanceInfo;
}

/** The one stdout line `--json` prints. */
export interface StartupJson {
  /** `http://localhost:{port}`, as in the banner. */
  url: string;
  /** `true` when an already-running viewer for this root was found and nothing was started. */
  reused: boolean;
  /** Absolute project folder, or `null` when detection didn't settle on one. */
  root: string | null;
}

/** Run the command. Never throws; every failure is one stderr line and exit code 1. */
export async function runCli(argv: readonly string[], io: CliIo): Promise<CliResult> {
  const fail = (message: string): CliResult => {
    io.stderr(`phase-viewer: ${oneLine(message)}`);
    return { exitCode: 1 };
  };

  const parsed = parseCliArgs(argv);
  if (!parsed.ok) return fail(parsed.error);
  const { options } = parsed;

  if (options.help) {
    io.stdout(usage());
    return { exitCode: 0 };
  }
  if (options.version) {
    io.stdout(readVersion());
    return { exitCode: 0 };
  }

  const resolved = await resolveWorkspace(options, io.cwd);
  if (!resolved.ok) return fail(resolved.error);
  const workspace = await toMainCheckout(resolved.workspace, io.worktrees);
  const root = workspace.kind === 'found' ? workspace.root : null;
  const instanceDir = io.instanceDir ?? defaultInstanceDir();

  // One viewer per project: a live server for this root is reused, whatever --port says.
  if (root !== null) {
    const running = await findRunningInstance(root, instanceDir);
    if (running !== null) {
      io.stdout(
        options.json
          ? formatStartupJson(running.port, true, running.root)
          : `${formatStartup(running.port, workspace, io.cwd)}\nalready running (pid ${running.pid}), reusing it`,
      );
      return { exitCode: 0, workspace, reused: running };
    }
  }

  let server: RunningServer;
  try {
    server = await (io.startServer ?? startViewerServer)({ port: options.port, host: HOST, workspace });
  } catch (err) {
    return fail(`couldn't start the server: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Record the instance (only for a settled root). Failing to write it costs
  // reuse, not the server, so it's a stderr note and the run carries on.
  let instance: InstanceHandle | undefined;
  if (root !== null) {
    try {
      instance = writeInstance({ pid: process.pid, port: server.port, root, version: readVersion() }, instanceDir);
      const handle = instance;
      const close = server.close.bind(server);
      // Patched in place (not wrapped) so callers keep the server object's other members.
      server.close = () => {
        handle.release();
        return close();
      };
    } catch (err) {
      io.stderr(`phase-viewer: couldn't write the instance file: ${oneLine(err instanceof Error ? err.message : String(err))}`);
    }
  }

  io.stdout(options.json ? formatStartupJson(server.port, false, root) : formatStartup(server.port, workspace, io.cwd));
  return instance ? { exitCode: 0, server, workspace, instance } : { exitCode: 0, server, workspace };
}

/** The `--json` line: `{"url","reused","root"}`, no newlines inside. */
export function formatStartupJson(port: number, reused: boolean, root: string | null): string {
  const out: StartupJson = { url: `http://localhost:${port}`, reused, root };
  return JSON.stringify(out);
}

/**
 * The startup banner: the URL line (`phase-viewer → http://localhost:{port}`),
 * then the resolved root, or what detection found instead.
 */
export function formatStartup(port: number, workspace: Workspace, cwd: string): string {
  const lines = [`phase-viewer → http://localhost:${port}`];
  switch (workspace.kind) {
    case 'found':
      lines.push(`root: ${workspace.root}`);
      break;
    case 'candidates':
      lines.push(`root: not chosen, docs/phases/ found in ${workspace.candidates.length} folders:`);
      for (const candidate of workspace.candidates) lines.push(`  ${candidate}`);
      lines.push('Rerun with --dir <path> to choose one.');
      break;
    case 'none':
      lines.push(`root: none, no docs/phases/ in ${path.resolve(cwd)}, one level up, or one level down`);
      lines.push('Rerun with --dir <path> to point at a project folder.');
      break;
  }
  return lines.join('\n');
}

/** Collapse whitespace runs (newlines included) so a message stays on one line. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------------------
// Process entry
// ---------------------------------------------------------------------------

/** Whether this module is the program Node started (not an import). */
function isProcessEntry(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    const self = realpathSync(fileURLToPath(import.meta.url));
    const started = realpathSync(entry);
    return process.platform === 'win32' ? self.toLowerCase() === started.toLowerCase() : self === started;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const result = await runCli(process.argv.slice(2), {
    cwd: process.cwd(),
    stdout: (text) => process.stdout.write(`${text}\n`),
    stderr: (text) => process.stderr.write(`${text}\n`),
  });
  const { server } = result;
  if (!server) {
    process.exitCode = result.exitCode;
    return;
  }
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    void server.close().finally(() => process.exit(0));
  };
  // The instance file goes on exit and on each stop signal; a hard kill leaves
  // it behind, and the next start's stale check clears it.
  if (result.instance) releaseOnExit(result.instance, stop);
  else for (const signal of STOP_SIGNALS) process.once(signal, stop);
}

if (isProcessEntry()) {
  main().catch((err: unknown) => {
    process.stderr.write(`phase-viewer: ${oneLine(err instanceof Error ? err.message : String(err))}\n`);
    process.exitCode = 1;
  });
}
