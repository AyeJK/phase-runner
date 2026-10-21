/**
 * A dev loop of a test's own, for scenarios the shared `webServer` (a fresh
 * copy with the retry script playing) can't give: a stale run log, or a
 * viewer server that stops and comes back.
 *
 * It does what `scripts/dev.ts` does, in the test process: copies the
 * `trail-log` fixture (or the one named) with the chosen freshness (no script plays), starts the
 * viewer server on it, and starts Vite with `/api` proxied to that server.
 * The server can then be stopped and restarted on the same port while Vite
 * keeps serving the page, which is what the browser sees when the viewer
 * server goes away.
 *
 * To play a run on cue, append steps to `fixture.root` with `writeStep` from
 * `scripts/simulate-run.ts` (as `rail.spec.ts` does).
 *
 * Ports in use (each test its own pair, all clear of the shared `webServer`
 * on 4790 / 4791): `shell.spec.ts` 4798–4799 and 4850–4853,
 * `sprint.spec.ts` 4810–4811, `states.spec.ts` 4830–4835, `rail.spec.ts`
 * 4840–4847.
 */
import { fileURLToPath } from 'node:url';
import { createServer as createViteServer, type ViteDevServer } from 'vite';
import { prepareFixture, type Freshness, type PreparedFixture } from '../../scripts/simulate-run.js';
import { startViewerServer, type ViewerServer } from '../../src/server/http.js';
import { HOST } from '../../src/server/port.js';

export interface HarnessOptions {
  /** Vite's port (strict: the test fails if it's taken). */
  clientPort: number;
  /** First port the viewer server tries. */
  serverPort: number;
  /** How old the copied run logs' latest event is. Default `fresh` (90 s). */
  freshness?: Freshness;
  /** Fixture folder under `test/fixtures/`. Default `trail-log`. */
  fixture?: string;
  /** A project folder to copy instead of a fixture (its `docs/`, under the same folder name). */
  source?: string;
}

export interface Harness {
  /** The page URL (Vite), e.g. `http://127.0.0.1:4794`. */
  baseURL: string;
  fixture: PreparedFixture;
  /** Stop the viewer server (Vite stays up, so its proxy answers with errors). */
  stopServer(): Promise<void>;
  /** Start the viewer server again on the port it had. */
  startServer(): Promise<void>;
  /** Stop everything and delete the copy. */
  close(): Promise<void>;
}

const VITE_CONFIG = fileURLToPath(new URL('../../vite.config.ts', import.meta.url));

export async function startHarness(options: HarnessOptions): Promise<Harness> {
  const fixture = await prepareFixture({
    fixture: options.fixture,
    source: options.source,
    freshness: options.freshness ?? 'fresh',
  });
  const workspace = { kind: 'found' as const, root: fixture.root, source: 'dir' as const };

  const first = await startViewerServer({ port: options.serverPort, host: HOST, workspace });
  const apiPort = first.port;
  const apiUrl = first.url;
  let server: ViewerServer | null = first;

  let started: ViteDevServer | null = null;
  try {
    // vite.config.ts reads its proxy target from here; the inline proxy below says the same.
    process.env.PHASE_VIEWER_API = apiUrl;
    started = await createViteServer({
      configFile: VITE_CONFIG,
      logLevel: 'silent',
      server: {
        host: HOST,
        port: options.clientPort,
        strictPort: true,
        proxy: { '/api': { target: apiUrl } },
      },
    });
    await started.listen();
  } catch (err) {
    await started?.close();
    await first.close();
    await fixture.cleanup();
    throw err;
  }
  const vite: ViteDevServer = started;

  return {
    baseURL: `http://${HOST}:${options.clientPort}`,
    fixture,
    async stopServer() {
      await server?.close();
      server = null;
    },
    async startServer() {
      if (server) return;
      const next = await startViewerServer({ port: apiPort, host: HOST, workspace });
      if (next.port !== apiPort) {
        await next.close();
        throw new Error(`viewer server came back on ${next.port}, not ${apiPort}`);
      }
      server = next;
    },
    async close() {
      await Promise.allSettled([vite.close(), server?.close()]);
      server = null;
      await fixture.cleanup();
    },
  };
}
