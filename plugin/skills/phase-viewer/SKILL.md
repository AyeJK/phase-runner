---
name: phase-viewer
description: "Starts the phase-viewer live dashboard for this project (npx phase-viewer) in the background and reports its localhost URL, reusing the viewer that's already running for the project instead of starting a second one. Shows phases, sprints, tasks and gate results from docs/phases/ and its run logs, updating live during a phase-builder run. In a remote or cloud session it starts nothing and gives the command to run locally. Trigger phrases: open the viewer, start the viewer, launch the phase viewer, show the dashboard, open the dashboard, viewer URL, where's the viewer, watch the build, phase-viewer."
---

# Phase Viewer

Starts [`phase-viewer`](https://www.npmjs.com/package/phase-viewer), a local read-only dashboard for phase-runner builds, and hands the user its URL. The server runs in the background, so the session stays free, and only one viewer runs per project: asking again returns the same URL.

The viewer reads `docs/phases/` and the run logs in `docs/phases/.runs/`. It never writes to the project. It needs Node.js 20 or later.

**Don't block the session.** `phase-viewer` keeps running until it's stopped. Never run it as an ordinary foreground command: that call would never return.

---

## Step 1: Local or remote?

The viewer listens on `127.0.0.1` of the machine that runs it. In a cloud session that is the remote machine, and the user's browser can't reach it.

Check the environment with a shell command, e.g. `echo "${CLAUDE_CODE_REMOTE:-}"` in Bash or `$env:CLAUDE_CODE_REMOTE` in PowerShell.

- **`true`**: this is a remote Claude Code session. Start nothing. Tell the user to run the viewer on their own machine, from their local checkout of the project:

  ```
  cd <your local checkout>
  npx phase-viewer@latest
  ```

  It prints a URL to open; Ctrl+C stops it. Stop here.
- **Anything else** (unset or empty): local. Continue. Remote Control, where a phone or claude.ai steers a session running on the user's machine, is local too.

## Step 2: Find the project folder

The project folder is the one that holds `docs/phases/`. Start from the session's working directory, and search the same places the CLI does:

1. The working directory itself.
2. One level up.
3. Each immediate subfolder.

- **One match**: that's the project folder.
- **Several**: ask the user which project to open, then use it.
- **None**: don't start anything. Say there are no phase plans here yet (`phase-planner` creates `docs/phases/`), and that the viewer can be pointed elsewhere with `npx phase-viewer --dir <path>`. Stop here.

Settle this before starting. When the CLI can't settle on a folder itself, it still starts a server but records no instance for it, so the next request would start a second one.

## Step 3: Start it in the background

From the project folder, run:

```bash
cd "<project folder>" && npx --yes phase-viewer@latest --json
```

Use the host's background mode for this command, e.g. `run_in_background: true` on Claude Code's Bash tool. The call returns at once with a task id and an output file.

- **Use Bash, not PowerShell, on Windows.** A viewer started from a Bash background task keeps running after that task or the session ends. The PowerShell tool's background task takes the whole process tree down with it, so the viewer would die when the task stops.
- **Don't stop the task afterwards.** It isn't needed, and it doesn't stop the viewer anyway. The viewer runs until its process is ended or the machine restarts.
- `--yes` skips npx's install prompt the first time the package is downloaded.
- `@latest` makes npx check for a newer release instead of reusing the copy it cached the first time. A newer viewer that finds an older one running for the project stops it and takes over, so the run log's newer events are always read by a viewer that knows them.
- **No background shell** (the host can't run a command in the background): go to the fallback below.

## Step 4: Wait for the URL

With `--json`, the viewer prints exactly one line of JSON on stdout once it's listening:

```json
{"url":"http://localhost:4747","reused":false,"root":"C:\\Users\\me\\my-project"}
```

Read the task's output (the output file the background call returned, or the host's tool for reading background output) until a line parses as JSON with a `url` field. Ignore anything else in the output, such as npm warnings.

- A viewer that's already running answers in under a second. A first run downloads the package, which can take up to about **60 seconds**. Check every few seconds rather than in a tight loop.
- If the task exits with a non-zero code before any JSON line, the output holds a one-line `phase-viewer: ...` error (or an npm error, e.g. `npx` not found or Node too old). Go to the fallback and include that error.
- No JSON line after about 60 seconds: go to the fallback.

## Step 5: Report

Give the user the URL and say which case it was:

- `"reused": false`: "The phase viewer is running at http://localhost:4747." Mention that it keeps running in the background until its process is ended or the machine restarts.
- `"reused": true`: "The phase viewer was already running for this project: http://localhost:4747." Nothing new was started; the background task has already exited, which is expected.

Keep the report to those one or two lines. Don't open a browser for the user unless they ask and the host has a tool for it.

## Fallback: give the user the command

When the viewer can't be started from here (no background shell, a CLI or npm error, or no URL within about 60 seconds), say why in one line, then give the command to run in their own terminal:

```
cd "<project folder>"
npx phase-viewer@latest
```

It prints the URL to open, and Ctrl+C stops it. If a background task from Step 3 is still running (e.g. still downloading), leave it: if it finishes, it will be the running viewer, and the next "open the viewer" returns its URL.

---

## Notes

- **One viewer per project.** The CLI records each running viewer in a small file in the system temp folder (`phase-viewer/`, or `PHASE_VIEWER_INSTANCE_DIR` if set) and reuses it whatever `--port` says. A viewer that was killed hard leaves a stale file, which the next start detects and replaces.
- **Port.** The viewer starts at port 4747 and takes the next free one if that's taken. Only pass `--port <n>` if the user asks for a specific port.
- **Run logs.** Suggest adding `docs/phases/.runs/` to the project's `.gitignore` if it isn't there: the logs change on every run and only mean something on the machine that ran the build.
