# Deploy State — turkarta-operations

_Last updated: 2026-06-26_

## Status: scaffold complete, not yet deployed

TypeScript (grammY + Hono) ops hub with **two bots in one service**. Builds clean
(`pnpm typecheck` + `pnpm build` both pass). Nothing committed yet, nothing deployed.

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
4. **Create groups**, add bots, grab chat IDs via `getUpdates`. Make support group a
   **forum/topics** supergroup.
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
