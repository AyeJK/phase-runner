# phase-runner-hud

An experimental Claude Code mod for [Phase Runner](https://github.com/AyeJK/phase-runner). It puts a Phase Runner pane beside the conversation: phase-viewer's screens, with the live run on top while `phase-builder` runs a phase. It raises a toast when the run needs you, and `/phase-status` prints where the run is without a model call.

Phase Runner works the same without it. Nothing in the main plugin depends on the mod, and the mod never writes to your project: it only reads `docs/phases/` and the run logs in `docs/phases/.runs/`.

## What it shows

**The pane.** A full alternative to the [phase-viewer](../viewer/) web page, in a pane of its own. It opens when a session starts in a Phase Runner project, again when a run goes live, and on `/phase-status`. Close it from its mark; it stays closed until the next run starts.

- **Phases.** Every phase, grouped In progress, Not started and Complete, with its badge (`Running · wave 2 of 3`, `Needs you`, `Complete`), its done/eligible task count, parse warnings, and the viewer's status bar. Click a phase to open it.
- **A phase.** The viewer's phase rail: the heading and badge, a banner for each escalation and for lines that couldn't be read, the status bar, then each wave of the latest run (sequential or parallel, how long it took, its retries) with a card per sprint. A card shows the sprint's state (`Re-verifying`, `Verify failed`, `Needs you`) and its task bar, and opens in place, the running ones from the start: the goal, every task with its status (`Running` and `Built` from the implementer's task lines), the failure being retried and what happens next, then acceptance criteria, dependencies, verification and run notes. A banner under the last wave says when the run is complete or paused, and what needs you.

The states, badges and words are the viewer's own: the pane draws from the same derivation code, so the two never disagree. On the desktop, headings are drawn large, a click anywhere on a phase card opens it and on a sprint card's header opens or closes it, ‹ All phases is a bordered pill, and the status bars are drawn in the viewer's colors for light and dark. In the terminal the same screens use plain buttons and a line of colored blocks for each bar.

**The live line.** At the top of the pane while a phase is running:

```
↻ LIVE  P8 · wave 2 · 8.3 verify 2/3                4:12 PM
```

That is phase 8, wave 2, Sprint 8.3, in verify, attempt 2 of 3, and the time of the last event. The gate is one of `implement`, `verify`, `wave-test` or `doc-sync`. A gate that just failed reads `verify failed 2/3` until the retry starts, and a sprint that has passed everything reads `done`. The line follows the run log, so it changes within about 2 seconds of each gate result. The `task` lines an implementer logs as it starts and finishes each task don't change it and raise no toast; the sprint card's task rows show those. Press the line to open its phase.

The line shows while the newest run log has an event from the last 30 minutes and its phase isn't complete. While it shows, the pane follows that phase until you open another. Earlier versions of the mod kept this line on the status line under the prompt; this one clears it.

**Toasts.** One toast each time a run stops for you:

- **Escalation.** A gate failed on its last allowed attempt, for example verify failing 3 of 3. A failed doc-sync counts too, since doc-sync never retries on its own.
- **Blocker.** An implementer reported a blocked task.
- **Phase complete.** Every sprint in the phase file has passed doc-sync or has all its eligible tasks marked `x`.

Each of these raises one toast, not one per poll. Two sprints that fail the same verify share a toast. Anything that happened before the session started raises nothing.

**`/phase-status`.** Opens the pane and prints the phase, each sprint's tasks as done/eligible, the current wave and gate, and when the last event was logged:

```
Phase 8 — Claude Integration
Sprints: 8.1 5/5 · 8.2 9/10 · 8.3 2/6 · 8.4 0/4 (16/25 tasks)
Now: wave 2 · 8.3 verify 2/3
Last event: 4:12 PM, 3 min ago
```

The mod answers this itself from the files on disk. It starts no turn and uses no tokens.

## Install

In Claude Code, with the Phase Runner marketplace added:

```
/plugin marketplace add AyeJK/phase-runner
/plugin install phase-runner-hud@phase-runner
```

Start a new session from your project folder, the one that holds `docs/phases/`. In a folder with no `docs/phases/` the mod stays quiet: the pane doesn't open and nothing raises a toast.

## Options

Both are in `/config` once the mod is installed.

| Option | Default | What it does |
|--------|---------|--------------|
| `workspace` | empty | The folder that holds `docs/phases/`, when it isn't the session's directory. Absolute, or relative to the session's directory. |
| `sound` | off | Plays a short chime with each toast. In the terminal, Claude Code plays sounds on macOS only for now; on Windows and Linux the toast shows without one. |

## Claude Code only

This is a Claude Code mod, so it runs in Claude Code: the terminal and the desktop app's Code tab. Cursor and other hosts have no mods and won't load it. Phase Runner's skills run there as before.

In the terminal the pane docks beside the transcript in the fullscreen layout. On the main screen it opens above the prompt when you ask for it (`/phase-status`), and an unasked open waits for a wide enough window.

## Early-access API

Claude Code's mods API is early access and changes between releases. The pane was written against Claude Code 2.1.299, the first release it knows draws text sizes, weights and a monospaced face. On an older release with panes (its tests run on 2.1.289) it draws the same screens in plain and bold text.

If a Claude Code update breaks the mod, uninstall it from `/plugin`. Your phase runs are not affected.

## Development

```sh
claude plugin validate hud    # the manifest and the hooks module, as the engine reads them
claude plugin test hud        # the tests in hud/test/
```

Run both from the repo root.

The mod reads phase files and run logs with the same parser and derive code as [phase-viewer](../viewer/), and draws the pane from the same view derivations as the viewer's screens. A mod can only import files from its own folder, so those modules are copied from `viewer/src/core/` and `viewer/src/client/` into `hud/hooks/core/` and `hud/hooks/client/`. Don't edit the copies. After a change to either, copy them again:

```sh
node hud/scripts/sync-core.mjs            # write the copy
node hud/scripts/sync-core.mjs --check    # exit 1 if the copy has drifted from the source
```

| Path | What it is |
|------|------------|
| `hooks/register.tsx` | The hooks module: every call on Claude Code's `# phase-runner-hud

An experimental Claude Code mod for [Phase Runner](https://github.com/AyeJK/phase-runner). It puts a Phase Runner pane beside the conversation: phase-viewer's screens, with the live run on top while `phase-builder` runs a phase. It raises a toast when the run needs you, and `/phase-status` prints where the run is without a model call.

Phase Runner works the same without it. Nothing in the main plugin depends on the mod, and the mod never writes to your project: it only reads `docs/phases/` and the run logs in `docs/phases/.runs/`.

## What it shows

**The pane.** A full alternative to the [phase-viewer](../viewer/) web page, in a pane of its own. It opens when a session starts in a Phase Runner project, again when a run goes live, and on `/phase-status`. Close it from its mark; it stays closed until the next run starts.

- **Phases.** Every phase, grouped In progress, Not started and Complete, with its badge (`Running · wave 2 of 3`, `Needs you`, `Complete`), its done/eligible task count, parse warnings, and the viewer's status bar. Press a phase's title to open it.
- **A phase.** The viewer's phase rail: the heading and badge, a banner for each escalation and for lines that couldn't be read, the status bar, then each wave of the latest run (sequential or parallel, how long it took, its retries) with a card per sprint. A card shows the sprint's state (`Re-verifying`, `Verify failed`, `Needs you`) and its task bar, and opens in place, the running ones from the start: the goal, every task with its status (`Running` and `Built` from the implementer's task lines), the failure being retried and what happens next, then acceptance criteria, dependencies, verification and run notes. A banner under the last wave says when the run is complete or paused, and what needs you.

The states, badges and words are the viewer's own: the pane draws from the same derivation code, so the two never disagree. On the desktop the status bars are drawn in the viewer's colors for light and dark; in the terminal they are a line of colored blocks.

**The live line.** At the top of the pane while a phase is running:

```
↻ LIVE  P8 · wave 2 · 8.3 verify 2/3                4:12 PM
```

That is phase 8, wave 2, Sprint 8.3, in verify, attempt 2 of 3, and the time of the last event. The gate is one of `implement`, `verify`, `wave-test` or `doc-sync`. A gate that just failed reads `verify failed 2/3` until the retry starts, and a sprint that has passed everything reads `done`. The line follows the run log, so it changes within about 2 seconds of each gate result. The `task` lines an implementer logs as it starts and finishes each task don't change it and raise no toast; the sprint card's task rows show those. Press the line to open its phase.

The line shows while the newest run log has an event from the last 30 minutes and its phase isn't complete. While it shows, the pane follows that phase until you open another. Earlier versions of the mod kept this line on the status line under the prompt; this one clears it.

**Toasts.** One toast each time a run stops for you:

- **Escalation.** A gate failed on its last allowed attempt, for example verify failing 3 of 3. A failed doc-sync counts too, since doc-sync never retries on its own.
- **Blocker.** An implementer reported a blocked task.
- **Phase complete.** Every sprint in the phase file has passed doc-sync or has all its eligible tasks marked `x`.

Each of these raises one toast, not one per poll. Two sprints that fail the same verify share a toast. Anything that happened before the session started raises nothing.

**`/phase-status`.** Opens the pane and prints the phase, each sprint's tasks as done/eligible, the current wave and gate, and when the last event was logged:

```
Phase 8 — Claude Integration
Sprints: 8.1 5/5 · 8.2 9/10 · 8.3 2/6 · 8.4 0/4 (16/25 tasks)
Now: wave 2 · 8.3 verify 2/3
Last event: 4:12 PM, 3 min ago
```

The mod answers this itself from the files on disk. It starts no turn and uses no tokens.

## Install

In Claude Code, with the Phase Runner marketplace added:

```
/plugin marketplace add AyeJK/phase-runner
/plugin install phase-runner-hud@phase-runner
```

Start a new session from your project folder, the one that holds `docs/phases/`. In a folder with no `docs/phases/` the mod stays quiet: the pane doesn't open and nothing raises a toast.

## Options

Both are in `/config` once the mod is installed.

| Option | Default | What it does |
|--------|---------|--------------|
| `workspace` | empty | The folder that holds `docs/phases/`, when it isn't the session's directory. Absolute, or relative to the session's directory. |
| `sound` | off | Plays a short chime with each toast. In the terminal, Claude Code plays sounds on macOS only for now; on Windows and Linux the toast shows without one. |

## Claude Code only

This is a Claude Code mod, so it runs in Claude Code: the terminal and the desktop app's Code tab. Cursor and other hosts have no mods and won't load it. Phase Runner's skills run there as before.

In the terminal the pane docks beside the transcript in the fullscreen layout. On the main screen it opens above the prompt when you ask for it (`/phase-status`), and an unasked open waits for a wide enough window.

## Early-access API

Claude Code's mods API is early access and changes between releases. The pane was written against Claude Code 2.1.299, the first release it knows draws text sizes, weights and a monospaced face. On an older release with panes (its tests run on 2.1.289) it draws the same screens in plain and bold text.

If a Claude Code update breaks the mod, uninstall it from `/plugin`. Your phase runs are not affected.

## Development

```sh
claude plugin validate hud    # the manifest and the hooks module, as the engine reads them
claude plugin test hud        # the tests in hud/test/
```

Run both from the repo root.

The mod reads phase files and run logs with the same parser and derive code as [phase-viewer](../viewer/), and draws the pane from the same view derivations as the viewer's screens. A mod can only import files from its own folder, so those modules are copied from `viewer/src/core/` and `viewer/src/client/` into `hud/hooks/core/` and `hud/hooks/client/`. Don't edit the copies. After a change to either, copy them again:

```sh
node hud/scripts/sync-core.mjs            # write the copy
node hud/scripts/sync-core.mjs --check    # exit 1 if the copy has drifted from the source
```

| Path | What it is |
|------|------------|
, and the desktop's pill controls |
| `hooks/pill.tsx` | A control's label on the desktop: a `Client` that draws the words and posts the press |
| `hooks/hit.tsx` | A card as something to click on the desktop: a clear `Client` laid over it |
| `hooks/pane.tsx` | The pane's screens, drawn with a surface's elements, as plain functions |
| `hooks/project.ts` | Every phase file and run log into the viewer's `Project`, as the viewer's loader builds it |
| `hooks/hud.ts` | The live line, toast and `/phase-status` texts, as plain functions |
| `hooks/core/`, `hooks/client/` | Copied from the viewer. Don't edit |
| `types/index.d.ts` | The values the mod keeps in `$.state`: toasts raised, and what the pane shows |
| `sounds/chime.wav` | The sound the `sound` option plays |
| `test/` | Tests and their fixtures |
