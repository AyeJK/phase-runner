---
name: design-planner
description: "Establishes visual design language and screen contracts between project scope docs and phase-planner. Produces docs/design/DESIGN.md (Google design.md spec), screen specs, HTML mockups (screens/*.html + index hub), and design-system.md for phase-builder. Use when the user wants to design UI before phase planning, lock a design system, write screen specs, review HTML mockups, or run the design pass after a scope/rebuild plan. Trigger phrases: design pass, design-planner, design the UI, design system, DESIGN.md, screen specs, visual direction, before phase planner."
---

# Design Planner

Establishes **visual language and screen contracts** after a scope/rebuild plan and **before** phase-planner. Output feeds phase-planner (screen references in sprints) and phase-builder (`design-system.md` for UI implementation and wave-test asserts).

**Pipeline position:**

```
Scope doc (what/why/architecture)
    → design-planner (this skill)
    → phase-planner (sprints)
    → phase-builder (build)
```

**Not this skill:** Architecture, API design, sprint breakdown, or implementation. Use scope docs + phase-planner + phase-builder for those. Use `product-planner` only for non-UI product exploration — not as a substitute for this step.

For file templates, token schema, and screen-spec format, see [reference.md](reference.md).

**The build reads the files.** Everything this skill decides lives under `docs/design/`, and that is all phase-planner and phase-builder ever read. In a session whose Artifact tool lists a Design System type, Step 7 also publishes the design system as a Design System artifact. Where it lists a Design type, Step 6 also publishes the screen mockups as artboards on one Design canvas. A published design can then be changed in two places: on its page, or in the files by asking in chat. **Design sync** copies each change to the other side without asking, so there is one design, not two: a screen's file on disk is its artboard on the canvas, and `design-system.md` is the design system's README. It runs at the start of every run of this skill, after every change this skill makes, before phase-planner creates a phase and before phase-builder starts a build. In a session without that tool the skill writes the same files and skips every artifact step. Mechanics are in [artifacts.md](artifacts.md) and [design-sync.md](design-sync.md).

---

## Step 1 — Resolve project layout

Run once at the start. Same rules as phase-builder's `project-layout.md` — read that file if this project also uses phase-builder, otherwise resolve directly:

| Path | Role |
|------|------|
| **workspace_root** | Folder containing `docs/` — design artifacts live here |
| **app_root** | Folder with the stack manifest and `src/` (often a subfolder like `{name}-app/`) |

**Design output paths (all under workspace_root):**

| File | Purpose |
|------|---------|
| `docs/design/DESIGN.md` | Canonical agent contract — Google [design.md](https://github.com/google-labs-code/design.md) spec |
| `docs/design/design-system.md` | Expanded patterns — **phase-builder reads this path** |
| `docs/design/screens/*.md` | Per-surface screen specs (acceptance criteria for phase-planner) |
| `docs/design/screens/*.html` | **Reviewable HTML mockups** — one per screen + `index.html` hub |
| `docs/design/screens/_theme.css` | Shared styles for the mockups — this project's own visual direction, established in Step 4 |

Report layout before writing:

```
Design pass layout:
  workspace_root: {path}
  app_root:       {path}
  scope input:    {path to scope doc or "conversation"}
```

If `docs/design/` doesn't exist, create it and `docs/design/screens/` under `workspace_root`. No setup script is needed first.

If `docs/design/DESIGN.md` records a published artifact, run **Design sync** ([design-sync.md](design-sync.md)) first, before reading or changing anything else, so a change made on the page is in the files.

If `docs/design/` already exists, read all files before editing. Preserve locked decisions unless the user asks to revise.

---

## Step 2 — Read inputs

Read in order:

1. **Scope doc** — user path or pasted plan (e.g. a rebuild plan or product spec under `docs/`). Extract product name, audience, UI surfaces mentioned, hard UX rules, stack (web framework, desktop shell, etc.).
2. **Project convention docs** — `CLAUDE.md` / `README.md` / equivalent, for terminology and conventions the project already uses (many products have their own vocabulary for core concepts — use whatever the scope doc or existing docs establish, don't invent new terms).
3. **Existing design** — `docs/design/*`, root `DESIGN.md`, prior prototypes.
4. **App context** — skim `app_root`'s manifest file, existing routes/components if UI already exists. Note what to extend vs. replace.

Do not re-interview on facts already in the scope doc. Ask only for gaps that block design decisions.

---

## Step 3 — Surface inventory

Produce a table before any visual work. Save it inside `docs/design/DESIGN.md` under `## Surfaces` (extension section — allowed by design.md spec) or as a standalone `docs/design/surface-inventory.md` when the list is long.

| Surface | Route / shell | Phase | Priority | Notes |
|---------|---------------|-------|----------|-------|
| {e.g. Settings — Profile editor} | `/settings/profile` | 2 | P0 | {any notable constraint} |
| {e.g. Onboarding overlay} | Modal / full-screen | 1 | P0 | {any notable constraint} |

**Scope rule:** Spec surfaces for **near-term phases only** (typically Phase 1–3). Defer Phase 4+ to a later design pass unless the user explicitly asks.

Present the inventory to the user. Confirm missing surfaces or wrong priorities before locking direction.

---

## Step 4 — Design direction

Commit one aesthetic direction before writing tokens. If a frontend/visual-direction skill is available in this environment, read its design-thinking guidance for the direction workshop and apply its purpose/tone/constraints/differentiation framing to **this product**, not generic SaaS. If no such skill is available, run the workshop yourself using the same framing: what's the product's purpose, tone, and what should differentiate it visually from competitors.

### Present 2–3 directions

Each direction is a short card:

- **Name** — a short evocative label for this direction
- **One-line mood**
- **Type + color posture** — fonts, light/dark, accent strategy
- **Fit** — why it matches the product thesis
- **Risk** — what it makes harder

Ask the user to pick one, blend two, or describe a reference (site, app, image). **Do not lock tokens until they confirm.**

### Multi-surface products

When surfaces have different jobs (e.g. a control-panel shell vs. a public-facing web app), either:

- **One system, two modes** — shared tokens + mode overrides in YAML (e.g. `colors.panel-*` vs `colors.public-*`), or
- **Split design passes** — one pass per surface family (run skill twice)

State the choice in `DESIGN.md` Overview.

### Optional prototypes

If direction is ambiguous, write **one** static HTML file to `docs/design/prototypes/{name}.html` using the chosen direction. Inline CSS only. Present it to the user for review. Prototypes are throwaway — tokens in `DESIGN.md` are the contract once approved.

---

## Step 5 — Write DESIGN.md

Write `docs/design/DESIGN.md` following the Google design.md spec. See [reference.md](reference.md) for the full template.

**Requirements:**

1. **YAML front matter** — `name`, `version: alpha`, token groups: `colors`, `typography`, `spacing`, `rounded`, `components` (minimum: primary button + one input), in the shapes [reference.md](reference.md) gives under "The token shapes the linter reads"
2. **Body sections** in spec order: Overview → Colors → Typography → Layout → Elevation & Depth → Shapes → Components → Do's and Don'ts
3. **Prose matches tokens** — every accent color in prose exists in YAML; tokens are normative
4. **Product-specific Do's and Don'ts** — translate scope UX rules (e.g. "never show blocking error dialogs" → explicit component behavior)
5. **Terminology** — use whatever project-specific terms the scope doc or existing docs already established; don't introduce new ones here
6. **Keep the artifact lines** — if the existing DESIGN.md has a `Design system artifact: {url}` line (written by Step 7) or a `Design canvas: {url}` line (written by Step 6) under its title, every rewrite keeps them as they are

After writing, run lint when available:

```bash
npx -p @google/design.md designmd lint docs/design/DESIGN.md
```

Use the `designmd` command as written. The package's other command is named `design.md`, and on Windows `npx @google/design.md lint` opens that file in a text editor and hangs instead of running.

If lint reports errors, fix them before proceeding. Read the warnings: fix the ones that point at a real gap, and leave the two [reference.md](reference.md) lists as expected. If the CLI is unavailable or doesn't answer within a minute or so, stop waiting and self-check against the [reference.md](reference.md) checklist.

**Optional:** Copy or symlink to `{workspace_root}/DESIGN.md` when the user wants root-level discovery — note both paths in the handoff.

---

## Step 6 — Write screen specs + HTML mockups

For each P0/P1 surface, create **both**:

1. **Markdown spec** — `docs/design/screens/{kebab-name}.md` (acceptance criteria for phase-builder)
2. **HTML mockup** — `docs/design/screens/{kebab-name}.html` (visual review for the user)

Use the templates in [reference.md](reference.md). Shared styles live in `docs/design/screens/_theme.css` (tokens, panels, buttons — reuse from an existing repo if this is a rebuild).

Also write **`docs/design/screens/index.html`** — hub linking all mockups.

Each markdown spec must include:

- Route or shell type
- Purpose (one sentence)
- Layout wireframe (ASCII or structured blocks)
- Component list (names matching DESIGN.md)
- **States matrix** — empty, loading, error, success, edge cases from scope doc
- Copy rules — labels, empty states, forbidden phrases
- **Acceptance bullets** — observable checks for phase-builder `Verification.assert`
- **Preview:** link to sibling `.html` mockup

Each HTML mockup must:

- Render real tokens from DESIGN.md (not generic wireframe gray boxes)
- Label interactive regions
- Take its shared look from `_theme.css`, with screen-specific styles only when needed

**Which form a mockup takes.** It depends on whether the project has, or is about to get, a Design canvas:

| Session | Form |
|---------|------|
| The Artifact tool lists a Design type, or DESIGN.md already records a canvas | The canvas's own form ([artifacts.md](artifacts.md), Screen file form): the file on disk is the artboard, sent as it is. It carries a copy of `_theme.css`'s rules and has no review bar |
| Anything else | The plain form in [reference.md](reference.md): links `_theme.css`, with a fixed review bar (screen name, phase, link back to `index.html`). A later session that can publish converts it once, in place |

Link each spec from DESIGN.md `## Surfaces` table (Spec + Preview columns).

Do not duplicate token tables in screen specs — reference `DESIGN.md` sections instead.

### Publish the Design canvas

Do this after the mockups and `index.html` are written, and only if the session's Artifact tool lists a **Design** type. If it doesn't — no Artifact tool, or no such type — skip this section: Step 6 ends at the files above, as it always has, and nothing later depends on the canvas. If DESIGN.md records a canvas from an earlier session, leave the line alone: the next sync in a session that can publish sends this run's changes.

The canvas shows every mockup as an artboard, laid out in rows, using the project's Design System artifact so its Theme menu shows the project's tokens by name. Each artboard is the mockup's own file, uploaded as it is: nothing is converted on the way up, and a screen edited on the canvas comes back down into the same file (Design sync). The files still open from disk.

1. **Look for a recorded canvas.** DESIGN.md's header (the lines directly under its title) records one as `Design canvas: {url}`.
2. **Wait for the design system if it isn't published yet.** The canvas installs the project's Design System artifact, which Step 7 publishes. If DESIGN.md's header has no `Design system artifact:` line and this session can publish one, go on to Step 7 now and come back to this section when its publish is done, before Step 8. If the header already has the line, publish the canvas here.
3. **No canvas line: first run.** Create one Design canvas named `{Product Name} — Screens`, and write its URL into DESIGN.md's header (`Design canvas: {url}`) and into `screens/index.html` before filling it. A mockup still in the plain form is converted in place first.
4. **Line present: later run.** Revise the canvas at that URL. Never create a second one. Design sync already ran in Step 1, so a screen changed on the canvas is in its file. Send only the screen files this run changed (all of them when `_theme.css` changed), add an artboard for a new one, and remove the artboard of a deleted one. If the URL can't be opened or edited, tell the user and ask what to do.
5. **Fill it per [artifacts.md](artifacts.md):** exactly one artboard per HTML mockup, each titled with its screen spec's name; app and web screens as fluid pages, phone screens at 390×844; rows by phase or surface family with a title note per row; the first P0 screen as the entry; and the project's Design System artifact installed.
6. **Run the canvas checks** in [artifacts.md](artifacts.md) before publishing.
7. **Write the sync record** ([design-sync.md](design-sync.md)).
8. **Give the user the link.**

If there is no Design System artifact to install (its publish failed, or the session lists no Design System type), publish the canvas without it, tell the user its Theme menu will show plain values for now, and install the system on the first later run that finds it recorded.

A publish that fails doesn't fail the design pass. The mockups on disk are the review fallback: report what happened and carry on.

---

## Step 7 — Seed design-system.md

Write or update `docs/design/design-system.md`. This is the **operational doc phase-builder injects** into UI implementation and wave-test.

Structure:

1. Header — last updated, links to `DESIGN.md`, optional HTML gallery path
2. **Design intent** — condensed from Overview (table of principles)
3. **Design tokens** — CSS custom properties derived from YAML (copy-paste ready `:root` block)
4. **Typography scale** — table mapping elements → tokens
5. **Core component patterns** — ASCII + class/CSS conventions for buttons, inputs, cards, modals used in screen specs
6. **UI copy** — voice rules for visible strings
7. **Screen index** — table linking surface → spec file → route

**Source-of-truth rule:**

| File | Role |
|------|------|
| `DESIGN.md` | Locked tokens + rationale — edit in design pass |
| `design-system.md` | Expanded patterns — grows during early UI sprints; token changes must trace back to `DESIGN.md` |
| Design System artifact (when published) | The same two files on a page: its README is `design-system.md`, its tokens are DESIGN.md's. A change on either side is copied to the other by Design sync |

When both files exist and conflict on token values, **DESIGN.md wins** — update design-system.md to match. When the artifact and the files differ, **Design sync settles it**: the side that changed since the last sync is copied to the other, and the user is asked only when the same thing changed on both.

### Publish the Design System artifact

Do this after both files are written, and only if the session's Artifact tool lists a **Design System** type. If it doesn't — no Artifact tool, or no such type — skip this section: Step 7 ends at the two files, as it always has, and nothing later depends on the artifact. If DESIGN.md records a system from an earlier session, leave the line alone: the next sync in a session that can publish sends this run's changes.

1. **Look for a recorded system.** DESIGN.md's header is the lines directly under its `# {Product Name} — Design System` title, one per published artifact. A published system is recorded there as `Design system artifact: {url}`.
2. **No line: first run.** Create one Design System artifact named after the product, and write `Design system artifact: {url}` into DESIGN.md's header before filling it.
3. **Line present: later run.** Revise the system at that URL. Never create a second one. Design sync already ran in Step 1, so an edit made on the page is in the files. If the URL can't be opened or edited, tell the user and ask what to do.
4. **Fill it per [artifacts.md](artifacts.md):** DESIGN.md's tokens, each with the same value it has in the YAML; `design-system.md` as its README; a cover; and its index, written last. No components.
5. **Run the artifact checks** in [artifacts.md](artifacts.md) before publishing.
6. **Write the sync record** ([design-sync.md](design-sync.md)).
7. **Give the user the link.**

A publish that fails doesn't fail the design pass. The files are complete; report what happened and go on.

**Then the canvas.** If Step 6 left the Design canvas waiting for this system, publish it now (Step 6, "Publish the Design canvas"), whether or not the system's publish succeeded. If a canvas is already recorded and this step republished the system with changed tokens, revise the canvas so its installed copy of the tokens matches. Then go on to Step 8.

---

## Step 8 — Handoff

Present saved paths and the review hub:

```
Design pass complete.

Review mockups (open in browser):
  docs/design/screens/index.html

Artifacts:
  docs/design/DESIGN.md
  docs/design/design-system.md
  docs/design/screens/*.md + *.html

Next steps:

1. **Generate phase plans** — hand off to phase-planner:
   "Use docs/design/ and {scope doc path}. Generate phase plans.
    UI sprints must reference screen spec paths in the Reference column.
    Verification assert lines should come from screen spec acceptance bullets."

2. **Iterate** — revise direction, add a screen, or update tokens in DESIGN.md
```

**With a Design canvas.** When DESIGN.md's header records a canvas, give its link alongside the hub, as a second line under "Review mockups":

```
Review mockups (open in browser):
  docs/design/screens/index.html
  Design canvas: {url}
```

Tell the user they can change the design on the canvas and the design system page, or by asking in chat, and that either way the files follow: the change is picked up before the next design change, before a phase is planned and before a build starts. With no canvas recorded, the handoff is the block above, unchanged. The phase-planner handoff still names `docs/design/` paths, never an artifact link.

If the user asks to proceed immediately, read the phase-planner skill and generate phase plans using design artifacts as constraints.

### Phase-planner constraints (include in handoff)

When invoking phase-planner, require:

- UI task **Reference** column → `docs/design/screens/{file}.md`
- Sprint **Verification** `assert:` lines → from screen spec acceptance bullets
- No visual invention in task descriptions — "implement per screen spec"
- Data-only sprints → `skip-ui: true`; no design references needed

---

## Operations (iteration)

| User says | Action |
|-----------|--------|
| "revise direction" / "new aesthetic" | Re-run Step 4 → rewrite DESIGN.md tokens + design-system.md; flag screen specs that need layout updates |
| "add screen for X" | New `screens/*.md`; update screen index in design-system.md |
| "update tokens" / "change accent" | Edit DESIGN.md YAML + prose → sync design-system.md CSS block |
| "sync design-system from DESIGN" | Regenerate token/CSS sections from DESIGN.md; preserve component patterns |
| "design pass report" | List surfaces specced vs. deferred; lint status; files changed |
| "sync the design" / "I changed it on the canvas" | Design sync (below) |

Use targeted edits. One write pass per operation when possible.

**Sync before and after a change.** When DESIGN.md's header records an artifact, every operation in this table starts with Design sync, so it edits files that already hold what was changed on the page. After the operation, send what it changed: `DESIGN.md` or `design-system.md` to the Design System artifact (Step 7, later run), a screen file or `_theme.css` to the canvas (Step 6, later run). In a session that can't publish, finish the operation and say nothing more: the next sync in a session that can publish sends the change.

### Design sync

Copies what changed on a published page into the files, and what changed in the files onto the page, since the last time they matched. The whole procedure is in [design-sync.md](design-sync.md): what counts as the same on both sides, the sync record that tells which side changed, and what to do with each change.

- **It doesn't ask.** A change on one side is copied to the other. The user is asked only when the same screen or token was changed on both sides, or when a screen was removed from the canvas.
- **It says what it copied**, in one short block, and nothing when there was nothing to copy.
- **A screen changed on the canvas updates its spec too.** The screen file is replaced by the canvas's version and the lines of its spec the change touches are brought up to date, so phase-planner and phase-builder read a spec that matches the mockup.
- **When it runs:** at the start of every run of this skill (Step 1), before and after any operation above, before phase-planner creates a phase, before phase-builder starts a build, and when the user asks for it.

---

## Integration map

| Skill / tool | When |
|--------------|------|
| **Scope doc** | Input — product/architecture only |
| **design-planner** | This skill — visual language + screens |
| **phase-planner** | Sprints — references screen specs |
| **phase-builder** | Build — reads `design-system.md`; wave-test asserts against it |
| **A frontend-design-style skill, if available** | Direction workshop + optional prototypes only — not production UI |
| **A ui-pattern skill, if available** | Implementation patterns during phase-builder — loses to project design docs |
| **product-planner** | Non-UI product planning — do not use for design-system output |
| **Artifact tool with a Design System type, if the session has one** | Step 7 publishes the design system; Design sync keeps its page and the files the same. No skill builds from the artifact |
| **Artifact tool with a Design type, if the session has one** | Step 6 publishes the mockups as artboards on one canvas; Design sync keeps each artboard and its screen file the same. No skill builds from the canvas |

---

## Quality checks before finishing

- [ ] User confirmed design direction (Step 4)
- [ ] `DESIGN.md` has valid YAML + all required body sections (or omitted with reason)
- [ ] Lint passes or manual checklist complete
- [ ] Every P0/P1 surface has a screen spec **and** HTML mockup with link from spec
- [ ] `docs/design/screens/index.html` hub links all mockups
- [ ] `design-system.md` exists with CSS tokens aligned to DESIGN.md
- [ ] Scope UX hard rules appear in Do's and Don'ts
- [ ] No sprint/task breakdown in design artifacts (that's phase-planner's job)
- [ ] Artifacts saved under `workspace_root/docs/design/`, not inside app_root unless user explicitly uses single-folder layout
- [ ] If a Design System artifact was published: its URL is in DESIGN.md's header, every DESIGN.md token is in it with the same value, and it passes the type's own checks — every token has a usage note, and text contrast is at least 4.5:1 in every theme (full list in [artifacts.md](artifacts.md))

- [ ] If a Design canvas was published: its URL is in DESIGN.md's header and in `screens/index.html`, it has exactly one artboard per HTML mockup, each titled with its screen spec's name, the project's design system is installed on it, and each artboard is its screen file under `docs/design/screens/`, byte for byte (full list in [artifacts.md](artifacts.md))
- [ ] If either was published or revised: `docs/design/.sync.json` records it as it is now

The last three checks apply only when this session published or revised that artifact. With no Artifact tool, or without the type listed, they are skipped, not failed.

---

## Anti-patterns

- **Skipping direction confirmation** — locking tokens without user pick → rework in every UI sprint
- **Specifying all future phases** — over-design before validation
- **HTML monolith plan** — that's product-planner; use markdown screen specs instead
- **Tokens only in design-system.md** — DESIGN.md must exist as the portable agent contract
- **Generic AI aesthetics** — a default sans-serif + purple gradient unless the product explicitly calls for it
- **Implementing production components in this skill** — prototypes are static HTML only; code ships in phase-builder
- **Pointing the build at an artifact** — handing phase-planner or phase-builder an artifact link. They read `docs/design/`; Design sync is what puts a page edit there
- **Two versions of a screen** — keeping a plain mockup beside its artboard, or converting on the way up. Once a project has a canvas, the screen file on disk is the artboard
- **Asking which side wins** — the sync record says which side changed. Ask only when both did
