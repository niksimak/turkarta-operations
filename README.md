# turkarta-operations

Internal operations hub for Turkarta. One service, **two Telegram bots**, shared core.
**TypeScript** (grammY + Hono), deploys on Render.

| Bot | Audience | Job |
|-----|----------|-----|
| `@turkarta_leads`   | Internal team | Inbound leads from the Lovable landing → claimable cards in the ops group |
| `@turkarta_support` | End users     | Support / user requests → two-way relay + claimable tickets |

## How it works

### Leads (one-shot claim)
The Lovable landing is on **Lovable Cloud** (a Supabase DB we can't reach), so the form
fires each lead straight at this service:
```
Lovable form submit ──POST {name,contact,message,source}──►  POST /webhooks/leads
   → insert into OUR ops DB → post a lead card to the ops group + @-mention the roster
   → first teammate taps "Взять / Take"  → race-safe claim (UPDATE … WHERE status='new')
   → card edited in place: "🟢 Allocated to Artem", button removed
```

### Support (two-way relay)
```
User taps "Связаться с поддержкой" (in @turkarta_support, or via a Mini App settings
button that deep-links to t.me/turkarta_support?start=miniapp)
   → bot opens a ticket → posts a claimable card to the ops group + roster ping
   → agent taps "Взять / Take" → ticket allocated, a forum topic opens for the relay
   → RELAY: agent replies in the ticket thread → forwarded to the user's DM;
            user replies to the bot     → forwarded into the ticket thread
   → agent taps "Закрыть / Resolve" → ticket closed, relay ends
```

The "tag everyone" effect uses a **roster** (a fixed config list of teammate @usernames),
because Telegram bots cannot enumerate group members or use a native @all.

## Stack
- TypeScript, Node 22
- [grammY](https://grammy.dev/) — two `Bot` instances, webhook mode
- [Hono](https://hono.dev/) — webhook endpoints (Telegram + lead intake)
- [postgres](https://github.com/porsager/postgres) → **our own** ops Postgres (Supabase project you own, or Render PG)
- [zod](https://zod.dev/) — env + payload validation
- Deploy: Render (`render.yaml` / Dockerfile)

## Database
We keep our **own** ops Postgres — Lovable Cloud's DB is unreachable, and we need a home
for lead/ticket state + claim status regardless. Easiest: spin up a Supabase project
*you* own (or a Render Postgres) and put its connection string in `DATABASE_URL`.

## Setup
1. **Create two bots** via [@BotFather](https://t.me/BotFather) → `LEADS_BOT_TOKEN`, `SUPPORT_BOT_TOKEN`.
   For the support bot: `/setprivacy → Disable` so it can read agent replies in the group.
2. Add `@turkarta_leads` to the **ops group**; add `@turkarta_support` to the **support group**
   (make it a **forum/topics** supergroup so each ticket gets its own relay thread).
3. **Get chat IDs** — message the group, then
   `curl https://api.telegram.org/bot<TOKEN>/getUpdates` → read `message.chat.id`.
4. Provision the ops Postgres, copy `.env.example` → `.env`, fill everything.
5. Apply schema: `pnpm migrate` (uses `DATABASE_URL`).
6. Wire the Lovable form to POST leads here — see [`docs/LOVABLE_SETUP.md`](docs/LOVABLE_SETUP.md).
7. Dev: `pnpm install && pnpm dev`. Telegram webhooks self-register from `PUBLIC_BASE_URL` on boot.

## Scripts
- `pnpm dev` — watch mode
- `pnpm build` / `pnpm start` — compile to `dist/`, run
- `pnpm typecheck`
- `pnpm migrate` — apply `migrations/0001_init.sql`

## Env
See `.env.example`.
