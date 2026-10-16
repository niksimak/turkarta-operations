# Support CRM: design

Date: 2026-10-16. Status: draft for owner review.
Repo: `turkarta-operations` (ops), with two small additions in `turkarta`.

## 1. Goal

Give the support team (3 to 10 operators, 100 to 500 tickets a day) one inbox
where they see every inquiry from the Telegram bot, the Mini App and the
web/PWA chat, with the user's text and photos, the user's identity (Telegram
@username and id, email, channel) and account context, and answer back with
text and photos.

The CRM **replaces** Bitrix24 Open Lines and the Telegram forum group as the
place operators work. Owner decisions (2026-10-16):

| Topic | Decision |
|---|---|
| Bitrix | Replaced. No history import; Bitrix stays readable for old lookups. |
| TG support group | Retired as a reply surface; keeps alert pings only. |
| Email | Contact info on the user card. Not an inbound channel in v1. |
| Media | **Photos only**, both directions. Other types show as a labelled chip. |
| Access | SSO from the Turkarta admin panel; roles `admin` and `support`. |
| UI | React SPA served by ops at `/crm`; light and dark themes. |
| Queue | One shared queue; unclaimed for 5 min means auto-assign. |
| Notify | Every new ticket: in-CRM sound + desktop notification, and a TG group ping. |

## 2. Context (current state, ops `origin/main` 2357682)

- Ops already owns support data in its own Neon Postgres (`turkarta-ops`):
  `support_requests` (tickets), `support_messages`, `support_attachments`
  (bytea photos, jpeg/png/webp, 8 MB, one per message). Turkarta has no
  support tables; `routes/web_support.py` proxies to ops.
- Inbound: TG bot DM and Mini App (`openSupport()` opens the bot DM) go
  through `src/bots/support.ts`; web goes turkarta proxy, then
  `createWebTicket` / `pushWebUserMessage`. Non-text TG messages are stored as
  placeholder text (`contentLabel`); only the first photo's `file_id` is kept.
- Outbound: Bitrix `ONIMCONNECTORMESSAGEADD` goes to `deliverOperatorReply`
  (`src/bitrix_reply.ts`): TG is text only, web stores the row and calls
  turkarta `notifySupportReply` (bell + web push).
- The TG forum group (`SUPPORT_CHAT_ID`) carries ticket cards, claim buttons
  and a topic per ticket, relayed both ways.
- The AI support-agent layer (`support_agent_*`, migrations 0012/0013) is fed
  by DB triggers on the support tables and runs in shadow mode.
- Ops runs on Render **free** tier (cold starts). No SSE or websockets exist.

## 3. Architecture

```
TG bot ─┐                         ┌─ /crm        React SPA
Mini App┼─→ ops intake ─→ ops PG ←┼─ /crm/api    JSON
Web/PWA ┘  (support.ts)  (support_*, crm_*)      /crm/api/stream  SSE
                                   │
                                   ├─→ TG Bot API sendMessage / sendPhoto / sendMediaGroup
                                   ├─→ turkarta /webhooks/ops/support-reply (web bell + push)
                                   ├─→ turkarta /webhooks/ops/support/user-context
                                   └─→ TG support group: alert pings with CRM link
Turkarta admin «Поддержка» ─→ signed 60 s token ─→ ops /crm/sso ─→ ops session cookie
```

Every chunk extends an existing ops module:

| Chunk | Plugs into |
|---|---|
| Inbound capture (real kinds, TG photo file_ids, albums) | `src/bots/support.ts`, `src/db.ts` |
| Reply delivery (text + photos, TG and web) | new `src/crm/reply.ts`, reusing the TG send and `turkarta_api.ts` paths from `bitrix_reply.ts` |
| CRM API, SSO, sessions, SSE | new `src/crm/*` routes mounted in `src/server.ts` |
| Workers (auto-assign, SLA pings) | the existing in-process interval workers |
| Cutover switch | `src/config.ts` (`SUPPORT_SURFACE`) gating Bitrix + forum code paths |
| SPA | new `web/` package in the existing pnpm workspace |
| Turkarta SSO issuer + nav item | `routes/_admin_html.py` `NAV_ITEMS`, a new admin route gated by `require_support_role` |
| Turkarta user context | `routes/webhooks_ops.py` (same shared secret as `support-reply`) |

Single ops instance is assumed: presence is in memory and fan-out uses
Postgres `LISTEN/NOTIFY`. Scaling to more than one instance is out of scope.

## 4. Data model (migration `0016_support_crm.sql`, additive only)

All changes are additive so the AI-agent triggers and the running Bitrix path
keep working during rollout.

**`support_requests`** (ticket) gets:
- `assigned_operator_id bigint null` → `crm_operators.id`
- `auto_assigned boolean not null default false`
- `queued_at timestamptz null` (entered the queue; set on create and on reopen to queue)
- `waiting_since timestamptz null` (oldest unanswered user message; null when answered)
- `first_response_at timestamptz null`
- `last_message_at timestamptz null` (list ordering)

Status values are kept and relabelled in the UI:

| DB value | UI | Meaning |
|---|---|---|
| `new` | Новый | in the queue, nobody assigned |
| `allocated` | В работе | assigned to an operator |
| `awaiting` | Ждём клиента | operator answered last |
| `resolved` | Решён | closed |

Note: `awaiting` used to mean "taken but parked". In CRM mode it means
"waiting on the client". The forum park button disappears with the forum.

**`support_messages`** gets:
- `kind text not null default 'text'` check in `text, photo, note, unsupported, system`
- `unsupported_type text null` (`video`, `animation`, `voice`, `document`, `sticker`, `video_note`, `audio`)
- `author_name text null` (operator display name; `author_id` uses `crm:<admin_user_id>`)
- `response_seconds integer null` (set on agent messages: `created_at - waiting_since`)
- `delivery_status text null` check in `pending, sent, failed`; `delivery_error text null`

`body` holds the text or photo caption. `note` and `system` rows are never
delivered to the user and never returned by the web user API.

**`support_attachments`**:
- drop the unique constraint on `message_id`; add `position smallint not null default 0`
- add `tg_file_id text null`, `tg_file_unique_id text null`
- `content` and `size_bytes` become nullable, with check
  `(content is not null) or (tg_file_id is not null)`
- max 10 attachments per message (enforced in code)

Inbound TG photos store `tg_file_id` only (Telegram keeps the file). Web
uploads and operator uploads store bytes. An operator photo sent to a TG user
also records the returned `tg_file_id`.

**New tables:**

```
crm_operators      id bigint pk (= turkarta admin_users.id), name, email, role,
                   on_shift bool, last_active_at, last_assigned_at,
                   notify_sound bool default true, created_at, updated_at
crm_sessions       id uuid pk, token_hash text unique, operator_id, expires_at, created_at
crm_sso_nonces     jti text pk, expires_at          -- replay guard
crm_ticket_events  id bigserial pk, ticket_id, type, actor_operator_id null,
                   payload jsonb, created_at
                   type in: created, assigned, auto_assigned, unassigned,
                   taken_over, status_changed, reopened
crm_canned_replies id uuid pk, title, body, use_count int, created_by, updated_by,
                   created_at, updated_at
crm_settings       key text pk, value jsonb
                   sla_first_minutes 15, sla_followup_minutes 30,
                   auto_assign_minutes 5, reopen_days 7,
                   offline_after_minutes 15
```

## 5. Inbound

`support.ts` keeps its intake (ticket open, email question, category) and
changes how messages are stored:

- text → `kind=text`
- photo → `kind=photo`, caption in `body`, one attachment row with the largest
  size's `file_id`. Photos sharing a `media_group_id` are joined into one
  message (up to 10 attachments): the first photo creates the message, later
  ones within 2 s with the same `media_group_id` append attachment rows to it.
- video, GIF, voice, document, sticker, video note, audio → `kind=unsupported`,
  `unsupported_type` set, caption kept in `body`. No bytes stored.

Web messages arrive as today; `pushWebUserMessage` also sets `kind` and stores
its photo as an attachment row.

After each user message, in one transaction:
- set `waiting_since` if null, set `last_message_at`
- resolved ticket and last activity within `reopen_days`: reopen. Previous
  operator on shift keeps it (`allocated`), otherwise back to the queue (`new`,
  `queued_at=now`). Older resolved ticket: the existing rule opens a new ticket.
- `awaiting` → `allocated`
- `NOTIFY crm_events` with `{type, ticket_id}`

New ticket also triggers the new-ticket notifications (section 8).

## 6. Outbound (operator replies)

`POST /crm/api/tickets/:id/messages` (multipart: `body`, `kind=reply|note`, up to 10 `photos`).

1. Lock the ticket row. If it is assigned to another operator, reject `409
   assigned_to_other` (the UI offers «Перехватить», which calls `/take-over`
   and logs `taken_over`). If unassigned, claim it (`assigned`).
2. Insert the message (`delivery_status=pending` for replies) and the
   attachment rows (bytes), compute `response_seconds`, set
   `first_response_at` if null, clear `waiting_since`, status → `awaiting`.
3. Commit, then deliver:
   - TG ticket (`user_tg` set): text → `sendMessage`; one photo → `sendPhoto`
     with caption; 2 to 10 photos → `sendMediaGroup`, caption on the first.
     Store the returned `file_id`s.
   - Web ticket: nothing to send; call turkarta `notifySupportReply` (bell +
     push) as today. The web API returns `attachments[]` per message and keeps
     the singular `attachment` (first item) until the webapp ships the array.
4. Set `delivery_status` to `sent` or `failed` with `delivery_error` (for
   example TG 403 "bot was blocked"). Failed messages show «не доставлено» with
   a retry button (`POST /crm/api/messages/:id/retry`).

Notes (`kind=note`) skip delivery entirely, do not change status, timers or
`response_seconds`, and support `@имя` mentions (mentioned operator gets an
in-CRM notification).

Limits: jpeg/png/webp, 8 MB each (TG `sendPhoto` cap is 10 MB), 10 per message.

## 7. Queue, assignment, SLA

- **Queue.** `new` tickets, ordered by `queued_at`. Any operator can «Взять».
  Replying to a queued ticket claims it.
- **Auto-assign worker** (every 30 s): select `new` tickets with
  `queued_at < now() - auto_assign_minutes` using `FOR UPDATE SKIP LOCKED`.
  Candidate operators: `on_shift` and `last_active_at > now() -
  offline_after_minutes`. Pick the fewest open (`allocated` + `awaiting`)
  tickets, tie-break oldest `last_assigned_at`. Set `auto_assigned=true`, log
  `auto_assigned`, notify the assignee. No candidate: ticket stays queued and a
  «никого нет на смене» ping goes to the TG group, at most once per 15 min.
- **On shift.** A toggle in the CRM. The SPA sends a heartbeat every 60 s while
  open; no heartbeat for `offline_after_minutes` turns `on_shift` off.
- **Reassign.** Admins reassign any ticket. Support operators can hand their own
  ticket to a colleague. Unassign returns it to the queue.
- **SLA timers.** A ticket's wait = `now() - waiting_since`. Target is
  `sla_first_minutes` before the first response, `sla_followup_minutes` after.
  List badge: neutral, amber from 50% of target, red when overdue. When a
  ticket goes overdue the worker posts one TG group ping per waiting period.
- **Response speed** is measured per agent reply as `response_seconds` (time
  from the oldest unanswered user message to that reply). Notes, status changes
  and assignments do not count.

## 8. Notifications

- **New ticket**: SSE `ticket.created` to every connected operator. The SPA
  plays a short sound (per-operator mute) and shows a browser `Notification`
  when the tab is hidden and permission is granted. A TG group ping:
  channel, name or @username, first line, CRM link.
- **Assigned to you** (manual or auto), **@mention in a note**, **user replied
  on your ticket**: in-CRM toast + sound + browser notification for that
  operator only.
- TG group pings in CRM mode: new ticket, SLA overdue, nobody on shift. No
  ticket cards, no topics, no relay.

## 9. Access (SSO)

Turkarta side:
- `NAV_ITEMS` entry «Поддержка», roles `admin` and `support`.
- `GET /admin/support-crm` gated by `require_support_role`: builds a token
  `{sub: admin_user_id, name, email, role, jti, exp: now+60s}` signed HMAC-SHA256
  with `CRM_SSO_SECRET`, redirects to `{OPS_PUBLIC_URL}/crm/sso?t=<token>`.
  Optional `next` param carries a ticket id for deep links.
- Classified in `tests/test_admin_support_role.py`.

Ops side:
- `GET /crm/sso` verifies the signature, expiry and role, inserts the `jti`
  into `crm_sso_nonces` (duplicate = replay, reject), upserts `crm_operators`,
  creates a session (random 32-byte token, hash stored, 12 h), sets cookie
  `crm_session` (HttpOnly, Secure, SameSite=Lax, Path=/crm) and redirects to
  `/crm`.
- `/crm/api/*` requires a valid session plus header `X-CRM: 1` (CSRF guard
  together with SameSite). No session → 401 → SPA sends the user to the admin
  «Поддержка» link.
- Role changes in Turkarta take effect at the next SSO (at most 12 h). Logout
  deletes the session.

## 10. User context

Turkarta adds `POST /webhooks/ops/support/user-context` next to
`support-reply` in `routes/webhooks_ops.py`, same `x-webhook-secret`. Input:
`{tg_id?, user_id?}`. Output:

```
{found, user_id, tg_id, tg_username, name, email, email_verified,
 registered_at, kyc_level,
 cards: [{last4, status, plan, balance_usd}],
 recent_topups: [{amount_rub, amount_usd, status, created_at}]  // last 5
 admin_url}
```

Ops calls it from `turkarta_api.ts`, caches per user for 60 s. A TG user with
no Turkarta account returns `found=false`; the panel shows «Нет аккаунта» with
the TG data ops already has. Errors or timeouts degrade the panel to ops data.
Card PANs, CVV and full balances history are never returned.

## 11. CRM API and live updates

REST under `/crm/api` (JSON, session cookie):

```
GET  /me                         POST /me/shift {on}         POST /me/heartbeat
GET  /tickets?view=queue|mine|all&status=&channel=&operator=&overdue=&q=&cursor=
GET  /tickets/:id                (ticket, messages, events, user context)
POST /tickets/:id/messages       POST /messages/:id/retry
POST /tickets/:id/take           POST /tickets/:id/take-over
POST /tickets/:id/assign {operator_id|null}
POST /tickets/:id/status {status}
GET  /attachments/:id            (bytes, or streamed from Telegram via getFile)
GET|POST|PUT|DELETE /canned[/:id]
GET  /operators                  GET /stats?from=&to=
GET|PUT /settings                (admin only)
POST /tickets/:id/presence {state: viewing|typing}
GET  /stream                     (SSE)
```

`/attachments/:id` for TG photos calls `getFile` and streams the bytes; the
bot token never reaches the browser. Responses are `Cache-Control: private,
max-age=86400`.

**SSE.** One connection per tab. Events: `ticket.created`, `ticket.updated`,
`message.created`, `presence`, `operator.updated`, `notify`. Payloads are
small ids; the SPA refetches the affected queries. On reconnect the SPA
refetches its open views, so there is no replay log. Server sends a comment
ping every 20 s to keep proxies from closing the stream. Writers `NOTIFY
crm_events`; the SSE hub `LISTEN`s and fans out. Presence lives in memory with
a 10 s TTL.

## 12. Stats

`GET /stats?from&to` (default last 7 days, Moscow time). Team block:
- new tickets per day by channel (chart)
- backlog now, oldest waiting ticket, % replies within SLA

Per operator row:
- tickets taken (manual), auto-assigned, resolved
- replies sent
- response speed: median and p90 of `response_seconds`
- first response: median and p90 (`first_response_at - created_at`)
- % replies within SLA, reopen rate

Admins see every row. Support operators see the team block and their own row.

## 13. UI

Russian. Desktop-first (≥1280 px): nav rail, ticket list, thread, user panel.
Below 1024 px: list and thread as separate screens, panel as a sheet.

- **Nav rail:** Очередь (count), Мои, Все, overdue badge, Статистика, Шаблоны,
  Настройки (admin), «На смене» toggle, sound toggle, theme switch.
- **List row:** channel dot (TG бот / Mini App / Web), name or @username, wait
  timer with SLA colour, last message first line, assignee avatar, presence,
  «авто» marker for auto-assigned.
- **Thread:** user and operator messages on opposite sides, operator name on
  agent messages; notes tinted amber; system events as quiet dividers; photos
  inline with a lightbox; unsupported media as a chip («🎥 Видео не
  поддерживается»); delivery state on agent messages. Header: status menu,
  assign menu, «Взять» / «Перехватить», «Решить».
- **Composer:** Ответ / Заметка (Tab toggles), `/` opens canned reply search
  with `{имя}` and `{оператор}` variables, Ctrl/Cmd+Enter sends. Locked with
  «Перехватить» when the ticket belongs to someone else.
- **Attaching photos.** Three ways, all landing in the same preview strip above
  the input (thumbnail, remove button, up to 10):
  - **Drag and drop** onto the whole thread pane, not just the composer.
    While a drag is over the pane, an overlay reads «Отпустите, чтобы
    прикрепить» with the accepted formats. Several files can be dropped at
    once; extra files beyond 10 are rejected with a toast.
  - **Paste** (Ctrl/Cmd+V) of a screenshot or copied image.
  - **📎 button** opening the file picker (multi-select).
  Files that are not jpeg/png/webp or exceed 8 MB are rejected per file with a
  clear reason («только фото: JPG, PNG, WEBP», «больше 8 МБ»); valid files in
  the same drop are kept. Dropping onto a locked composer is ignored with the
  «Перехватить» hint. Previews use object URLs, revoked on send or remove.
- **User panel:** section 10 data, click-to-copy ids, past tickets, «Открыть в
  админке».
- **Keyboard:** `j`/`k` move, `Enter` open, `a` take, `e` resolve, `/` canned,
  `g q` / `g m` / `g a` switch views.
- **Look:** calm, dense work tool. Neutral surfaces, one accent, colour reserved
  for meaning (SLA state, channel, notes, delivery failures). Design tokens as
  CSS variables with light and dark sets; follows the OS by default, operator
  override persisted locally. Motion is short and purposeful (message enter,
  list reorder, lightbox zoom from thumbnail) and honours
  `prefers-reduced-motion`.
- Implementation runs the `/impeccable` skill for layout, hierarchy and the
  token system, and `/emil-design-eng` for interaction polish (composer,
  optimistic send, list transitions). Fonts and exact palette are chosen there.

Stack: React 18, Vite, TypeScript, Tailwind, react-router, TanStack Query.
Package `web/` in the pnpm workspace, built into `dist/web`, served by Hono at
`/crm` with SPA fallback. The Dockerfile gains the web build step.

## 14. Cutover and rollback

New env `SUPPORT_SURFACE` = `bitrix` (default, today's behaviour) or `crm`.

- Both modes: inbound capture of real kinds and photos, the CRM UI and API.
  Operators can use the CRM read-only before cutover.
- `crm` mode: no `imconnector.send.messages`; Bitrix events ignored and logged;
  no forum ticket cards, topics or relay; TG group gets alert pings only; CRM
  replies, auto-assign and SLA pings active.
- At cutover a one-off script posts «Поддержка переехала в CRM: <link>» into
  each open forum topic.
- **Rollback:** set `SUPPORT_SURFACE=bitrix` and restart. Gap: CRM-era messages
  are not in Bitrix; tickets stay readable in the CRM.
- Bitrix and forum code are deleted in a follow-up PR after one clean week.

## 15. Infra

- Render plan `free` → `starter` (always on; SSE and the workers need it).
- New env on ops: `SUPPORT_SURFACE`, `CRM_SSO_SECRET`. Existing
  `TURKARTA_API_URL` / `TURKARTA_API_SECRET` are reused.
- New env on turkarta: `CRM_SSO_SECRET`, `OPS_PUBLIC_URL`.
- Each prod change follows the global rule: blast radius and one-line rollback
  stated before acting; temporary values get a dated `TEMP:` entry in
  `docs/DEPLOY-STATE.md`.

## 16. Error handling

- Delivery failures are visible and retryable (section 6), never silent.
- TG `getFile` failure on a photo shows a «фото недоступно» placeholder.
- SSE drop: the SPA shows a quiet «переподключение…» marker and refetches on
  reconnect.
- User-context failure degrades the panel to ops data.
- Concurrent take / reply: row lock plus `409` with the current assignee.
- Auto-assign race: `SKIP LOCKED`; covered by a two-worker Postgres test.

## 17. Testing

Ops, existing `node --test` unit and Postgres suites:
- status transitions, reopen window, `waiting_since` and `response_seconds` maths
- take / take-over / reply-on-other's-ticket `409`
- auto-assign: candidate selection, nobody on shift, two concurrent workers
- inbound kinds, albums, unsupported types; photo attachment rows
- reply delivery to TG (single, album, failure 403) and web (notify called,
  notes never exposed to the web API)
- SSO: valid, expired, bad signature, wrong role, replayed `jti`
- stats queries on fixed fixtures
- `SUPPORT_SURFACE` gating: no Bitrix calls and no forum posts in `crm` mode

Turkarta: SSO route and user-context endpoint unit tests; role classification
in `test_admin_support_role.py`; webapp renders `attachments[]` for agent
messages.

SPA: typecheck and build in CI; Playwright smoke on a seeded ops DB (login via
test SSO token, open ticket, send reply with photo, see it in thread).

## 18. Out of scope (v1)

Email as a channel; video, GIF, voice, document handling; Bitrix history
import; AI assist inside the CRM (AI layer stays in shadow mode); multiple ops
instances; deleting Bitrix and forum code (follow-up PR).
