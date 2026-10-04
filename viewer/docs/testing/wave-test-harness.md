# Wave test harness — phase-viewer

## Start

- `npm run dev` from `phase-runner-repo/viewer/` (Git Bash). Copies `test/fixtures/trail-log` to a temp folder, starts the viewer server on the first free port from 4747, and Vite on 5173 with `/api` proxied to it.
- Ready URL: `http://127.0.0.1:5173/` — printed to stdout as `phase-viewer dev → ...` once both Vite and the server are listening (a few seconds).
- The simulated run (`--script retry` by default) starts ~4s after the process launches and appends a step every 2s (20 steps for `retry`, about 40s: each sprint's `implement` `start` line, its `task` lines one task at a time, then its gate lines), then prints `simulated run: finished`. If you start testing more than ~45s after launching `npm run dev`, the run will already be finished and you'll only see the final state — restart the dev server if you need to observe the live transition, and navigate the browser to it immediately (within the 4s start delay) rather than waiting.
- Stop with SIGTERM/Ctrl+C — it cleans up the temp fixture copy itself. On Windows, `Stop-Process` on the `node ... dev.ts` process works from PowerShell; find it via `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where CommandLine -like '*dev.ts*'`.

## Sign in

No auth in this app yet (read-only local dashboard, Sprint 4.1 scope).

## Seed data

- Fixture: `test/fixtures/trail-log` — project name `trail-log`, 3 phases, 22 tasks. This is the one `npm run dev` uses by default and what Sprint 4.1's acceptance notes refer to.
- Other fixtures exist (`sample-project`, `multi-phase`, `broken`, `legacy-table`, `mixed-symbols`, `sparse-rows`) but aren't wired into `npm run dev` without `--fixture <name>`.

## Fixtures / state

- `npm run dev` always works on a temp copy (`%TEMP%\phase-viewer-sim-XXXXXX\trail-log`), never the checked-in fixture — safe to leave running, no cleanup needed in the repo itself.

## Don't touch

- Nothing reaches production; everything is local temp files and localhost ports.

## Routes and hooks (unified interface, Sprint 7.3–7.4)

- `/` is the phase kanban (home). `/?phase=N` opens phase N's slide-in panel over the kanban. `/list` and `/list?phase=N` are the list view. `/` remembers the last layout (List vs Kanban) via localStorage and goes to `/list` when nothing is stored (List is the default); the Kanban toggle always lands on the kanban.
- Old routes redirect (Sprint 7.3, kept through 7.4's screen deletion): `/overview` → `/` if Kanban is the stored layout, else `/list`, `/live` → `/?phase=N` for the default phase (N = most recent run activity, else first with work left) regardless of stored layout, `/phase/:n` → `/?phase=n`, `/sprint/:id` → `/?phase={its phase}#s{id}`. Verified manually 2026-09-29: all four land correctly with no console errors.
- Test hooks: `section[data-lane]` (kanban lanes: `future|progress|complete`, each with `[data-testid=lane-count]`, and `[data-testid=lane-empty]` when it has no phases), `a[data-kan-col]` (phase cards in the lanes), `li[data-tile]` (kanban tiles), `[data-testid=slide-panel]`, `[data-testid=scrim]`, `button[data-filter]` (`all|progress|complete|future`, list view only), `[data-testid=view-toggle]` with `role=group aria-label=Layout`, `a[data-phase-item]` (list rows). The rail (inside the panel or list) renders sprint cards with an expandable task table, acceptance criteria, dependencies and verification — this now covers what the old Phase page / Sprint detail screens showed.
- The project name is only in the document title ("Phase N: Title · phase-runner" or "Phases · phase-runner"); the top bar has none by design.
- Connection lost: with the page already open, stop the `dev.ts` process. The loaded page keeps its last snapshot and shows the banner within a second or two; start `npm run dev` again on the same ports and it reconnects (backoff up to 10 s) and the banner goes. `tests/e2e/harness.ts` does the same with only the viewer server stopped; `tests/e2e/shell.spec.ts` covers this against a harness server, so a wave test only needs to re-check it live if a server it started is already up.
- A dev server can be pointed at a real project instead of a fixture: `npm run dev -- --project <path>` (e.g. this workspace root, to test against the real `docs/phases`). Check `Get-CimInstance Win32_Process -Filter "Name='node.exe'"` for an existing `dev.ts --project ...` before starting a new one — reuse it if found.

## Removed screens (deleted Sprint 7.4)

The Overview, Live run, Sprint detail and Phase page screens, the top-bar tabs, the phase plan sidebar, the phase picker and the status legend are gone, replaced by the kanban / slide-in panel / list view above. Their old test hooks (`phase-sidebar`, `phase-picker`, `phase-progress`, `sprint-list`, `live-run`, `overview`, `phase-page`, `sprint-page`) no longer exist. Shared pieces the rail still uses (tasks table, acceptance criteria, badges, status bar) survived the deletion.

## Quirks

- **A long-running dev server can log stale HMR errors on the first navigation after heavy edits.** A `dev.ts` process left running across many file edits (e.g. across a whole sprint's implementation) can surface leftover `ReferenceError`s in the console from a prior failed HMR update, even though the page renders correctly and a fresh tab shows a clean console. Don't fail a wave test on a console error alone if it doesn't reproduce in a brand-new tab — open one (`browser_tabs` action `new`) and re-check before flagging it as CONSOLE_ERRORS.
- **Playwright MCP browser profile can go stale.** If `browser_navigate` errors with "Browser is already in use for ...mcp-chrome-<id>...", a previous session's Chrome processes are still holding that profile (they survive past the owning process's lifetime on Windows). Find and kill them: `Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine -like '*mcp-chrome-<id>*' } | Stop-Process -Force`, then retry navigation.
- `data-connection` on `.app` goes straight to `"live"` on a fresh load in dev (no visible `connecting` state in normal conditions — the proxy and server are already up by the time Vite serves the page).
- `prefers-color-scheme` picks the theme; Playwright's `browser_emulate_media({ colorScheme: 'dark' })` + a fresh `browser_navigate` (not just evaluate) is what actually flips `data-theme` on `<html>`.
