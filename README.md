<p align="center">
  <img src="docs/social-preview-grid.gif" alt="Phase Runner: your whole product team, not just a coding agent. The stages Idea, Design, Plan, Build and QA light up in turn, then Sign off turns green." width="100%">
</p>

# Phase Runner

**Your whole product team, not just a coding agent.**

Plan → design → build → QA, with you as the PM who signs off.

Phase Runner is a set of Claude skills that takes a product from a rough idea to shipped code. It plans the work as phases and sprints, locks a design system before any code gets written, builds in parallel waves, and runs independent verification and browser QA on every wave. You approve at the checkpoints; the agents do the loop in between.

## Install

In Claude Code:

```
/plugin install phase-runner --marketplace AyeJK/phase-runner
```

Or add it from the [Anthropic plugin directory](https://claude.ai/customize/plugins/id/edc33bb8-c02f-4eec-987c-93b6a5c1cd40%40anthropic-plugin-directory) on claude.ai, which puts it in Claude Code, Cowork and chat on your account. The directory serves the latest reviewed version, so it can trail this repo by a few days.

Skills load as `phase-runner:phase-planner`, `phase-runner:phase-builder`, and so on.

Using Cursor or another agent, or want plain skills instead of a plugin? Install with [skills](https://skills.sh):

```
npx skills add AyeJK/phase-runner
```

This copies the same nine skills into your project, without the `phase-runner:` prefix.

## Quick start

**New project:**

1. Type `/product-planner` and a sentence about your idea to get started. It interviews you and turns your idea into a product plan. Review and iterate until the plan matches what you want to build.
2. Once you've reviewed your product plan, use `/design-planner` to come up with a visual style for your project and lock it in, with mockups of every screen. Once more, review and iterate until you like what you see.
3. Once you're happy with your UI design, use `/phase-planner` to turn your plan and designs into phase plans.
4. Use `/phase-viewer` to open the dashboard and review your phase plans before you build.
5. When the phases look right, type `/phase-builder run phase 1`.

**Existing project:**

1. Whether it's a new feature, or a full refactor, talk through your idea in chat.
2. When it feels solid, use `/phase-planner` to turn the conversation into phase plans.
3. Use `/phase-viewer` to open the dashboard and review your phase plans before you build.
4. When the phases look right, type `/phase-builder run phase 1`.

## How it works

<p align="center">
  <img src="docs/how-it-works.gif" alt="How Phase Runner works, one stage at a time, using phase-viewer's own build. Idea: product-planner writes the plan and weighs three options for who writes the run log, picking A3. Design: design-planner locks the palette, type and status badges. Plan: phase-planner lists seven phases and splits Phase 2 into sprints 2.1 to 2.5, with acceptance criteria. Build: phase-builder runs the sprints in four waves, with 2.2 and 2.3 in parallel, each on a fresh sub-agent. QA: verify fails Sprint 2.3 on two tests, retries with the failure attached, and passes. Sign off: Phase 2 ends at 27 of 28 tasks with one needing you, and you approve." width="100%">
</p>

When you run a phase, `phase-builder` groups sprints into parallel-safe waves and gives each sprint a fresh sub-agent. Every sprint carries acceptance criteria, and UI sprints build against your design system. After every wave, `phase-verify` runs your build, typecheck and tests and reviews the diff against every acceptance criterion, and `phase-wave-test` checks UI work in a browser against your design system. A failed wave retries the same sprint with the failure attached, up to three times, then escalates to you. Only `phase-doc-sync` writes status back to the phase file, so the plan always matches what actually passed. Nothing ships past you.

Want two phases going at once? Say *"run phase 4 in a worktree"* in a second session. That phase builds on its own branch in a git worktree, so neither session's verify gate trips over the other's half-written code. When the phase finishes, `phase-builder` merges the branch back and asks before removing the worktree.

## Local dashboard

[`phase-viewer`](viewer/) is a local dashboard for tracking your phases, sprints and tasks. Monitor your phase builds, wave progress, verification failures and anything that needs your attention. It updates as the files change, and it only reads your project, never writes to it.

<p align="center">
  <img src="docs/phase-viewer.gif" alt="phase-viewer during Phase 2 of its own build, after typing run phase 2. Sprint 2.1 is already complete. Sprints 2.2 and 2.3 build in parallel in wave 2. 2.3 fails verify on two tests with CRLF line endings, and 2.2 waits while 2.3 retries with the failure attached and passes. Wave 3 builds 2.4. In wave 4, 2.5 stops on a blocked task that needs your call, and the phase reads 27 of 28 tasks with 1 task blocked." width="100%">
</p>

<sub>Animated from the run log of Phase 2 of this repo's own build: the real sprints, the verify failure and retry, and the blocker.</sub>

In Claude Code, say *"open the viewer"*. The `phase-viewer` skill starts it in the background and gives you the URL. Ask again later and you get the same URL, since only one viewer runs per project.

Or, from your project folder (the one that holds `docs/phases/`), in your own terminal:

```
npx phase-viewer
```

Phases running in git worktrees (phase-builder's worktree mode or a desktop side session) show up in the same viewer until their branch is merged. You don't need a second viewer. Needs phase-viewer 0.6.0 or later.

**Local sessions only.** The viewer serves on `localhost` of the machine that runs it. In a cloud or remote Claude Code session, the skill starts nothing and tells you to run `npx phase-viewer` on your own machine, against your local checkout.

**Keep run logs out of git.** `phase-builder`'s agents append JSON lines to `docs/phases/.runs/`: one per gate result, one as each sprint's implementation starts, and one as each task starts and finishes. The viewer reads these logs, but they only make sense on the machine that ran the build, so add this to your `.gitignore`:

```gitignore
docs/phases/.runs/
```

## Claude integrations

### Claude artifacts

In a Claude app session, the two planning skills publish what they write as Claude artifacts: hosted pages you can share and, for the design, edit.

| Skill | From the files | Published as |
|---|---|---|
| `product-planner` | `docs/Plan-{Name}-{date}.html` | The plan as a hosted page |
| `design-planner` | `docs/design/DESIGN.md` and `design-system.md` | A Design System artifact: the tokens, with `design-system.md` as its README |
| `design-planner` | `docs/design/screens/*.html` | One Design canvas, with an artboard per mockup, using the project's Design System artifact for its tokens |

### Claude Code HUD (experimental)

[`phase-runner-hud`](hud/) is an experimental mod plugin for Claude Code built on an early-access API.

- **A toast** each time a run stops for you: an escalation (a gate failed on its last allowed attempt), a blocker (an implementer reported a blocked task), or the phase completing.
- **`/phase-status`**, which prints the phase, how many tasks each sprint has done, the current wave and gate (`wave 2 · 8.3 verify 2/3`), and when the last event was logged. The mod answers it from the files on disk, with no model call and no tokens.

```
/plugin install phase-runner-hud --marketplace AyeJK/phase-runner
```

Then start a new session from your project folder, the one that holds `docs/phases/`. It has two options, both in `/config`: `workspace`, for when `docs/phases/` isn't in the session's folder, and `sound`, a short chime with each toast (off by default). [`hud/README.md`](hud/README.md) has the details.

## How it compares

| | Phase Runner | [Superpowers](https://github.com/obra/superpowers) | [Spec Kit](https://github.com/github/spec-kit) | [GSD](https://github.com/open-gsd/gsd-core) | [BMAD](https://github.com/bmad-code-org/BMAD-METHOD) |
|---|---|---|---|---|---|
| **Idea → product plan** | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Design system before code** | ✅ | ❌ | ❌ | ✅ | ✅ |
| **Parallel build** | ✅ | ❌ | — | ✅ | — |
| **A separate agent reviews the work** | ✅ | ✅ | ❌ | 🟡 | 🟡 |
| **Automatic retry on failure** | ✅ | ✅ | 🟡 | 🟡 | — |
| **Browser QA on UI work** | ✅ | ❌ | ❌ | 🟡 | 🟡 |
| **Live dashboard of the build** | ✅ | ❌ | ❌ | 🟡 | 🟡 |

✅ built into the workflow · 🟡 a command you run · ❌ not included · — not documented

Most of these pieces exist somewhere. Phase Runner is the one where all of them run on their own, on every wave, inside the build loop.

## Receipts

[`phase-viewer`](viewer/) was built with Phase Runner: 7 phases, 26 sprints. Sprints 1.1 to 1.3 added the run log itself, so the log picks up at 1.4 and covers the other 23. Here's what it recorded:

- **84 gate results** across implement, verify, wave-test and doc-sync
- **3 verify failures, on 2 sprints.** Both were fixed by automatic retries, with no help needed
- **5 verify partials.** Nothing failed, but a note went on record and the wave moved on
- **9 browser wave-tests**, all passed
- **1 escalation**, where the run stopped and asked for a human

What verify caught:

- **Sprint 4.2.** Attempt 1 failed `npm run check`: the new browser test used `window` and `document`, but the project's TypeScript config has no DOM types. Attempt 2 fixed that, then failed again, because at 375px wide every page scrolled sideways by 168px. Attempt 3 fixed the overflow and passed.
- **Sprint 5.3.** Attempt 1 failed typecheck: a test imported a chain of files that reached a `.tsx` component, and the root TypeScript build isn't set up for JSX. Attempt 2 moved the shared helper into a plain `.ts` file and passed.

The partials were either criteria that verify couldn't check from the command line, such as ones needing a real plugin install (3 sprints), or all criteria met with a note attached, such as files changed outside the sprint's Module column (2 sprints). The escalation was Sprint 7.5, whose last task needed a plugin install and a live phase run on a real machine.

<sub>Counted from `docs/phases/.runs/` on Sep 29, 2026. Run logs are gitignored, so this section is the published record.</sub>

## What's in here

### Skills you use

These are the five you talk to. Everything else runs on its own.

| Skill | Job |
|---|---|
| `product-planner` | Turns a rough idea into a rich HTML plan doc — options considered, data flow, open questions. Optional first step. In Claude app sessions it publishes the plan as a hosted page ([Claude artifacts](#claude-artifacts)). |
| `design-planner` | Locks a visual design system and per-screen specs *before* implementation starts. In Claude app sessions it publishes a Design System artifact and a Design canvas ([Claude artifacts](#claude-artifacts)). |
| `phase-planner` | Creates and edits `docs/phases/Phase-*.md` files — the sprint/task source of truth. |
| `phase-builder` | The orchestrator. Reads a phase file, groups sprints into parallel-safe waves, spawns implementation sub-agents, and won't advance a wave until it passes verification. Optional worktree mode runs a phase on its own branch, so two sessions can build two phases at once. |
| `phase-viewer` | Starts the live dashboard (`npx phase-viewer`) in the background and gives you its URL. Local sessions only. |

### Skills phase-builder runs for you

You normally don't call these. `phase-builder` spawns each one as a sub-agent during a run, with its own narrow job and a structured result it has to hand back.

| Skill | Job |
|---|---|
| `phase-ui-implement` | Builds UI sprints. Reads your `design-system.md` first, generic UI-pattern skills second. |
| `phase-verify` | Runs your build/test/typecheck command, then reviews the wave's diff: a met/not-met verdict with evidence for every acceptance criterion, a check that no test was deleted or weakened, and a check that changes stay inside each sprint's Module column. Serious findings fail the wave and trigger a retry. |
| `phase-wave-test` | Browser and UI checks on UI sprints, against your project's `design-system.md` if one exists. |
| `phase-doc-sync` | The *only* thing allowed to write status changes back into the phase file. Batches edits, never touches acceptance criteria or task text. |

## Why sub-agents, and why the strict handoff order

The orchestrator (`phase-builder`) never writes code, never runs your test suite, and never edits the phase file directly. Every one of those actions happens in a sub-agent with a narrow, single-purpose prompt, and the orchestrator only advances after reading back a structured result block (`SPRINT RESULT`, `VERIFY RESULT`, `WAVE TEST RESULT`, `DOC SYNC RESULT`). This is deliberate:

- **The orchestrator thread stays cheap and legible.** No command output, no tool logs — just one-line status per gate. You can read what happened in a long run without wading through build logs.
- **Nothing is "done" because an agent said so.** Verify and wave-test are separate passes with their own pass/fail contract. Implementation can't grade its own homework.
- **The phase file can't drift.** Only doc-sync writes to it, and only after every gate for that wave has actually passed. The viewer's [live task progress](#local-dashboard) comes from the run log, so the phase file is still written only by doc-sync.
- **Retries retry the same unit of work**, not a patched-together "fix" task with no scope boundary. A failed sprint gets re-spawned with the failure injected — same sprint ID, same acceptance criteria, `(retry n)` in the description.

## The folder convention

```
your-project/
├── docs/
│   ├── phases/
│   │   ├── Phase-1-Foundation.md
│   │   ├── Phase-2-Core-Feature.md
│   │   └── ...
│   └── design/                    (written by design-planner)
│       ├── DESIGN.md
│       ├── design-system.md
│       └── screens/
│           ├── index.html
│           └── {screen}.md + {screen}.html
└── app/                           (or wherever your actual code lives)
    ├── package.json / pyproject.toml / Cargo.toml / go.mod
    └── src/
```

Two roots matter and phase-builder resolves both automatically at the start of every run (see `plugin/skills/phase-builder/project-layout.md`):

- **workspace_root** — where `docs/` lives
- **app_root** — where your code and its manifest file live

Small projects often have these be the same folder. Larger ones split them — useful when you want the phase history to survive a full rewrite of the app itself.

Worktree mode needs `docs/phases/` tracked in the same git repo as the code. If the phase docs sit outside the repo (a split layout), each session would write to the same phase folder, so `phase-builder` won't start a worktree run.

You don't need to create these folders. `phase-planner` and `design-planner` make them the first time they run.

## Platform support

The only environment-specific pieces — which tool spawns a sub-agent, what type name to give it, and how skill files get loaded — are resolved once per run by `plugin/skills/phase-builder/runtime-adapter.md`, which discovers what's actually available in your session rather than assuming a specific tool. See that file if you're adding support for a new environment.

What each piece needs:

| Piece | Needs |
|---|---|
| The skills | Any supported host: Cursor, Claude Code, or a host built on the Claude Agent SDK |
| [Claude artifacts](#claude-artifacts) | A Claude app session whose Artifact tool is present. `design-planner`'s two also need that tool to list the Design System type (for the design system) and the Design type (for the canvas) |
| [`phase-viewer`](#local-dashboard) | Node.js 20 or later, on your own machine |

## Optional dependencies

`phase-ui-implement` and `design-planner` will use a generic UI-component-pattern skill and a frontend-design-direction skill *if you have one installed* — they're not bundled here, since good ones are often licensed separately (for example, Anthropic ships example skills like this with its own products). Nothing in this kit requires them; without one, implementation falls back to matching your project's existing components and, absent that, standard accessible-UI defaults. If you have such a skill installed under a name your environment can discover, `skill-router.md` will pick it up automatically.

## Status conventions

| Symbol | Meaning |
|---|---|
| `—` | Not started |
| `~` | In progress |
| `x` | Completed |
| `BLOCKED` | Blocked by dependency or issue |
| `MANUAL` | Yours to do: publish, install on your machine, record, anything outside the codebase |
| `CUT` | Removed from scope (row preserved for history) |
| `DEFERRED` | Pushed to a later sprint or phase |

`BLOCKED` and `MANUAL` both need you, in different ways. A `BLOCKED` task is agent work that got stuck: `phase-builder` stops and asks, and an agent finishes it once you unblock it. A `MANUAL` task never goes to an agent and never stops the run. `phase-builder` lists it at the phase checkpoint, and you mark it `x` when you've done it.

Only `phase-doc-sync` writes these during an automated run. You can obviously edit the file by hand any time outside a run, or just ask `phase-planner` to make the change conversationally.

## License

MIT — see [LICENSE](LICENSE).
