/**
 * The unified shell's own states (design-system.md "Loading", "Connection
 * lost", "Unified states"): the loading block before the first snapshot, the
 * layout a bare `/` opens (the list view on a first visit), and
 * the connection-lost banner while the server is away, and the theme choice in
 * the top bar's settings menu. The kanban, filter
 * row, panel, list view and their 375 px layouts are in `board.spec.ts`.
 *
 * The loading test holds back the event stream on the shared `webServer`.
 * The connection test needs a server that stops and returns, so it starts
 * its own dev loop with `startHarness` on ports clear of the shared one
 * (4798 / 4799).
 */
import { expect, test } from '@playwright/test';
import { startHarness, startOnKanban } from './harness.js';

/** The phase the trail-log fixture's newest run-log events belong to. */
const ACTIVE_PHASE = 'Phase 2: Trip Journal';

test.describe('loading', () => {
  test('the loading block shows under the filter row until the first snapshot arrives', async ({ page }) => {
    // Refuse the event stream so no snapshot can arrive.
    await page.route('**/api/events', (route) => route.abort());
    await page.goto('/');

    const loading = page.getByTestId('loading');
    await expect(loading).toBeVisible();
    await expect(loading).toHaveAttribute('role', 'status');
    await expect(loading.locator('h3')).toHaveText('Loading');
    await expect(loading.locator('p')).toHaveText('Reading phase files');
    await expect(page.locator('.app')).toHaveAttribute('data-connection', 'connecting');
    // The shell is up around it; nothing else claims the page yet.
    await expect(page.locator('.app-head')).toBeVisible();
    const row = await page.getByTestId('filter-row').boundingBox();
    const shown = await loading.boundingBox();
    expect(row && shown && shown.y >= row.y + row.height).toBe(true);
    // Never connected, so nothing says the connection was lost.
    await expect(page.getByTestId('connection-lost')).toHaveCount(0);
    await expect(page.getByTestId('list-view')).toHaveCount(0);

    // Let the stream through: the next reconnect brings the snapshot and the list view replaces the block.
    await page.unroute('**/api/events');
    await expect(page.getByTestId('list-view')).toBeVisible({ timeout: 15_000 });
    await expect(loading).toHaveCount(0);
    await expect(page.locator('.app')).toHaveAttribute('data-connection', 'live');
  });
});

test.describe('layout', () => {
  test('a first visit to / opens the list view, and the kanban once it was used last', async ({ page }) => {
    const toggle = page.getByRole('group', { name: 'Layout' });

    // Nothing remembered: the list view.
    await page.goto('/');
    await expect(page).toHaveURL('/list');
    await expect(page.getByTestId('list-view')).toBeVisible();
    await expect(toggle.getByRole('button', { name: 'List' })).toHaveAttribute('aria-pressed', 'true');

    // The kanban, once chosen, is what / opens.
    await toggle.getByRole('button', { name: 'Kanban' }).click();
    await expect(page).toHaveURL('/');
    await expect(page.getByTestId('kanban')).toBeVisible();
    await page.goto('/');
    await expect(page).toHaveURL('/');
    await expect(page.getByTestId('kanban')).toBeVisible();
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
    await page.getByTestId('filter-row').click({ position: { x: 5, y: 5 } });
    await expect(menu).toHaveCount(0);
  });
});

test.describe('connection lost', () => {
  test('the banner shows only while the server is down and the last view stays', async ({ page }) => {
    test.setTimeout(90_000);
    const harness = await startHarness({ clientPort: 4798, serverPort: 4799, freshness: 'fresh' });
    try {
      // The kanban, and the panel of the active phase.
      await startOnKanban(page);
      await page.goto(`${harness.baseURL}/`);
      await expect(page.locator('.app')).toHaveAttribute('data-connection', 'live');
      const columns = page.locator('a[data-kan-col]');
      await expect(columns).toHaveCount(3);
      const active = page.locator('a[data-kan-col="2"]');
      await expect(active).toHaveAccessibleName(ACTIVE_PHASE);

      // Connected: nothing connection-related on screen.
      const banner = page.getByTestId('connection-lost');
      await expect(banner).toHaveCount(0);
      await expect(page.getByText(/connection|reconnect/i)).toHaveCount(0);

      await harness.stopServer();
      await expect(banner).toBeVisible({ timeout: 15_000 });
      await expect(banner).toContainText('Lost connection to the viewer server.');
      await expect(banner).toContainText(/Showing the last update from \d{1,2}:\d{2} (AM|PM)\./);
      await expect(page.locator('.app')).toHaveAttribute('data-connection', 'reconnecting');
      // The last snapshot stays on screen, the banner under the filter row.
      await expect(columns).toHaveCount(3);
      await expect(page.locator('li[data-tile]')).toHaveCount(8);
      const row = await page.getByTestId('filter-row').boundingBox();
      const shown = await banner.boundingBox();
      expect(row && shown && shown.y >= row.y + row.height).toBe(true);
      // An open panel shows it too.
      await active.click();
      await expect(page.getByTestId('slide-panel').getByTestId('connection-lost')).toBeVisible();

      await harness.startServer();
      await expect(banner).toHaveCount(0, { timeout: 30_000 });
      await expect(page.locator('.app')).toHaveAttribute('data-connection', 'live');
      await expect(page.getByTestId('slide-panel').getByTestId('phase-rail')).toHaveAttribute('data-phase', '2');
    } finally {
      await harness.close();
    }
  });
});
