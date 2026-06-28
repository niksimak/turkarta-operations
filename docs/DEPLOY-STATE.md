# Deploy State — turkarta-operations

_Last updated: 2026-06-28_

## Status: scaffold complete + relay hardened, not yet deployed

TypeScript (grammY + Hono) ops hub with **two bots in one service**. Builds clean
(`pnpm typecheck` + `pnpm build` both pass). Committed, not yet deployed.

**2026-06-28 — added (commit pending):**
- **Media relay both directions** in support (photos/docs/voice/video/stickers via
  `copyMessage`, attributed). Critical for payment support — users send screenshots.
- **`/id` command in both bots** — prints caller tg id + chat id. Use it to grab
  `*_CHAT_ID` (step 4) and roster `tg_id`s (step 5) without fishing through `getUpdates`.
- **Resolve closes the forum topic** so the support group's topic list stays clean.
- **Graceful shutdown** — drains the PG pool on Render's SIGTERM/SIGINT.

## Decisions locked
- **Stack:** TypeScript (grammY + Hono + postgres + zod), Node 22, deploy on Render.
- **Two bots, one repo:** `@turkarta_leads` (internal) + `@turkarta_support` (user-facing).
- **Lovable = Lovable Cloud** → its DB is unreachable. So:
  - Landing form **POSTs leads to** `/webhooks/leads` (see `docs/LOVABLE_SETUP.md`).
  - We run **our own ops Postgres** for lead/ticket state + claim status.
- **Notify = roster @-mentions** (bots can't @all / can't list members).
- **Claim = race-safe** `UPDATE … WHERE status='new'`; first tap wins.
- **Support relay:** forum-topic per ticket; user DM ↔ agent thread; Resolve closes it.

## What's built
- `src/` — config, db (claim + relay), cards, bots/leads, bots/support, server, index
- `migrations/0001_init.sql` — `leads` + `support_requests`
- `docs/LOVABLE_SETUP.md` — Lovable form→webhook wiring (edge-function prompt + contract)
- `Dockerfile`, `render.yaml`, `.env.example`, isolated `pnpm-workspace.yaml`

## Pickup — next session (in order)
1. ~~Commit the scaffold~~ ✅ done (`61bf9a5`).
2. **Provision ops Postgres** — a Supabase project *you own* (or Render PG) → `DATABASE_URL`.
   Then `pnpm migrate`.
3. **BotFather:** create both bots → tokens. Support bot: `/setprivacy → Disable`.
4. **Create groups**, add bots, make the support group a **forum/topics** supergroup.
   Grab chat IDs by sending **`/id`** in each group (or DM a bot `/id` for your own tg_id).
5. **Fill `.env`** (tokens, chat IDs, DATABASE_URL, PUBLIC_BASE_URL, secrets, ROSTER).
6. **Deploy to Render** (Docker) → set `PUBLIC_BASE_URL` to the Render URL → webhooks
   self-register on boot.
7. **Wire Lovable** — paste the prompt from `docs/LOVABLE_SETUP.md` into Lovable's AI.
8. Smoke test: submit a test lead → card appears → tap Take → status flips. Then DM the
   support bot → ticket card → claim → relay both ways → resolve.

## Inputs still needed from Nikita
- 2 bot tokens, 2 chat IDs, ops `DATABASE_URL`, roster (names + @usernames + tg_ids).
- Confirm the Lovable form's actual field names (assumed: name / contact / message).

## Open questions / risks
- Lovable Cloud edge-function availability — if not available, fall back to client-side
  fetch (secret exposed; rotate-able). See `docs/LOVABLE_SETUP.md`.
- Support bot privacy mode MUST be disabled or agent replies won't relay.
- One open support ticket per user enforced by a partial unique index — fine for v1.
