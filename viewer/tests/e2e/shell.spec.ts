/**
 * The shell (design-system.md "Calmer layout", "Loading", "Connection
 * lost"): one layout, the list view; the top bar (wordmark, project name,
 * gear, nothing else); the routes and their redirects; warnings for files no
 * phase owns; the loading block; the theme choice; and the connection-lost
 * banner.
 *
 * - The loading and theme tests use the shared `webServer` (the retry script
 *   playing on `trail-log`).
 * - The layout, routes, top bar and warnings tests use a dev loop of their
 *   own on a still copy of `trail-log` (no script plays, so the phase `/`
 *   shows is fixed) in a folder with a long name, plus a run log for a phase
 *   that has no plan, holding lines that can't be read (ports 4850 / 4851).
 * - The phase sidebar and the phone switcher (Sprint 9.2) use a dev loop on
 *   a still copy of `multi-phase` with phase 1 retitled long enough to wrap
 *   (ports 4852 / 4853): phase 1 complete, phase 2 with a blocked task,
 *   phase 3 not started.
 * - The connection test needs a server that stops and returns, so it starts
 *   its own dev loop on ports 4798 / 4799.
 */
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { impliedPhase } from '../../src/client/list/derive.js';
import { loadProject } from '../../src/core/load.js';
import type { Project } from '../../src/core/model.js';
import { startHarness, type Harness } from './harness.js';

/*
 * The callbacks passed to `page.evaluate` run in the browser, but this file
 * is type-checked with the root tsconfig (Node, no DOM lib), so they reach
 * the page's globals through `globalThis` with just the shapes they use.
 */
interface PageGlobals {
  document: { documentElement: { scrollWidth: number; clientWidth: number } };
  localStorage: { getItem(key: string): string | null };
}

/** How far the page scrolls sideways (0 or less means no horizontal scroll). */
async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(() => {
    const root = (globalThis as unknown as PageGlobals).document.documentElement;
    return root.scrollWidth - root.clientWidth;
  });
}

/** Open a route and wait for the first snapshot. */
async function open(page: Page, url: string): Promise<void> {
  await page.goto(url);
  await expect(page.locator('.app')).toHaveAttribute('data-connection', 'live');
}

/** The phase the trail-log fixture's newest run-log events belong to. */
const ACTIVE_PHASE = 'Phase 2: Trip Journal';

/** A project folder name too long for the top bar at 375 px. */
const LONG_NAME = 'trail-log-with-a-project-folder-name-long-enough-to-need-an-ellipsis';

/** The run log for a phase with no plan: two lines that can't be read. */
const ORPHAN_LOG = 'docs/phases/.runs/phase-9.jsonl';

const TRAIL_LOG = fileURLToPath(new URL('../../test/fixtures/trail-log', import.meta.url));
const MULTI_PHASE = fileURLToPath(new URL('../../test/fixtures/multi-phase', import.meta.url));

// ---------------------------------------------------------------------------
// Loading and theme (the shared webServer)
// ---------------------------------------------------------------------------

test.describe('loading', () => {
  test('the loading block shows under the top bar until the first snapshot arrives', async ({ page }) => {
    // Refuse the event stream so no snapshot can arrive.
    await page.route('**/api/events', (route) => route.abort());
    await page.goto('/');

    const loading = page.getByTestId('loading');
    await expect(loading).toBeVisible();
    await expect(loading).toHaveAttribute('role', 'status');
    await expect(loading.locator('h3')).toHaveText('Loading');
    await expect(loading.locator('p')).toHaveText('Reading phase files');
    await expect(page.locator('.app')).toHaveAttribute('data-connection', 'connecting');
    // The shell is up around it; nothing else claims the page yet, and no project name shows.
    const head = await page.locator('.app-head').boundingBox();
    const shown = await loading.boundingBox();
    expect(head && shown && shown.y >= head.y + head.height).toBe(true);
    await expect(page.getByTestId('project-name')).toHaveCount(0);
    // Never connected, so nothing says the connection was lost.
    await expect(page.getByTestId('connection-lost')).toHaveCount(0);
    await expect(page.getByTestId('list-view')).toHaveCount(0);

    // Let the stream through: the next reconnect brings the snapshot and the list view replaces the block.
    await page.unroute('**/api/events');
    await expect(page.getByTestId('list-view')).toBeVisible({ timeout: 15_000 });
    await expect(loading).toHaveCount(0);
    await expect(page.locator('.app')).toHaveAttribute('data-connection', 'live');
    await expect(page.getByTestId('project-name')).toBeVisible();
  });
});

test.describe('theme', () => {
  test('the settings gear picks Light, Dark or System, and the choice is remembered', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto('/');
    const html = page.locator('html');
    await expect(html).toHaveAttribute('data-theme', 'dark');

    const gear = page.locator('.app-head').getByRole('button', { name: 'Settings' });
    await expect(gear).toHaveAttribute('aria-expanded', 'false');
    await gear.click();
    await expect(gear).toHaveAttribute('aria-expanded', 'true');
    const menu = page.getByTestId('settings-menu');
    const theme = menu.getByRole('group', { name: 'Theme' });
    await expect(theme.getByRole('button', { name: 'System' })).toHaveAttribute('aria-pressed', 'true');

    // Light applies at once and the menu stays open.
    await theme.getByRole('button', { name: 'Light' }).click();
    await expect(html).toHaveAttribute('data-theme', 'light');
    await expect(theme.getByRole('button', { name: 'Light' })).toHaveAttribute('aria-pressed', 'true');
    await expect(menu).toBeVisible();

    // Escape closes it and puts focus back on the gear.
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    await expect(gear).toBeFocused();

    // Remembered across a reload, over the OS setting.
    await page.reload();
    await expect(html).toHaveAttribute('data-theme', 'light');

    // System follows the OS again, including when it changes.
    await gear.click();
    await theme.getByRole('button', { name: 'System' }).click();
    await expect(html).toHaveAttribute('data-theme', 'dark');
    await page.emulateMedia({ colorScheme: 'light' });
    await expect(html).toHaveAttribute('data-theme', 'light');

    // A click outside closes the menu.
    await page.getByTestId('list-main').click({ position: { x: 5, y: 5 } });
    await expect(menu).toHaveCount(0);
  });
});

// ---------------------------------------------------------------------------
// One layout, the top bar, routes and warnings (a still copy of trail-log)
// ---------------------------------------------------------------------------

test.describe('a still trail-log in a long-named folder', () => {
  let loop: Harness;
  let project: Project;
  let source: string;

  test.beforeAll(async () => {
    test.setTimeout(60_000);
    // The copy's folder is named after `source`, so the project name is LONG_NAME.
    source = await mkdtemp(path.join(os.tmpdir(), 'phase-viewer-shell-'));
    const named = path.join(source, LONG_NAME);
    await cp(TRAIL_LOG, named, { recursive: true });
    await writeFile(path.join(named, ORPHAN_LOG), 'not json at all\n{"v":1,"ts":\n', 'utf8');
    loop = await startHarness({ clientPort: 4850, serverPort: 4851, source: named, freshness: 'as-is' });
    project = await loadProject(loop.fixture.root);
  });

  test.afterAll(async () => {
    await loop?.close();
    if (source) await rm(source, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  test.describe('1280 px', () => {
    test.use({ viewport: { width: 1280, height: 900 } });

    test('/ shows the list view on the default phase; no kanban, toggle or filters anywhere', async ({ page }) => {
      const implied = impliedPhase(project);
      expect(implied).not.toBeNull();
      const n = String(implied);

      await open(page, `${loop.baseURL}/`);
      await expect(page).toHaveURL(`${loop.baseURL}/`);
      await expect(page.getByTestId('list-view')).toBeVisible();
      await expect(page.locator('a[data-phase-item][aria-current="page"]')).toHaveAttribute('data-phase-item', n);
      await expect(page.getByTestId('list-main').getByTestId('phase-rail')).toHaveAttribute('data-phase', n);
      const phase = project.phases.find((p) => p.number === implied)!;
      await expect(page).toHaveTitle(new RegExp(`^Phase ${n}: ${phase.title} · ${LONG_NAME}$`));

      // One layout: no kanban, slide-in panel, layout toggle or filter row.
      await expect(page.getByTestId('kanban')).toHaveCount(0);
      await expect(page.getByTestId('slide-panel')).toHaveCount(0);
      await expect(page.getByRole('group', { name: 'Layout' })).toHaveCount(0);
      await expect(page.getByTestId('filter-row')).toHaveCount(0);
      await expect(page.locator('button[data-filter]')).toHaveCount(0);
      // Nothing remembered about a layout.
      expect(await page.evaluate(() => (globalThis as unknown as PageGlobals).localStorage.getItem('phase-viewer:view'))).toBeNull();

      // A phase row selects that phase at /phase/N, without a page load.
      await page.locator('a[data-phase-item="1"]').click();
      await expect(page).toHaveURL(`${loop.baseURL}/phase/1`);
      await expect(page.getByTestId('list-main').getByTestId('phase-rail')).toHaveAttribute('data-phase', '1');
      await expect(page.locator('a[data-phase-item][aria-current="page"]')).toHaveAttribute('data-phase-item', '1');
    });

    test('the top bar is the wordmark, the project name and the gear, with nothing under it but the page', async ({ page }) => {
      await page.emulateMedia({ colorScheme: 'dark' });
      await open(page, `${loop.baseURL}/phase/2`);
      const head = page.locator('header.app-head');
      await expect(head).toHaveCSS('height', '56px');

      // The wordmark: 20px tall, no glow (in dark, where the glow used to be).
      const wm = head.locator('svg.wm');
      await expect(wm).toHaveCSS('height', '20px');
      await expect(wm).toHaveCSS('filter', 'none');

      // The project name: the folder's name, the full path as its tooltip only.
      const name = head.getByTestId('project-name');
      await expect(name).toHaveText(LONG_NAME);
      await expect(name).toHaveAttribute('title', loop.fixture.root);
      await expect(page).toHaveTitle(new RegExp(` · ${LONG_NAME}$`));
      await expect(name).toHaveCSS('font-size', '13px');
      await expect(name).toHaveCSS('font-weight', '500');
      await expect(name).toHaveCSS('text-overflow', 'ellipsis');
      expect((await name.boundingBox())!.width).toBeLessThanOrEqual(280);

      // Then the gear, 12px to its right; nothing else in the bar.
      const gear = head.getByRole('button', { name: 'Settings' });
      const nameBox = (await name.boundingBox())!;
      const gearBox = (await gear.boundingBox())!;
      expect(Math.round(gearBox.x - (nameBox.x + nameBox.width))).toBe(12);
      await expect(head.locator('button')).toHaveCount(1);
      await expect(head.locator('a, nav, [role="group"]')).toHaveCount(0);

      // Under the bar, the page itself.
      const headBox = (await head.boundingBox())!;
      const layout = (await page.getByTestId('list-view').boundingBox())!;
      expect(Math.round(layout.y)).toBe(Math.round(headBox.y + headBox.height));
    });

    test('old addresses land on their list routes', async ({ page }) => {
      const cases: Array<[from: string, to: string]> = [
        ['/list', '/'],
        ['/list?show=progress', '/'],
        ['/?show=complete', '/'],
        ['/overview', '/'],
        ['/?phase=8', '/phase/8'],
        ['/?phase=2', '/phase/2'],
        ['/list?phase=3&show=complete', '/phase/3'],
        ['/live?phase=1', '/phase/1'],
        ['/live', `/phase/${impliedPhase(project)}`],
      ];
      for (const [from, to] of cases) {
        await open(page, `${loop.baseURL}${from}`);
        await expect(page, `${from} → ${to}`).toHaveURL(`${loop.baseURL}${to}`);
        await expect(page.getByTestId('list-view')).toBeVisible();
      }

      // /?phase=8: Phase 8 isn't in the plans, so its page says so, inside the shell.
      await open(page, `${loop.baseURL}/?phase=8`);
      await expect(page.getByTestId('not-found')).toHaveAttribute('data-kind', 'phase');
      await expect(page.getByTestId('not-found').locator('h3')).toHaveText('Phase 8 not found');
      await expect(page.getByTestId('not-found-overview')).toHaveAttribute('href', '/');

      // /?phase=2 shows Phase 2.
      await open(page, `${loop.baseURL}/?phase=2`);
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(ACTIVE_PHASE);

      // A sprint lands on its phase with its card open; a hash survives the /list redirect.
      for (const from of ['/sprint/2.3', '/list?phase=2#s2.3']) {
        await open(page, `${loop.baseURL}${from}`);
        await expect(page).toHaveURL(`${loop.baseURL}/phase/2#s2.3`);
        await expect(page.locator('article[data-sprint-card="2.3"]')).toHaveAttribute('data-open', 'true');
      }
    });

    test('a run log no phase owns shows its warning on every phase page', async ({ page }) => {
      const orphan = project.warnings.filter((w) => w.file.replace(/\\/g, '/').endsWith(ORPHAN_LOG));
      expect(orphan.length).toBeGreaterThan(0);
      const lines = new Set(orphan.map((w) => w.line)).size;

      for (const n of project.phases.map((p) => p.number)) {
        await open(page, `${loop.baseURL}/phase/${n}`);
        const rail = page.getByTestId('list-main').getByTestId('phase-rail');
        await expect(rail).toHaveAttribute('data-phase', String(n));
        const banner = rail.locator(`[data-testid="parse-warnings"][data-file="${ORPHAN_LOG}"]`);
        await expect(banner).toHaveCount(1);
        await expect(banner.locator('strong')).toHaveText(`${lines} lines in phase-9.jsonl couldn't be read`);
      }

      // Show details lists its lines.
      const banner = page.locator(`[data-testid="parse-warnings"][data-file="${ORPHAN_LOG}"]`);
      await banner.getByTestId('parse-warnings-toggle').click();
      await expect(banner.getByTestId('parse-warning')).toHaveCount(orphan.length);
    });
  });

  test.describe('375 px', () => {
    test.use({ viewport: { width: 375, height: 812 } });

    test('a long project name ends in an ellipsis and keeps the gear on screen', async ({ page }) => {
      await open(page, `${loop.baseURL}/phase/2`);
      const head = page.locator('header.app-head');
      await expect(head).toHaveCSS('height', '52px');
      await expect(head).toHaveCSS('padding-left', '16px');
      await expect(head.locator('svg.wm')).toHaveCSS('height', '16px');

      const name = head.getByTestId('project-name');
      await expect(name).toBeVisible();
      await expect(name).toHaveText(LONG_NAME);
      // Cut short with an ellipsis: the text is wider than the box it shows in.
      expect(
        await name.evaluate((el) => {
          const box = el as unknown as { scrollWidth: number; clientWidth: number };
          return box.scrollWidth > box.clientWidth;
        }),
      ).toBe(true);
      await expect(name).toHaveCSS('text-overflow', 'ellipsis');

      // The wordmark, the name and the gear side by side, the gear inside the 16px gutter, 8px after the name.
      const wmBox = (await head.locator('svg.wm').boundingBox())!;
      const nameBox = (await name.boundingBox())!;
      const gearBox = (await head.getByRole('button', { name: 'Settings' }).boundingBox())!;
      expect(nameBox.x).toBeGreaterThanOrEqual(wmBox.x + wmBox.width);
      expect(Math.round(gearBox.x - (nameBox.x + nameBox.width))).toBe(8);
      expect(gearBox.x + gearBox.width).toBeLessThanOrEqual(375 - 16 + 0.5);
      expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    });
  });
});

// ---------------------------------------------------------------------------
// Phase sidebar and phone switcher (a still multi-phase copy, phase 1 retitled)
// ---------------------------------------------------------------------------

/** Phase 1's title in the copy: long enough to wrap in the 232px sidebar. */
const LONG_TITLE = 'Overview, Sprint Detail and States';

/** Dark theme colours the checks read (design-system.md "Viewer tokens"). */
const TEXT_3 = 'rgb(138, 131, 122)';
const PASSED = 'rgb(76, 212, 128)';

/** The phase row for phase n inside `scope` (the sidebar or the sheet). */
function phaseItem(scope: Locator, n: number): Locator {
  return scope.locator(`a[data-phase-item="${n}"]`);
}

/** How many elements in `list` are cut off (their text is wider or taller than their box). */
async function clipped(list: Locator): Promise<number> {
  return list.evaluateAll(
    (els) =>
      els.filter((el) => {
        const box = el as unknown as { scrollWidth: number; clientWidth: number; scrollHeight: number; clientHeight: number };
        return box.scrollWidth > box.clientWidth || box.scrollHeight > box.clientHeight;
      }).length,
  );
}

test.describe('phase sidebar and switcher', () => {
  let loop: Harness;
  let source: string;

  test.beforeAll(async () => {
    test.setTimeout(60_000);
    source = await mkdtemp(path.join(os.tmpdir(), 'phase-viewer-side-'));
    const named = path.join(source, 'multi-phase');
    await cp(MULTI_PHASE, named, { recursive: true });
    const file = path.join(named, 'docs/phases/Phase-1-Foundations.md');
    const text = await readFile(file, 'utf8');
    await writeFile(file, text.replace('# Phase 1 — Foundations', `# Phase 1 — ${LONG_TITLE}`), 'utf8');
    loop = await startHarness({ clientPort: 4852, serverPort: 4853, source: named, freshness: 'as-is' });
  });

  test.afterAll(async () => {
    await loop?.close();
    if (source) await rm(source, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  test.beforeEach(async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
  });

  test.describe('1280 px', () => {
    test.use({ viewport: { width: 1280, height: 900 } });

    test('the sidebar: heading line, one row per phase with its end item, the selected row marked', async ({ page }) => {
      await open(page, `${loop.baseURL}/phase/2`);
      const side = page.getByTestId('phase-sidebar');
      await expect(side).toBeVisible();
      await expect(side).toHaveCSS('position', 'sticky');
      await expect(side).toHaveCSS('overflow-y', 'auto');
      const sideBox = (await side.boundingBox())!;
      expect(Math.round(sideBox.width)).toBe(264);
      expect(Math.round(sideBox.y)).toBe(56);
      expect(Math.round(sideBox.height)).toBe(900 - 56);

      await expect(side.locator('.side-h b')).toHaveText('Phases');
      await expect(side.getByTestId('phases-complete')).toHaveText('1 of 3 complete');
      await expect(side.locator('a[data-phase-item]')).toHaveCount(3);

      // Phase 1, complete: a quiet grey check and no bar.
      const p1 = phaseItem(side, 1);
      await expect(p1).toHaveAttribute('data-group', 'complete');
      await expect(p1).toHaveAccessibleName(`Phase 1: ${LONG_TITLE}, Complete`);
      await expect(p1.locator('.ph-n')).toHaveText('1');
      await expect(p1.locator('[data-end]')).toHaveAttribute('data-end', 'pass');
      await expect(p1.locator('svg.i.pass')).toHaveCSS('color', TEXT_3);
      await expect(p1.locator('.seg-bar')).toHaveCount(0);
      await expect(p1).not.toHaveAttribute('aria-current');

      // Phase 2, a blocked task: the needs icon and a 4px bar; selected, with the amber inset.
      const p2 = phaseItem(side, 2);
      await expect(p2).toHaveAttribute('data-group', 'progress');
      await expect(p2).toHaveAccessibleName('Phase 2: Library UI, Needs you');
      await expect(p2.locator('[data-end]')).toHaveAttribute('data-end', 'needs');
      await expect(p2.locator('svg.i.needs')).toHaveCount(1);
      await expect(p2.locator('.seg-bar')).toHaveCSS('height', '4px');
      await expect(p2).toHaveAttribute('aria-current', 'page');
      await expect(p2).toHaveCSS('box-shadow', 'rgb(255, 176, 0) 2px 0px 0px 0px inset');

      // Phase 3, not started: the count and no bar.
      const p3 = phaseItem(side, 3);
      await expect(p3).toHaveAttribute('data-group', 'future');
      await expect(p3.locator('[data-end]')).toHaveAttribute('data-end', 'count');
      await expect(p3.locator('[data-end]')).toHaveText('0/5');
      await expect(p3.locator('.seg-bar')).toHaveCount(0);

      // Every title shows in full, and no switcher at this width.
      await expect(side.locator('.ph-t')).toHaveText([LONG_TITLE, 'Library UI', 'Sharing']);
      expect(await clipped(side.locator('.ph-t'))).toBe(0);
      await expect(page.getByTestId('phase-switcher')).toBeHidden();

      // A row selects its phase.
      await p3.click();
      await expect(page).toHaveURL(`${loop.baseURL}/phase/3`);
      await expect(page.getByTestId('list-main').getByTestId('phase-rail')).toHaveAttribute('data-phase', '3');
      await expect(p3).toHaveAttribute('aria-current', 'page');
      await expect(p2).not.toHaveAttribute('aria-current');
    });
  });

  test.describe('768 px', () => {
    test.use({ viewport: { width: 768, height: 900 } });

    test('a long title wraps onto two lines in the 232px sidebar and shows in full', async ({ page }) => {
      await open(page, `${loop.baseURL}/phase/1`);
      const side = page.getByTestId('phase-sidebar');
      expect(Math.round((await side.boundingBox())!.width)).toBe(232);
      const title = phaseItem(side, 1).locator('.ph-t');
      await expect(title).toHaveText(LONG_TITLE);
      await expect(title).toHaveCSS('line-height', '21px');
      expect(Math.round((await title.boundingBox())!.height / 21)).toBe(2);
      expect(await clipped(side.locator('.ph-t'))).toBe(0);
      expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    });
  });

  test.describe('375 px', () => {
    test.use({ viewport: { width: 375, height: 812 } });

    test('the switcher names the phase; its sheet lists every phase, and choosing one shows it', async ({ page }) => {
      await open(page, `${loop.baseURL}/phase/2`);
      await expect(page.getByTestId('phase-sidebar')).toBeHidden();

      // The 48px bar under the top bar: "Phase 2", the title, the end item and the chevron.
      const sw = page.getByTestId('phase-switcher');
      await expect(sw).toBeVisible();
      const barBox = (await page.locator('.switch-bar').boundingBox())!;
      expect(Math.round(barBox.y)).toBe(52);
      expect(Math.round(barBox.height)).toBe(48);
      await expect(page.locator('.switch-bar')).toHaveCSS('position', 'sticky');
      await expect(sw.locator('.n')).toHaveText('Phase 2');
      await expect(sw.locator('.t')).toHaveText('Library UI');
      await expect(sw.locator('[data-end]')).toHaveAttribute('data-end', 'needs');
      await expect(sw.locator('svg.chev')).toHaveCount(1);
      await expect(sw).toHaveAttribute('aria-expanded', 'false');

      // Closed: no sheet and no rows in it.
      const sheet = page.getByTestId('phase-sheet');
      await expect(sheet).toBeHidden();
      await expect(sheet.locator('a[data-phase-item]')).toHaveCount(0);

      // Open: every phase, the same heading, focus on the selected row, and the page held still.
      await sw.click();
      await expect(sw).toHaveAttribute('aria-expanded', 'true');
      await expect(sw).toHaveAttribute('aria-controls', (await sheet.getAttribute('id'))!);
      await expect(sheet).toBeVisible();
      expect(Math.round((await sheet.boundingBox())!.y)).toBe(100);
      await expect(sheet.getByTestId('phases-complete')).toHaveText('1 of 3 complete');
      await expect(sheet.locator('a[data-phase-item]')).toHaveCount(3);
      await expect(sheet.locator('.ph-t')).toHaveText([LONG_TITLE, 'Library UI', 'Sharing']);
      await expect(sheet.locator('.ph').first()).toHaveCSS('padding-top', '12px');
      await expect(phaseItem(sheet, 2)).toHaveAttribute('aria-current', 'page');
      await expect(phaseItem(sheet, 2)).toBeFocused();
      await expect(page.locator('html')).toHaveCSS('overflow-y', 'hidden');
      expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);

      // Choosing Phase 1 shows it and closes the sheet, focus back on the switcher.
      await phaseItem(sheet, 1).click();
      await expect(page).toHaveURL(`${loop.baseURL}/phase/1`);
      await expect(sheet).toBeHidden();
      await expect(sw).toHaveAttribute('aria-expanded', 'false');
      await expect(sw).toBeFocused();
      await expect(page.getByTestId('list-main').getByTestId('phase-rail')).toHaveAttribute('data-phase', '1');
      await expect(sw.locator('.n')).toHaveText('Phase 1');
      await expect(sw.locator('.t')).toHaveText(LONG_TITLE);
      await expect(sw.locator('.t')).toHaveCSS('text-overflow', 'ellipsis');
      // In the switcher a complete phase's check is green.
      await expect(sw.locator('svg.i.pass')).toHaveCSS('color', PASSED);
      await expect(page.locator('html')).not.toHaveCSS('overflow-y', 'hidden');
    });

    test('Escape, the scrim and the switcher each close the sheet, returning focus to the switcher', async ({ page }) => {
      await open(page, `${loop.baseURL}/phase/2`);
      const sw = page.getByTestId('phase-switcher');
      const sheet = page.getByTestId('phase-sheet');

      // Escape.
      await sw.click();
      await expect(phaseItem(sheet, 2)).toBeFocused();
      await page.keyboard.press('Escape');
      await expect(sheet).toBeHidden();
      await expect(sw).toHaveAttribute('aria-expanded', 'false');
      await expect(sw).toBeFocused();

      // From the keyboard: Enter opens it with focus on the selected row.
      await page.keyboard.press('Enter');
      await expect(sheet).toBeVisible();
      await expect(phaseItem(sheet, 2)).toBeFocused();

      // The scrim (below the panel).
      await page.mouse.click(187, 812 - 24);
      await expect(sheet).toBeHidden();
      await expect(sw).toBeFocused();
      await expect(page).toHaveURL(`${loop.baseURL}/phase/2`);

      // The switcher itself.
      await sw.click();
      await expect(sheet).toBeVisible();
      await sw.click();
      await expect(sheet).toBeHidden();
      await expect(sw).toHaveAttribute('aria-expanded', 'false');
      await expect(sw).toBeFocused();
    });
  });

  test('no sideways strip and no horizontal page scroll at 375 and 719 px, sheet open or closed', async ({ page }) => {
    for (const width of [375, 719]) {
      await page.setViewportSize({ width, height: 800 });
      await open(page, `${loop.baseURL}/phase/2`);
      await expect(page.getByTestId('phase-sidebar'), `${width}px`).toBeHidden();
      await expect(page.getByTestId('phase-switcher'), `${width}px`).toBeVisible();
      expect(await horizontalOverflow(page), `${width}px`).toBeLessThanOrEqual(0);
      await page.getByTestId('phase-switcher').click();
      await expect(page.getByTestId('phase-sheet')).toBeVisible();
      expect(await horizontalOverflow(page), `${width}px, sheet open`).toBeLessThanOrEqual(0);
      await page.keyboard.press('Escape');
    }
  });
});

// ---------------------------------------------------------------------------
// Connection lost (a server that stops and returns)
// ---------------------------------------------------------------------------

test.describe('connection lost', () => {
  test('the banner shows only while the server is down and the last view stays', async ({ page }) => {
    test.setTimeout(90_000);
    const harness = await startHarness({ clientPort: 4798, serverPort: 4799, freshness: 'fresh' });
    try {
      await page.goto(`${harness.baseURL}/phase/2`);
      await expect(page.locator('.app')).toHaveAttribute('data-connection', 'live');
      const rail = page.getByTestId('list-main').getByTestId('phase-rail');
      await expect(rail).toHaveAttribute('data-phase', '2');
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(ACTIVE_PHASE);
      const cards = page.locator('article[data-sprint-card]');
      await expect(cards).toHaveCount(4);

      // Connected: nothing connection-related on screen.
      const banner = page.getByTestId('connection-lost');
      await expect(banner).toHaveCount(0);
      await expect(page.getByText(/connection|reconnect/i)).toHaveCount(0);

      await harness.stopServer();
      await expect(banner).toBeVisible({ timeout: 15_000 });
      await expect(banner).toContainText('Lost connection to the viewer server.');
      await expect(banner).toContainText(/Showing the last update from \d{1,2}:\d{2} (AM|PM)\./);
      await expect(page.locator('.app')).toHaveAttribute('data-connection', 'reconnecting');
      // The last snapshot stays on screen, the banner under the top bar.
      await expect(rail).toHaveAttribute('data-phase', '2');
      await expect(cards).toHaveCount(4);
      const head = await page.locator('.app-head').boundingBox();
      const shown = await banner.boundingBox();
      expect(head && shown && shown.y >= head.y + head.height).toBe(true);

      await harness.startServer();
      await expect(banner).toHaveCount(0, { timeout: 30_000 });
      await expect(page.locator('.app')).toHaveAttribute('data-connection', 'live');
      await expect(rail).toHaveAttribute('data-phase', '2');
    } finally {
      await harness.close();
    }
  });
});
