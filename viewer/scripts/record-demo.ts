#!/usr/bin/env node
/**
 * Record the viewer while a run log replays, as a GIF (the README's demo).
 *
 *     tsx scripts/record-demo.ts --replay <run-log.jsonl> [--from <project> | --fixture trail-log]
 *                                [--start-at <ts>] [--speed 30] [--max-gap 4000] [--gap 9@7000] [--reset-later] [--fill-tasks]
 *                                [--path /list?phase=2] [--width 1280] [--height 800] [--light]
 *                                [--fps 12] [--gif-width 1280] [--hold-start 2500] [--hold-end 4000]
 *                                [--out demo.gif] [--frames <folder>]
 *                                [--notes 2.3@3-7 | --open 2.4@12-18] [--notes-delay 800] [--notes-hold 2500]
 *                                [--bar-url localhost:4747/list] [--no-bar] [--no-crop]
 *
 * 1. Copies the project and gets it ready to replay (`simulate-run.ts`).
 * 2. Starts the viewer server on the copy, serving the built client
 *    (`npm run build` first), and opens `--path` in headless Chromium.
 * 3. Plays the replay and screenshots the page as it goes. Before each frame
 *    the page's clock is set to the replay's clock, so "so far" and wave
 *    durations read as they were logged, not squeezed by `--speed`.
 * 4. Sprint cards the viewer opens on its own as they start running are
 *    closed again, so every sprint stays in frame. With `--notes`, one card
 *    and its Run notes open `--notes-delay` after the first step named, and
 *    close `--notes-hold` after the last (where a failed attempt shows, and
 *    then how it was fixed). `--open` does the same with only the card open:
 *    its tasks, and the failure under them while it's retried. `--gap 9@7000`
 *    lets step 9 come up to 7000 ms after the step before it, instead of
 *    `--max-gap`: for an implementation shown in an open card, so each task
 *    is seen Running before it reads Built.
 * 5. Turns the frames into a GIF with ffmpeg (on PATH), with one palette
 *    built from a sample of frames across the whole clip (and its last).
 *    The GIF is cropped a little below the lowest content any frame showed
 *    (`--no-crop` keeps the full viewport), and a plain browser toolbar
 *    showing `--bar-url` goes on top (`--no-bar` leaves it off).
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { chromium } from '@playwright/test';
import { DEFAULT_CLIENT_DIR, startViewerServer } from '../src/server/http.js';
import { HOST } from '../src/server/port.js';
import { fillTasks, parseMs, parseSpeed, prepareFixture, prepareReplay, readReplay, simulateRun } from './simulate-run.js';

/** Time allowed for the page to load before the first step plays. */
const LOAD_BUDGET_MS = 6_000;

/**
 * Runs in the page (a string: this tsconfig has no DOM types). Closes every
 * sprint card that's open, on each DOM change, before the browser paints.
 */
const CLOSE_OPENED_CARDS = `
  window.__keepOpen = new Set();
  new MutationObserver(() => {
    for (const card of document.querySelectorAll('article[data-sprint-card][data-open="true"]')) {
      if (!window.__keepOpen.has(card.dataset.sprintCard)) card.querySelector('[data-testid="card-toggle"]')?.click();
    }
  }).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-open'] });
`;

/**
 * Open a sprint card and scroll it into view: with `runNotes`, its Run notes
 * too, keeping their end in view; otherwise the card from its top, so its
 * badge stays in frame.
 */
const showCard = (id: string, runNotes: boolean): string => `(() => {
  window.__keepOpen.add(${JSON.stringify(id)});
  const card = document.querySelector('article[data-sprint-card=${JSON.stringify(id)}]');
  if (!card) return;
  if (card.dataset.open !== 'true') card.querySelector('[data-testid="card-toggle"]').click();
  requestAnimationFrame(() => {
    const notes = ${runNotes} ? card.querySelector('details[data-row="run-notes"]') : null;
    if (notes) notes.open = true;
    if (!notes) {
      card.scrollIntoView({ block: 'start', behavior: 'smooth' });
      return;
    }
    notes.scrollIntoView({ block: 'end', behavior: 'smooth' });
    // Keep the notes' end in view as new notes land.
    window.__notesResize = new ResizeObserver(() => notes.scrollIntoView({ block: 'end', behavior: 'smooth' }));
    window.__notesResize.observe(notes);
  });
})()`;

/** Close a card opened by {@link showCard} and scroll back to the top. */
const hideCard = (id: string): string => `(() => {
  window.__notesResize?.disconnect();
  window.__keepOpen.delete(${JSON.stringify(id)});
  const card = document.querySelector('article[data-sprint-card=${JSON.stringify(id)}]');
  if (card && card.dataset.open === 'true') card.querySelector('[data-testid="card-toggle"]').click();
  window.scrollTo({ top: 0, behavior: 'smooth' });
})()`;

/**
 * Runs in the page: the lowest point any content reaches in the viewport, in
 * CSS px. Tall containers (the sidebar, the page) are skipped, so only the
 * things inside them count; anything cut off by the bottom edge counts as
 * reaching it.
 */
const CONTENT_BOTTOM = `(() => {
  let bottom = 0;
  for (const el of document.body.querySelectorAll('*')) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0 || r.height >= innerHeight / 2 || r.top >= innerHeight) continue;
    bottom = Math.max(bottom, Math.min(r.bottom, innerHeight));
  }
  return Math.ceil(bottom);
})()`;

/** Space kept under the lowest content when cropping. */
const CROP_MARGIN = 24;

/** Height of the browser toolbar drawn on top of the GIF. */
const BAR_HEIGHT = 48;

/**
 * A plain browser toolbar: window dots, back, forward, reload and the address.
 * It's rendered in a page of the viewer itself, so it gets the bundled IBM
 * Plex fonts and the theme tokens (dark or light, like the recording).
 */
const browserBar = (url: string): string => {
  const slash = url.indexOf('/');
  const host = slash === -1 ? url : url.slice(0, slash);
  const rest = slash === -1 ? '' : url.slice(slash);
  const icon = (d: string, off = false): string =>
    `<span class="rd-btn${off ? ' off' : ''}"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${d}</svg></span>`;
  const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
  return `<style>
    body { margin: 0; background: var(--bg); }
    .rd-bar { height: ${BAR_HEIGHT}px; box-sizing: border-box; display: flex; align-items: center; gap: 6px; padding: 0 14px; background: var(--surface); border-bottom: 1px solid var(--border); font-family: var(--sans); }
    .rd-dots { display: flex; gap: 8px; margin-right: 14px; }
    .rd-dots i { width: 12px; height: 12px; border-radius: 50%; background: var(--border); }
    .rd-btn { width: 30px; height: 30px; display: grid; place-items: center; color: var(--text-3); }
    .rd-btn.off { opacity: 0.45; }
    .rd-btn svg { width: 16px; height: 16px; }
    .rd-url { flex: 1; height: 32px; margin-left: 6px; display: flex; align-items: center; gap: 8px; padding: 0 14px; background: var(--bg); border: 1px solid var(--border); border-radius: 16px; font-size: 14px; color: var(--text-3); }
    .rd-url b { font-weight: 400; color: var(--text); }
    .rd-url svg { width: 14px; height: 14px; }
  </style>
  <div class="rd-bar">
    <div class="rd-dots"><i></i><i></i><i></i></div>
    ${icon('<path d="M10 3 5 8l5 5"/>')}${icon('<path d="m6 3 5 5-5 5"/>', true)}${icon('<path d="M13 8a5 5 0 1 1-1.5-3.6"/><path d="M13 2.5V5h-2.5"/>')}
    <div class="rd-url"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><circle cx="8" cy="8" r="6"/><path d="M8 7v4M8 5v.01" stroke-linecap="round"/></svg><span><b>${esc(host)}</b>${esc(rest)}</span></div>
  </div>`;
};

/**
 * `--notes 2.3@3-7`: show sprint 2.3's Run notes from step 3 to step 7 (1-based, as the steps print).
 * `--open 2.4@12-18`: the same with only the card open (its tasks, and the failure being retried).
 */
function parseShown(raw: string | undefined, flag: string): { sprint: string; from: number; to: number } | null {
  if (raw === undefined) return null;
  const m = /^([\w.]+)@(\d+)-(\d+)$/.exec(raw.trim());
  if (!m) throw new Error(`${flag} must look like 2.3@3-7 (sprint @ first step - last step)`);
  return { sprint: m[1]!, from: Number(m[2]), to: Number(m[3]) };
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      replay: { type: 'string' },
      from: { type: 'string' },
      fixture: { type: 'string' },
      'start-at': { type: 'string' },
      speed: { type: 'string' },
      'max-gap': { type: 'string' },
      gap: { type: 'string' },
      path: { type: 'string' },
      width: { type: 'string' },
      height: { type: 'string' },
      light: { type: 'boolean' },
      fps: { type: 'string' },
      'gif-width': { type: 'string' },
      'hold-start': { type: 'string' },
      'hold-end': { type: 'string' },
      out: { type: 'string' },
      frames: { type: 'string' },
      'reset-later': { type: 'boolean' },
      'fill-tasks': { type: 'boolean' },
      notes: { type: 'string' },
      open: { type: 'string' },
      'notes-delay': { type: 'string' },
      'notes-hold': { type: 'string' },
      'bar-url': { type: 'string' },
      'no-bar': { type: 'boolean' },
      'no-crop': { type: 'boolean' },
    },
    strict: true,
    allowPositionals: false,
  });

  if (values.replay === undefined) throw new Error('--replay <run-log.jsonl> is required');
  if (!existsSync(path.join(DEFAULT_CLIENT_DIR, 'index.html'))) throw new Error('No built client: run `npm run build` first');
  const num = (raw: string | undefined, fallback: number, flag: string): number => {
    if (raw === undefined) return fallback;
    const n = parseMs(raw);
    if (n === null || n === 0) throw new Error(`${flag} must be a whole number above 0`);
    return n;
  };
  const speed = values.speed === undefined ? 30 : parseSpeed(values.speed);
  if (speed === null) throw new Error('--speed must be a number above 0');
  const width = num(values.width, 1280, '--width');
  const height = num(values.height, 800, '--height');
  const fps = num(values.fps, 12, '--fps');
  const gifWidth = num(values['gif-width'], width, '--gif-width');
  const holdStart = num(values['hold-start'], 2_500, '--hold-start');
  const holdEnd = num(values['hold-end'], 4_000, '--hold-end');
  const maxGapMs = values['max-gap'] === undefined ? undefined : num(values['max-gap'], 0, '--max-gap');
  const out = path.resolve(values.out ?? 'demo.gif');
  if (values.notes !== undefined && values.open !== undefined) throw new Error('--notes and --open each open a card; give one');
  const notes = parseShown(values.notes, '--notes') ?? parseShown(values.open, '--open');
  const runNotes = values.notes !== undefined;
  const notesDelay = num(values['notes-delay'], 800, '--notes-delay');
  const notesHold = num(values['notes-hold'], 2_500, '--notes-hold');
  const pagePath = values.path ?? '/list';
  // The address shows the port a user would get (4747), not the recorder's own.
  const barUrl = values['bar-url'] ?? `localhost:4747${pagePath}`;

  // 1. The copy, reset and seeded. The first step lands once the page has loaded and held.
  const fixture = await prepareFixture({ fixture: values.fixture, source: values.from, freshness: 'as-is' });
  const framesDir = values.frames === undefined ? await mkdtemp(path.join(tmpdir(), 'phase-viewer-frames-')) : path.resolve(values.frames);
  await mkdir(framesDir, { recursive: true });
  const origin = Date.now() + LOAD_BUDGET_MS + holdStart;
  let steps = await prepareReplay(fixture.root, await readReplay(path.resolve(values.replay)), {
    startAt: values['start-at'],
    origin,
    resetLater: values['reset-later'],
  });
  if (values['fill-tasks']) steps = await fillTasks(fixture.root, steps);
  const logged = steps.filter((s) => !s.filler).length;
  if (values.gap !== undefined) {
    // `--gap 9@7000`: logged step 9 (1-based, as the steps print) may wait up to 7000 ms.
    const m = /^(\d+)@(\d+)$/.exec(values.gap.trim());
    const step = m ? steps.filter((s) => !s.filler)[Number(m[1]) - 1] : undefined;
    if (!m || !step) throw new Error(`--gap must look like 9@7000 (step @ longest wait in ms), with a step from 1 to ${logged}`);
    step.maxGapMs = Number(m[2]);
  }

  // 2. Server and page.
  const server = await startViewerServer({ port: 4800, host: HOST, workspace: { kind: 'found', root: fixture.root, source: 'dir' } });
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width, height }, colorScheme: values.light ? 'light' : 'dark' });
    await page.clock.setFixedTime(Date.now());
    await page.addInitScript({ content: CLOSE_OPENED_CARDS });
    await page.goto(`${server.url}${pagePath}`);
    await page.waitForSelector('article[data-sprint-card]');
    await page.mouse.move(width - 1, height - 1);

    // 3. Play and capture. Steps are counted without fillers, as they print.
    let loggedDone = 0;
    const sim = simulateRun({
      root: fixture.root,
      steps,
      speed,
      maxGapMs,
      origin,
      startDelayMs: Math.max(0, origin - Date.now()),
      onStep: (step) => {
        if (step.filler) return;
        const n = ++loggedDone;
        process.stdout.write(`step ${n}/${logged}: ${step.events.map((e) => `${e.sprint} ${e.gate} ${e.result}`).join(', ')}\n`);
        if (notes && n === notes.from) setTimeout(() => void page.evaluate(showCard(notes.sprint, runNotes)), notesDelay);
        if (notes && n === notes.to) setTimeout(() => void page.evaluate(hideCard(notes.sprint)), notesHold);
      },
    });
    let finished = false;
    void sim.done.then(() => (finished = true));

    const frames: Array<{ file: string; at: number }> = [];
    let contentBottom = 0;
    const recordFrom = origin - holdStart;
    let endAt = Infinity;
    const frameMs = 1000 / fps;
    while (Date.now() < endAt) {
      const now = Date.now();
      if (finished && endAt === Infinity) endAt = now + holdEnd;
      await page.clock.setFixedTime(sim.clock());
      if (now >= recordFrom) {
        const file = path.join(framesDir, `f${String(frames.length).padStart(5, '0')}.png`);
        await page.screenshot({ path: file });
        frames.push({ file, at: now });
        if (!values['no-crop']) contentBottom = Math.max(contentBottom, (await page.evaluate(CONTENT_BOTTOM)) as number);
      }
      const wait = frameMs - (Date.now() - now);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    }
    process.stdout.write(`${frames.length} frames over ${((frames.at(-1)!.at - frames[0]!.at) / 1000).toFixed(1)} s\n`);

    // 5. GIF: each frame lasts until the next was taken.
    const list = frames
      .map((f, i) => {
        const next = frames[i + 1]?.at ?? f.at + frameMs;
        return `file '${f.file.replaceAll('\\', '/')}'\nduration ${((next - f.at) / 1000).toFixed(3)}`;
      })
      .join('\n');
    const listFile = path.join(framesDir, 'frames.txt');
    await writeFile(listFile, `${list}\nfile '${frames.at(-1)!.file.replaceAll('\\', '/')}'\n`, 'utf8');
    // One palette from every 20th frame plus the last, weighting each equally, so a colour
    // that only shows late or small (a pink Needs you at the end) still gets exact entries.
    const sample = frames.filter((_, i) => i % 20 === 0 || i === frames.length - 1);
    const sampleFile = path.join(framesDir, 'palette-frames.txt');
    await writeFile(sampleFile, sample.map((f) => `file '${f.file.replaceAll('\\', '/')}'`).join('\n') + '\n', 'utf8');
    const palette = path.join(framesDir, 'palette.png');
    const scale = `scale=${gifWidth}:-1:flags=lanczos`;

    // Crop to the content, and put the toolbar on top. Both passes (palette and GIF) build the
    // same picture from input 0 (the frames) and the last input (the toolbar, when there is one).
    const cropHeight = values['no-crop'] ? height : Math.min(height, contentBottom + CROP_MARGIN);
    const bar = path.join(framesDir, 'browser-bar.png');
    if (!values['no-bar']) {
      const barPage = await browser.newPage({ viewport: { width, height: BAR_HEIGHT }, colorScheme: values.light ? 'light' : 'dark' });
      await barPage.goto(`${server.url}/`); // for the bundled fonts and the theme tokens
      await barPage.evaluate(`document.body.innerHTML = ${JSON.stringify(browserBar(barUrl))}`);
      await barPage.evaluate('document.fonts.ready');
      await barPage.locator('.rd-bar').screenshot({ path: bar });
      await barPage.close();
    }
    const compose = (barInput: number): string =>
      values['no-bar']
        ? `[0:v]crop=${width}:${cropHeight}:0:0`
        : `[0:v]crop=${width}:${cropHeight}:0:0,pad=${width}:${cropHeight + BAR_HEIGHT}:0:${BAR_HEIGHT}[pg];[pg][${barInput}:v]overlay=0:0:shortest=1`;
    const barArgs = values['no-bar'] ? [] : ['-loop', '1', '-i', bar];
    process.stdout.write(`frame: ${width}x${cropHeight} (content ends at ${contentBottom || height}px)${values['no-bar'] ? '' : ` + ${BAR_HEIGHT}px bar`}\n`);

    await ffmpeg(['-y', '-f', 'concat', '-safe', '0', '-i', sampleFile, ...barArgs, '-lavfi', `${compose(1)},${scale},palettegen=max_colors=256:stats_mode=full`, palette]);
    await ffmpeg([
      '-y',
      '-f', 'concat', '-safe', '0', '-i', listFile,
      '-i', palette,
      ...barArgs,
      '-lavfi', `fps=${fps},${compose(2).replace('[0:v]', '')}[c];[c]${scale}[x];[x][1:v]paletteuse=dither=none:diff_mode=rectangle`,
      '-loop', '0',
      out,
    ]);
    process.stdout.write(`gif: ${out}\n`);
  } finally {
    await browser.close();
    await server.close();
    await fixture.cleanup();
    if (values.frames === undefined) await rm(framesDir, { recursive: true, force: true });
  }
}

function ffmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...args], { stdio: 'inherit' });
    child.on('error', (err) => reject(new Error(`ffmpeg: ${err.message} (is it on PATH?)`)));
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited with ${code}`))));
  });
}

main().catch((err: unknown) => {
  process.stderr.write(`record-demo: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
