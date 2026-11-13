---
paths:
  - "apps/web/src/**/*.tsx"
  - "apps/web/src/**/*.css"
  - "apps/web/index.html"
  - "apps/web/public/**"
---

# UI

- Design source: `docs/redesign/04-ui-ux-system.md` (Design System v3). Legacy screens (`src/components/`, the v2 `@theme` block in `src/index.css`, class-string exports of `components/ui.tsx`) show behaviour and texts only; new code never copies their styling or structure.
- Visual values exist only in `src/ui/tokens/*.css`. Feature code uses semantic utilities (`text-fg-muted`, `gap-group`, `h-ctl`) and `ui` components. No hex, no arbitrary value, no Tailwind default palette, no `className` passed to `ui` components.
- A screen picks one page template (04 §7.1). It never writes its own `<main>`, page frame, `<table>`, form field, dialog, toast, popover, file input, or SVG icon. Missing pattern → add it to `src/ui/` and to 04 first.
- Density comes from `data-density` on the layout container. Components never take a `dense` flag.
- Every data view shows loading, empty, error and success states.
- Every visible string is an i18n key (`locales/vi`). No Vietnamese literal in `.tsx`. Labels and errors never show internal keys or config paths. One term per concept.
- No native `<select>`, date / month input, or visible `<input type="file">`.
- Accessibility: real `<button>` / `<a href>` / `<label>`; visible focus; APG patterns; contrast per 04 §5.2.
- Heavy libraries stay in lazy chunks; `ui/data/DataGrid` is imported by path, not through the `ui` barrel. State the remaining start-up JS budget (limit 240 KiB gzip, printed by `pnpm build`) at the start of a UI task.
- Do not rely on Tailwind class order to override another class (`pb-0` once lost to `pb-12`).
- New screen or changed layout: build an Artifact mock-up, get the owner's approval, then code. Inspect every screenshot at 1280, 1024 and 390 px yourself before showing the owner.
