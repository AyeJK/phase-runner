# Run Log

A phase run's story (when each sprint started, which gates failed, how many retries it took, which files each wave changed) otherwise lives only in the session transcript. The run log keeps it: one JSON line per sprint per gate, plus a start line each time a sprint's implementation begins and a line as the implementer starts and finishes each task, appended as the run happens, in a file per phase. Tools such as `phase-viewer` read it.

The gate agents and the implementation agents write it; the orchestrator never does. phase-builder passes each gate and each implementer a `run_log` block, and the agent appends its own events with one shell line. This file is the spec. The three gate skills and `phase-ui-implement` restate the append line byte for byte, and phase-builder's implementation prompt carries it, so no agent needs to open this file.

---

## Where it lives

```
{workspace_root}/docs/phases/.runs/phase-{N}.jsonl
```

- Under **workspace_root**, next to the phase files, not under app_root. In a split layout the two differ.
- The dot folder keeps it out of phase-builder's `Phase-{N}-*.md` glob.
- Append-only. Nothing edits or rewrites a line once it's written.
- Recommend `docs/phases/.runs/` in the project's `.gitignore`. The log is run noise, and ignoring it keeps it out of verify's wave diff. phase-verify never flags it either way.
- When a phase runs in a git worktree (worktree mode, or a desktop side session), the log is written inside the worktree, like the phase-file edits. The viewer (phase-viewer 0.6.0 and later) reads every git worktree's logs too, so a worktree run shows live from the main checkout's viewer until the branch is merged. Nothing changes in how the log is written.

---

## The `run_log` block

phase-builder adds this to the verify, wave-test and doc-sync payloads. A gate that gets no `run_log` block writes nothing and behaves exactly as it did before. The verify baseline call never gets one and never writes.

```json
"run_log": {
  "path": "C:/work/my-project/docs/phases/.runs/phase-5.jsonl",
  "phase": 5,
  "wave": 2,
  "attempt": 1,
  "max": 3,
  "sprint_results": [
    { "sprint": "5.3", "completed": [1, 2, 3], "blocked": [4], "notes": "first line of the sprint's NOTES" }
  ],
  "diff_base": "tree sha, or null",
  "wave_end": "tree sha, or null"
}
```

| Field | Sent to | Value |
|-------|---------|-------|
| `path` | all three | Absolute path of the log file, with **forward slashes** (`C:/…` on Windows — `dirname` doesn't split on backslashes) |
| `phase` | all three | Phase number `N` |
| `wave` | all three | The wave's number in this run's execution plan: 1, 2, 3… |
| `attempt` | all three | See [attempt and max](#attempt-and-max) |
| `max` | all three | See [attempt and max](#attempt-and-max) |
| `sprint_results` | verify only | One entry per sprint whose implementation ran since the previous verify in this wave, parsed from its `SPRINT RESULT` |
| `diff_base` | doc-sync only | The wave's `diff_base` (the same sha verify got) |
| `wave_end` | doc-sync only | The `SNAPSHOT` from the wave's last passing verify: the code the wave finished with |

### The implementer's `run_log` block

phase-builder also adds a smaller block to each implementation prompt, general and `phase-ui-implement` alike, one per sprint:

```json
"run_log": {
  "path": "C:/work/my-project/docs/phases/.runs/phase-5.jsonl",
  "phase": 5,
  "wave": 2,
  "sprint": "5.3",
  "attempt": 1,
  "max": 3
}
```

| Field | Value |
|-------|-------|
| `path`, `phase`, `wave` | As for the gates |
| `sprint` | This implementer's sprint id |
| `attempt` | `verify_retry_count + 1` when the implementer is spawned or continued, so it matches the `implement` and `verify` lines of the verify that follows. See [attempt and max](#attempt-and-max) |
| `max` | `max_verify_retries`, `0` when the user set no limit |

The implementer's first action, before reading or editing anything, is one `implement` `start` append. Each implementation run writes exactly one: the first spawn, a re-spawn on retry, and a retry continued in the same agent (`SendMessage` or equivalent) alike. A continued retry gets the new block, or at least its new `attempt`, in the retry message, and appends a fresh start line before its fixes.

After the start line the implementer appends `task` lines as it works: a `task` `start` line before it begins each task and a `task` `pass` line when that task is finished, with the task number alone as the summary and the block's `attempt` and `max`. They show which task is running and which are built while the sprint is still being implemented. They are not a status change: the implementer never edits the phase file, and the Status column is still written only by doc-sync.

An implementation prompt with no `run_log` block writes nothing: no start line and no `task` lines.

---

## Event shape (v1)

One JSON object per line, UTF-8, `\n`-terminated.

```
{"v":1,"ts":"2026-09-28T13:02:00Z","phase":2,"wave":3,"sprint":"2.4","gate":"implement","result":"start","attempt":1,"max":3,"summary":""}
{"v":1,"ts":"2026-09-28T13:03:10Z","phase":2,"wave":3,"sprint":"2.4","gate":"task","result":"start","attempt":1,"max":3,"summary":"1"}
{"v":1,"ts":"2026-09-28T13:09:40Z","phase":2,"wave":3,"sprint":"2.4","gate":"task","result":"pass","attempt":1,"max":3,"summary":"1"}
{"v":1,"ts":"2026-09-28T13:21:00Z","phase":2,"wave":3,"sprint":"2.4","gate":"verify","result":"fail","attempt":1,"max":3,"summary":"typecheck: 2 errors in src/parser.ts"}
{"v":1,"ts":"2026-09-28T13:40:00Z","phase":2,"wave":3,"sprint":"2.4","gate":"doc_sync","result":"pass","attempt":1,"max":1,"summary":"4 tasks updated","files":["src/parser/tables.ts","src/parser/tables.test.ts"]}
```

| Field | Type | Required | Meaning |
|-------|------|----------|---------|
| `v` | number | yes | Format version, always `1` |
| `ts` | string | yes | UTC time of the append, `YYYY-MM-DDTHH:MM:SSZ`, from `date -u`. Never typed by hand |
| `phase` | number | yes | Phase number |
| `wave` | number | yes | Wave number within the run |
| `sprint` | string | yes | Sprint id, e.g. `"2.4"`. Every v1 event is about one sprint |
| `gate` | string | yes | `implement`, `verify`, `wave_test`, `doc_sync` or `task` |
| `result` | string | yes | `pass`, `partial`, `warn`, `fail`, `blocked` or `start` — which ones each gate uses is below. `start` is only ever on `implement` and `task` |
| `attempt` | number | yes | 1-based attempt of this gate in this wave |
| `max` | number | yes | Retry limit for this gate; `0` means no limit |
| `summary` | string | yes | One line, at most 200 characters. May be empty. On a `task` line it is the task number and nothing else |
| `files` | string[] | no | `doc_sync` only: files the wave changed, relative to app_root. Omitted when either sha is missing |

### Gates

| `gate` | Written by | When | `result` |
|--------|-----------|------|----------|
| `implement` | the implementer (general or `phase-ui-implement`) | First action of each implementation run, before any other work, one line for its own sprint. Its `ts` marks when implementing began. A marker, not a gate step: see [Reading the log](#reading-the-log) | `start` |
| `task` | the implementer (general or `phase-ui-implement`) | After its `implement` `start` line, while it works: one line before it begins a task and one when that task is finished, for its own sprint. Markers, not gate steps: see [Reading the log](#reading-the-log) | `start` when it begins the task, `pass` when it finishes it |
| `implement` | phase-verify | First thing in each verify run, before any check starts and as its own append (never batched with the `verify` lines), one line per entry in `sprint_results`. Its `ts` marks when verifying began | `blocked` if the sprint's `blocked` list is non-empty, else `pass` |
| `verify` | phase-verify | Last thing before `VERIFY RESULT`, one line per sprint in `wave_sprints` | `fail`: STATUS is FAIL and the sprint is in `AFFECTED_SPRINTS` (or it's `ALL`). `partial`: the sprint has a non-blocking finding (an `UNVERIFIED` criterion, a scope note). `pass`: neither |
| `wave_test` | phase-wave-test | Last thing before `WAVE TEST RESULT`, one line per sprint in `wave_sprints` | `fail` / `warn`: STATUS is FAIL / WARN and the sprint is in `AFFECTED_SPRINTS` (or it's `ALL`). `pass`: otherwise |
| `doc_sync` | phase-doc-sync | Last thing before `DOC SYNC RESULT`, after its edits, one line per sprint in the payload. The next wave's implementation may already be running: its `start` and `task` lines can come before this line, its `implement` `pass` / `blocked` lines still come after, because verify waits for doc-sync | `pass` if its statuses were applied, `fail` if it's listed in `FAILURES` |

Summaries:

- `implement` `start`: empty. The attempt is already in `attempt`, and line order shows whether it follows a verify or a wave-test failure.
- `task` `start` / `pass`: the task number alone, the `#` of its row in the sprint's task table (`3`). No words, no title.
- `implement` `pass` / `blocked`: `done 1,2,3; blocked 4 — {notes}`. Drop the `blocked` part when nothing is blocked (`done 1,2 — {notes}`, never `blocked none`), and the note when there is none.
- `verify`: on `fail`, that sprint's first `FAILURES` line without its sprint-id prefix. Otherwise `criteria {met}/{total} met`, plus `; {k} unverified` when there are any.
- `wave_test`: on `fail` / `warn`, the sprint's first failure or issue. Otherwise `{n} URLs, {m} viewports`.
- `doc_sync`: `{k} tasks updated`, or the reason from `FAILURES`.

### attempt and max

phase-builder already keeps a retry counter per gate per wave. `attempt` is that counter plus one at the moment the gate or implementer is spawned (or an implementer is continued); the orchestrator puts it in `run_log`.

| `gate` | `attempt` | `max` |
|--------|-----------|-------|
| `implement` (all three results), `verify` | `verify_retry_count + 1` — 1 on the wave's first implementation and verify, +1 after each verify FAIL | `max_verify_retries` (default 3) |
| `task` | The `attempt` of the `implement` `start` line of the same implementation run | The `max` of that line |
| `wave_test` | `wave_test_retry_count + 1` | `max_wave_test_retries` (default 3) |
| `doc_sync` | 1, or n on the n-th doc-sync the user asks for in the same wave | 1 — doc-sync never retries on its own; a failure pauses the run |

- The user's "strict — no retry limit" → `max: 0`.
- Counters reset when a new wave starts and when the user picks "continue retrying" after an escalation, so `attempt` goes back to 1.
- A re-implement and verify re-run after a wave-test failure don't bump the verify counter, so their `implement` (`start`, then `pass` / `blocked`) and `verify` lines repeat the previous attempt number. Line order is the source of truth for sequence; `attempt` is a label.

### Order within a wave

```
implement start → task start / pass … → implement → verify     attempt 1
implement start → task start / pass … → implement → verify     attempt 2 (after a verify FAIL: new set)
wave_test                                                      UI waves only
doc_sync                                                       last, and only once every gate has passed
```

In a multi-sprint wave each implementer writes its own `start` line, so the wave's `start` lines come first, in whatever order the implementers got to them. On a retry only the re-implemented sprints get a new `start` line; phase-verify's `implement` lines cover the same sprints.

An implementer's `task` lines come after its `start` line and before phase-verify's `implement` line for that sprint: `task` `start` 1, `task` `pass` 1, `task` `start` 2 and so on, one pair per task it works on. In a multi-sprint wave the sprints' `task` lines interleave. A task the implementer couldn't finish (blocked) has a `start` line and no `pass` line. On a retry the implementer writes `task` lines only for the tasks it works on again.

The next wave's implementation starts at the same time as doc-sync, so its `start` and `task` lines (carrying the next wave's number) can land before or among this wave's `doc_sync` lines. Place them by `wave`, not by position. In a log with no `start` lines, a reader that marks "wave N+1 implementing" from wave N's `doc_sync` line is up to a minute late.

On a wave-test retry the sequence is `implement start → implement → verify → wave_test` again. An escalation writes nothing: a reader sees a `fail` at `attempt == max` (with `max > 0`) and no later line for that sprint.

---

## The append line

Every writer appends with this line. Copy it exactly and replace only the `{…}` placeholders; keep every other character, including the summary's `tr` pipe and `"${RL_FILES:-}"`. Run one line per event, one command each or chained with `&&` in a single call. Chain only lines written at the same moment: phase-verify's `implement` lines go out before its checks run, its `verify` lines after. An implementer's `start` line is a single command of its own. So is each of its `task` lines, except that a finished task's `pass` line and the next task's `start` line may be chained in one command.

```sh
mkdir -p "$(dirname '{path}')" && printf '{"v":1,"ts":"%s","phase":%d,"wave":%d,"sprint":"%s","gate":"%s","result":"%s","attempt":%d,"max":%d,"summary":"%s"%s}\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" '{phase}' '{wave}' '{sprint}' '{gate}' '{result}' '{attempt}' '{max}' "$(printf '%s' '{summary}' | tr '\042\134\011\012\015' "'/   " | tr -d '\000-\037')" "${RL_FILES:-}" >> '{path}'
```

| Placeholder | From |
|-------------|------|
| `{path}` (twice) | `run_log.path` |
| `{phase}`, `{wave}`, `{attempt}`, `{max}` | `run_log`. Must be integers — an empty value logs `0` |
| `{sprint}` | The sprint id |
| `{gate}`, `{result}` | Values from the tables above |
| `{summary}` | The one-line summary. For an `implement` `start` line it's empty: `'{summary}'` becomes `''`. For a `task` line it's the task number: `'3'` |

**Writing the summary.** Type it as plain text. The line turns `"` into `'`, `\` into `/`, and tabs and newlines into spaces, and it drops other control characters, so the JSON stays valid whatever you type; `$`, backticks, `%` and non-ASCII text pass through unchanged. The one character you must handle is the straight apostrophe, because the summary sits inside single quotes: write `'` as `'\''`, or reword (`does not`). An unescaped apostrophe either fails the command or garbles the summary. Never backslash-escape anything else: inside single quotes `\"` stays two characters, so it lands in the log as `/'`.

**No doubled backslashes.** The line deliberately contains no `\\`: some agent shells collapse `\\` to `\` before bash sees it. Don't "fix" the octal escapes (`\042`, `\134`) into another form.

**Shell.** It needs a POSIX shell: bash, zsh or sh on macOS and Linux, Git Bash on Windows. It doesn't run in PowerShell. It uses only `mkdir`, `dirname`, `printf`, `date`, `tr` and `>>`; no `jq` or `node`.

### doc-sync: the `files` field

doc-sync sets `RL_FILES` in the same command, before its append lines. It's empty for every other writer, so their lines carry no `files`.

```sh
RL_FILES=$(cd '{app_root}' && git -c core.quotePath=false diff --relative --name-only {diff_base} {snapshot} -- ':(exclude)docs/phases') && RL_FILES=',"files":['"$(printf '%s' "$RL_FILES" | tr '\042\134' "'/" | sed 's/.*/"&"/' | paste -sd, -)"']' || RL_FILES=''
```

- `{diff_base}` is `run_log.diff_base`; `{snapshot}` is `run_log.wave_end`. Paths come out relative to app_root, the same base as the phase file's Module cells.
- `docs/phases` is excluded: doc-sync's status edits and the log itself aren't the wave's work.
- Either sha missing (`diff_base` or `wave_end` is null) → skip this line entirely; the events carry no `files`.
- git fails → `RL_FILES` ends up empty and the events are still written, without `files`. Report the git error in NOTES.
- An empty diff gives `"files":[]`.

Shape of the full command for a two-sprint wave:

```sh
RL_FILES=…; {append line for 5.2} && {append line for 5.3}
```

---

## When an append fails

A non-zero exit from the append (unwritable path, no POSIX shell, a quoting slip) gets one line in the writer's `NOTES` (a gate's result block, or an implementer's `SPRINT RESULT`), e.g. `run log: append failed (mkdir: permission denied)`. It never changes the gate's STATUS, and it never stops, blocks or delays an implementer's sprint or any task in it; a failed `task` append is handled the same way as a failed `start` append. Fix an obvious slip (an unescaped apostrophe) and run the line once more at most; then note it and move on. Never write or repair the log with a file-edit tool.

---

## Reading the log

For tools that consume it:

- Skip any line that doesn't parse as JSON, including a last line still being written. Never fail on one.
- Skip lines whose `v` isn't a version you know. Ignore unknown fields; treat a missing `summary` as empty.
- Waves, retries and escalations come from line order. Wave numbers restart at 1 each time phase-builder runs the phase again, so a drop in `wave` marks a new run. (A run resumed inside wave 1 reads as a continuation of it.)
- `implement` `start` lines are markers, not gate steps: never count one as an attempt, a retry or a result, and don't let one cut a wave. The next wave's `start` lines can sit between the previous wave's lines, so skip `start` lines when looking for a drop in `wave`. Place each one in the wave its `wave` names, in the run of the line before it, or in the next run when its `wave` is lower than that line's (a new run's first implementer).
- Logs may have no `start` lines at all (runs logged before implementers wrote them, or a failed append). Fall back to the other events: a wave's start is then its first line.
- `task` lines are markers like `implement` `start`: never count one as an attempt, a retry or a gate result, and never let one cut a wave or move a wave's start or end. Place each one the way a `start` line is placed, in the wave its `wave` names. Skip a `task` line whose `summary` isn't a whole number, and ignore a task number the sprint doesn't have.
- For each sprint in a wave, the latest `task` line per task number says where that task stands: `start` means the implementer is working on it, `pass` means it is built and not yet verified. The gates still decide whether the work passes, and a task is done only when doc-sync marks it in the phase file, so drop what the `task` lines say once the sprint's `doc_sync` line lands. A `start` with no `pass` after it when the sprint's `implement` result line lands is not a running task any more: the implementer left it unfinished, or its `pass` append failed.
- A log may have no `task` lines at all (runs logged before implementers wrote them, an implementation prompt with no `RUN LOG` section, or failed appends). Everything else reads the same with or without them.
- Parallel implementers append at nearly the same moment. Each line is one short `>>` write; the skip-unparseable rule above covers the rare garbled one.
- Wave start, wave end and escalation are derived from the events, never logged as events of their own.
