/**
 * The unified shell (Sprint 7.3): the phase kanban at `/` (three lanes: Not
 * started, In progress, Complete), the slide-in panel, the list view at
 * `/list` and its filter row, the List | Kanban toggle, and the old routes'
 * redirects. Every test starts with the kanban as the last layout used, so
 * a bare `/` opens it.
 *
 * - The `multi-phase` fixture (as-is timestamps): phase 1 complete, phase 2
 *   in progress with a blocked task (Needs you), phase 3 not started (no run
 *   log). Expected counts, groups and tile states are derived in the test
 *   from the same fixture with the same pure functions the client uses.
 * - A `trail-log` copy with phase 2's title made long enough to wrap, one
 *   task of a finished sprint set back to not started (the amber Waiting
 *   tile), and an `implement` `start` marker appended (a running card and
 *   an Implementing tile).
 * - A `multi-phase` copy edited while the page is open: counts, tiles, the
 *   lanes and warning tags follow within 2 s, without a reload.
 *
 * Overview's checks (Sprint 7.4) moved here: hand-counted done / eligible
 * per phase with cut and deferred left out, status bar segments sized by
 * the model, and following phase file edits.
 *
 * Ports: 4850–4855 (see `harness.ts`).
 */
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { formatTs } from '../../scripts/simulate-run.js';
import { impliedPhase } from '../../src/client/board/derive.js';
import { notStartedTasks } from '../../src/client/data/status.js';
import { PHASE_FILTERS, phaseGroup, phaseGroupCounts, sprintCardState } from '../../src/client/rail/derive.js';
import { loadProject } from '../../src/core/load.js';
import type { Project } from '../../src/core/model.js';
import { startHarness, startOnKanban, type Harness } from './harness.js';

/*
 * The callbacks passed to `page.evaluate` run in the browser, but this file
 * is type-checked with the root tsconfig (Node, no DOM lib), so they reach
 * the page's globals through `globalThis` with just the shapes they use.
 */

interface PageDocument {
  document: {
    documentElement: { scrollWidth: number; clientWidth: number };
    activeElement: unknown;
    querySelector(selector: string): { contains(node: unknown): boolean } | null;
  };
  getComputedStyle(el: unknown): { animationName: string; boxShadow: string };
}

/** How far the page scrolls sideways (0 or less means no horizontal scroll). */
async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(() => {
    const root = (globalThis as unknown as PageDocument).document.documentElement;
    return root.scrollWidth - root.clientWidth;
  });
}

/** How far the kanban board scrolls sideways inside itself (0 or less means it doesn't). */
async function boardOverflow(page: Page): Promise<number> {
  return page.getByTestId('kan-board').evaluate((el) => {
    const board = el as unknown as { scrollWidth: number; clientWidth: number };
    return board.scrollWidth - board.clientWidth;
  });
}

/** Whether focus is inside the slide-in panel. */
async function focusInPanel(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const { document } = globalThis as unknown as PageDocument;
    return document.querySelector('[data-testid="slide-panel"]')?.contains(document.activeElement) ?? false;
  });
}

async function animationName(locator: Locator): Promise<string> {
  return locator.evaluate((el) => (globalThis as unknown as PageDocument).getComputedStyle(el).animationName);
}

/** Open a route and wait for the first snapshot. */
async function open(page: Page, url: string): Promise<void> {
  await page.goto(url);
  await expect(page.locator('.app')).toHaveAttribute('data-connection', 'live');
}

/** An attribute of every match, in order. */
async function attrs(list: Locator, name: string): Promise<(string | null)[]> {
  return list.evaluateAll(
    (els, attr) => els.map((el) => (el as unknown as { getAttribute(n: string): string | null }).getAttribute(attr)),
    name,
  );
}

/** `--manual` as computed, in either theme (dark `#a78bfa`, light `#6d28d9`). */
const MANUAL_RGB = /^rgb\((167, 139, 250|109, 40, 217)\)$/;

/** Lanes, left to right. */
const LANES = ['future', 'progress', 'complete'] as const;

function lane(page: Page, group: (typeof LANES)[number]): Locator {
  return page.locator(`section[data-lane="${group}"]`);
}

/** A phase's card (the hook is from when each phase was a column). */
function column(page: Page, n: number): Locator {
  return page.locator(`a[data-kan-col="${n}"]`);
}

function tile(page: Page, id: string): Locator {
  return page.locator(`li[data-tile="${id}"]`);
}

function panel(page: Page): Locator {
  return page.getByTestId('slide-panel');
}

function filter(page: Page, key: string): Locator {
  return page.locator(`button[data-filter="${key}"]`);
}

function toggle(page: Page, name: 'Kanban' | 'List'): Locator {
  return page.getByRole('group', { name: 'Layout' }).getByRole('button', { name });
}

/** "6/6 tasks": done over eligible, as the card and panel heading write it. */
function countText(project: Project, n: number): string {
  const p = project.progress.byPhase[String(n)];
  const eligible = p?.eligible ?? 0;
  return `${p?.done ?? 0}/${eligible} ${eligible === 1 ? 'task' : 'tasks'}`;
}

/**
 * The `multi-phase` fixture by hand (`test/fixtures/multi-phase/docs/phases/`):
 *
 * - Phase 1: 1.1 (3 x) and 1.2 (3 x): 6/6.
 * - Phase 2: 2.1 (x, ~, BLOCKED, —), 2.2 (—, —, CUT), 2.3 (—, —, DEFERRED):
 *   10 tasks, 8 eligible, 1 done.
 * - Phase 3: 3.1 (—, —, DEFERRED), 3.2 (—, —, MANUAL): 6 tasks, 5 eligible, 0 done.
 */
const MULTI_PHASE = [
  { phase: 1, total: 6, done: 6, eligible: 6, count: '6/6 tasks' },
  { phase: 2, total: 10, done: 1, eligible: 8, count: '1/8 tasks' },
  { phase: 3, total: 6, done: 0, eligible: 5, count: '0/5 tasks' },
] as const;

/** The window property that survives in-app navigation and is cleared by a full page load. */
interface Marked {
  __boardMarker?: string;
}

/** Tag the window so a full page load (which would clear it) can be detected. */
async function markWindow(page: Page): Promise<void> {
  await page.evaluate(() => {
    (globalThis as unknown as Marked).__boardMarker = 'still here';
  });
}

async function windowMarker(page: Page): Promise<string | undefined> {
  return page.evaluate(() => (globalThis as unknown as Marked).__boardMarker);
}

/** Warnings the model has on one phase's file and its run log. */
function warningsFor(project: Project, phaseFile: string): number {
  const phase = project.phases.find((p) => path.resolve(p.file) === path.resolve(phaseFile));
  const runFile = phase ? project.runs.find((r) => r.phase === phase.number)?.file : undefined;
  const files = new Set([phaseFile, ...(runFile ? [runFile] : [])].map((f) => path.resolve(f)));
  return project.warnings.filter((w) => files.has(path.resolve(w.file))).length;
}

/** Replace the one line matching `pattern` in a file of the copy. */
async function editLine(file: string, pattern: RegExp, replacement: string): Promise<void> {
  const text = await readFile(file, 'utf8');
  const matches = text.match(new RegExp(pattern.source, 'g')) ?? [];
  if (matches.length !== 1) throw new Error(`${pattern} matched ${matches.length} times in ${file}`);
  await writeFile(file, text.replace(pattern, replacement), 'utf8');
}

// A first visit to `/` opens the list view (`shell.spec.ts`); these tests are about the kanban.
test.beforeEach(async ({ page }) => {
  await startOnKanban(page);
});

// ---------------------------------------------------------------------------
// multi-phase
// ---------------------------------------------------------------------------

test.describe('multi-phase fixture', () => {
  let loop: Harness;
  let project: Project;

  test.beforeAll(async () => {
    loop = await startHarness({ clientPort: 4850, serverPort: 4851, fixture: 'multi-phase', freshness: 'as-is' });
    project = await loadProject(loop.fixture.root);
  });
  test.afterAll(async () => {
    await loop?.close();
  });

  test.use({ viewport: { width: 1280, height: 900 } });

  test('/ shows three lanes, each phase a card in its lane with its count, status bar and sprint tiles', async ({ page }) => {
    await open(page, `${loop.baseURL}/`);
    await expect(page).toHaveURL(`${loop.baseURL}/`);

    // Top bar: the wordmark and the settings gear, nothing else.
    await expect(page.locator('.app-head').getByRole('img', { name: 'Phase Runner' })).toBeVisible();
    await expect(page.locator('.app-head a, .app-head nav')).toHaveCount(0);
    await expect(page.locator('.app-head button')).toHaveCount(1);
    await expect(page.locator('.app-head button')).toHaveAccessibleName('Settings');

    // Three lanes, left to right, each with its group's phases in phase order and their count.
    const lanes = page.locator('section[data-lane]');
    expect(await attrs(lanes, 'data-lane')).toEqual([...LANES]);
    await expect(lanes.getByRole('heading', { level: 2 })).toHaveText([/^Not started/, /^In progress/, /^Complete/]);
    for (const group of LANES) {
      const want = project.phases.filter((p) => phaseGroup(project, p) === group).map((p) => String(p.number));
      expect(await attrs(lane(page, group).locator('a[data-kan-col]'), 'data-kan-col')).toEqual(want);
      await expect(lane(page, group).getByTestId('lane-count')).toHaveText(String(want.length));
    }
    await expect(page.locator('a[data-kan-col]')).toHaveCount(project.phases.length);
    // The lanes are the groups: no filters here.
    await expect(page.locator('button[data-filter]')).toHaveCount(0);

    for (const phase of project.phases) {
      const col = column(page, phase.number);
      await expect(col).toHaveAccessibleName(`Phase ${phase.number}: ${phase.title}`);
      await expect(col.locator('.num')).toHaveText(`Phase ${phase.number}`);
      await expect(col.getByTestId('kan-count')).toHaveText(countText(project, phase.number));
      await expect(col.getByTestId('kan-title')).toHaveText(phase.title);
      await expect(col).toHaveAttribute('data-group', phaseGroup(project, phase));
      // One tile per sprint, in plan order, with the rail's card state.
      expect(await attrs(col.locator('li[data-tile]'), 'data-tile')).toEqual(phase.sprints.map((s) => s.id));
      for (const sprint of phase.sprints) {
        await expect(tile(page, sprint.id)).toHaveAttribute('data-state', sprintCardState(project, sprint));
      }
    }

    // Complete: the pass icon, with the state word for screen readers.
    await expect(tile(page, '1.1').locator('svg.i.pass')).toHaveCount(1);
    await expect(tile(page, '1.1').locator('.visually-hidden')).toHaveText(', Complete');
    // Needs you: pink border and the needs icon. Pink is never a whole card.
    await expect(tile(page, '2.1')).toHaveClass(/\bneeds\b/);
    await expect(tile(page, '2.1').locator('svg.i.needs')).toHaveCount(1);
    await expect(column(page, 2)).not.toHaveClass(/needs/);
    // Not started: dashed tile with the grey dot; a not-started phase's card is dashed.
    await expect(tile(page, '3.1')).toHaveClass(/\bfuture\b/);
    await expect(tile(page, '3.1').locator('svg.i.wait')).toHaveCount(1);
    await expect(column(page, 3)).toHaveClass(/\bfuture\b/);
    await expect(column(page, 3)).toHaveCSS('border-top-style', 'dashed');
    // Nothing is running here.
    await expect(page.locator('a[data-kan-col].running')).toHaveCount(0);

    // Lanes are equal width, side by side, and fit: nothing to scroll to.
    const boxes = await Promise.all((await lanes.all()).map(async (l) => (await l.boundingBox())!));
    for (const box of boxes) expect(Math.abs(box.width - boxes[0]!.width)).toBeLessThan(1);
    expect(boxes[0]!.x).toBeLessThan(boxes[1]!.x);
    expect(boxes[1]!.x).toBeLessThan(boxes[2]!.x);
    expect(await boardOverflow(page)).toBeLessThanOrEqual(0);

    await expect(page).toHaveTitle(/^Phases · /);
  });

  // Moved from Overview (Sprint 7.4): numbers written out by hand, so a model change and a rendering bug can't cancel out.
  test('card counts are done over eligible from the model, with cut and deferred left out', async ({ page }) => {
    await open(page, `${loop.baseURL}/`);
    for (const want of MULTI_PHASE) {
      const model = project.progress.byPhase[String(want.phase)]!;
      // The fixture by hand and the model agree...
      expect(model).toMatchObject({ total: want.total, done: want.done, eligible: want.eligible });
      // ...and the denominator leaves out exactly the cut and deferred tasks.
      expect(model.eligible).toBe(model.total - model.byStatus.cut - model.byStatus.deferred);

      const col = column(page, want.phase);
      await expect(col.getByTestId('kan-count')).toHaveText(want.count);
      // Status bar: one segment per status the model counts, sized by that count. To-do and
      // manual tasks in sprints not started are grey: `future` on a started bar, else `todo`.
      const started = model.done + model.byStatus.active > 0;
      const phase = project.phases.find((p) => p.number === want.phase)!;
      const quiet = notStartedTasks(project, phase);
      const qt = Math.min(quiet.todo, model.byStatus.todo);
      const qm = Math.min(quiet.manual, model.byStatus.manual);
      const segments = started
        ? { ...model.byStatus, todo: model.byStatus.todo - qt, manual: model.byStatus.manual - qm, future: qt + qm }
        : { ...model.byStatus, todo: model.byStatus.todo + qm, manual: model.byStatus.manual - qm, future: 0 };
      const counted = Object.entries(segments).filter(([, n]) => n > 0);
      const bar = col.getByTestId('phase-status-bar');
      await expect(bar.locator('i')).toHaveCount(counted.length);
      for (const [status, n] of counted) {
        await expect(bar.locator(`i[data-status="${status}"]`)).toHaveAttribute('style', new RegExp(`flex-grow:\\s*${n}\\b`));
      }
    }
  });

  test('the list view: each filter shows its count and exactly its rows', async ({ page }) => {
    await open(page, `${loop.baseURL}/list`);
    const counts = phaseGroupCounts(project);
    const rows = page.locator('a[data-phase-item]');

    await expect(filter(page, 'all')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('button[data-filter] .filter-label')).toHaveText(PHASE_FILTERS.map((f) => f.label));

    for (const f of PHASE_FILTERS) {
      await expect(filter(page, f.key).getByTestId('filter-count')).toHaveText(String(counts[f.key]));
      await filter(page, f.key).click();
      await expect(filter(page, f.key)).toHaveAttribute('aria-pressed', 'true');
      await expect(page.locator('button[data-filter][aria-pressed="true"]')).toHaveCount(1);
      await expect(page).toHaveURL(f.key === 'all' ? `${loop.baseURL}/list` : `${loop.baseURL}/list?show=${f.key}`);

      const expected = project.phases
        .filter((p) => f.key === 'all' || phaseGroup(project, p) === f.key)
        .map((p) => String(p.number));
      expect(await attrs(rows, 'data-phase-item')).toEqual(expected);
      expect(expected).toHaveLength(counts[f.key]);
    }

    // In progress is exactly the started phases that aren't complete.
    await filter(page, 'progress').click();
    expect(await attrs(rows, 'data-phase-item')).toEqual(['2']);
    // The filter survives a reload.
    await page.reload();
    await expect(filter(page, 'progress')).toHaveAttribute('aria-pressed', 'true');
    await expect(rows).toHaveCount(1);
  });

  test('clicking a card slides its rail in; the back arrow, the scrim and Escape close it', async ({ page }) => {
    await open(page, `${loop.baseURL}/`);

    // Open by click: the panel slides in from the right, over a scrim.
    await column(page, 2).click();
    await expect(page).toHaveURL(`${loop.baseURL}/?phase=2`);
    const dialog = page.getByRole('dialog', { name: 'Phase 2: Library UI' });
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(await animationName(panel(page))).toBe('slide-in');
    await expect(page.getByTestId('scrim')).toBeVisible();
    await expect(panel(page).getByTestId('phase-rail')).toHaveAttribute('data-phase', '2');
    await expect(panel(page).getByRole('heading', { level: 2, name: 'Phase 2: Library UI' })).toBeVisible();
    // Focus moves to the back arrow; the page behind is inert.
    const back = page.getByRole('button', { name: 'Back to phases' });
    await expect(back).toBeFocused();
    await expect(page.getByTestId('kanban')).toHaveAttribute('inert', '');
    await expect(page.getByTestId('filter-row')).toHaveAttribute('inert', '');
    await expect(page).toHaveTitle(/^Phase 2: Library UI · /);
    // 1000px from the right edge, once it has slid in.
    await expect
      .poll(async () => {
        const box = await panel(page).boundingBox();
        return box ? Math.round(box.x + box.width) : null;
      })
      .toBe(1280);
    expect(Math.round((await panel(page).boundingBox())!.width)).toBe(1000);
    await expect(column(page, 2)).toHaveClass(/\bopen\b/);

    // Focus stays in the panel.
    await page.keyboard.press('Shift+Tab');
    expect(await focusInPanel(page)).toBe(true);
    await page.keyboard.press('Tab');
    await expect(back).toBeFocused();

    // Back arrow: closes, focus returns to the card.
    await back.click();
    await expect(panel(page)).toHaveCount(0);
    await expect(page).toHaveURL(`${loop.baseURL}/`);
    await expect(column(page, 2)).toBeFocused();
    await expect(page.getByTestId('kanban')).not.toHaveAttribute('inert', '');

    // Scrim.
    await column(page, 1).click();
    await expect(page.getByRole('dialog', { name: 'Phase 1: Foundations' })).toBeVisible();
    await page.getByTestId('scrim').click({ position: { x: 100, y: 400 } });
    await expect(panel(page)).toHaveCount(0);
    await expect(page).toHaveURL(`${loop.baseURL}/`);
    await expect(column(page, 1)).toBeFocused();

    // Escape.
    await column(page, 3).click();
    await expect(page.getByRole('dialog', { name: 'Phase 3: Sharing' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(panel(page)).toHaveCount(0);
    await expect(page).toHaveURL(`${loop.baseURL}/`);
    await expect(column(page, 3)).toBeFocused();
  });

  test('/?phase=N opens the panel directly; browser Back closes it', async ({ page }) => {
    await open(page, `${loop.baseURL}/?phase=2`);
    await expect(page.getByRole('dialog', { name: 'Phase 2: Library UI' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Back to phases' })).toBeFocused();
    // Closing a panel that was linked to replaces the entry with the board.
    await page.keyboard.press('Escape');
    await expect(panel(page)).toHaveCount(0);
    await expect(page).toHaveURL(`${loop.baseURL}/`);
    await expect(column(page, 2)).toBeFocused();

    // Opened from the board: Back closes it, Forward opens it again.
    await column(page, 1).click();
    await expect(panel(page)).toHaveAttribute('data-phase', '1');
    await page.goBack();
    await expect(panel(page)).toHaveCount(0);
    await expect(page).toHaveURL(`${loop.baseURL}/`);
    await expect(column(page, 1)).toBeFocused();
    await page.goForward();
    await expect(panel(page)).toHaveAttribute('data-phase', '1');
    // Closing it now goes Back too, so history doesn't pile up.
    await page.getByRole('button', { name: 'Back to phases' }).click();
    await expect(panel(page)).toHaveCount(0);
    await expect(page).toHaveURL(`${loop.baseURL}/`);

    // An unknown phase: not found in the panel, the board behind it.
    await open(page, `${loop.baseURL}/?phase=99`);
    await expect(panel(page).getByTestId('not-found')).toHaveAttribute('data-kind', 'phase');
    await expect(page.getByTestId('kanban')).toBeAttached();
  });

  test('reduced motion: the panel appears and goes without sliding', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await open(page, `${loop.baseURL}/`);
    await column(page, 2).click();
    await expect(panel(page)).toBeVisible();
    expect(await animationName(panel(page))).toBe('none');
    await page.keyboard.press('Escape');
    await expect(panel(page)).toHaveCount(0, { timeout: 150 });
  });

  test('the list view selects a phase and shows its rail, without the back arrow', async ({ page }) => {
    await open(page, `${loop.baseURL}/list?phase=2`);
    await expect(page.getByTestId('list-view')).toBeVisible();
    const items = page.locator('a[data-phase-item]');
    expect(await attrs(items, 'data-phase-item')).toEqual(project.phases.map((p) => String(p.number)));
    await expect(page.locator('a[data-phase-item][aria-current="page"]')).toHaveAttribute('data-phase-item', '2');
    await expect(page.locator('a[data-phase-item="2"]')).toHaveCSS('box-shadow', /rgb\(255, 176, 0\) 3px 0px 0px 0px inset/);
    await expect(page.locator('a[data-phase-item="2"] .pi-count')).toHaveText(countText(project, 2));
    await expect(page.locator('a[data-phase-item="2"] .seg-bar')).toBeVisible();
    await expect(page.locator('a[data-phase-item="2"] .pi-done')).toHaveCount(0);
    await expect(page.locator('a[data-phase-item="3"]')).toHaveClass(/\bfuture\b/);
    // A complete phase: the green check in place of the count, and no status bar.
    const done = page.locator('a[data-phase-item="1"]');
    await expect(done.locator('.pi-done')).toHaveAccessibleName('Complete');
    await expect(done.locator('.pi-done svg.i.pass')).toBeVisible();
    await expect(done.locator('.pi-count')).toHaveCount(0);
    await expect(done.locator('.seg-bar')).toHaveCount(0);

    const rail = page.getByTestId('list-main').getByTestId('phase-rail');
    await expect(rail).toHaveAttribute('data-phase', '2');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Phase 2: Library UI');
    await expect(page.getByRole('button', { name: 'Back to phases' })).toHaveCount(0);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(toggle(page, 'List')).toHaveAttribute('aria-pressed', 'true');
    await expect(page).toHaveTitle(/^Phase 2: Library UI · /);

    // A row swaps the rail.
    await page.locator('a[data-phase-item="1"]').click();
    await expect(page).toHaveURL(`${loop.baseURL}/list?phase=1`);
    await expect(rail).toHaveAttribute('data-phase', '1');
    await expect(page.locator('a[data-phase-item][aria-current="page"]')).toHaveAttribute('data-phase-item', '1');

    // The filter hides rows.
    await filter(page, 'complete').click();
    await expect(page).toHaveURL(`${loop.baseURL}/list?phase=1&show=complete`);
    expect(await attrs(items, 'data-phase-item')).toEqual(['1']);

    // No phase: the running phase, else the default one.
    await open(page, `${loop.baseURL}/list`);
    const implied = String(impliedPhase(project));
    await expect(page.locator('a[data-phase-item][aria-current="page"]')).toHaveAttribute('data-phase-item', implied);
    await expect(rail).toHaveAttribute('data-phase', implied);
  });

  test('the view toggle keeps the phase; the filter stays with the list view', async ({ page }) => {
    await open(page, `${loop.baseURL}/list?phase=2&show=progress`);
    await toggle(page, 'Kanban').click();
    await expect(page).toHaveURL(`${loop.baseURL}/?phase=2`);
    await expect(page.getByRole('dialog', { name: 'Phase 2: Library UI' })).toBeVisible();
    // The kanban shows every phase, whatever the list was filtered to.
    await expect(page.locator('a[data-kan-col]')).toHaveCount(project.phases.length);

    await page.keyboard.press('Escape');
    await expect(page).toHaveURL(`${loop.baseURL}/`);
    await expect(toggle(page, 'Kanban')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('button[data-filter]')).toHaveCount(0);

    await toggle(page, 'List').click();
    await expect(page).toHaveURL(`${loop.baseURL}/list`);
    await expect(page.getByTestId('list-view')).toBeVisible();
    await expect(filter(page, 'all')).toHaveAttribute('aria-pressed', 'true');

    // A `show` on the kanban's URL is ignored.
    await open(page, `${loop.baseURL}/?show=complete`);
    await expect(page.locator('a[data-kan-col]')).toHaveCount(project.phases.length);
  });

  test('the last layout is remembered for /, and the Kanban toggle still reaches the kanban', async ({ page }) => {
    await open(page, `${loop.baseURL}/list`);
    await open(page, `${loop.baseURL}/`);
    await expect(page).toHaveURL(`${loop.baseURL}/list`);
    await expect(page.getByTestId('list-view')).toBeVisible();

    await toggle(page, 'Kanban').click();
    await expect(page).toHaveURL(`${loop.baseURL}/`);
    await expect(page.getByTestId('kanban')).toBeVisible();
    await open(page, `${loop.baseURL}/`);
    await expect(page).toHaveURL(`${loop.baseURL}/`);
    await expect(page.getByTestId('kanban')).toBeVisible();
  });

  test('old routes land on their new equivalents', async ({ page }) => {
    await open(page, `${loop.baseURL}/overview`);
    await expect(page).toHaveURL(`${loop.baseURL}/`);
    await expect(page.getByTestId('kanban')).toBeVisible();
    await expect(panel(page)).toHaveCount(0);

    await open(page, `${loop.baseURL}/live`);
    await expect(page).toHaveURL(`${loop.baseURL}/?phase=${impliedPhase(project)}`);
    await expect(panel(page)).toHaveAttribute('data-phase', String(impliedPhase(project)));

    await open(page, `${loop.baseURL}/live?phase=1`);
    await expect(page).toHaveURL(`${loop.baseURL}/?phase=1`);

    await open(page, `${loop.baseURL}/phase/3`);
    await expect(page).toHaveURL(`${loop.baseURL}/?phase=3`);
    await expect(page.getByRole('dialog', { name: 'Phase 3: Sharing' })).toBeVisible();
    await expect(page).toHaveTitle(/^Phase 3: Sharing · /);

    await open(page, `${loop.baseURL}/sprint/2.3`);
    await expect(page).toHaveURL(`${loop.baseURL}/?phase=2#s2.3`);
    await expect(panel(page).locator('article[data-sprint-card="2.3"]')).toHaveAttribute('data-open', 'true');
    await expect(panel(page).locator('article[data-sprint-card="2.3"]')).toBeInViewport();
  });

  test.describe('375 px', () => {
    test.use({ viewport: { width: 375, height: 812 } });

    test('no horizontal page scroll; the board scrolls inside itself; the panel is full width', async ({ page }) => {
      await open(page, `${loop.baseURL}/`);
      await expect(page.locator('a[data-kan-col]')).toHaveCount(project.phases.length);
      expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
      // Lanes keep their 240px minimum; the board scrolls sideways.
      for (const group of LANES) expect((await lane(page, group).boundingBox())!.width).toBeGreaterThanOrEqual(239);
      expect(await boardOverflow(page)).toBeGreaterThan(0);

      await column(page, 2).click();
      await expect(panel(page)).toBeVisible();
      await expect
        .poll(async () => {
          const box = await panel(page).boundingBox();
          return box ? [Math.round(box.x), Math.round(box.width)] : null;
        })
        .toEqual([0, 375]);
      expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    });

    test('the list view stacks the phase list above the rail', async ({ page }) => {
      await open(page, `${loop.baseURL}/list?phase=2`);
      const list = await page.getByRole('navigation', { name: 'Phases', exact: true }).boundingBox();
      const main = await page.getByTestId('list-main').boundingBox();
      expect(list && main).toBeTruthy();
      expect(main!.y).toBeGreaterThanOrEqual(list!.y + list!.height - 1);
      await expect(page.locator('a[data-phase-item="2"] .seg-bar')).toBeHidden();
      expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    });
  });
});

// ---------------------------------------------------------------------------
// multi-phase with phase file edits (moved from Overview, Sprint 7.4)
// ---------------------------------------------------------------------------

test.describe('the kanban follows phase file edits', () => {
  test('counts, tiles, lanes and warning tags update within 2 s without a reload', async ({ page }) => {
    test.setTimeout(90_000);
    const APPEAR_MS = 2_000;
    const harness = await startHarness({ clientPort: 4854, serverPort: 4855, fixture: 'multi-phase', freshness: 'as-is' });
    try {
      const [phase1File, phase2File, phase3File] = ['Phase-1-Foundations.md', 'Phase-2-Library-UI.md', 'Phase-3-Sharing.md'].map(
        (f) => path.join(harness.fixture.phasesDir, f),
      ) as [string, string, string];

      await page.setViewportSize({ width: 1280, height: 900 });
      await open(page, `${harness.baseURL}/`);
      await markWindow(page);
      await expect(column(page, 2).getByTestId('kan-count')).toHaveText('1/8 tasks');
      await expect(tile(page, '2.1')).toHaveAttribute('data-state', 'needs-you');

      // 1. Unblock 2.1's task 3 (BLOCKED → x): 2/8, and 2.1 no longer needs you.
      await editLine(phase2File, /\| BLOCKED \| 3 \| Cover images/, '| x | 3 | Cover images');
      await expect(column(page, 2).getByTestId('kan-count')).toHaveText('2/8 tasks', { timeout: APPEAR_MS });
      await expect(tile(page, '2.1')).not.toHaveAttribute('data-state', 'needs-you');
      await expect(tile(page, '2.1').locator('svg.i.needs')).toHaveCount(0);

      // 2. Finish 3.2's task 1: the sprint has started, but task 2 is still to do, so the tile reads
      // Waiting, not Needs you. Finish task 2 as well: only its MANUAL task is left, so the tile
      // turns to the violet manual Needs you (its own icon, not pink), and phase 3 is In progress, 2/5.
      // Before that, 3.2's MANUAL task alone leaves the tile Not started and the phase future.
      await expect(tile(page, '3.2')).toHaveAttribute('data-state', 'not-started');
      await expect(column(page, 3)).toHaveAttribute('data-group', 'future');
      await expect(lane(page, 'future').locator('a[data-kan-col]')).toHaveCount(1);
      await editLine(phase3File, /\| — \| 1 \| Stats queries/, '| x | 1 | Stats queries');
      await expect(tile(page, '3.2')).toHaveAttribute('data-state', 'waiting', { timeout: APPEAR_MS });
      await expect(tile(page, '3.2').locator('svg.i.manual')).toHaveCount(0);
      await editLine(phase3File, /\| — \| 2 \| Stats page with two charts/, '| x | 2 | Stats page with two charts');
      await expect(tile(page, '3.2')).toHaveAttribute('data-state', 'manual', { timeout: APPEAR_MS });
      await expect(tile(page, '3.2')).toHaveClass(/\bmanual\b/);
      await expect(tile(page, '3.2').locator('svg.i.manual')).toHaveCount(1);
      await expect(tile(page, '3.2').locator('svg.i.needs')).toHaveCount(0);
      await expect(tile(page, '3.2').locator('svg.i.manual')).toHaveCSS('color', MANUAL_RGB);
      await expect(tile(page, '3.2').locator('.visually-hidden')).toHaveText(', Needs you');
      await expect(column(page, 3)).toHaveAttribute('data-group', 'progress');
      await expect(column(page, 3).getByTestId('kan-count')).toHaveText('2/5 tasks');

      // 3. Block task 1 instead: blocked and manual together read pink needs you, still In progress, 1/5.
      await editLine(phase3File, /\| x \| 1 \| Stats queries/, '| BLOCKED | 1 | Stats queries');
      await expect(tile(page, '3.2')).toHaveAttribute('data-state', 'needs-you', { timeout: APPEAR_MS });
      await expect(tile(page, '3.2')).toHaveClass(/\bneeds\b/);
      await expect(tile(page, '3.2').locator('svg.i.needs')).toHaveCount(1);
      await expect(tile(page, '3.2').locator('svg.i.manual')).toHaveCount(0);
      await expect(column(page, 3)).toHaveAttribute('data-group', 'progress');
      await expect(column(page, 3).getByTestId('kan-count')).toHaveText('1/5 tasks');
      // Phase 3 moved lanes when it started: In progress holds 2 and 3, and Not started is empty.
      expect(await attrs(lane(page, 'progress').locator('a[data-kan-col]'), 'data-kan-col')).toEqual(['2', '3']);
      await expect(lane(page, 'progress').getByTestId('lane-count')).toHaveText('2');
      await expect(lane(page, 'future').getByTestId('lane-count')).toHaveText('0');
      await expect(lane(page, 'future').getByTestId('lane-empty')).toHaveText('No phases');

      // 4. A table row with no closing pipe: phase 1's card gets a warning count.
      await editLine(
        phase1File,
        /\| x \| 3 \| Seed script with 20 sample books \| scripts\/seed\.ts \|/,
        '| x | 3 | Seed script with 20 sample books | scripts/seed.ts |\n| x | 4 | Row with no closing pipe | scripts/extra.ts',
      );
      const after = await loadProject(harness.fixture.root);
      const warnings = warningsFor(after, phase1File);
      expect(warnings).toBeGreaterThan(0);
      const tag = column(page, 1).locator('[data-tag="warnings"]');
      await expect(tag).toHaveText(`${warnings} ${warnings === 1 ? 'warning' : 'warnings'}`, { timeout: APPEAR_MS });
      await expect(tag).toHaveClass(/\bwarn\b/);
      await expect(column(page, 2).locator('[data-tag="warnings"]')).toHaveCount(warningsFor(after, phase2File) > 0 ? 1 : 0);

      // All of it, and opening a phase, without a page load.
      await column(page, 2).click();
      await expect(panel(page)).toHaveAttribute('data-phase', '2');
      expect(await windowMarker(page)).toBe('still here');
    } finally {
      await harness.close();
    }
  });
});

// ---------------------------------------------------------------------------
// trail-log with a long title, a task left and a run starting
// ---------------------------------------------------------------------------

test.describe('a wrapped title, a task left and a running sprint', () => {
  test('a long title wraps to two lines; Waiting and Implementing tiles; the running card', async ({ page }) => {
    const harness = await startHarness({ clientPort: 4852, serverPort: 4853, freshness: 'fresh' });
    try {
      const longTitle = 'Trip Journal, Offline Sync and the Long Road to Shareable Photo Albums';
      const file = path.join(harness.fixture.phasesDir, 'Phase-2-Trip-Journal.md');
      const text = await readFile(file, 'utf8');
      await writeFile(
        file,
        text
          .replace('# Phase 2 — Trip Journal', `# Phase 2 — ${longTitle}`)
          .replace('| x | 3 | Not-found state', '| — | 3 | Not-found state'),
        'utf8',
      );

      await page.setViewportSize({ width: 1280, height: 900 });
      await open(page, `${harness.baseURL}/`);
      const title = column(page, 2).getByTestId('kan-title');
      await expect(title).toHaveText(longTitle);
      // It wraps to two lines and stops there.
      const titleHeight = (await title.boundingBox())!.height;
      expect(titleHeight).toBeGreaterThan(30);
      expect(titleHeight).toBeLessThan(50);

      // A task left: the amber remaining tile (tint, 2px amber left edge, amber dot), never pink.
      const s21 = tile(page, '2.1');
      await expect(s21).toHaveAttribute('data-state', 'waiting');
      await expect(s21).toHaveClass(/\bremaining\b/);
      await expect(s21).toHaveCSS('box-shadow', /rgb\(255, 176, 0\) 2px 0px 0px 0px inset/);
      await expect(s21.locator('svg.i.wait')).toHaveCSS('color', 'rgb(255, 176, 0)');

      // The implementer starts 2.2: its tile runs with the state badge, and the card runs.
      const marker = JSON.stringify({
        v: 1,
        ts: formatTs(new Date()),
        phase: 2,
        wave: 2,
        sprint: '2.2',
        gate: 'implement',
        result: 'start',
        attempt: 1,
        max: 3,
        summary: '',
      });
      await appendFile(path.join(harness.fixture.runsDir, 'phase-2.jsonl'), `${marker}\n`, 'utf8');
      const s22 = tile(page, '2.2');
      await expect(s22).toHaveAttribute('data-state', 'implementing', { timeout: 5_000 });
      await expect(s22).toHaveClass(/\brun\b/);
      await expect(s22.getByTestId('tile-badge')).toHaveText('Implementing');
      await expect(s22.locator('svg.i.run')).toHaveCount(1);
      await expect(column(page, 2)).toHaveClass(/\brunning\b/);
      await expect(column(page, 2)).toHaveAttribute('data-running', 'true');
      await expect(column(page, 1)).not.toHaveClass(/\brunning\b/);

      // /live now lands on the running phase.
      await open(page, `${harness.baseURL}/live`);
      await expect(page).toHaveURL(`${harness.baseURL}/?phase=2`);
    } finally {
      await harness.close();
    }
  });
});
