# Phase Runner

**Your whole product team, not just a coding agent.**

Plan → design → build → QA, with you as the PM who signs off.

Phase Runner takes a product from a rough idea to shipped code. It plans the work as phases and sprints, locks a design system before any code gets written, builds in parallel waves, and checks every wave with independent verification and browser QA. You approve at the checkpoints. The agents run the loop in between.

## How you use it

1. **Plan the product.** Tell `product-planner` what you want to build. It writes a product plan with the options, how the data flows, and the open questions to settle.
2. **Design it.** `design-planner` locks a design system and mocks up every screen in HTML before any code exists.
3. **Break it into phases.** `phase-planner` turns the plan and the designs into phase files, split into sprints and tasks, each with acceptance criteria.
4. **Build it.** Say *"implement phase 1"*. `phase-builder` takes it from there and checks in with you when it hits a blocker or finishes the phase.

## What runs for you

`phase-builder` groups sprints into waves that are safe to run in parallel and gives each sprint a fresh sub-agent. UI sprints go to `phase-ui-implement`, which builds against your design system. After every wave:

- `phase-verify` runs your build, typecheck and tests, and reviews the diff against each acceptance criterion.
- `phase-wave-test` checks UI work in a browser against your design system.
- `phase-doc-sync` is the only agent that writes status back to the phase file, so the plan always matches what actually passed.

A failed wave retries with the failure attached, up to three times, then escalates to you. Say *"open the viewer"* and `phase-viewer` starts a local dashboard that shows the run live.

## What it reads, writes, runs and fetches

- **Files:** works only inside your project. Product plans go in `docs/`, designs in `docs/design/`, phase plans in `docs/phases/`, run logs in `docs/phases/.runs/`, and code wherever your sprints put it.
- **Commands:** runs your project's own build, typecheck, test and dev-server commands. For UI checks it drives a browser if you have a browser-testing tool installed.
- **Two npm packages, fetched with npx:** `phase-viewer` runs [`npx phase-viewer`](https://www.npmjs.com/package/phase-viewer), a dashboard that serves on `localhost` and only reads `docs/phases/`. `design-planner` runs the [`@google/design.md`](https://www.npmjs.com/package/@google/design.md) linter on `DESIGN.md`, and skips it if it's unavailable.
- **Network and data:** sends nothing to any third-party service. No telemetry, no accounts, no API keys. In a Claude app session, `product-planner` and `design-planner` can publish their docs as artifacts in your own Claude account.

## Works with

Built for Claude Code. The skills also run in Cursor and in hosts built on the Claude Agent SDK. `phase-viewer` needs Node.js 20 or later on your own machine.

Full docs, a comparison with other kits, and receipts from a real build are at [github.com/AyeJK/phase-runner](https://github.com/AyeJK/phase-runner).

## License

MIT
