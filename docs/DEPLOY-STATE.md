# Deploy State — turkarta-operations

_Last updated: 2026-06-28_

## Status: DEPLOYED + LIVE on Render (free tier) — 2026-06-28

Service `srv-d90g7t4m0tmc73dpi000` → **https://turkarta-operations.onrender.com**
(Render workspace "Turkarta", region frankfurt, plan **free**). Both bot webhooks
self-registered; `/health` green; `/webhooks/leads` smoke-tested (card posted to the
Лиды group). DB = Neon project `turkarta-ops` (calm-rain-98006074), schema migrated.

**Live infra (2026-06-28):**
- Bots: `@turkarta_partners_bot` (leads) + `@turkarta_support_bot` (support, privacy OFF).
- Chat IDs: LEADS `-5387327159` (group) · SUPPORT `-1004370996267` (forum supergroup).
- Repo is **PUBLIC** (no secrets committed) so Render could fetch it. To re-private:
  grant the Render GitHub App access at https://github.com/settings/installations,
  then `gh repo edit niksimak/turkarta-operations --visibility private`.
- Deploy build needed two fixes: Docker `--ignore-scripts` (pnpm 11 esbuild) +
  declared `@types/node`. Auto-deploy on push isn't wired; trigger via API/dashboard.

### Endpoints (live)
- `POST /webhooks/leads` — Lovable landing → partners bot. Fields: name, company, phone,
  email, tg_username (+aliases), message, contact, source. Header `X-Webhook-Secret`.
- `POST /webhooks/support` — Mini App → support ticket. Fields: tg (req), username, name,
  email, device, request (req). Header `X-Webhook-Secret` (`APP_WEBHOOK_SECRET`, falls
  back to `LEADS_WEBHOOK_SECRET`). See `docs/SUPPORT.md`.

### Support ticket system (live 2026-06-28)
Three intake channels → one operator workflow in the TG channel.
- **Bot**: guided intake (request → email/skip, DB-persisted via intake_step).
- **Mini App**: `POST /webhooks/support` (telegram channel; relays via bot DM).
- **Web PWA**: `channel='web'` tickets (no telegram id). Operator replies route to a
  durable `support_messages` log the web app **polls** (server-to-server, proxied by
  the web FastAPI backend with `user.id` as `web_user_id`). Endpoints:
  `POST /api/support/web/open`, `POST /api/support/web/message`,
  `GET /api/support/web/messages?web_user_id&since=<seq>` (integer cursor), and
  `POST /api/support/web/welcome` (proactive onboarding greeting — seeds an agent
  message + posts a "new signup" card; deduped per open ticket).
Operator card: Take → category (tech/bug/feature) + status (Awaiting/Resolve);
'awaiting' = parked-open. Text+media relay both ways (web = text; media TG-only).
Migrations 0004–0007. Full doc: `docs/SUPPORT.md`.

**Web app integration (2026-06-28):** the turkarta repo side (FastAPI proxy
`/api/web/support/*`, React chat screen, proactive welcome on signup) — **PR
niksimak/turkarta#90 MERGED to main/dev**. Needs `OPS_WEBHOOK_SECRET` set on the dev
API (= this service's `LEADS_WEBHOOK_SECRET`) to go live.

**Webhook secret renamed (2026-06-28):** `SUPABASE_WEBHOOK_SECRET` → `LEADS_WEBHOOK_SECRET`
(it was never a Supabase resource — just the shared `x-webhook-secret` string; misleading
name from the scaffold). Renamed in code + Render env (same value). The DB is **Neon only**.

### Remaining
- **Wire Lovable form → `/webhooks/leads`** (see `docs/LOVABLE_SETUP.md`, URL filled in).
- **Wire Mini App → `/webhooks/support`** + route app users through the bot deep link so
  relay works (see `docs/SUPPORT.md`). Optionally set a dedicated `APP_WEBHOOK_SECRET` on Render.
- **Merge web PWA support (PR turkarta#90)** + set `OPS_WEBHOOK_SECRET` on the dev API.
  ~~Add 3 thin proxy routes in `apps/api`~~ ✅ done on the branch. Original notes:
  routes behind web-auth forward to ops with `X-Webhook-Secret` +
  `user.id`, and a chat UI in `apps/webapp` that polls every ~3-5s. Sketch in `docs/SUPPORT.md`.
- Fill `ROSTER` (env on Render) with teammates' tg_ids (via `/id`) to enable @-pings
  + claim gating. Currently empty = anyone can claim, no mention ping.

---
## (historical) Status: scaffold complete + relay hardened, not yet deployed

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
