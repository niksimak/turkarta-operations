# Deploy State — turkarta-operations

_Last updated: 2026-10-18_

## Status: CSAT live, image `crm-f3be1ab` — 2026-10-18

- Live image `registry.fly.io/turkarta-operations:crm-f3be1ab` (main `f3be1ab`, ops v9): #26 CSAT. After a CRM resolve
  with a human reply since the last reopen / previous survey, the customer gets `csat_text` («Мы смогли вам помочь?»).
  Telegram + Mini App: 👍/👎 buttons, typed «да/нет» counts, 👎 → force-reply comment (once). Ratings in the timeline
  and Stats («Клиенты довольны», «Довольны» per operator/topic, shown from 5 answers).
- Schema on boot: `0020_crm_csat.sql` (verified on prod: `crm_csat` exists, event check has `csat` and `topic_changed`).
- **TEMP (2026-10-18): `csat_web_enabled` = false (default)** — web PWA customers are not asked yet.
  Flip condition: the Turkarta widget is on prod (it is: backend v88 `prod-92b6262e`, webapp v34 `prodweb-92b6262e`,
  turkarta#1094/#1095) → owner switches CRM Settings → «Оценка в веб-чате» on. Delete this TEMP line when flipped.
- Rollback: Settings → «Оценка после решения» off (instant), or
  `fly deploy --image registry.fly.io/turkarta-operations:crm-e26b858 -a turkarta-operations` (schema additive).

## Status: CRM topics live, image `crm-e26b858` — 2026-10-18

- Live image `registry.fly.io/turkarta-operations:crm-e26b858` (main `e26b858`, ops v8), PRs since `crm-f0aa27e`:
  #22 stats count video replies (v6 `crm-0a6dd45`); #23 stats: time to resolution, one-reply share,
  messages per ticket, «Когда пишут клиенты» heatmap (v7 `crm-7acf716`); #24 topics (contact reasons).
- #24: migration `0019_crm_topics.sql` on boot (verified on prod: 10 seeded topics, `topic` in
  `crm_ticket_events_type_check`, `support_agent_jobs_kind_check`, new `support_requests_topic_source_check`).
  On a CRM resolve the agent worker runs a `topic` job (shadow mode, internal only): own allowance
  3 calls/ticket/UTC day, shared $1/day / $20/month caps. Operator choice (incl. clearing) always wins.
- Tripwire after the first resolves: `select status, error_code, count(*) from support_agent_jobs where kind='topic' group by 1,2`
  must show `completed`; repeated `model_unavailable` = the strict schema was refused (topics stay manual).
- Rollback: `update support_agent_jobs set status='superseded', finished_at=now() where kind='topic' and status in ('pending','running')`
  (the old worker would run a topic job as a review), then
  `fly deploy --image registry.fly.io/turkarta-operations:crm-7acf716 -a turkarta-operations`; schema is additive.
- Spec + plans: `docs/superpowers/specs/2026-10-18-crm-quality-design.md`, `docs/superpowers/plans/2026-10-18-crm-{stats-resolution,topics}.md`.
  Next: CSAT (ops + Turkarta web widget), «Качество» page (owner only) + template suggestions, Monday summary.

## Status: PWA push + video replies live, image `crm-f0aa27e` — 2026-10-17 night

- Live image `registry.fly.io/turkarta-operations:crm-f0aa27e` (main `f0aa27e`): #19 PWA (manifest,
  `/crm/sw.js`, per-device «Push-уведомления» switch) + Web Push to every operator for new ticket
  (scope «Все»), assigned, client replied, and the reply reminder when a ticket goes overdue;
  #20 operator video replies (one per message, MP4/MOV/WEBM, ≤ 20 MB, Telegram `sendVideo`,
  CRM plays inline with Range support).
- Secrets added (staged, then this deploy): `CRM_VAPID_PUBLIC_KEY`, `CRM_VAPID_PRIVATE_KEY`
  (generated on the owner's Mac, never printed). Subject = `PUBLIC_BASE_URL`.
- Schema on boot: `0017_crm_push.sql` (table `crm_push_subscriptions`), `0018_support_video.sql`
  (kind / media / size checks widened in place; verified on prod after boot).
- Web customers: the video player shipped in Turkarta webapp #1090 (prod webapp v33 `prodweb-32a84930`, 2026-10-18).
- Rollback: `fly deploy --image registry.fly.io/turkarta-operations:crm-de7997e -a turkarta-operations`
  (old code runs on the widened schema); push off: `fly secrets unset CRM_VAPID_PUBLIC_KEY CRM_VAPID_PRIVATE_KEY`.

## Status: CRM follow-ups live, image `crm-de7997e` — 2026-10-17 evening

- Live image `registry.fly.io/turkarta-operations:crm-de7997e` (main `de7997e`), PRs #11–#17:
  backlog archive script (#11), lost session → admin sign-in and back (#12), client panel
  CSB email + card `product_id` (#13), settings history «Система» (#14), mobile menu (#15),
  top-up rail + Antarctic ids (#16), ticket opens without waiting on Turkarta + hover prefetch (#17).
  Previous images: `crm-79e0986` (#11–#15), `crm-fee15a9` (cutover).
- Rollback: `fly deploy --image registry.fly.io/turkarta-operations:crm-79e0986 -a turkarta-operations`.
- Panel fields need Turkarta prod ≥ main `d211c608` (#1082, #1084, #1085, #1086); without it
  they are just absent (all optional in the parser).
- Open: the Bitrix delivery-confirmation retry (`[bitrix-ol] delivery confirmation pending`,
  ACCESS_DENIED, msgs ol-14005/ol-14009) still runs hourly in crm mode. Harmless; drop it in the
  Bitrix removal PR.
- Open: CRM speed beyond #17 not measured yet (DB round-trip ams → Neon); the probe failed on
  a flaky local network to Fly.

## Status: support CRM LIVE on Fly, Bitrix off — 2026-10-17

- Host: Fly app `turkarta-operations` (personal org, `ams`), 1 machine, image
  `registry.fly.io/turkarta-operations:crm-fee15a9` (main `fee15a9`, PR #9).
  `https://support.turkarta.me` (DNS at ps.kz, Fly cert issued); `/` redirects to `/crm`.
- `SUPPORT_SURFACE=crm` since 10:29:42Z. Bitrix gets no calls. Operators answer only in the
  CRM, opened from the Turkarta admin «Поддержка» (SSO, `CRM_SSO_SECRET` on both apps).
- Secrets: the 25 Render env vars copied as-is, plus `SUPPORT_SURFACE`, `PUBLIC_BASE_URL`,
  `CRM_SSO_SECRET`. `DATABASE_URL` is the direct Neon endpoint (no pooler).
- Both bot webhooks point at `support.turkarta.me` (checked with getWebhookInfo, 0 pending).
  Bot downtime during the move: 10:20:29Z to 10:22:16Z.
- Cutover: `crm_cutover --apply` stamped 713 open tickets as overdue-pinged and requeued 8.
  «Автоназначение» and «Просрочка» were off during the flip (crm_settings_log rows with no
  operator), back on after. `forum_farewell --send` posted in 8 open topics.
- Backlog archive (2026-10-17, after operators saw only old tickets in «Очередь»): the 713
  pre-cutover open tickets with no customer message since 10:29:42Z were resolved by
  `archiveBacklog` (scripts/crm_archive_backlog.ts, run from the compiled function on the
  machine). No resolve message sent. Queue 729 → 16. Each has a `status_changed` event with
  `payload.reason = 'cutover_backlog'`. Rollback:
  `update support_requests r set status = e.payload->>'from', resolved_at = null from crm_ticket_events e where e.ticket_id = r.id and e.payload->>'reason' = 'cutover_backlog'`.
- Turkarta prod: backend v84 `prod-04a55334` with `OPS_SUPPORT_BASE_URL=https://support.turkarta.me`
  and `CRM_SSO_SECRET`. Webapp `prodweb-04a55334` (every photo of a message in the web chat).
- Rollback: `fly secrets set SUPPORT_SURFACE=bitrix -a turkarta-operations` restores ops'
  Bitrix mode, but the Bitrix app handler still points at Render, so Bitrix replies need
  Render resumed too. Full rollback = resume Render (it re-takes the webhooks on start) and
  `fly secrets unset OPS_SUPPORT_BASE_URL -a turkarta-backend-prod`.
  Turkarta images before this move: backend `prod-6907209e`, webapp `prodweb-964361f6`.
- TEMP: 2026-10-17 Render service `srv-d90g7t4m0tmc73dpi000` suspended, not deleted. Flip when:
  one clean week on Fly (2026-10-24), then delete it. Owner: Nikita.
- TEMP: 2026-10-17 Bitrix code and `BITRIX_*` secrets still in ops, unused in crm mode. Flip when:
  the owner removes the Bitrix24 app; then a cleanup PR drops the code and the secrets. Owner: Nikita.
- TEMP: 2026-10-17 Turkarta `ops_support_base_url` code default still the Render URL (env
  overrides it on prod). Flip when: Render is deleted; small Turkarta PR sets the Fly URL. Owner: Nikita.
- Open: dev Turkarta (`turkarta-backend-dev`) has no `OPS_SUPPORT_BASE_URL`, so its web chat
  calls the suspended Render URL. Not checked further.

## Status: operator-reply relay fixed (web tickets) — 2026-06-30

Commit `8a23a97`, deployed to the live service.

Operator **text replies** to web tickets were silently dropped: when the web user
wrote *before* the operator claimed, the relay forum topic was created empty, so
operators replied in the wrong place. Status changes still worked (those are button
callbacks). Root cause confirmed via the ops DB — a test web ticket had `user` +
`system` (claim/resolve) messages but **no `agent` row**.

Fixes:
- **On claim, seed the relay topic** with the request + "Отвечайте в этой теме" hint
  (`claim` handler) — the topic is never empty and the reply target is unmistakable.
- The operator-reply handler now also matches a **reply to the ticket card** via the
  new `db.ticketByCardMessage(messageId)` (matches `tg_message_id`), so a reply in the
  General area still reaches the user.

The turkarta app side shipped to prod the same day (auth auto-recovery, in-app support
routing, mobile/zoom, contact-email) — see turkarta `docs/DEPLOY-STATE.md` (2026-06-30).
`OPS_WEBHOOK_SECRET` is now set on both the prod and dev turkarta APIs.

---

## Status: support-bot UX hardened + ROSTER live — 2026-06-29

Three fixes shipped + deployed to the live Render service (commits on `main`,
deployed via `render deploys create … --confirm --wait`):

- **`edf14e9` — two-tap confirm to close + Russian-only copy.** A single tap on the
  operator «Закрыть» button closed tickets instantly (an accidental tap right after
  «Взять»), so users saw «Обращение закрыто» before any operator replied. Resolve is
  now two-step: first tap swaps in a Да/Отмена row, second tap closes. Also stripped
  all bilingual RU+EN strings → **Russian only** across both bots (greeting, email
  prompt, queue/join/close notices, cards, status/category labels, buttons, toasts).
- **`d484db1` — any roster operator can close/park (not just the claimer).** Park/
  resolve were locked to the operator who tapped «Взять»; now gated on roster
  membership (`rosterGuardFailed`) instead. `db.awaitTicket`/`resolveTicket` dropped
  their `claimed_by_tg` condition. Claiming stays roster-gated.

### 🧑‍🤝‍🧑 ROSTER now set (env on Render, was `[]`)
```json
[{"name":"Никита","username":"nikitasim","tg_id":387115382},
 {"name":"Артём","username":"ashotovich_34","tg_id":425253253}]
```
With `tg_id`s present, **claim-gating is now ON** (only these two can tap «Взять»),
park/resolve is limited to them, and new ticket/lead cards ping them via
`tg://user?id=…` (real notifications). Set via Render REST API (`PUT …/env-vars/ROSTER`)
+ redeploy. To add/change operators: each sends `/id` to **@turkarta_support_bot** →
update the ROSTER env → redeploy.

> ⚠️ Don't set a partial roster (some members without `tg_id`): the moment ANY member
> has a `tg_id`, claim-gating switches on and members WITHOUT one get locked out of
> claiming. Set all operators' `tg_id`s together.

### Related (other repo)
The turkarta app's prod API now has `OPS_WEBHOOK_SECRET` = this service's
`LEADS_WEBHOOK_SECRET`, so the in-app web support chat is live on prod
(app.turkarta.me). See turkarta `docs/DEPLOY-STATE.md` (2026-06-29 top entry).

---

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
- ~~Fill `ROSTER` (env on Render) with teammates' tg_ids~~ ✅ done 2026-06-29
  (Никита + Артём, see top entry) — @-pings + claim gating now active.

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

**TEMP 2026-08-03:** `TURKARTA_API_URL` points at the DEV api (turkarta-api-dev.onrender.com) so support-reply pushes are testable before the turkarta prod promote (#385 is in the 17-commit main→prod delta). Flip condition: after promote, set back to `https://api.turkarta.me` + deploy. Prod-app callbacks meanwhile no-op on dev (unknown user ids) — same as before the feature.

**2026-08-04: TEMP CLOSED** — turkarta promoted (PR #386), prod endpoint verified 403; `TURKARTA_API_URL` flipped back to `https://api.turkarta.me`. Support-reply pushes now LIVE for prod web users.

**2026-08-04 session close:** Bitrix hub COMPLETE — all 3 support channels two-way in «Открытая линия 3» (web: log+push; tg: bot DM, dedup by bitrix_message_id). Support-reply push callback live against prod api. TG topic runs in parallel (primacy decision pending); TG media = placeholders. 🔴 Rotate: Bitrix webhook URL, app token, client_secret (all burned in build chat).

## Fly.io (live since 2026-10-17, see the status at the top)

- App: `turkarta-operations`, region `ams`, config `fly.toml` (repo root).
- Domain: `support.turkarta.me` (`fly certs add`). It becomes `PUBLIC_BASE_URL`.
  The CRM lives at `https://support.turkarta.me/crm`; `/` redirects there.
- Spec: `docs/superpowers/specs/2026-10-16-support-crm-design.md` §15.
- Rule: never scale above 1 machine. Presence is in memory, workers run in-process,
  and bot webhooks must not run twice.

Before the first deploy:
- `DATABASE_URL` must be a direct Neon endpoint. If the host has `-pooler` in it, set the
  direct URL instead. CRM live updates use LISTEN/NOTIFY, which the pooler drops.

Move sequence (run in `SUPPORT_SURFACE=bitrix` mode so behaviour is unchanged):
1. `fly deploy --ha=false` with `PUBLIC_BASE_URL` set to the Fly URL. On boot ops calls
   `setWebhook`, so both bots switch to Fly. Boot also applies migration 0016.
2. `fly scale count 1`, then `fly machines list`: exactly one machine, state `started`.
3. Suspend the Render service right away. A Render cold start would call `setWebhook`
   again and take the bots back.
4. Re-point Turkarta's ops URL to Fly and redeploy it.
5. Bitrix: update the app handler and event URLs to the Fly host (`event.bind` again).
6. Smoke test: TG DM to the support bot, web ticket, Bitrix reply round trip.
   The CRM opens read-only in this mode.

Rollback of the move: keep the Fly app in `SUPPORT_SURFACE=bitrix` and fix forward. If Fly
itself is the problem, deploy THIS branch to Render (`SUPPORT_SURFACE=bitrix`), resume it,
then point Turkarta and Bitrix back. Never resume the old Render image: migration 0016 drops
`support_attachments_message_id_key`, and origin/main's `addMessage` needs it.
Render is deleted after one clean week.

CRM cutover (later, its own step, Fly already live):
Run the scripts from a local checkout of this branch with the prod env vars passed inline;
they are not in the image. Both print ids or counts only.
1. `node --import tsx scripts/crm_cutover.ts` (dry run), check the counts.
2. CRM «Настройки» → «Команда»: switch off «Автоназначение» and «Просрочка». Otherwise the
   first worker tick after the flip sees every open Bitrix-era ticket as overdue, pings the
   TG group for each one and auto-assigns them before step 4 cleans them up.
3. `fly secrets set SUPPORT_SURFACE=crm` (restarts the machine).
4. `node --import tsx scripts/crm_cutover.ts --apply`.
5. Switch «Автоназначение» and «Просрочка» back on.
6. `node --import tsx scripts/forum_farewell.ts`, check the list, then run it with `--send`.
7. Smoke: a CRM reply to a test user only, after step 3. Never reply to a real customer
   as a test.

Rollback of the cutover: `fly secrets set SUPPORT_SURFACE=bitrix` on the same Fly app.
CRM-era messages are not in Bitrix; they stay readable in the CRM.

Interim state entry, add when each step lands (copy, fill in, keep until the flip):
`TEMP: YYYY-MM-DD <what is temporary, e.g. Render suspended not deleted / SUPPORT_SURFACE=bitrix on Fly>. Flip when: <condition, e.g. one clean week on Fly / cutover done>. Owner: <name>.`
