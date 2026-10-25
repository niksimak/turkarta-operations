# CRM design system

Source of truth for every CRM view. Tokens live in `src/styles/tokens.css` and
are mapped 1:1 in `tailwind.config.ts`; components use the Tailwind names, never
raw hex. Product facts: `PRODUCT.md`.

## Direction: station wayfinding

A support desk that reads like a metro wayfinding system: neutral plates, a
strict signage hierarchy, and colour only where it identifies a line (the
channel) or raises an alarm (SLA, failure). The operator should know what
waits, how long, and whose it is at a glance, all shift long.

- Mode: Operate. Familiar affordances beat novelty; brand lives in details.
- Refuses the helpdesk default: purple accent, soft shadowed cards, avatars and
  colour on every row.
- Disciplines kept from the challengers this direction beat (seed `3d88a2ed`):
  - tabular numerals everywhere a number can change (data-field discipline);
  - a strict 4 px module, nothing off-grid (construction-grid discipline);
  - fixed row and control heights so lists compare at one scale;
  - density without apology: 14 px body, 32 px controls;
  - coded colour stays coded: a hue never doubles as decoration.

## Colour

Strategy: Restrained. Neutrals plus one accent; meaning colours are small
(dots, timer text, badges), never fields. The only tinted surface is a note.

| Token | Light | Dark | Use |
|---|---|---|---|
| `bg` | `#f3f4f6` | `#0f1114` | app ground behind panes |
| `surface` | `#ffffff` | `#16191d` | working plates: list, thread, active nav plate |
| `surface-2` | `#ebedf0` | `#1c2025` | second layer: nav rail, toolbars, panel |
| `border` | `#dde0e5` | `#2a2f36` | hairlines, plate outlines |
| `border-strong` | `#8a919d` | `#5f6773` | control outlines, switch track off (3:1) |
| `text` | `#16181d` | `#e6e8eb` | primary text |
| `text-muted` | `#5a6170` | `#9ba2ad` | secondary text, placeholders (≥5.3:1 on every surface) |
| `hover` / `pressed` | text at 5 % / 9 % | text at 6 % / 10 % | overlays on any surface |
| `accent` | `#2160e0` | `#6b9bff` | primary action, current item, focus ring |
| `accent-hover` | `#1a52c4` | `#86adff` | primary button hover |
| `accent-fg` | `#ffffff` | `#0b0d10` | text on accent fills |
| `accent-soft` | `#e7eefd` | `#1a2740` | selected row |
| `sla-ok` / `-soft` | `#1d7a43` / `#e3f3e9` | `#4cc27a` / `#13291c` | within target |
| `sla-warn` / `-soft` | `#975600` / `#fcf0d8` | `#e6a23c` / `#33270f` | past warn share; also «Переподключение…» |
| `sla-late` / `-soft` | `#c8322f` / `#fbe9e8` | `#ff6b63` / `#3a1c1c` | overdue |
| `note-bg` / `note-border` / `note-text` | `#fdf3d7` / `#ecd593` / `#6b4a00` | `#2b2414` / `#4d3f1c` / `#e8c770` | internal notes (amber) |
| `danger` / `-soft` | `#c8322f` / `#fbe9e8` | `#ff6b63` / `#3a1c1c` | delivery failure, destructive actions, save errors |
| `ch-bot` | `#198edb` | `#3198d6` | Telegram bot marker |
| `ch-miniapp` | `#583bab` | `#8459db` | Mini App marker |
| `ch-web` | `#128d6f` | `#158561` | Web/PWA marker |
| `ch-payout` | `#a86a00` | `#c98a12` | «Выплата» ticket marker |

Contrast (WCAG): every text token, SLA and accent colour included, is ≥4.5:1
on `bg`, `surface` and `surface-2` in both themes; SLA text on its own soft tint
is ≥4.5:1. `ch-*` are graphic markers only (≥3:1 on `bg`, `surface`,
`surface-2` and the selected-row tint), so never set text in a channel colour.
They also colour the stats chart, so the three are tuned as one categorical
set: the dataviz validator passes them all-pairs in both themes (worst CVD
ΔE 16.1 light / 9.9 dark, normal vision 16.8 / 17.4). Re-run it before
changing any of them.

Rules:
- Accent marks the current thing and the primary action. Not headings, not icons
  at rest, not links in prose.
- Channel = a 8 px circle marker (a metro line dot) plus its name in the tooltip
  or label. Shape stays the same across channels; only hue changes.
- SLA colour goes on the timer text and its small soft badge, not the row.
- One amber: notes. SLA warn is ochre (`#975600`) so the two never read alike.

Theme: `system` by default; `data-theme="light"|"dark"` on `<html>` from
`prefs.theme`, remembered in `localStorage` (`crm.theme`) so the first paint is
right. Without JS the OS preference applies (the duplicated dark block in
`tokens.css`; a test keeps both copies equal).

## Type

One family: **Golos Text** (Paratype, Cyrillic-first, built for Russian
interfaces), self-hosted via `@fontsource/golos-text`, weights **400 and 600
only**. Fallback `system-ui, -apple-system, "Segoe UI", Roboto`. Mono
(`ui-monospace` stack) only for ids, tokens and copied values.

| Class | Size / line | Use |
|---|---|---|
| `text-xs` | 12 / 16 | badges, timestamps, meta |
| `text-sm` | 13 / 18 | secondary rows, row previews |
| `text-base` | 14 / 20 | body, controls, nav (default) |
| `text-md` | 15 / 22 | message bubbles, rail title |
| `text-lg` | 17 / 24 | pane and dialog titles |
| `text-xl` | 20 / 28 | page titles (Статистика, Настройки) |

- `font-semibold` (600) for titles, the active nav item, counts, buttons. No
  other weights, no italics in UI.
- `.num` (`tabular-nums`) on every count, timer, amount and date column.
- Fixed rem scale; nothing fluid. Prose (messages) caps at ~70ch.

## Space, size, radius

- 4 px module: 4, 8, 12, 16, 20, 24, 32, 40. Tight inside groups (4 to 8),
  16 to 24 between groups, more space above a heading than below.
- Controls: 32 px default (`h-8`), 28 px compact (segmented items), 36 px for
  the one primary action on a pane. Nav item 32 px (36 px on the compact rail).
- Rail 216 px (`w-rail`) at ≥1024 px, 56 px icon rail below
  (`w-rail-compact`); labels become `aria-label` + `title`.
- Radius: `xs` 4 (badges, segment items), `sm` 6 (buttons, inputs, nav items),
  `md` 8 (plates, popovers), `lg` 12 (sheets, lightbox). Circles only for
  markers, avatars and the switch.
- Depth: flat plates separated by 1 px borders or `0 0 0 1px var(--border)`
  rings. `shadow-pop` only for floating layers (menus, popovers, toasts).

## Density rules

- Desktop first (≥1280): rail, list, thread, user panel side by side.
- List rows: two lines (name + timer; preview), 56 px, no card chrome, divided
  by hairlines. Hover = `hover` overlay, selected = `accent-soft`.
- Counts as plates: 20 px tall, `bg-surface` + ring; zero hides on the compact
  rail and turns muted on the wide one. Overdue count is `sla-late` on its soft
  tint and hides at zero.
- Empty states teach the next action in one line; no illustrations.
- Loading: skeleton blocks in `hover` tint at final size, never centred spinners.

## Motion

| Token | Value | Use |
|---|---|---|
| `--dur-press` | 120 ms | press scale |
| `--dur-fast` | 150 ms | colour, background, hover |
| `--dur-base` | 200 ms | switch thumb, menus, message enter |
| `--dur-slow` | 260 ms | sheet, lightbox |
| `--ease-out` | `cubic-bezier(0.23, 1, 0.32, 1)` | anything entering or responding |
| `--ease-in-out` | `cubic-bezier(0.77, 0, 0.175, 1)` | movement on screen (list reorder) |
| `--ease-drawer` | `cubic-bezier(0.32, 0.72, 0, 1)` | mobile sheet |
| `--press-scale` | 0.97 | `.press:active` |
| `--enter-shift` | 4 px | entering message / toast offset |

- Animate only what changed state: message enter, list reorder, lightbox zoom
  from the thumbnail, menus. No page-load choreography.
- Keyboard-driven actions (`j`/`k`, `g q`, `Enter`, `/`) never animate.
- Transitions, not keyframes, for anything that can retrigger. Exits faster
  than enters. Never from `scale(0)`; start at 0.95 + opacity 0. Popovers
  scale from their trigger.
- `prefers-reduced-motion`: `--press-scale` → 1 and `--enter-shift` → 0;
  colour and opacity transitions stay.
- Hover effects only under `(hover: hover) and (pointer: fine)` (`.hover-surface`).

## Interaction floor

- Every control is a real `button`/`a`/`input`; keyboard reachable.
- Focus: `:focus-visible` only, 2 px `--focus` outline, 2 px offset. Never
  remove it without replacing it.
- Every pressable gets `.press` (scale feedback + colour transition).
- Toggles: `role="switch"` + `aria-checked` (На смене), `aria-pressed` (Звук),
  `role="radiogroup"` with arrow keys (Тема).
- Optimistic writes roll back on failure and say so in one line («Не
  сохранилось. Повторите.»).
- Live state is announced: reconnect marker is `role="status"`, errors
  `role="alert"`.
- Browser surfaces are themed: `::selection`, caret (`accent`), placeholder,
  thin scrollbars in `border`.

## Copy

Russian, short, plain, actionable. Errors say what happened and what to do.
No em-dashes, no «не X, а Y», no filler, no decorative emoji. Controls name
their action («Войти через админку», «Повторить», «Перехватить»).
