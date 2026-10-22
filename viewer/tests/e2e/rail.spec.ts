/**
 * The phase page (Sprint 7.2's rail, made calmer in Sprint 9.3), opened at
 * `/phase/N` (or `/list?phase=N`, which redirects there since Sprint 9.1):
 * the header's meta line, waves as heading lines over one list of sprint
 * rows, rows that open in place to their tasks and collapsed rows, Run
 * notes, and row badges and edges that follow a run as it happens.
 *
 * - The `multi-phase` fixture (as-is timestamps, so durations are fixed):
 *   phase 1 is complete, with two logged waves (the second 18 min with one
 *   retry), phase 2 has one running wave and two sprints that haven't run.
 * - A `trail-log` copy with the `simulate-run` retry script appended step by
 *   step (`writeStep`), after an `implement` `start` marker, checking each
 *   badge within {@link APPEAR_MS} of its event being appended. Between the
 *   marker and the implement lines it appends the sprint's `task` lines
 *   (Sprint 8.5): each task row reads Running, then Built, within
 *   {@link APPEAR_MS}, and the phase file's status once doc sync is logged.
 * - A `trail-log` copy with one task of a finished sprint set back to not
 *   started: the amber Waiting card.
 * - A `trail-log` copy with the `escalation` script appended: the escalation
 *   banner under the meta line, cleared by a later event (Live run's
 *   check, moved here in Sprint 7.4).
 * - The `worktree-run` fixture (Sprint 10.3): phase 2 runs in a linked git
 *   worktree, so the page shows the worktree's phase file and run log, with
 *   "Worktree {branch}" last on the meta line (the path as its tooltip);
 *   phase 1, from the main checkout, has no such item. An event appended to
 *   the worktree's log shows live, and at 375 px the meta line wraps.
 * - 375 px on the shared `webServer`.
 *
 * Ports: 4840–4849 (see `harness.ts`).
 */
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { buildScript, formatTs, writeStep, type ScriptEvent } from '../../scripts/simulate-run.js';
import { formatTime } from '../../src/client/format.js';
import { startHarness, type Harness } from './harness.js';

/** Acceptance: a badge follows its gate event within 2 s of the append. */
const APPEAR_MS = 2_000;

/** The part of `document` the scroll check reads (this file is type-checked without the DOM lib). */
interface PageDocument {
  document: { documentElement: { scrollWidth: number; clientWidth: number } };
}

/** A computed style property of the first match (this file is type-checked without the DOM lib). */
async function css(target: Locator, property: string): Promise<string> {
  return target.evaluate(
    (el, prop) =>
      (globalThis as unknown as { getComputedStyle(el: unknown): Record<string, string> }).getComputedStyle(el)[prop]!,
    property,
  );
}

/** How far the page scrolls sideways (0 or less means no horizontal scroll). */
async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(() => {
    const root = (globalThis as unknown as PageDocument).document.documentElement;
    return root.scrollWidth - root.clientWidth;
  });
}

/** Open a route and wait for the first snapshot. */
async function open(page: Page, url: string): Promise<void> {
  await page.goto(url);
  await expect(page.locator('.app')).toHaveAttribute('data-connection', 'live');
}

function railRow(page: Page, key: string): Locator {
  return page.locator(`section[data-rail-row="${key}"]`);
}

function card(page: Page, id: string): Locator {
  return page.locator(`article[data-sprint-card="${id}"]`);
}

function badge(page: Page, id: string): Locator {
  return card(page, id).getByTestId('card-state');
}

function row(page: Page, id: string, name: string): Locator {
  return card(page, id).locator(`details[data-row="${name}"]`);
}

/** An attribute of every match, in order. */
async function attrs(list: Locator, name: string): Promise<(string | null)[]> {
  return list.evaluateAll(
    (els, attr) => els.map((el) => (el as unknown as { getAttribute(n: string): string | null }).getAttribute(attr)),
    name,
  );
}

// ---------------------------------------------------------------------------
// multi-phase
// ---------------------------------------------------------------------------

test.describe('multi-phase fixture', () => {
  let loop: Harness;

  test.beforeAll(async () => {
    loop = await startHarness({ clientPort: 4840, serverPort: 4841, fixture: 'multi-phase', freshness: 'as-is' });
  });
  test.afterAll(async () => {
    await loop?.close();
  });

  test('phase 2 shows its meta line, its wave and every sprint once, in plan order', async ({ page }) => {
    await open(page, `${loop.baseURL}/phase/2`);
    await expect(page.getByTestId('phase-rail')).toHaveAttribute('data-phase', '2');

    // Header: the eyebrow and title, then the meta line.
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Phase 2: Library UI');
    await expect(page.locator('h1 .eyebrow')).toBeVisible();
    await expect(page.locator('h1 .page-name')).toHaveText('Library UI');
    const meta = page.getByTestId('phase-meta');
    await expect(page.getByTestId('phase-status')).toHaveText('1 task blocked');
    await expect(page.getByTestId('phase-status').locator('svg.i.needs')).toHaveCount(1);
    await expect(page.getByTestId('phase-progress-text')).toHaveText('1 of 8 tasks');
    // Wave 1's start isn't logged, so no total minutes.
    await expect(page.getByTestId('rail-summary')).toHaveText('1 wave');
    await expect(page.getByTestId('rail-retries')).toHaveText('No retries');
    await expect(page.getByTestId('phase-time')).toHaveText(/^Started (\w{3} \d{1,2}, )?\d{1,2}:\d{2} [AP]M$/);
    await expect(meta).toHaveText(/^1 task blocked·1 of 8 tasks·1 wave·No retries·Started /);
    // Not complete: the status bar shows, under the meta line.
    await expect(page.getByTestId('phase-status-bar')).toBeVisible();
    // No "Sprints" line and no last-event time.
    await expect(page.locator('.rail-meta, h2.rail-h')).toHaveCount(0);
    await expect(page.getByText(/last event/)).toHaveCount(0);

    // Waves: the logged wave, then the sprints that haven't run.
    expect(await attrs(page.locator('section[data-rail-row]'), 'data-rail-row')).toEqual(['wave-1-1', 'not-run']);
    expect(await attrs(page.locator('article[data-sprint-card]'), 'data-sprint-card')).toEqual(['2.1', '2.2', '2.3']);

    const wave = railRow(page, 'wave-1-1');
    await expect(wave).toHaveAttribute('aria-label', 'Wave 1');
    await expect(wave).toHaveAttribute('data-row-state', 'running');
    await expect(wave.locator('.wave-h')).toHaveText('Wave 1·Running·Sequential·start not logged');
    await expect(wave.getByTestId('wave-name')).toHaveText('Wave 1');
    await expect(wave.getByTestId('wave-live').locator('svg.i.run')).toHaveCount(1);
    await expect(wave.getByTestId('wave-mode')).toHaveText('Sequential');
    await expect(wave.getByTestId('wave-duration')).toHaveText('start not logged');

    const notRun = railRow(page, 'not-run');
    await expect(notRun.locator('.wave-h')).toHaveText('Not run yet');
    await expect(notRun.getByTestId('wave-mode')).toHaveCount(0);
    await expect(notRun.getByTestId('wave-duration')).toHaveCount(0);
    await expect(notRun.locator('ul.sprints')).toHaveClass(/dashed/);
    expect(await css(notRun.locator('ul.sprints'), 'borderTopStyle')).toBe('dashed');
    await expect(card(page, '2.2')).toHaveClass(/dashed/);

    // Badges: a blocked task reads Needs you (pink, with the pink edge); nothing done reads the plain tag.
    await expect(badge(page, '2.1')).toHaveText('Needs you');
    await expect(badge(page, '2.1')).toHaveClass(/status needs/);
    await expect(card(page, '2.1')).toHaveClass(/needs/);
    expect(await css(card(page, '2.1'), 'boxShadow')).toContain('inset');
    await expect(badge(page, '2.2')).toHaveText('Not started');
    await expect(badge(page, '2.2')).toHaveClass(/^tag$/);
    expect(await css(card(page, '2.2'), 'boxShadow')).toBe('none');
    // The id without "Sprint" on screen; screen readers still hear it.
    await expect(card(page, '2.1').locator('.card-toggle .sid')).toHaveText('Sprint 2.1');
    await expect(card(page, '2.1').locator('.card-toggle .sid .visually-hidden')).toHaveText('Sprint');
    await expect(card(page, '2.1').getByTestId('card-toggle')).toHaveAccessibleName(/^Sprint 2\.1 /);

    // Nothing is running, so every row starts collapsed, status bar showing.
    for (const id of ['2.1', '2.2', '2.3']) {
      await expect(card(page, id)).toHaveAttribute('data-open', 'false');
      await expect(card(page, id).getByTestId('card-body')).toBeHidden();
      await expect(card(page, id).getByTestId('card-status-bar')).toBeVisible();
    }
  });

  test('phase 1, complete: a quiet meta line, no status bar or green banner, a check per sprint', async ({ page }) => {
    await open(page, `${loop.baseURL}/phase/1`);
    await expect(page.getByTestId('phase-status')).toHaveText('Complete');
    await expect(page.getByTestId('phase-status').locator('svg.i.pass')).toHaveCount(1);
    await expect(page.getByTestId('phase-progress-text')).toHaveText('6 of 6 tasks');
    await expect(page.getByTestId('rail-summary')).toHaveText('2 waves');
    await expect(page.getByTestId('rail-retries')).toHaveText('1 retry');
    await expect(page.getByTestId('phase-time')).toHaveText(/^Finished \w{3} \d{1,2}, \d{1,2}:\d{2} [AP]M$/);
    await expect(page.getByTestId('phase-meta')).toHaveText(/^Complete·6 of 6 tasks·2 waves·1 retry·Finished /);
    await expect(page.getByTestId('phase-status-bar')).toHaveCount(0);
    await expect(page.getByTestId('run-end')).toHaveCount(0);
    await expect(page.getByText('Phase run complete')).toHaveCount(0);
    expect(await attrs(page.locator('section[data-rail-row]'), 'data-rail-row')).toEqual(['wave-1-1', 'wave-1-2']);

    // Wave heading lines: no done check.
    const w1 = railRow(page, 'wave-1-1');
    await expect(w1).toHaveAttribute('data-row-state', 'done');
    await expect(w1.locator('.wave-h svg')).toHaveCount(0);
    await expect(w1.getByTestId('wave-live')).toHaveCount(0);
    await expect(w1.getByTestId('wave-duration')).toHaveText('start not logged');
    await expect(w1.getByTestId('wave-retries')).toHaveCount(0);

    // Wave 2 starts at wave 1's doc sync (9:03:30) and ends at its own (9:21:05).
    const w2 = railRow(page, 'wave-1-2');
    await expect(w2.locator('.wave-h')).toHaveText('Wave 2·Sequential·18 min·1 retry');
    await expect(w2.getByTestId('wave-retries')).toHaveText('1 retry');

    // A complete sprint: the green check alone, no Complete badge, no bar, no edge.
    for (const id of ['1.1', '1.2']) {
      const end = badge(page, id);
      await expect(end).toHaveText('Complete');
      await expect(end).toHaveClass('row-done');
      await expect(end.locator('svg.i.pass')).toBeVisible();
      await expect(end.locator('.visually-hidden')).toHaveText('Complete');
      await expect(card(page, id).locator('.status')).toHaveCount(0);
      await expect(card(page, id).getByTestId('card-status-bar')).toHaveCount(0);
      expect(await css(card(page, id), 'boxShadow')).toBe('none');
    }
  });

  test('each wave is a heading line over one bordered list, on a page no wider than 880 px', async ({ page }) => {
    await page.setViewportSize({ width: 1536, height: 900 });
    await open(page, `${loop.baseURL}/phase/2`);
    await expect(page.locator('.wave-cell, .rail-cards, .rail-card')).toHaveCount(0);
    for (const key of ['wave-1-1', 'not-run']) {
      const section = railRow(page, key);
      await expect(section.locator('ul.sprints')).toHaveCount(1);
      // One list holds every row of the wave; each row is a list item.
      await expect(section.locator('ul.sprints > li > article[data-sprint-card]')).toHaveCount(
        await section.locator('article[data-sprint-card]').count(),
      );
      const heading = await section.locator('.wave-h').boundingBox();
      const list = await section.locator('ul.sprints').boundingBox();
      expect(heading && list).toBeTruthy();
      expect(list!.y).toBeGreaterThanOrEqual(heading!.y + heading!.height);
      expect(await css(section.locator('ul.sprints'), 'borderTopWidth')).toBe('1px');
    }
    const pageBox = await page.getByTestId('phase-rail').boundingBox();
    const mainBox = await page.getByTestId('list-main').boundingBox();
    expect(pageBox!.width).toBeLessThanOrEqual(880);
    // Centred in the main area.
    const left = pageBox!.x - mainBox!.x;
    const right = mainBox!.x + mainBox!.width - (pageBox!.x + pageBox!.width);
    expect(Math.abs(left - right)).toBeLessThan(24);
  });

  test('a card opens to its goal, tasks and collapsed rows; others keep their state', async ({ page }) => {
    await open(page, `${loop.baseURL}/list?phase=2`);
    const s21 = card(page, '2.1');
    const toggle = s21.getByTestId('card-toggle');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(s21).toHaveAttribute('data-open', 'true');

    await expect(s21.getByTestId('card-goal')).toHaveText('Show every book as a cover grid with sort and filter.');
    // It opens inside its row: under the toggle line, inside the same list item.
    const head = await s21.locator('.sprint-head').boundingBox();
    const body = await s21.getByTestId('card-body').boundingBox();
    const item = await page.locator('ul.sprints > li', { has: s21 }).boundingBox();
    expect(head && body && item).toBeTruthy();
    expect(body!.y).toBeGreaterThanOrEqual(head!.y + head!.height - 1);
    expect(body!.y + body!.height).toBeLessThanOrEqual(item!.y + item!.height + 1);
    expect(body!.x).toBeGreaterThanOrEqual(item!.x - 1);
    expect(body!.x + body!.width).toBeLessThanOrEqual(item!.x + item!.width + 1);
    // Its contents line up under the title (64 px in).
    const goal = await s21.getByTestId('card-goal').boundingBox();
    expect(Math.abs(goal!.x - item!.x - 64)).toBeLessThan(2);
    await expect(page.locator('ul.sprints > li > article[data-sprint-card="2.1"] > [data-testid="card-body"]')).toHaveCount(1);
    const tasks = s21.getByTestId('tasks-table');
    await expect(tasks.locator('tr')).toHaveCount(4);
    // The not-started task of a sprint that has begun stays plain grey.
    await expect(tasks.locator('tr[data-task="4"]')).toHaveAttribute('data-status', 'todo');
    await expect(tasks.locator('tr[data-task="4"]')).not.toHaveClass(/remaining/);

    // Four collapsed rows, all closed.
    const rows = s21.locator('details[data-row]');
    expect(await attrs(rows, 'data-row')).toEqual(['criteria', 'dependencies', 'verification', 'run-notes']);
    for (const r of await rows.all()) await expect(r).not.toHaveAttribute('open');
    await expect(row(page, '2.1', 'criteria').getByTestId('card-row-end')).toHaveText('2');
    await expect(row(page, '2.1', 'dependencies').getByTestId('card-row-end')).toHaveText('Phase 1, Sprint 1.2');
    await expect(row(page, '2.1', 'verification').getByTestId('card-row-end')).toHaveText('6');
    await expect(row(page, '2.1', 'run-notes').getByTestId('card-row-end')).toHaveText('1');

    // Run notes: closed until clicked; the attempt note lives only there.
    const note = s21.getByTestId('run-note');
    await expect(note).toHaveCount(1);
    await expect(note).toBeHidden();
    await expect(page.getByTestId('run-note')).toHaveCount(await page.locator('details[data-row="run-notes"] [data-testid="run-note"]').count());
    await row(page, '2.1', 'run-notes').locator('summary').click();
    await expect(note).toBeVisible();
    await expect(note).toHaveAttribute('data-kind', 'notes');
    await expect(note.locator('b')).toHaveText(`Verify attempt 1 passed with notes · ${formatTime('2026-09-21T14:02:10Z')}`);
    await expect(note.locator('code')).toHaveText('criteria 1/2 met; 1 unverified');
    // The other rows stay closed.
    await expect(row(page, '2.1', 'criteria')).not.toHaveAttribute('open');

    // Another card: no run notes, so three rows. The first card stays open.
    await expect(card(page, '2.2')).toHaveAttribute('data-open', 'false');
    await card(page, '2.2').getByTestId('card-toggle').click();
    await expect(card(page, '2.2')).toHaveAttribute('data-open', 'true');
    expect(await attrs(card(page, '2.2').locator('details[data-row]'), 'data-row')).toEqual([
      'criteria',
      'dependencies',
      'verification',
    ]);
    await expect(row(page, '2.2', 'verification').getByTestId('card-row-end')).toHaveText('None');
    await expect(s21).toHaveAttribute('data-open', 'true');

    // Closing one leaves the other open.
    await toggle.click();
    await expect(s21.getByTestId('card-body')).toBeHidden();
    await expect(card(page, '2.2')).toHaveAttribute('data-open', 'true');
    await expect(card(page, '2.3')).toHaveAttribute('data-open', 'false');
  });

  test('a failed attempt shows in Run notes with how it was fixed', async ({ page }) => {
    await open(page, `${loop.baseURL}/list?phase=1`);
    await card(page, '1.2').getByTestId('card-toggle').click();
    const notes = row(page, '1.2', 'run-notes');
    await expect(notes.getByTestId('card-row-end')).toHaveText('1');
    await notes.locator('summary').click();
    const note = notes.getByTestId('run-note');
    await expect(note).toHaveAttribute('data-kind', 'failed');
    await expect(note).toHaveAttribute('data-resolved', 'true');
    await expect(note.locator('b')).toHaveText(`Verify attempt 1 failed · ${formatTime('2026-09-20T09:11:45Z')}`);
    await expect(note.locator('code')).toHaveText('test: dedupe keeps two rows for the same ISBN');
    await expect(note.locator('.then')).toHaveText(
      `Fixed in implement attempt 2; verify passed at ${formatTime('2026-09-20T09:19:50Z')}.`,
    );
    // 1.1 passed first time: no Run notes row.
    await card(page, '1.1').getByTestId('card-toggle').click();
    await expect(row(page, '1.1', 'run-notes')).toHaveCount(0);
  });

  test('#s{id} opens that row and scrolls to it', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 500 });
    await open(page, `${loop.baseURL}/phase/2#s2.3`);
    await expect(card(page, '2.3')).toHaveAttribute('data-open', 'true');
    await expect(card(page, '2.3').getByTestId('tasks-table')).toBeVisible();
    await expect(card(page, '2.3')).toBeInViewport();
    await expect(card(page, '2.2')).toHaveAttribute('data-open', 'false');
    // The old query form still lands.
    await open(page, `${loop.baseURL}/list?phase=2#s2.3`);
    await expect(card(page, '2.3')).toHaveAttribute('data-open', 'true');
    await expect(card(page, '2.3')).toBeInViewport();
  });
});

// ---------------------------------------------------------------------------
// trail-log with a run appended step by step
// ---------------------------------------------------------------------------

test.describe('a run in progress', () => {
  test('badges follow each gate within 2 s; waves appear and finish in the rail', async ({ page }) => {
    test.setTimeout(90_000);
    const harness = await startHarness({ clientPort: 4842, serverPort: 4843, freshness: 'fresh' });
    try {
      await open(page, `${harness.baseURL}/list?phase=2`);
      const steps = buildScript('retry');
      const append = (i: number): Promise<void> => writeStep(harness.fixture.root, steps[i]!, new Date());

      // Before: wave 1 done, the rest not run yet.
      expect(await attrs(page.locator('section[data-rail-row]'), 'data-rail-row')).toEqual(['wave-1-1', 'not-run']);
      await expect(railRow(page, 'wave-1-1')).toHaveAttribute('data-row-state', 'done');
      await expect(badge(page, '2.1')).toHaveText('Complete');
      await expect(badge(page, '2.1')).toHaveClass('row-done');
      await expect(badge(page, '2.2')).toHaveText('Not started');

      // The implementer starts 2.2: wave 2 appears, running, and its card opens.
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
      await expect(badge(page, '2.2')).toHaveText('Implementing', { timeout: APPEAR_MS });
      await expect(badge(page, '2.2')).toHaveClass(/status run/);
      await expect(card(page, '2.2')).toHaveClass(/\brun\b/);
      // The running row: its badge, its bar and a 2px cyan left edge; the others stay quiet.
      const runningColour = await css(badge(page, '2.2'), 'color');
      expect(await css(card(page, '2.2'), 'boxShadow')).toBe(`${runningColour} 2px 0px 0px 0px inset`);
      await expect(card(page, '2.2').getByTestId('card-status-bar')).toBeVisible();
      expect(await css(card(page, '2.1'), 'boxShadow')).toBe('none');
      await expect(card(page, '2.1').locator('.status')).toHaveCount(0);
      expect(await css(card(page, '2.4'), 'boxShadow')).toBe('none');
      await expect(badge(page, '2.4')).toHaveText('Not started');
      const w2 = railRow(page, 'wave-1-2');
      await expect(w2).toHaveAttribute('data-row-state', 'running');
      await expect(w2.getByTestId('wave-live')).toHaveText('Running');
      await expect(w2.getByTestId('wave-duration')).toHaveText(/ so far$/);
      await expect(card(page, '2.2')).toHaveAttribute('data-open', 'true');
      // The phase is running: the meta line says so and when it started.
      await expect(page.getByTestId('phase-status')).toHaveText(/^Running wave \d+ of \d+$/);
      await expect(page.getByTestId('phase-status').locator('svg.i.run')).toHaveCount(1);
      await expect(page.getByTestId('phase-time')).toHaveText(/^Started /);

      // Task lines: the implementer logs each task as it starts and finishes it, and the
      // task's row follows within 2 s. Running, then Built; never Complete before doc sync.
      const taskRow = (id: string, n: number): Locator => card(page, id).getByTestId('tasks-table').locator(`tr[data-task="${n}"]`);
      const taskLines = (...lines: Array<['start' | 'pass', number]>): Promise<void> =>
        writeStep(
          harness.fixture.root,
          {
            events: lines.map(
              ([result, n]): ScriptEvent => ({ phase: 2, wave: 2, sprint: '2.2', gate: 'task', result, attempt: 1, max: 3, summary: String(n) }),
            ),
          },
          new Date(),
        );
      const words = card(page, '2.2').getByTestId('tasks-table').locator('td.st');
      await expect(words).toHaveText(['Not started', 'Not started', 'Not started']);
      const bar = card(page, '2.2').getByTestId('card-status-bar');
      await expect(bar).toHaveAttribute('aria-label', '3 not started');
      const phaseBarBefore = await page.getByTestId('phase-status-bar').first().getAttribute('aria-label');
      const phaseBefore = await page.getByTestId('phase-progress-text').textContent();

      await taskLines(['start', 1]);
      await expect(taskRow('2.2', 1).locator('td.st')).toHaveText('Running', { timeout: APPEAR_MS });
      await expect(taskRow('2.2', 1)).toHaveAttribute('data-progress', 'running');
      await expect(taskRow('2.2', 1)).toHaveAttribute('data-status', 'todo');
      await expect(taskRow('2.2', 1).locator('svg.i.run')).toHaveCount(1);
      // The rows still to do stay plain grey Not started.
      await expect(taskRow('2.2', 2).locator('td.st')).toHaveText('Not started');
      // The card's status bar fills with it, in the run's colour.
      await expect(bar).toHaveAttribute('aria-label', '1 running, 2 not started');

      await taskLines(['pass', 1], ['start', 2]);
      await expect(taskRow('2.2', 1).locator('td.st')).toHaveText('Built', { timeout: APPEAR_MS });
      await expect(taskRow('2.2', 1)).toHaveAttribute('data-progress', 'built');
      // Built has its own icon and the run's colour, not Complete's ringed green check.
      await expect(taskRow('2.2', 1).locator('svg.i.built')).toHaveCount(1);
      await expect(taskRow('2.2', 1).locator('svg.i.pass')).toHaveCount(0);
      await expect(taskRow('2.2', 1).locator('td.st')).toHaveCSS('color', await badge(page, '2.2').evaluate((el) => (globalThis as unknown as { getComputedStyle(el: unknown): { color: string } }).getComputedStyle(el).color));
      await expect(words).toHaveText(['Built', 'Running', 'Not started']);
      await expect(bar).toHaveAttribute('aria-label', '1 built, 1 running, 1 not started');
      await expect(bar.locator('i[data-status="built"]')).toHaveCSS('background-color', await bar.locator('i[data-status="active"]').evaluate((el) => (globalThis as unknown as { getComputedStyle(el: unknown): { backgroundColor: string } }).getComputedStyle(el).backgroundColor));

      await taskLines(['pass', 2], ['start', 3]);
      await expect(words).toHaveText(['Built', 'Built', 'Running'], { timeout: APPEAR_MS });
      await taskLines(['pass', 3]);
      await expect(words).toHaveText(['Built', 'Built', 'Built'], { timeout: APPEAR_MS });

      await expect(bar).toHaveAttribute('aria-label', '3 built');

      // Nothing else moved: the count, the phase's bar, the badge and the wave are the phase file's and the gates'.
      await expect(card(page, '2.2').locator('.card-sub')).toHaveText('Tasks0/3');
      await expect(page.getByTestId('phase-status-bar').first()).toHaveAttribute('aria-label', phaseBarBefore!);
      await expect(page.getByTestId('phase-progress-text')).toHaveText(phaseBefore!);
      await expect(badge(page, '2.2')).toHaveText('Implementing');
      await expect(w2).toHaveAttribute('data-row-state', 'running');
      await expect(w2.getByTestId('wave-retries')).toHaveCount(0);

      // Implement lines: verifying begins. Implementing → Verifying.
      await append(0);
      await expect(badge(page, '2.2')).toHaveText('Verifying', { timeout: APPEAR_MS });
      await expect(badge(page, '2.3')).toHaveText('Verifying');
      // Built tasks stay Built while the gates run.
      await expect(words).toHaveText(['Built', 'Built', 'Built']);
      await expect(w2.getByTestId('wave-mode')).toHaveText('Parallel');
      expect(await attrs(w2.locator('article[data-sprint-card]'), 'data-sprint-card')).toEqual(['2.2', '2.3']);
      await expect(card(page, '2.3')).toHaveAttribute('data-open', 'true');

      // 2.3's verify fails: red Verify failed until the retry, with the failure under its tasks;
      // 2.2 passed, and waits for 2.3, since the wave test runs once for the whole wave.
      await append(1);
      await expect(badge(page, '2.3')).toHaveText('Verify failed', { timeout: APPEAR_MS });
      await expect(badge(page, '2.3')).toHaveClass(/status fail/);
      // Still working: the running spinner, in red.
      // Cast: this tsconfig has no DOM types.
      type Styles = { getComputedStyle(el: unknown): { color: string } };
      const failedRed = await badge(page, '2.3').evaluate((el) => (globalThis as unknown as Styles).getComputedStyle(el).color);
      await expect(badge(page, '2.3').locator('svg.i.run')).toHaveCSS('color', failedRed);
      await expect(card(page, '2.3')).toHaveClass(/\bfail\b/);
      expect(await css(card(page, '2.3'), 'boxShadow')).toBe(`${failedRed} 2px 0px 0px 0px inset`);
      await expect(badge(page, '2.2')).toHaveText('Waiting');
      const failure = card(page, '2.3').getByTestId('card-failure');
      await expect(failure).toContainText('Verify attempt 1 failed. test: 2 failing in src/photos/import.test.ts');
      await expect(failure.getByTestId('card-failure-next')).toHaveText('Retry next · 2 attempts left');
      await expect(card(page, '2.2').getByTestId('card-failure')).toHaveCount(0);
      const notes = row(page, '2.3', 'run-notes');
      await expect(notes.getByTestId('card-row-end')).toHaveText('1');
      await expect(notes).not.toHaveAttribute('open');
      await expect(notes.getByTestId('run-note')).toBeHidden();

      // Implement attempt 2 (logged without a start line): Verify failed → Re-verifying.
      await append(2);
      await expect(badge(page, '2.3')).toHaveText('Re-verifying', { timeout: APPEAR_MS });
      await expect(badge(page, '2.3')).toHaveClass(/status run/);
      await expect(failure.getByTestId('card-failure-next')).toHaveText('Verifying the retry');
      await expect(badge(page, '2.2')).toHaveText('Waiting');
      await expect(w2.getByTestId('wave-retries')).toHaveText('1 retry');

      // Verify passes, wave test, doc sync: the wave finishes.
      await append(3);
      // A UI wave: every sprint in it goes through the wave test.
      await expect(badge(page, '2.3')).toHaveText('Wave testing', { timeout: APPEAR_MS });
      await expect(failure).toHaveCount(0);
      await append(4);
      await expect(badge(page, '2.3')).toHaveText('Doc syncing', { timeout: APPEAR_MS });
      await append(5);
      await expect(w2).toHaveAttribute('data-row-state', 'done', { timeout: APPEAR_MS });
      // No done check on the wave, and the Running item goes.
      await expect(w2.locator('.wave-h svg')).toHaveCount(0);
      await expect(w2.getByTestId('wave-live')).toHaveCount(0);
      await expect(w2.getByTestId('wave-duration')).toHaveText(/^(under 1 min|\d+ min)$/);
      await expect(badge(page, '2.2')).toHaveText('Complete');
      await expect(badge(page, '2.3')).toHaveText('Complete');
      // Finished rows go quiet: the check alone, no edge.
      await expect(badge(page, '2.3')).toHaveClass('row-done');
      expect(await css(card(page, '2.2'), 'boxShadow')).toBe('none');
      expect(await css(card(page, '2.3'), 'boxShadow')).toBe('none');
      // Doc sync is logged: every row shows the phase file's status, and none still reads Built.
      await expect(words).toHaveText(['Complete', 'Complete', 'Complete']);
      await expect(page.locator('tr[data-progress]')).toHaveCount(0);
      await expect(card(page, '2.2').locator('svg.i.built')).toHaveCount(0);
      await notes.locator('summary').click();
      await expect(notes.getByTestId('run-note')).toHaveAttribute('data-resolved', 'true');
      await expect(page.getByTestId('rail-summary')).toHaveText('2 waves');
      await expect(page.getByTestId('rail-retries')).toHaveText('1 retry');

      // Every sprint still appears once, in plan order.
      expect(await attrs(page.locator('article[data-sprint-card]'), 'data-sprint-card')).toEqual([
        '2.1',
        '2.2',
        '2.3',
        '2.4',
      ]);
    } finally {
      await harness.close();
    }
  });
});

// ---------------------------------------------------------------------------
// A manual task left: Waiting
// ---------------------------------------------------------------------------

test.describe('a sprint with a task left', () => {
  test('shows a neutral Waiting badge and a grey status-bar segment', async ({ page }) => {
    const harness = await startHarness({ clientPort: 4844, serverPort: 4845, freshness: 'fresh' });
    try {
      const file = path.join(harness.fixture.phasesDir, 'Phase-2-Trip-Journal.md');
      const text = await readFile(file, 'utf8');
      await writeFile(file, text.replace('| x | 3 | Not-found state', '| — | 3 | Not-found state'), 'utf8');

      await open(page, `${harness.baseURL}/list?phase=2`);
      const s21 = card(page, '2.1');
      await expect(badge(page, '2.1')).toHaveText('Waiting');
      await expect(badge(page, '2.1')).toHaveClass(/status wait/);
      await expect(badge(page, '2.1')).toHaveCSS('color', 'rgb(84, 77, 68)');
      await expect(badge(page, '2.1')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
      await expect(badge(page, '2.1').locator('svg.i.wait')).toHaveCount(1);
      // Idle: no edge on the row.
      await expect(s21).toHaveCSS('box-shadow', 'none');

      const bar = s21.getByTestId('card-status-bar');
      const todo = bar.locator('i[data-status="todo"]');
      await expect(todo).toHaveCount(1);
      await expect(todo).toHaveCSS('background-color', 'rgb(207, 200, 188)');

      await s21.getByTestId('card-toggle').click();
      await expect(s21.getByTestId('tasks-table').locator('tr[data-task="3"] td.st')).toHaveText('Not started');
    } finally {
      await harness.close();
    }
  });
});

// ---------------------------------------------------------------------------
// An escalation (moved from Live run, Sprint 7.4)
// ---------------------------------------------------------------------------

test.describe('an escalation', () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test('three failed verify attempts show the banner under the meta line; a later event clears it', async ({ page }) => {
    test.setTimeout(90_000);
    const harness = await startHarness({ clientPort: 4846, serverPort: 4847, freshness: 'fresh' });
    try {
      await open(page, `${harness.baseURL}/list?phase=2`);
      for (const step of buildScript('escalation')) await writeStep(harness.fixture.root, step, new Date());

      const banner = page.getByTestId('escalation-banner');
      await expect(banner).toHaveCount(1, { timeout: 10_000 });
      await expect(banner).toHaveAttribute('role', 'alert');
      await expect(banner).toHaveAttribute('data-sprint', '2.4');
      await expect(banner.locator('strong')).toHaveText('Verify retry limit reached (3/3) on sprint 2.4');
      await expect(banner.locator('p')).toHaveText("Waiting on you in the Claude Code session. The viewer can't act on this.");
      await expect(banner.locator('svg.i.needs')).toHaveCount(1);
      // Under the meta line and the phase's status bar, above the waves.
      const bannerBox = await banner.boundingBox();
      const metaBox = await page.getByTestId('phase-meta').boundingBox();
      const barBox = await page.getByTestId('phase-status-bar').boundingBox();
      const wavesBox = await page.locator('.waves').boundingBox();
      expect(bannerBox && metaBox && barBox && wavesBox).toBeTruthy();
      expect(bannerBox!.y).toBeGreaterThan(metaBox!.y + metaBox!.height);
      expect(bannerBox!.y).toBeGreaterThan(barBox!.y);
      expect(bannerBox!.y + bannerBox!.height).toBeLessThanOrEqual(wavesBox!.y);

      // The phase and the sprint read Needs you (the row with its pink edge); the card has one note per failed attempt.
      await expect(page.getByTestId('phase-status')).toHaveText('Needs you');
      await expect(page.getByTestId('phase-status').locator('svg.i.needs')).toHaveCount(1);
      await expect(badge(page, '2.4')).toHaveText('Needs you');
      await expect(card(page, '2.4')).toHaveClass(/\bneeds\b/);
      expect(await css(card(page, '2.4'), 'boxShadow')).toBe(`${await css(banner.locator('strong'), 'color')} 2px 0px 0px 0px inset`);
      if ((await card(page, '2.4').getAttribute('data-open')) !== 'true') {
        await card(page, '2.4').getByTestId('card-toggle').click();
      }
      await expect(row(page, '2.4', 'run-notes').getByTestId('card-row-end')).toHaveText('3');
      expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);

      // "Continue retrying": a later event for the sprint clears the banner.
      await writeStep(
        harness.fixture.root,
        {
          events: [
            {
              phase: 2,
              wave: 3,
              sprint: '2.4',
              gate: 'implement',
              result: 'pass',
              attempt: 1,
              max: 3,
              summary: 'done 1,2,3 — Continue retrying. Keep photo order in the manifest.',
            },
          ],
        },
        new Date(),
      );
      await expect(banner).toHaveCount(0, { timeout: APPEAR_MS });
      await expect(badge(page, '2.4')).not.toHaveText('Needs you');
      await expect(page.getByTestId('phase-status')).not.toHaveText('Needs you');
    } finally {
      await harness.close();
    }
  });
});

// ---------------------------------------------------------------------------
// worktree-run: phase 2 running in a linked git worktree
// ---------------------------------------------------------------------------

test.describe('a phase running in a git worktree', () => {
  let loop: Harness;

  test.beforeAll(async () => {
    loop = await startHarness({ clientPort: 4848, serverPort: 4849, fixture: 'worktree-run', freshness: 'fresh' });
  });
  test.afterAll(async () => {
    await loop?.close();
  });

  function worktree() {
    const wt = loop.fixture.worktrees[0];
    expect(wt?.name).toBe('phase-2-trip-journal');
    return wt!;
  }

  test('phase 2 shows the worktree\'s run and statuses, and "Worktree {branch}" last on the meta line', async ({ page }) => {
    const wt = worktree();
    await open(page, `${loop.baseURL}/phase/2`);

    // The worktree's phase file (2.1 done) and run log (wave 1), not the main checkout's (nothing done, no log).
    await expect(page.getByTestId('phase-progress-text')).toHaveText('3 of 12 tasks');
    await expect(page.getByTestId('rail-summary')).not.toHaveText('No run log');
    expect(await attrs(page.locator('section[data-rail-row]'), 'data-rail-row')).toEqual(['wave-1-1', 'not-run']);
    await expect(railRow(page, 'wave-1-1')).toHaveAttribute('data-row-state', 'done');
    await expect(badge(page, '2.1')).toHaveText('Complete');
    await expect(badge(page, '2.2')).toHaveText('Not started');

    // The worktree item: last, the branch, the full path as its tooltip, in the meta line's own text style.
    const item = page.getByTestId('phase-worktree');
    await expect(item).toHaveText('Worktree claude/phase-2-trip-journal');
    await expect(item).toHaveAttribute('title', wt.root);
    await expect(page.getByTestId('phase-meta').locator(':scope > span').last().getByTestId('phase-worktree')).toHaveCount(1);
    await expect(page.getByTestId('phase-meta')).toHaveText(/·Worktree claude\/phase-2-trip-journal$/);
    const tasks = page.getByTestId('phase-progress-text');
    for (const prop of ['color', 'fontSize', 'fontWeight', 'fontFamily']) {
      expect(await css(item, prop)).toBe(await css(tasks, prop));
    }
    await expect(item.locator('svg')).toHaveCount(0);

    // Some tasks done, nothing running: the plain grey word, no icon and no box.
    const state = page.getByTestId('phase-status');
    await expect(state).toHaveText('Waiting');
    await expect(state.locator('svg')).toHaveCount(0);
    expect(await css(state, 'borderTopStyle')).toBe('none');
    expect(await css(state, 'textTransform')).toBe('none');
    expect(await css(state, 'fontSize')).toBe(await css(tasks, 'fontSize'));
    expect(await css(state, 'fontFamily')).toBe(await css(tasks, 'fontFamily'));

    // Nothing about worktrees anywhere else (the sidebar, the switcher). The
    // project name in the top bar, "worktree-run", is the fixture's folder.
    expect((await page.locator('body').innerText()).match(/Worktree /g)).toHaveLength(1);
  });

  test('a phase from the main checkout has no worktree item', async ({ page }) => {
    await open(page, `${loop.baseURL}/phase/1`);
    await expect(page.getByTestId('phase-status')).toHaveText('Complete');
    await expect(page.getByTestId('phase-meta')).toBeVisible();
    await expect(page.getByTestId('phase-worktree')).toHaveCount(0);
    expect((await page.locator('body').innerText()).match(/Worktree /g)).toBeNull();
  });

  test('at 375 px the meta line wraps, with no horizontal page scroll', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await open(page, `${loop.baseURL}/phase/2`);
    const item = page.getByTestId('phase-worktree');
    await expect(item).toBeVisible();
    const first = await page.getByTestId('phase-status').boundingBox();
    const last = await item.boundingBox();
    expect(first && last).toBeTruthy();
    // On a later line than the first item, inside the 16 px gutters.
    expect(last!.y).toBeGreaterThan(first!.y);
    expect(last!.x + last!.width).toBeLessThanOrEqual(375 - 15);
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    // No line ends on a dot: each dot shares its line with the item after it.
    const onItemLine = await page.getByTestId('phase-meta').locator('.sep').evaluateAll((els) =>
      els.map((sep) => {
        const next = sep.nextElementSibling?.getBoundingClientRect();
        const dot = sep.getBoundingClientRect();
        const mid = dot.top + dot.height / 2;
        return next !== undefined && mid > next.top && mid < next.bottom;
      }),
    );
    expect(onItemLine.length).toBeGreaterThan(0);
    expect(onItemLine.every(Boolean)).toBe(true);
  });

  test("appending to the worktree's run log updates the page live", async ({ page }) => {
    const wt = worktree();
    await open(page, `${loop.baseURL}/phase/2`);
    await expect(badge(page, '2.2')).toHaveText('Not started');

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
    await appendFile(path.join(wt.runsDir, 'phase-2.jsonl'), `${marker}\n`, 'utf8');
    await expect(badge(page, '2.2')).toHaveText('Implementing', { timeout: APPEAR_MS });
    await expect(railRow(page, 'wave-1-2')).toHaveAttribute('data-row-state', 'running', { timeout: APPEAR_MS });
    // Still shown from the worktree.
    await expect(page.getByTestId('phase-worktree')).toHaveText('Worktree claude/phase-2-trip-journal');
  });
});

// ---------------------------------------------------------------------------
// 375 px
// ---------------------------------------------------------------------------

test.describe('375 px', () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test('no horizontal page scroll, with a row open; the eyebrow hides and rows stay in their lists', async ({ page }) => {
    await page.goto('/phase/2');
    await expect(page.getByTestId('phase-rail')).toBeVisible();
    await expect(page.locator('h1 .eyebrow')).toBeHidden();
    await expect(page.getByRole('heading', { level: 1 })).toHaveAccessibleName(/^Phase 2: /);
    await expect(page.getByTestId('phase-meta')).toBeVisible();
    await card(page, '2.1').getByTestId('card-toggle').click();
    await expect(card(page, '2.1').getByTestId('tasks-table')).toBeVisible();
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);

    for (const section of await page.locator('section[data-rail-row]').all()) {
      const heading = await section.locator('.wave-h').boundingBox();
      const list = await section.locator('ul.sprints').boundingBox();
      expect(heading && list).toBeTruthy();
      expect(list!.y).toBeGreaterThanOrEqual(heading!.y + heading!.height);
      // Inside the 375 px screen, less the 16 px gutters.
      expect(list!.x).toBeGreaterThanOrEqual(15);
      expect(list!.x + list!.width).toBeLessThanOrEqual(375 - 15);
    }
  });
});
