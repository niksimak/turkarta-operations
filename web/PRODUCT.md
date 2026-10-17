# Product

<!-- impeccable:product-schema 1 -->

> Written without an interview round: this run had no answer mechanism (a
> subagent with no question tool). Every fact below comes from the task brief
> and spec `docs/superpowers/specs/2026-10-16-support-crm-design.md`; items
> marked *(inferred)* are assumptions to confirm.

## Platform

web

## Users

3 to 10 Russian-speaking Turkarta support operators (roles `admin` and
`support`, some marked `is_lead`). They sit in this tool for a full shift,
every working day, answering users who wrote through the Telegram bot, the
Mini App or the web PWA. Desktop first (1280 px and up); a phone is a
fallback for checking the queue *(inferred)*.

## Product Purpose

Replace Bitrix Open Lines and the Telegram forum relay with one queue Turkarta
owns: every support conversation lands as a ticket, gets claimed or
auto-assigned, is answered with text and photos, and is resolved within SLA.
Success: no ticket waits past its SLA unnoticed, and an operator can go from
alert to reply in a few keystrokes.

## Positioning

Built for Turkarta's own support: tickets carry the customer's Turkarta
account (cards, KYC level, recent top-ups) next to the thread, and the access
comes from the Turkarta admin by single sign-on.

## Operating Context

- Entry: the Turkarta admin «Поддержка» link (signed 60 s token, 12 h session).
- Live updates over SSE; sound and browser notifications for new tickets and
  personal events.
- Views: Очередь, Мои, Все; Статистика, Шаблоны, Настройки.
- Shift state («На смене») and a 60 s heartbeat drive auto-assignment.
- Long sessions under office light by day and dim light on evening shifts
  *(inferred)*; theme follows the OS with a personal override.

## Capabilities and Constraints

- React 18 SPA served by the ops service at `/crm`; API at `/crm/api`.
- UI copy in Russian; code and docs in English.
- Photos only (JPG, PNG, WEBP, up to 8 MB, up to 10 per message).
- Keyboard-first: `j`/`k`, `Enter`, `a`, `e`, `/`, `g q` / `g m` / `g a`.
- No component library; plain React, Tailwind and CSS variables.

## Brand Commitments

- Internal tool of the Turkarta family; inherits the product blue accent
  (`#3e87ff` in the Turkarta UI kit) as a recognition detail *(inferred)*.
- Voice: short, plain, actionable Russian. No em-dashes, no filler, no
  decorative emoji (owner rule).

## Product Principles

1. The queue state is never ambiguous: what waits, how long, and who owns it.
2. Colour means something or it is absent (SLA, channel, notes, failures).
3. Calm over clever: nothing moves or glows unless state changed.
4. Every action reachable by keyboard, with a visible focus.

## Accessibility & Inclusion

WCAG AA contrast in both themes, visible focus on every control,
`prefers-reduced-motion` honoured.
