---
name: ui-workflow
description: Reliable workflow for building or fixing UI so results look intentional, not generic. Use for any frontend/UI task — new screen, component, redesign, "make it look better", layout, styling, or when the user says UI is the pain point.
---

# UI workflow

UI is unreliable when taste is vague and there's no visual check. Fix both: lock
one visual direction, build on a real component system, then verify with a
screenshot instead of guessing.

## 0. Pick ONE direction — don't stack taste skills
This machine has many competing "taste"/design skills (ui-ux-pro-max,
design-taste-frontend, high-end-visual-design, minimalist-ui,
industrial-brutalist-ui, stitch-design-taste, brandkit, …). Using several at once
produces muddy, inconsistent output. For a given project, choose **one** taste
source and stick to it. If unsure, ask the user for a reference (a URL or
screenshot) and match that.

## 1. Ground the components (current APIs, not memory)
- Reuse the project's existing components and design tokens first.
- For shadcn/ui: use the **shadcn MCP** (`get_component`, `get_block`, `list_blocks`,
  `apply_theme`) to pull real, current component code — don't hand-write it.
- For any library's props/API, confirm via **Context7** rather than recalling it.
- New visuals (icons, imagery): use the imagegen/frontend skills already installed
  rather than inventing SVGs.

## 2. Build
- Match the project's stack (most of yours are Next.js). Tailwind + a component
  system (shadcn/Radix) over bespoke CSS unless the project says otherwise.
- Accessibility is not optional: labels, focus states, contrast, keyboard nav.
  Run the installed web-design-guidelines/accessibility skills on the result.

## 3. Verify visually (the step that makes UI reliable)
- Render it and **screenshot** with the Playwright or chrome-devtools MCP (both
  installed). Check desktop AND a mobile width.
- Compare against the reference/design. List concrete differences (spacing,
  hierarchy, color, alignment) and fix them. Iterate until it matches — don't
  declare it done from the code alone.
- For a second opinion, hand the screenshot + reference to the `frontend-verifier`
  subagent.

## Done =
Matches the reference at both breakpoints, passes accessibility checks, uses the
project's tokens/components, and you've shown the final screenshot as evidence.
