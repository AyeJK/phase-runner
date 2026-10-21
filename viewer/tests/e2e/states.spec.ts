/**
 * Empty, warning and not-found states (Sprint 5.3):
 *
 * - No phase plans: the viewer started (through `runCli`, as `npx
 *   phase-viewer` would) in a temp folder with no `docs/phases/` here, one
 *   level up or one level down shows the empty state, not an error: the large
 *   wordmark, "No phase plans found" and the folders it searched. No buttons.
 * - Several candidates: started in a temp folder with two subfolders holding
 *   `docs/phases/`, it lists both, each with its `npx phase-viewer --dir`
 *   command as plain text, and picks neither.
 * - Parse warnings: on a copy of the `broken` fixture, the warnings banner
 *   shows at the top of the phase's rail; Show details reveals the file,
 *   each line number and its raw text; every other sprint still renders.
 * - Not found: `/sprint/9.9`, `/phase/99` and an unknown address show the
 *   not-found block with a link back to the phases, inside the shell.
 *
 * Updated in Sprint 7.3 for the unified shell (Overview, Sprint detail and
 * the phase sidebar are gone), and in Sprint 9.1 for the one layout (the
 * kanban and its slide-in panel are gone).
 *
 * Each group starts a dev loop of its own (the viewer server plus Vite with
 * `/api` proxied to it), as `harness.ts` does for `trail-log`.
 *
 * Ports: 4830–4835 (see `harness.ts`).
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { createServer as createViteServer, type ViteDevServer } from 'vite';
import { prepareFixture, type PreparedFixture } from '../../scripts/simulate-run.js';
import { runCli, type RunningServer } from '../../src/cli.js';
import { loadProject } from '../../src/core/load.js';
import type { Project } from '../../src/core/model.js';
import type { Workspace } from '../../src/server/detect.js';
import { startViewerServer } from '../../src/server/http.js';
import { HOST } from '../../src/server/port.js';

const VITE_CONFIG = fileURLToPath(new URL('../../vite.config.ts', import.meta.url));

// ---------------------------------------------------------------------------
// Dev loops
// ---------------------------------------------------------------------------

interface Loop {
  baseURL: string;
  close(): Promise<void>;
}

/** Vite on `clientPort`, proxying `/api` to a viewer server already listening on `serverPort`. */
async function startVite(clientPort: number, serverPort: number): Promise<ViteDevServer> {
  const api = `http://${HOST}:${serverPort}`;
  // vite.config.ts reads its proxy target from here; the inline proxy below says the same.
  process.env.PHASE_VIEWER_API = api;
  const vite = await createViteServer({
    configFile: VITE_CONFIG,
    logLevel: 'silent',
    server: { host: HOST, port: clientPort, strictPort: true, proxy: { '/api': { target: api } } },
  });
  await vite.listen();
  return vite;
}

/** A loop around a started viewer server; `cleanup` runs after both servers close. */
async function loopAround(
  clientPort: number,
  server: RunningServer,
  cleanup: () => Promise<void>,
): Promise<Loop> {
  let vite: ViteDevServer;
  try {
    vite = await startVite(clientPort, server.port);
  } catch (err) {
    await server.close();
    await cleanup();
    throw err;
  }
  return {
    baseURL: `http://${HOST}:${clientPort}`,
    async close() {
      await Promise.allSettled([vite.close(), server.close()]);
      await cleanup();
    },
  };
}

/** The viewer started the way the command starts it: `runCli` in `cwd`, no `--dir`. */
async function startCliLoop(
  clientPort: number,
  serverPort: number,
  cwd: string,
  cleanup: () => Promise<void>,
): Promise<Loop & { workspace: Workspace; stdout: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const result = await runCli(['--port', String(serverPort)], {
    cwd,
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
  });
  if (!result.server || !result.workspace) {
    await cleanup();
    throw new Error(`phase-viewer exited ${result.exitCode}: ${err.join(' ')}`);
  }
  const loop = await loopAround(clientPort, result.server, cleanup);
  return { ...loop, workspace: result.workspace, stdout: out.join('\n') };
}

/** A throwaway folder tree; returns its base and a remover. */
async function tempTree(): Promise<{ base: string; remove: () => Promise<void> }> {
  const base = await mkdtemp(path.join(os.tmpdir(), 'phase-viewer-states-'));
  return { base, remove: () => rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) };
}

// ---------------------------------------------------------------------------
// Page helpers (this file is type-checked without the DOM lib)
// ---------------------------------------------------------------------------

interface Marked {
  __statesMarker?: string;
}

interface PageDocument {
  document: { documentElement: { scrollWidth: number; clientWidth: number } };
}

async function open(page: Page, url: string): Promise<void> {
  await page.goto(url);
  await expect(page.locator('.app')).toHaveAttribute('data-connection', 'live');
}

async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(() => {
    const root = (globalThis as unknown as PageDocument).document.documentElement;
    return root.scrollWidth - root.clientWidth;
  });
}

async function markWindow(page: Page): Promise<void> {
  await page.evaluate(() => {
    (globalThis as unknown as Marked).__statesMarker = 'still here';
  });
}

async function windowMarker(page: Page): Promise<string | undefined> {
  return page.evaluate(() => (globalThis as unknown as Marked).__statesMarker);
}

/** The `--dir` command the candidates state shows (quoted only when the path needs it). */
function dirCommand(folder: string): string {
  const arg = /[\s"'`$&|;<>()!*?#]/.test(folder) ? `"${folder.replace(/"/g, '\\"')}"` : folder;
  return `npx phase-viewer --dir ${arg}`;
}

// ---------------------------------------------------------------------------
// No phase plans
// ---------------------------------------------------------------------------

test.describe('no phase plans', () => {
  let loop: Awaited<ReturnType<typeof startCliLoop>>;
  let cwd: string;
  let base: string;

  test.beforeAll(async () => {
    test.setTimeout(60_000);
    // {base}/home is where the viewer starts; {base} is one level up; two
    // subfolders one level down. None has docs/phases/.
    const tree = await tempTree();
    base = tree.base;
    cwd = path.join(base, 'home');
    await mkdir(path.join(cwd, 'notes'), { recursive: true });
    await mkdir(path.join(cwd, 'src', 'docs'), { recursive: true });
    await writeFile(path.join(cwd, 'README.md'), '# Not a project\n', 'utf8');
    loop = await startCliLoop(4830, 4831, cwd, tree.remove);
  });

  test.afterAll(async () => {
    await loop?.close();
  });

  test('starting in a folder with no phase plans shows the empty state, not an error', async ({ page }) => {
    expect(loop.workspace).toEqual({
      kind: 'none',
      searched: [path.resolve(cwd), path.resolve(base), path.join(path.resolve(cwd), 'notes'), path.join(path.resolve(cwd), 'src')],
    });
    expect(loop.stdout).toContain('root: none');

    await open(page, `${loop.baseURL}/`);
    const empty = page.getByTestId('no-phase-plans');
    await expect(empty).toBeVisible();
    // `/` is the list view's route, which shows the empty state instead.
    await expect(page).toHaveURL(`${loop.baseURL}/`);
    // No project, so no project name in the top bar.
    await expect(page.getByTestId('project-name')).toHaveCount(0);

    await expect(empty.locator('svg.wm-lg')).toHaveAttribute('aria-label', 'Phase Runner');
    await expect(empty.locator('h3')).toHaveText('No phase plans found');
    await expect(empty).toContainText('Looked for docs/phases/ in this folder, one level up and one level down.');

    // Where it looked: this folder, one level up, one level down.
    const searched = page.getByTestId('searched');
    await expect(searched.locator('[data-level="here"] dd')).toHaveText(path.resolve(cwd));
    await expect(searched.locator('[data-level="up"] dd')).toHaveText(path.resolve(base));
    await expect(searched.locator('[data-level="down"] code')).toHaveText(['notes', 'src']);

    // No buttons, no list view, no error.
    await expect(page.locator('main button')).toHaveCount(0);
    await expect(page.getByTestId('list-view')).toHaveCount(0);
    await expect(page.getByTestId('not-found')).toHaveCount(0);
  });

  test('every route shows the empty state', async ({ page }) => {
    for (const route of ['/list', '/?phase=2', '/live', '/sprint/9.9', '/phase/99']) {
      await open(page, `${loop.baseURL}${route}`);
      await expect(page.getByTestId('no-phase-plans')).toBeVisible();
    }
  });

  test.describe('375 px', () => {
    test.use({ viewport: { width: 375, height: 812 } });

    test('no horizontal page scroll', async ({ page }) => {
      await open(page, `${loop.baseURL}/`);
      await expect(page.getByTestId('no-phase-plans')).toBeVisible();
      expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    });
  });
});

// ---------------------------------------------------------------------------
// Several candidates
// ---------------------------------------------------------------------------

test.describe('several candidates', () => {
  let loop: Awaited<ReturnType<typeof startCliLoop>>;
  let cwd: string;
  let candidates: string[];

  test.beforeAll(async () => {
    test.setTimeout(60_000);
    // {base}/workspace holds alpha/ and beta/ (each with docs/phases/) and notes/ (without).
    const tree = await tempTree();
    cwd = path.join(tree.base, 'workspace');
    candidates = ['alpha', 'beta'].map((name) => path.join(path.resolve(cwd), name));
    for (const folder of candidates) await mkdir(path.join(folder, 'docs', 'phases'), { recursive: true });
    await mkdir(path.join(cwd, 'notes'), { recursive: true });
    loop = await startCliLoop(4832, 4833, cwd, tree.remove);
  });

  test.afterAll(async () => {
    await loop?.close();
  });

  test('two candidate folders show both, each with its --dir command, and neither is picked', async ({ page }) => {
    expect(loop.workspace).toMatchObject({ kind: 'candidates', candidates });

    await open(page, `${loop.baseURL}/`);
    const block = page.getByTestId('candidates');
    await expect(block).toBeVisible();
    await expect(block.locator('svg.wm-lg')).toHaveCount(1);
    await expect(block.locator('h3')).toHaveText('Several project folders found');

    const items = page.getByTestId('candidate');
    await expect(items).toHaveCount(2);
    for (const [i, folder] of candidates.entries()) {
      await expect(items.nth(i)).toHaveAttribute('data-path', folder);
      await expect(items.nth(i).locator('strong')).toHaveText(path.basename(folder));
      await expect(items.nth(i).getByTestId('candidate-command')).toHaveText(dirCommand(folder));
    }

    // Plain text, never buttons; nothing chosen.
    await expect(page.locator('main button')).toHaveCount(0);
    await expect(page.getByTestId('list-view')).toHaveCount(0);
    await expect(page.getByTestId('project-name')).toHaveCount(0);
    const health = await page.request.get(`${loop.baseURL}/api/health`);
    expect(((await health.json()) as { root: string | null }).root).toBeNull();
  });

  test.describe('375 px', () => {
    test.use({ viewport: { width: 375, height: 812 } });

    test('no horizontal page scroll', async ({ page }) => {
      await open(page, `${loop.baseURL}/list`);
      await expect(page.getByTestId('candidate')).toHaveCount(2);
      expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    });
  });
});

// ---------------------------------------------------------------------------
// Parse warnings and not found (the broken fixture)
// ---------------------------------------------------------------------------

test.describe('broken fixture', () => {
  let loop: Loop;
  let fixture: PreparedFixture;
  let project: Project;

  test.beforeAll(async () => {
    test.setTimeout(60_000);
    fixture = await prepareFixture({ fixture: 'broken', freshness: 'as-is' });
    project = await loadProject(fixture.root);
    const server = await startViewerServer({
      port: 4835,
      host: HOST,
      workspace: { kind: 'found', root: fixture.root, source: 'dir' },
    }).catch(async (err: unknown) => {
      await fixture.cleanup();
      throw err;
    });
    loop = await loopAround(4834, server, () => fixture.cleanup());
  });

  test.afterAll(async () => {
    await loop?.close();
  });

  /** Distinct lines with a warning (what the banner title counts). */
  function warnedLines(): number {
    return new Set(project.warnings.map((w) => w.line)).size;
  }

  test('the warnings banner shows on the rail and expands to file, line and raw text', async ({ page }) => {
    expect(project.warnings.length).toBeGreaterThan(0);
    const lines = warnedLines();

    // The banner sits at the top of the phase's rail.
    await open(page, `${loop.baseURL}/phase/1`);
    await expect(page.getByTestId('phase-rail')).toBeVisible();

    const banner = page.getByTestId('parse-warnings');
    await expect(banner).toHaveCount(1);
    await expect(banner).toHaveAttribute('data-file', 'docs/phases/Phase-1-Broken.md');
    await expect(banner.locator('strong')).toHaveText(`${lines} lines in Phase-1-Broken.md couldn't be read`);
    await expect(banner.locator('p')).toHaveText('Everything else is shown.');
    await expect(banner.locator('svg.i.warn')).toHaveCount(1);

    // Collapsed until asked.
    const toggle = banner.getByTestId('parse-warnings-toggle');
    const details = banner.getByTestId('parse-warnings-details');
    await expect(toggle).toHaveText('Show details');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(details).toBeHidden();

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(toggle).toHaveText('Hide details');
    await expect(details).toBeVisible();

    // File, then one row per warning with its line number and raw text.
    await expect(details.locator('.warn-file')).toHaveText('docs/phases/Phase-1-Broken.md');
    const rows = details.getByTestId('parse-warning');
    await expect(rows).toHaveCount(project.warnings.length);
    const unclosed = details.locator('[data-testid="parse-warning"][data-line="18"]').first();
    await expect(unclosed.locator('.ln')).toHaveText('line 18');
    await expect(unclosed.getByTestId('parse-warning-raw')).toHaveText('| — | 2 | Second row has no closing pipe | src/b.ts');
    const junk = details.locator('[data-testid="parse-warning"][data-line="55"]').first();
    await expect(junk.getByTestId('parse-warning-raw')).toContainText('stray bytes');

    // And back.
    await toggle.click();
    await expect(details).toBeHidden();
  });

  test('every other sprint still renders', async ({ page }) => {
    const phase = project.phases[0]!;
    const ids = phase.sprints.map((s) => s.id);
    // The sprint with no N.M id is the only one that can't be addressed.
    expect(ids).toEqual(['1.1', '1.3', '1.4']);

    // `/phase/1`: the rail, one sprint card per sprint.
    await open(page, `${loop.baseURL}/phase/1`);
    const panel = page.getByTestId('list-main');
    await expect(panel.getByTestId('phase-rail')).toBeVisible();
    await expect(panel.getByTestId('parse-warnings')).toHaveCount(1);
    await expect(panel.locator('article[data-sprint-card]')).toHaveCount(ids.length);
    for (const id of ids) await expect(panel.locator(`article[data-sprint-card="${id}"]`)).toBeVisible();

    // Each sprint's card opens to its tasks (Sprint detail's tasks table moved onto the card).
    for (const sprint of phase.sprints) {
      const card = panel.locator(`article[data-sprint-card="${sprint.id}"]`);
      if ((await card.getAttribute('data-open')) !== 'true') await card.getByTestId('card-toggle').click();
      await expect(card.getByTestId('tasks-table').locator('tbody tr')).toHaveCount(sprint.tasks.length);
    }
  });

  test('an unknown sprint or phase shows not found with a link back to the phases', async ({ page }) => {
    // An unknown sprint lands on its phase (`/sprint/9.9` → `/phase/9#s9.9`), and an unknown
    // phase shows not found where its rail would be, with the phase list beside it.
    const cases = [
      { route: '/sprint/9.9', kind: 'phase', title: 'Phase 9 not found' },
      { route: '/phase/99', kind: 'phase', title: 'Phase 99 not found' },
      { route: '/nowhere', kind: 'page', title: 'Page not found' },
    ];
    for (const c of cases) {
      await open(page, `${loop.baseURL}${c.route}`);
      const block = page.getByTestId('not-found');
      await expect(block).toHaveAttribute('data-kind', c.kind);
      await expect(block.locator('h3')).toHaveText(c.title);
      // The shell stays.
      await expect(page.locator('.app-head')).toBeVisible();
      await expect(page.getByTestId('project-name')).toBeVisible();

      const link = block.getByTestId('not-found-overview');
      await expect(link).toHaveText('Back to phases');
      await expect(link).toHaveAttribute('href', '/');
      await markWindow(page);
      await link.click();
      await expect(page).toHaveURL(`${loop.baseURL}/`);
      await expect(page.getByTestId('list-main').getByTestId('phase-rail')).toBeVisible();
      await expect(page.getByTestId('not-found')).toHaveCount(0);
      expect(await windowMarker(page)).toBe('still here');
    }
  });

  test.describe('375 px', () => {
    test.use({ viewport: { width: 375, height: 812 } });

    test('no horizontal page scroll with details open, or on not found', async ({ page }) => {
      await open(page, `${loop.baseURL}/phase/1`);
      await page.getByTestId('parse-warnings-toggle').click();
      await expect(page.getByTestId('parse-warnings-details')).toBeVisible();
      expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);

      await open(page, `${loop.baseURL}/sprint/9.9`);
      await expect(page.getByTestId('not-found')).toBeVisible();
      expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    });
  });
});
