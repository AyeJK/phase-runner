---
name: product-planner
description: "Plans out a product, product feature, or set of related features and produces a rich HTML planning document. Use when the user wants to plan a new feature, explore implementation options, design a product flow, or create a visual spec before generating phase plans. Output is a self-contained HTML file saved to docs/ and presented as a viewable artifact. The HTML includes: overview, data flow diagram, options considered, UI mockups, technical decisions, and open questions. Designed to feed directly into phase-planner for phase plan generation. Trigger phrases: 'plan this feature', 'help me think through', 'create a product plan', 'plan out', 'I want to build', 'design the flow for', 'what are my options for', 'spec this out'."
---

# Product Planner

Produces a rich, self-contained **HTML planning document** from a product or feature description. This document serves as the primary reference for implementation agents and feeds into `phase-planner` for phase plan generation.

The output is NOT markdown. It is a single navigable HTML file with visual sections, SVG diagrams, and mockups — something you'll actually open and read.

The file in `docs/` is the plan. In a session that can publish artifacts, the same file is also published as a hosted page with a shareable link (Step 4). That page is a copy for reading and sharing; nothing downstream reads it.

---

## Step 1 — Gather Context

Before writing anything, get the information needed to produce a useful plan. Two paths:

### Path A — User has an existing plan doc

If the user pastes a plan or references an existing file (e.g. `docs/BuildPlan.md` or similar), read it. Extract:
- Feature/product name and one-line description
- Key goals and success criteria
- Any architecture, stack, or constraints already decided
- Any data flow or sequence already described
- Open questions still unresolved

Use the existing doc as the **source of truth** — don't re-interview on things already answered. Only ask for what's genuinely missing.

### Path B — Starting from scratch

Ask the user the following (combine into one message, not one question at a time):

```
To build the plan, I need a few things:

1. **What are we building?** — feature name and one-line description
2. **What problem does it solve?** — user need or workflow it replaces
3. **Scope** — single feature, multiple related features, or full product?
4. **Stack constraints** — existing tech stack or greenfield?
5. **Any options already on the table?** — approaches you're considering or have ruled out
6. **Anything already decided?** — architectural choices, APIs, data models locked in
7. **What's the biggest unknown?** — what you most need this plan to help figure out
```

Don't proceed to Step 2 until you have enough to write a substantive plan. If the user gives a one-liner, probe for the minimum viable context before writing.

---

## Step 2 — Read Project Context

Before writing the plan, read the project's existing codebase context to ground the plan in reality:

1. Read `CLAUDE.md` in the project folder (if present) for stack and conventions
2. Scan `docs/` for any existing phase plans, architecture docs, or prior specs
3. If the project has a repo, do a quick scan of key structural files (e.g. the stack manifest, schema files, main route files) to understand the current state
4. Note what already exists vs. what's net-new

This context informs the data flow diagram, option feasibility, and technical decision sections.

---

## Step 3 — Generate the HTML Plan

Write a single self-contained HTML file, starting from [template.html](template.html) in this skill's folder. Follow the structure below precisely. All CSS and JS stay inline; the only outside request is the template's Google Fonts link, and the page must read correctly without it. The file must open correctly in a browser with no server.

### File naming

```
docs/Plan-{FeatureName}-{YYYY-MM-DD}.html
```

e.g. `docs/Plan-NotificationsRework-2026-05-22.html`

Save to the project's `docs/` folder (the top-level coordination folder, NOT inside the app subfolder).

### Required HTML structure

The document has a **top bar**, a **left sidebar** of numbered section links, and **anchor-linked sections** in one column. All sections are visible on the page — no tabs. The template's only script marks the sidebar link for the section in view.

#### Mandatory sections (in order):

**1. Header**
- Top bar: the feature name, then "Product plan" and the status badge (Draft / In Review / Approved) at the right
- Page header: the feature name (large), the one-line description, and the date
- Nothing else in the header: no project line, no author, no "Product plan" eyebrow above the name

**2. Overview**
- What we're building (2–4 sentences)
- Why we're building it — user need or problem being solved
- What success looks like — measurable outcomes or acceptance criteria
- Scope: what's in, what's explicitly out

**3. Data Flow**
- SVG diagram showing system components, data movement, and key decision points
- Label every node and arrow clearly
- Use color to distinguish, with the template's node classes: user actions (gold, `n-user`), system components (gray, `n-sys`), external APIs (cyan, `n-ext`), data stores (green, `n-store`), and the matching legend
- Include a brief narrative below the diagram explaining the flow in plain English

**4. Options Considered**
- For each approach considered (minimum 2, maximum 5):
  - Option name + one-line description
  - For (green-bulleted list)
  - Against (red-bulleted list)
  - Verdict: Selected / Rejected / Deferred (with reason). Selected gets the green badge and green edge; Rejected and Deferred get quiet grey tags
- If only one option was considered, say so and explain why no alternatives were evaluated

**5. UI Mockups** *(omit only if purely backend/infra with zero UI surface)*
- HTML wireframes — structural layout, not visual polish — drawn with the **wireframe kit** (below), never the plan's own design
- Label every interactive element (buttons, inputs, dropdowns) with a blue `note`
- Include at minimum: the primary user-facing screen and any key state changes (empty state, loading, error, success)
- Use simple bordered boxes and placeholder text — this is a wireframe, not a design

**6. Technical Decisions**
- Locked-in architectural and implementation choices
- Format each as:
  - **Decision:** What was decided
  - **Rationale:** Why
  - **Constraints:** What this rules out going forward
- Include only genuinely decided things — not aspirations

**7. Open Questions / Risks**
- Unresolved decisions that will affect implementation
- Format each as:
  - **Question:** What needs to be answered
  - **Impact:** What depends on this answer
  - **Owner:** Who needs to answer it (user, external team, research)
- Include real risks (technical, scope, dependency) with likelihood and impact notes

**8. Implementation Handoff**
- A crisp summary for phase-planner: what this plan produces, what the first sprint should accomplish, key constraints the implementation agent needs to know
- Suggested phase structure (rough, non-binding): e.g. "Phase 1: API integration → Phase 2: UI → Phase 3: Polish"
- A "Generate Phase Plan" prompt the user can copy-paste to phase-planner:

```
Use this plan as input: [path to this HTML file]
Generate a phase plan for [feature name]. Stack: [stack].
First phase goal: [first phase goal].
```

The path is always the file in `docs/`, never an artifact link.

### HTML design guidelines

The plan's look is fixed by [template.html](template.html): it matches phase-viewer, so a plan and the build dashboard read as one tool. Copy the template's `<head>`, `<style>` and `<script>` unchanged and write the content into its markup patterns. Don't restyle it, and don't add CSS for something the template already has a class for. If the plan needs something the template lacks, add a small rule that uses the template's tokens.

The plan has to read correctly in two places: opened from disk, and hosted as an artifact (Step 4). The template already handles both; keep these rules when adding anything:

- Title: `<title>` is the feature name and nothing else — e.g. `<title>Notifications Rework</title>`. No "Plan:" prefix, no date, no description after a dash or colon. A hosted copy takes its name from it
- Colors: every color is a token in the template's `:root` blocks (dark first, then the light set under `prefers-color-scheme: light` and again under `:root[data-theme="light"]`). Everything outside the token blocks and the wireframe kit uses `var(--token)`. A new token goes in all three blocks
- Body: `body` sets `background: var(--bg)` and `color: var(--text)` explicitly. A hosted page sits on the host's own background, and a `body` without one lets it show through

What the template gives you, so you don't have to re-decide it:

- **Theme:** dark by default (warm near-black `--bg`, `--surface` panels, gold `--accent`), light from the reader's system setting. Status colors carry meaning: green `--passed` for selected and in scope, red `--failed` for cons and high risk, violet `--manual` for a task only the user can do. The accent is for links, the current section and user actions, never a status
- **Type:** IBM Plex Sans, IBM Plex Mono for ids, badges and code, falling back to the system fonts. Prose is 17px, the base 16px. Subheadings (`h3`) are 17px in `--text`; section headings 22px with a mono number
- **Layout:** a 56px sticky top bar, a 264px sticky sidebar, and an 880px content column. Paragraphs run the full column width; there's no `max-width` on text. Below 720px the sidebar is hidden and the column takes the screen
- **Patterns:** `.prose` for paragraphs, `.bullets` (square markers: `big` for main lists, `pass`, `fail`, `quiet` for color), `.panel` for a bordered box, `.rows` for a bordered list of `.row` items with a `.row-h` head (id, name, end item) and `.row-b` body, `.kv` for label/value pairs, `.status` and `.tag` badges, `.lvl` for risk levels, `.manual` for MANUAL tasks

### Wireframe kit

UI mockups use a separate, standard wireframe kit, also in the template. It doesn't inherit the plan's design: grey paper and grey ink, the system font, and one blue (`--wf-note`) for annotations. Its values are fixed on `.phone`, so wireframes look the same in every plan and in both themes, and never hint at the product's visual identity. That is design-planner's job.

- Inside `.phone`, use only the kit's classes: `bar`, `wf` (with `dash`, `img`, `win`, `warn`, `err`), `btn` (with `primary`, `ghost`), `line`, `chips`/`chip` (`on`), `slots`/`slot` (`filled`), `note`, `small`, `spacer`
- Never use the plan's tokens, badges or colors inside a wireframe. States are shown by line weight, dashes and grey fill: the winner has a heavy border, warnings and errors are dashed on grey, image placeholders are striped
- Each phone sits in a `.phone-wrap` with a `.phone-cap` caption (number and screen name). The caption is plan styling; the phone is kit styling
- The mockups intro says "Blue notes label interactive elements"

These are defaults for the **planning document itself** (a tool for you to read the plan), not a statement about the product's own visual identity.

### SVG diagram guidelines

- Viewbox: `0 0 800 400` or taller as needed
- Nodes: `rx="6"` rounded rectangles, labeled with `<text>` elements
- Arrows: `<line>` or `<path>` with `marker-end` arrowhead definitions in `<defs>`
- Colors: use the template's classes (`n-user`, `n-sys`, `n-ext`, `n-store` for nodes; `t` and `ts` for labels; `ln`, `dash`, `zone`, `zt` for lines and zones), never a literal value or inline color, so the diagram reads in both themes. Check that each label reads against its node's fill
- Put the SVG in a `.panel.diagram`, with the `.legend` above it
- Keep it legible: minimum font size 13px, adequate spacing between nodes
- Don't use ASCII art — always SVG for diagrams

---

## Step 4 — Save and Present

1. Write the file to `docs/Plan-{FeatureName}-{YYYY-MM-DD}.html` in the project folder
2. If the session can publish the file as an artifact, publish it (see below). If it can't, skip this step
3. Present it to the user: the file path, plus the artifact link if step 2 published one
4. Offer the user two follow-up options:

```
Plan saved. Next steps:

1. **Generate phase plans** — hand this off to phase-planner:
   "Use docs/Plan-{name}.html as input. Generate phase plans for {feature}."

2. **Iterate on the plan** — tell me what to adjust: add a section, revise an option,
   update the data flow, add mockups for a specific screen, etc.
```

### Publishing the plan as an artifact

Some sessions have an Artifact tool that publishes a local HTML file as a hosted page and returns its link (Claude app sessions do). Check the session's tools instead of assuming. With no such tool, present the file exactly as you would have before and say nothing about artifacts.

When the tool is there:

1. **Publish the saved file.** Give the tool the path of the file from step 1 — that file, not a copy or a rewritten version. Supply whatever else it asks for on a first publish (a one-sentence description, for example)
2. **Record the URL.** Add this tag to the file's `<head>`, straight after `<title>`:

   ```html
   <meta name="phase-runner:artifact" content="{url}">
   ```

   A later session reads the tag and republishes to the same URL instead of creating a second artifact. Don't republish just to get the tag into the hosted copy — the next revision carries it
3. **Give the user both.** The artifact link for reading and sharing, and the file path as the spec

Rules for every publish:

- **The file is the plan.** Publishing never replaces, moves or renames it, and every change goes into the file first. The artifact is a hosted copy of it
- **A failed publish is one line, never a stop.** If the tool errors or refuses, say so in one line of the reply (`Couldn't publish the artifact: {reason}. The plan is at docs/Plan-{name}.html.`) and carry on to the follow-up options. No retry loop, and nothing for the user to fix before they can use the plan
- **One plan, one artifact.** A file that already has a `phase-runner:artifact` tag is republished to that URL, as Iteration describes
- **The plan keeps its own design.** If the tool comes with page-design guidance, apply it only where it's about hosting (the title, theme tokens, what may load from outside the page). The sections and layout stay as Step 3 describes

---

## Step 5 — Handoff to Phase Planner (if requested)

If the user asks to proceed to phase planning immediately after the plan is created:

1. Read the Implementation Handoff section from the plan file
2. Invoke the `phase-planner` skill with the plan's file path (`docs/Plan-{name}.html`) as context
3. The phase plans go to `docs/phases/Phase-{N}-{Name}.md` as normal markdown — the HTML plan is the *input spec*, not the output format

The HTML plan file persists as the reference. `phase-planner` and the implementation agents spawned by `phase-builder` are pointed at its file path for full context — never at the artifact URL, even when one exists. They read `docs/`, and an artifact link is not something they can rely on being able to open.

---

## Iteration

If the user asks to update an existing plan (e.g. "revise the options section", "add a mockup for the settings screen", "update the data flow now that we've decided on X"):

1. Read the existing HTML file — the one in `docs/`, not the published page
2. Make the targeted edit — don't rewrite the whole file unless asked
3. Re-save the file
4. If the session can publish artifacts, republish it (see below)
5. Re-present the file path, and the artifact link if there is one
6. Note what changed in one line

### Republishing a revised plan

The edit goes into the file first; the artifact is updated from the file, never the other way round.

- **The file has a `<meta name="phase-runner:artifact">` tag.** Republish the file to the URL in its `content`, so the same link now shows the revision. The tool may want the live page read before a new session can update it; do that read if it asks, then publish the file. If the two differ, the file wins
- **The file has no tag.** Publish it as new and record the URL, as in Step 4. This covers plans written in a session that couldn't publish
- **Republishing to the recorded URL fails.** Say so in one line and leave the tag as it is. Don't publish a second artifact on your own; if the user asks for a new one, publish it and replace the URL in the tag
- **The session can't publish.** Edit and re-save as before, and leave any existing tag in place for a later session

---

## Quality checks before saving

- [ ] All 8 sections present (or UI Mockups explicitly omitted with reason)
- [ ] SVG data flow diagram is present and labeled
- [ ] At least 2 options compared in Options Considered
- [ ] Sidebar navigation links to all sections via anchor IDs
- [ ] File opens correctly from disk; the Google Fonts link is the only outside request
- [ ] `<title>` is the feature name alone
- [ ] The template's `<style>` and `<script>` are copied unchanged; any added rule uses its tokens
- [ ] Header holds only the name, the one-line description and the date; the status badge is in the top bar
- [ ] Wireframes use only the wireframe kit's classes, with blue notes on every interactive element
- [ ] Implementation Handoff section includes the phase-planner prompt, with the file path
- [ ] File saved to `docs/` (not inside the app subfolder)
