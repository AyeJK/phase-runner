# phase-runner-hud

An experimental Claude Code mod for [Phase Runner](https://github.com/AyeJK/phase-runner). It raises a toast when a run needs you, and `/phase-status` prints where the run is without a model call. It draws nothing else. For the full picture of a run, use [phase-viewer](../viewer/), the dashboard.

Phase Runner works the same without it. Nothing in the main plugin depends on the mod, and the mod never writes to your project: it only reads `docs/phases/` and the run logs in `docs/phases/.runs/`.

## What it does

**Toasts.** One toast each time a run stops for you:

- **Escalation.** A gate failed on its last allowed attempt, for example verify failing 3 of 3. A failed doc-sync counts too, since doc-sync never retries on its own.
- **Blocker.** An implementer reported a blocked task.
- **Phase complete.** Every sprint in the phase file has passed doc-sync or has all its eligible tasks marked `x`.

Each of these raises one toast, not one per poll. Two sprints that fail the same verify share a toast. Anything that happened before the session started raises nothing. The mod checks the newest run log every 2 seconds, so a toast lands within about 2 seconds of the line that caused it. The `task` lines an implementer logs as it starts and finishes each task raise no toast.

**`/phase-status`.** Prints the phase of the newest run log, each sprint's tasks as done/eligible, the current wave and gate, and when the last event was logged:

```
Phase 8 — Claude Integration
Sprints: 8.1 5/5 · 8.2 9/10 · 8.3 2/6 · 8.4 0/4 (16/25 tasks)
Now: wave 2 · 8.3 verify 2/3
Last event: 4:12 PM, 3 min ago
```

`Now:` names the wave, the sprint, the gate (`implement`, `verify`, `wave-test` or `doc-sync`) and the attempt. A gate that just failed reads `verify failed 2/3` until the retry starts, and a sprint that has passed everything reads `done`. When the log has had no event for 30 minutes the line says so, and when the phase is complete it reads `phase complete`.

The mod answers this itself from the files on disk. It starts no turn and uses no tokens. The states and words are phase-viewer's own: the mod reads the files with the viewer's parser and derive code, so the two never disagree.

## Install

In Claude Code:

```
/plugin install phase-runner-hud --marketplace AyeJK/phase-runner
```

Start a new session from your project folder, the one that holds `docs/phases/`. In a folder with no `docs/phases/` the mod stays quiet and nothing raises a toast.

## Options

Both are in `/config` once the mod is installed.

| Option | Default | What it does |
|--------|---------|--------------|
| `workspace` | empty | The folder that holds `docs/phases/`, when it isn't the session's directory. Absolute, or relative to the session's directory. |
| `sound` | off | Plays a short chime with each toast. In the terminal, Claude Code plays sounds on macOS only for now; on Windows and Linux the toast shows without one. |

## Claude Code only

This is a Claude Code mod, so it runs in Claude Code: the terminal and the desktop app's Code tab. Cursor and other hosts have no mods and won't load it. Phase Runner's skills run there as before.

## Early-access API

Claude Code's mods API is early access and changes between releases. If a Claude Code update breaks the mod, uninstall it from `/plugin`. Your phase runs are not affected.

Versions before 0.3.0 also drew a Phase Runner pane with phase-viewer's screens and a live line for the running phase. Both are gone: phase-viewer is the one dashboard.

## Development

```sh
claude plugin validate hud    # the manifest and the hooks module, as the engine reads them
claude plugin test hud        # the tests in hud/test/
```

Run both from the repo root.

The mod reads phase files and run logs with the same parser and derive code as [phase-viewer](../viewer/). A mod can only import files from its own folder, so those modules are copied from `viewer/src/core/` into `hud/hooks/core/`. Don't edit the copies. After a change to the source, copy them again:

```sh
node hud/scripts/sync-core.mjs            # write the copy
node hud/scripts/sync-core.mjs --check    # exit 1 if the copy has drifted from the source
```

| Path | What it is |
|------|------------|
| `hooks/register.ts` | The hooks module: the poll, the toasts and `/phase-status`, every call on Claude Code's `$` |
| `hooks/hud.ts` | The toast and `/phase-status` texts, as plain functions |
| `hooks/core/` | Copied from the viewer. Don't edit |
| `types/index.d.ts` | The values the mod keeps in `$.state`: when it started and which toasts it raised |
| `sounds/chime.wav` | The sound the `sound` option plays |
| `test/` | Tests and their fixtures |
