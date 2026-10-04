# phase-runner-hud

An experimental Claude Code mod for [Phase Runner](https://github.com/AyeJK/phase-runner). While `phase-builder` runs a phase, it shows where the run is in the status line and raises a toast when the run needs you. `/phase-status` prints the same information on request, without a model call.

Phase Runner works the same without it. Nothing in the main plugin depends on the mod, and the mod never writes to your project: it only reads `docs/phases/` and the run logs in `docs/phases/.runs/`.

## What it shows

**Status line.** One line under the prompt while a phase is running:

```
P8 · wave 2 · 8.3 verify 2/3
```

That is phase 8, wave 2, Sprint 8.3, in verify, attempt 2 of 3. The gate is one of `implement`, `verify`, `wave-test` or `doc-sync`. A gate that just failed reads `verify failed 2/3` until the retry starts, and a sprint that has passed everything reads `done`. The line follows the run log, so it changes within about 2 seconds of each gate result. The `task` lines an implementer logs as it starts and finishes each task don't change it and raise no toast; [phase-viewer](../viewer/) shows those.

The line shows while the newest run log has an event from the last 30 minutes and its phase isn't complete. Otherwise it's cleared.

**Toasts.** One toast each time a run stops for you:

- **Escalation.** A gate failed on its last allowed attempt, for example verify failing 3 of 3. A failed doc-sync counts too, since doc-sync never retries on its own.
- **Blocker.** An implementer reported a blocked task.
- **Phase complete.** Every sprint in the phase file has passed doc-sync or has all its eligible tasks marked `x`.

Each of these raises one toast, not one per poll. Two sprints that fail the same verify share a toast. Anything that happened before the session started raises nothing.

**`/phase-status`.** Prints the phase, each sprint's tasks as done/eligible, the current wave and gate, and when the last event was logged:

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

Start a new session from your project folder, the one that holds `docs/phases/`. In a folder with no `docs/phases/` the mod does nothing: no status line and no toasts.

## Options

Both are in `/config` once the mod is installed.

| Option | Default | What it does |
|--------|---------|--------------|
| `workspace` | empty | The folder that holds `docs/phases/`, when it isn't the session's directory. Absolute, or relative to the session's directory. |
| `sound` | off | Plays a short chime with each toast. In the terminal, Claude Code plays sounds on macOS only for now; on Windows and Linux the toast shows without one. |

## Claude Code only

This is a Claude Code mod, so it runs in Claude Code: the terminal and the desktop app's Code tab. Cursor and other hosts have no mods and won't load it. Phase Runner's skills run there as before.

## Early-access API

Claude Code's mods API is early access and changes between releases. The mod was written against Claude Code 2.1.287. Its tests also pass on 2.1.277, which has no `$.state` yet: there the mod keeps what it has already toasted in memory instead, and behaves the same except across a hot reload of the mod.

If a Claude Code update breaks the mod, uninstall it from `/plugin`. Your phase runs are not affected.

## Development

```sh
claude plugin validate hud    # the manifest and the hooks module, as the engine reads them
claude plugin test hud        # the tests in hud/test/
```

Run both from the repo root.

The mod reads phase files and run logs with the same parser and derive code as [phase-viewer](../viewer/). A mod can only import files from its own folder, so those modules are copied from `viewer/src/core/` into `hud/hooks/core/`. Don't edit the copies. After a change to the viewer's core, copy them again:

```sh
node hud/scripts/sync-core.mjs            # write the copy
node hud/scripts/sync-core.mjs --check    # exit 1 if the copy has drifted from the source
```

| Path | What it is |
|------|------------|
| `hooks/register.ts` | The hooks module: every call on Claude Code's `$` |
| `hooks/hud.ts` | The status line, toast and `/phase-status` texts, as plain functions |
| `hooks/core/` | Copied from the viewer. Don't edit |
| `types/index.d.ts` | The two values the mod keeps in `$.state` |
| `sounds/chime.wav` | The sound the `sound` option plays |
| `test/` | Tests and their fixtures |
