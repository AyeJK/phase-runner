# Design Planner — Reference

File templates, token schema, and screen-spec format.

---

## DESIGN.md template (Google design.md spec)

```markdown
---
name: {Product Name}
version: alpha
colors:
  background: "#..."
  surface: "#..."
  text-primary: "#..."
  text-secondary: "#..."
  accent: "#..."
  on-accent: "#..."
  border: "#..."
  # add semantic colors as needed: success, warning, danger
typography:
  # one token per text style; add or drop steps as the product needs
  display:
    fontFamily: "{display font stack}"
    fontSize: 40px
    fontWeight: 600
    lineHeight: 1.2
  lg:
    fontFamily: "{body font stack}"
    fontSize: 20px
    fontWeight: 600
    lineHeight: 1.3
  base:
    fontFamily: "{body font stack}"
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.5
  sm:
    fontFamily: "{body font stack}"
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.5
spacing:
  "1": 4px
  "2": 8px
  "3": 12px
  "4": 16px
  "5": 24px
  "6": 32px
  "7": 48px
  "8": 64px
rounded:
  sm: 4px
  md: 8px
  lg: 16px
  full: 9999px
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.on-accent}"
    typography: "{typography.base}"
    rounded: "{rounded.md}"
  input:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text-primary}"
    typography: "{typography.base}"
    rounded: "{rounded.sm}"
---

# {Product Name} — Design System

## Overview

{2-4 sentences: what this product is, who it's for, and the one-line design thesis — e.g. "warm and editorial" or "dense and utilitarian."}

## Colors

{Prose explanation of the palette above — when to use accent vs. neutral, dark/light mode notes if applicable.}

## Typography

{Prose explanation of the type scale and font pairing rationale.}

## Layout

{Grid/spacing philosophy, page structure conventions, responsive breakpoints.}

## Elevation & Depth

{Shadow/border conventions for layering — cards, modals, dropdowns.}

## Shapes

{Corner radius usage — when sharp vs. rounded, and why.}

## Components

{Per-component notes beyond the YAML tokens — states, variants, sizing.}

## Do's and Don'ts

**Do:**
- {Product-specific rule translated from scope doc UX requirements}

**Don't:**
- {Product-specific anti-pattern, often the inverse of a hard UX rule from the scope doc}

## Surfaces

| Surface | Route / shell | Phase | Priority | Spec | Preview |
|---------|---------------|-------|----------|------|---------|
| {name} | {route} | {N} | {P0/P1/P2} | [spec](screens/{name}.md) | [preview](screens/{name}.html) |
```

### The token shapes the linter reads

The front matter above is in the shape `design.md lint` accepts. A different shape parses as YAML and still fails the lint.

- **`colors`**, **`spacing`**, **`rounded`**: a flat map of name to value. No nested groups and no lists: a spacing `scale: [4, 8, 12]` is not read.
- **`typography`**: one token per text style, each an object with `fontFamily` and `fontSize`, plus `fontWeight`, `lineHeight` and `letterSpacing` when the style sets them. A bare `body-font` or a `scale` of sizes is not read.
- **`components`**: a flat map, one key per component or variant (`button-primary`, not `button` → `primary`). The sub-tokens are `backgroundColor`, `textColor`, `typography`, `rounded`, `padding`, `size`, `height` and `width`; anything else (a border color, a shadow) goes in the Components prose.
- **References** name the group: `{colors.accent}`, `{typography.base}`, `{rounded.md}`. A bare `{accent}` is an error.

Two warnings are expected and don't need fixing: `missing-primary` when the main color is named `accent`, and `orphaned-tokens` for a color no component references, such as `border`.

---

## Screen spec template

`docs/design/screens/{kebab-name}.md`:

```markdown
# {Screen Name}

**Route/shell:** {route or shell type, e.g. modal, full-screen, sidebar panel}
**Phase:** {N}
**Purpose:** {one sentence}

## Layout

```
{ASCII wireframe or structured block description}
```

## Components

- {Component name} — {brief note, matches DESIGN.md component list}
- {Component name} — {brief note}

## States

| State | Behavior |
|-------|----------|
| Empty | {what's shown with no data} |
| Loading | {skeleton, spinner, or other} |
| Error | {inline vs. toast vs. blocking — per DESIGN.md Do's/Don'ts} |
| Success | {confirmation pattern} |
| {Edge case from scope doc} | {behavior} |

## Copy rules

- {Label conventions, forbidden phrases, tone notes specific to this screen}

## Acceptance bullets

- {Observable, testable outcome — feeds phase-builder Verification.assert}
- {Observable, testable outcome}

**Preview:** [{kebab-name}.html]({kebab-name}.html)
```

---

## HTML mockup template

This is the plain form, for a project with no Design canvas. When the session can publish a canvas, or the project already has one, a mockup is written in the canvas's own form instead ([artifacts.md](artifacts.md), Screen file form), so the file on disk is the artboard.

`docs/design/screens/{kebab-name}.html`:

```html
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>{Screen Name} — Preview</title>
  <link rel="stylesheet" href="_theme.css">
  <style>
    /* screen-specific overrides only — shared look lives in _theme.css */
  </style>
</head>
<body>
  <div class="review-bar">
    <span>{Screen Name}</span>
    <span>Phase {N}</span>
    <a href="index.html">← All screens</a>
  </div>
  <main>
    <!-- Real tokens from DESIGN.md, real layout — not gray wireframe boxes -->
  </main>
</body>
</html>
```

`_theme.css` should define CSS custom properties matching the DESIGN.md YAML `colors`/`typography`/`spacing`/`rounded` tokens exactly, plus base styles for whatever components appear across mockups (buttons, cards, inputs, nav). Every plain mockup imports this one file — no per-screen token redefinition. A mockup in the canvas's form carries a copy of its rules instead, kept the same as this file.

`index.html` is a simple list of links to every screen mockup, grouped by phase, styled with the same `_theme.css`.

---

## Design.md spec compliance checklist

- [ ] YAML front matter parses as valid YAML
- [ ] `name` and `version` present
- [ ] `colors`, `typography`, `spacing`, `rounded` token groups all present
- [ ] `components` has at minimum a primary button and one input definition
- [ ] Body has all eight sections in order: Overview, Colors, Typography, Layout, Elevation & Depth, Shapes, Components, Do's and Don'ts
- [ ] Every color token referenced in prose exists in the YAML front matter (no orphan references)
- [ ] No token value appears only in prose without a corresponding YAML entry

If `npx -p @google/design.md designmd lint` isn't available in this environment, walk this checklist manually before treating DESIGN.md as locked.
