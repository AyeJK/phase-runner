# phase-viewer

A local, live dashboard for [phase-runner](https://github.com/AyeJK/phase-runner) builds. It reads the phase plans in `docs/phases/` and the run logs phase-runner writes next to them, and shows phases, sprints, tasks and gate results in your browser, updating as files change.

## Usage

From your project folder (the one that holds `docs/phases/`):

```sh
npx phase-viewer
```

It prints a URL such as `http://localhost:4747`. Open it in your browser. Press Ctrl+C to stop the viewer.

There's nothing to configure. Without `--dir`, the viewer looks for `docs/phases/` in the current folder, then one level up, then in each immediate subfolder. When it finds more than one, the page lists them with the `npx phase-viewer --dir <path>` command for each.

Requires Node.js 20 or later.

### From Claude Code

With the phase-runner plugin installed, say *"open the viewer"*. Its `phase-viewer` skill runs `npx phase-viewer --json` in the background and replies with the URL, or with the one already running for the project.

## What you see

- **Kanban.** The home page has one column per phase. Each column shows the phase's task count (for example "18/19 tasks"), a status bar and one tile per sprint. A tile says where its sprint stands: Implementing, Verifying, Wave testing, Doc syncing, Complete, Waiting, Needs you or Not started. After a failed gate it reads Verify failed (or Wave test failed), then Re-implementing and Re-verifying while the retry runs. Needs you means a task is `BLOCKED`, a gate hit its retry limit, or a sprint's other tasks are done and only its `MANUAL` tasks (ones only you can do, such as publishing) are left. The filters above the board show all phases, or only those in progress, complete or not started.
- **Phase panel.** Click a column and that phase slides in from the right. Its sprints are listed in plan order, with the waves they ran in beside them, how long each wave took and how many retries it needed. Open a sprint to see its tasks, acceptance criteria, dependencies, verification and run notes: each failed attempt, and the attempt that fixed it. The back arrow or Escape closes the panel.
- **Live task progress.** While a sprint is being implemented, its tasks table follows the implementer: a task reads Running when the implementer starts it and Built when it finishes it. Built means the code for that task is written and no gate has checked it yet. It is not Complete: once the sprint has passed its gates, doc sync marks the tasks in the phase file, and from then on each row shows its status there (Complete for a task marked `x`). The sprint card's status bar fills along with them, in blue, and turns green at doc sync. Task counts, the phase's status bar and the sprint's state still come from the phase file and the gate results. This needs a phase-runner version whose implementers log each task; with an older one, or a run log from before, the table shows the phase file's statuses as it always did.
- **List view.** The Kanban | List toggle puts the phases in a column on the left, with the selected phase's sprints filling the rest of the page. A complete phase shows a green check in place of its task count and status bar. The viewer opens in the list view the first time, and after that in whichever layout you used last.

A banner at the top of a phase tells you when a gate hit its retry limit and phase-runner is waiting on you, or when lines in a phase file couldn't be read. If the viewer's server stops, a banner says so and the page keeps showing the last update until the server is back.

## Options

| Flag | What it does |
|------|--------------|
| `-d, --dir <path>` | Project folder (the one holding `docs/phases/`). Skips detection. |
| `-p, --port <n>` | First port to try. Default 4747; if it's taken, the next free port is used. |
| `--json` | Print one line of JSON, `{"url","reused","root"}`, and nothing else on stdout. For scripts and tools. |
| `-h, --help` | Show help. |
| `-v, --version` | Show the version. |

## One viewer per project

Only one viewer runs per project folder. If one is already running for the same folder, `phase-viewer` prints its URL and exits without starting another, whatever `--port` says. The running viewer is recorded in a small file under your system temp folder (`phase-viewer/` inside it); set `PHASE_VIEWER_INSTANCE_DIR` to use a different folder.

## Read-only

The viewer never writes to your project. It only reads the files in `docs/phases/`, it has no endpoints that change anything, and its server answers `GET` and `HEAD` requests only. Status changes come from phase-runner itself; the viewer just shows them.

## Local sessions only

The server listens on `127.0.0.1` only, on the machine where you run it. In a cloud or remote Claude Code session, `localhost` is the remote machine, so a viewer started there can't be opened in your browser. Run `npx phase-viewer` on your own machine, against your local checkout.

## Keep run logs out of git

phase-runner appends its run logs to `docs/phases/.runs/`, one JSON line per gate result, plus a line as each sprint's implementation starts and as each task starts and finishes. They are only useful on the machine that ran the build, and they change on every run. Add this to your `.gitignore`:

```gitignore
docs/phases/.runs/
```

## License

MIT
