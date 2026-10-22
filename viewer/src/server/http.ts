/**
 * The viewer's HTTP server: plain Node `http`, no framework.
 *
 * | Route              | Answer |
 * |--------------------|--------|
 * | `GET /api/events`  | Server-sent events: `snapshot` on connect, then `phase`, `run`, `removed`, `warnings` and `design` (see `sse.ts`) |
 * | `GET /api/snapshot`| {@link ViewerSnapshot} as JSON |
 * | `GET /api/health`  | {@link Health} as JSON: `{ name, version, root, pid }` |
 * | `GET /api/…` other | 404 JSON |
 * | `GET` anything else| A file from `dist/client/`, else `index.html` (SPA fallback). A placeholder page while the client isn't built. |
 *
 * On start it loads the project from every checkout of its git repo into a
 * {@link CheckoutSet} (`checkouts.ts`: the main checkout plus each linked
 * worktree, merged phase by phase; just the project folder when there are no
 * worktrees or no repo), starts the file watchers and waits for their first
 * scan, then binds the first free port with {@link listenOnFreePort}. Each
 * settled file change is applied to the set, as is each worktree appearing or
 * going, and the updates are broadcast to every open event stream. When the
 * workspace has no resolved root (detection found nothing, or several
 * candidates) the server still starts: the snapshot carries the workspace
 * with `project: null`, and no watcher runs.
 *
 * Read-only guarantee: only GET and HEAD are accepted (anything else is 405
 * with `Allow: GET, HEAD`), there are no write endpoints, and no code path
 * here writes to disk. The project folder and the git folder are only read
 * (through `checkouts.ts`, `state.ts`, `watch.ts` and `worktrees.ts`); static files are only read from the client folder, and a
 * request path that resolves outside it is refused.
 */
import { createReadStream, readFileSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RunningServer, StartServerOptions } from '../cli.js';
import { listenOnFreePort } from './port.js';
import { createEventHub, type ViewerSnapshot } from './sse.js';
import { createCheckoutSet, watchCheckouts, type CheckoutSet } from './checkouts.js';
import type { ProjectWatcher } from './watch.js';

export type { ViewerSnapshot } from './sse.js';

/**
 * The built client (`dist/client/`), resolved from this module's location so
 * it's the same folder whatever the working directory: `src/server/` in
 * development and `dist/server/` once built both sit two levels below the
 * package root.
 */
export const DEFAULT_CLIENT_DIR = fileURLToPath(new URL('../../dist/client/', import.meta.url));

/** Longest the server waits for the watcher's first scan before listening anyway. */
const WATCH_READY_TIMEOUT_MS = 2_000;

/** Methods the server answers. Everything else is 405. */
const ALLOWED_METHODS = 'GET, HEAD';

/** `GET /api/health` body. */
export interface Health {
  /** Package name (`phase-viewer`). */
  name: string;
  /** Package version, or `unknown`. */
  version: string;
  /** Absolute project folder, or `null` when the workspace has none. */
  root: string | null;
  /** Server process id. */
  pid: number;
}

/** Options for {@link startViewerServer}: the CLI's, plus test and tuning knobs. */
export interface ViewerServerOptions extends StartServerOptions {
  /** Folder of the built client. Default {@link DEFAULT_CLIENT_DIR}. */
  clientDir?: string;
  /** Interval between SSE heartbeat comments. Default 15 s. */
  heartbeatMs?: number;
  /** Watcher quiet time per file. Default 100 ms. */
  debounceMs?: number;
  /** Poll instead of native file events (network drives). Default `false`. */
  usePolling?: boolean;
  /** Called with file-watcher errors. Default: ignored. */
  onWatchError?: (err: Error) => void;
}

/** A listening viewer server. */
export interface ViewerServer extends RunningServer {
  /** Host the server is bound to. */
  readonly host: string;
  /** `http://{host}:{port}`. */
  readonly url: string;
  /** The model a client connecting now would receive. */
  snapshot(): ViewerSnapshot;
  /** Open `/api/events` streams. */
  readonly eventClients: number;
  /** End open event streams, stop the watcher and close the HTTP server. Safe to call twice. */
  close(): Promise<void>;
}

/**
 * Start the viewer server: the default `StartServer` for `runCli`.
 *
 * Rejects only when no port can be bound; the watcher is stopped first.
 */
export async function startViewerServer(options: ViewerServerOptions): Promise<ViewerServer> {
  const { workspace, host } = options;
  const clientDir = path.resolve(options.clientDir ?? DEFAULT_CLIENT_DIR);
  const pkg = readPackage();
  const hub = createEventHub({ heartbeatMs: options.heartbeatMs });

  let state: CheckoutSet | null = null;
  let watcher: ProjectWatcher | null = null;
  if (workspace.kind === 'found') {
    const live = await createCheckoutSet(workspace.root);
    state = live;
    watcher = watchCheckouts(live, (updates) => hub.broadcast(updates), {
      debounceMs: options.debounceMs,
      usePolling: options.usePolling,
      onError: options.onWatchError,
    });
    await readyOrTimeout(watcher.ready, WATCH_READY_TIMEOUT_MS);
  }

  const snapshot = (): ViewerSnapshot => ({ workspace, project: state ? state.snapshot() : null });
  const health = (): Health => ({ name: pkg.name, version: pkg.version, root: state?.root ?? null, pid: process.pid });

  const server: Server = createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) sendText(res, 500, 'Internal server error', req.method === 'HEAD');
      else res.destroy();
    });
  });

  /** Route one request. */
  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? 'GET';
    if (method !== 'GET' && method !== 'HEAD') {
      res.setHeader('allow', ALLOWED_METHODS);
      sendJson(res, 405, { error: `Method ${method} not allowed; phase-viewer is read-only` }, false);
      return;
    }
    const head = method === 'HEAD';

    let pathname: string;
    try {
      pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    } catch {
      sendText(res, 400, 'Bad request', head);
      return;
    }

    if (pathname === '/api' || pathname.startsWith('/api/')) {
      switch (pathname) {
        case '/api/events':
          if (head) {
            res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store' }).end();
          } else {
            hub.connect(req, res, snapshot());
          }
          return;
        case '/api/snapshot':
          sendJson(res, 200, snapshot(), head);
          return;
        case '/api/health':
          sendJson(res, 200, health(), head);
          return;
        default:
          sendJson(res, 404, { error: `No API route ${pathname}` }, head);
          return;
      }
    }

    await serveClient(res, pathname, clientDir, { pkg, root: state?.root ?? null }, head);
  }

  let port: number;
  try {
    port = await listenOnFreePort(server, options.port, host);
  } catch (err) {
    hub.close();
    await watcher?.close();
    throw err;
  }

  let closing: Promise<void> | null = null;
  return {
    port,
    host,
    url: `http://${host}:${port}`,
    snapshot,
    get eventClients() {
      return hub.size;
    },
    close() {
      closing ??= (async () => {
        hub.close();
        await watcher?.close();
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        });
      })();
      return closing;
    },
  };
}

// ---------------------------------------------------------------------------
// Static client
// ---------------------------------------------------------------------------

/** Content types for the files a Vite build emits. */
const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

/**
 * Serve `pathname` from the client folder: the file when it exists, else
 * `index.html` (client-side routes such as `/sprint/3.3`), else the
 * placeholder page when the client isn't built. A path that resolves outside
 * the folder (`..`, encoded slashes or backslashes) is a 404.
 */
async function serveClient(
  res: ServerResponse,
  pathname: string,
  clientDir: string,
  info: { pkg: PackageInfo; root: string | null },
  head: boolean,
): Promise<void> {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    sendText(res, 400, 'Bad request', head);
    return;
  }
  if (decoded.includes('\0')) {
    sendText(res, 400, 'Bad request', head);
    return;
  }

  const file = path.join(clientDir, decoded);
  if (!isInside(clientDir, file)) {
    sendText(res, 404, 'Not found', head);
    return;
  }

  const index = path.join(clientDir, 'index.html');
  if (!(await isFile(index))) {
    sendBody(res, 200, 'text/html; charset=utf-8', placeholderPage(info.pkg, info.root), head);
    return;
  }
  if (file !== clientDir && (await isFile(file))) {
    await sendFile(res, file, head);
    return;
  }
  await sendFile(res, index, head);
}

/** Stream one file with its content type and length. */
async function sendFile(res: ServerResponse, file: string, head: boolean): Promise<void> {
  const { size } = await stat(file);
  res.writeHead(200, {
    'content-type': CONTENT_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
    'content-length': size,
    'cache-control': 'no-cache',
    'x-content-type-options': 'nosniff',
  });
  if (head) {
    res.end();
    return;
  }
  await new Promise<void>((resolve) => {
    const stream = createReadStream(file);
    stream.on('error', () => {
      res.destroy();
      resolve();
    });
    res.on('close', () => {
      stream.destroy();
      resolve();
    });
    stream.pipe(res);
  });
}

/** The page served while `dist/client/` has no `index.html`. */
function placeholderPage(pkg: PackageInfo, root: string | null): string {
  const project = root === null ? 'none (see /api/snapshot for what detection found)' : escapeHtml(root);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(pkg.name)}</title>
<style>
  body { font: 16px/1.5 system-ui, sans-serif; margin: 2rem; color: #1a1a1a; background: #fff; }
  code { font-family: ui-monospace, monospace; }
  @media (prefers-color-scheme: dark) { body { color: #e6e6e6; background: #151515; } a { color: #8ab4ff; } }
</style>
</head>
<body>
<h1>${escapeHtml(pkg.name)} ${escapeHtml(pkg.version)}</h1>
<p>The server is running, but the client isn't built yet.</p>
<p>Project folder: <code>${project}</code></p>
<p>Live data: <a href="/api/snapshot">/api/snapshot</a> · <a href="/api/events">/api/events</a> · <a href="/api/health">/api/health</a></p>
</body>
</html>
`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Package name and version for `/api/health`. */
interface PackageInfo {
  name: string;
  version: string;
}

/** `package.json` at the package root (two levels up, as for the client folder). */
function readPackage(): PackageInfo {
  try {
    const pkg: unknown = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
    const field = (key: string): string | undefined => {
      const value = typeof pkg === 'object' && pkg !== null ? (pkg as Record<string, unknown>)[key] : undefined;
      return typeof value === 'string' && value !== '' ? value : undefined;
    };
    return { name: field('name') ?? 'phase-viewer', version: field('version') ?? 'unknown' };
  } catch {
    return { name: 'phase-viewer', version: 'unknown' };
  }
}

function sendJson(res: ServerResponse, status: number, data: unknown, head: boolean): void {
  sendBody(res, status, 'application/json; charset=utf-8', JSON.stringify(data), head);
}

function sendText(res: ServerResponse, status: number, text: string, head: boolean): void {
  sendBody(res, status, 'text/plain; charset=utf-8', `${text}\n`, head);
}

function sendBody(res: ServerResponse, status: number, contentType: string, body: string, head: boolean): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(head ? undefined : body);
}

/** `true` when `child` is `parent` or below it. */
function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/** `true` when the path is a regular file; `false` on any error. */
async function isFile(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isFile();
  } catch {
    return false;
  }
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** Wait for `ready`, but no longer than `ms`. */
async function readyOrTimeout(ready: Promise<void>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    ready,
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ms);
      timer.unref();
    }),
  ]);
  clearTimeout(timer);
}
