# Support CRM Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Bitrix Open Lines and the TG forum group with a support CRM served by the ops service at `/crm`, hosted on Fly.io.

**Architecture:** Ops (Hono + grammY + postgres.js, Neon `turkarta-ops`) gains a `src/crm/` module: JSON API, SSE hub over Postgres `LISTEN/NOTIFY`, SSO sessions, reply delivery, auto-assign/SLA worker, settings and stats. A React SPA in `web/` is built into the ops image and served by Hono. Turkarta adds an SSO issuer, an admin nav item and a user-context endpoint. `SUPPORT_SURFACE=bitrix|crm` switches the operator surface.

**Tech Stack:** Node 22, TypeScript 5.7, Hono 4, grammY 1.32, postgres 3.4, zod 3; React 18, Vite 6, Tailwind 3, react-router 7, TanStack Query 5; Fly.io; turkarta: FastAPI + Python.

**Spec:** `docs/superpowers/specs/2026-10-16-support-crm-design.md` (read it before any task).

## Global Constraints

- All schema changes additive and idempotent (`if not exists`); existing Bitrix path and AI-agent triggers (`support_agent_message_insert`, `support_agent_ticket_resolved`) must keep working.
- Photos only: `image/jpeg`, `image/png`, `image/webp`, max 8 MB each (`MAX_PHOTO_BYTES`), max 10 per message. Reuse `validatePhoto()` from `src/support_media.ts`.
- SLA defaults: first response 5 min, follow-up 15 min, warn at 50%. Auto-assign after 5 min. Offline after 15 min. Reopen window 7 days.
- Roles: CRM access only for turkarta roles `admin` and `support`. Team settings editable by `admin` or `is_lead`. `is_lead` toggled by `admin` only.
- UI copy in Russian. Code, comments and docs in English.
- **No neuro-slop, anywhere (owner rule).** UI copy is short, plain and actionable: a label names the thing, a button names the action, an error says what happened and what to do («Не доставлено: пользователь заблокировал бота. Повторить»). No em-dashes, no «не X, а Y» framing, no filler («Отлично!», «Давайте…», «Упс»), no emoji decoration beyond the functional channel/type markers listed in this plan, no marketing tone, no explanatory paragraphs in the UI. Empty states: one line plus the next action. Code comments only where the *why* is non-obvious, one or two lines, no restating the code, no section-banner essays. Reviewers reject a task that violates this.
- Never log customer message text, emails, or tokens. Log ids and error codes only.
- Tests import compiled code from `../dist`; run `pnpm build` before `pnpm test`. Postgres tests are opt-in via `CRM_TEST_DATABASE_URL` pointing at a local disposable DB named `crm_test` on `127.0.0.1`/`localhost` (assert both, like `tests/bitrix_delivery_postgres.test.ts`). Never load `.env`.
- Unit tests that import modules touching `config` set the env block used in `tests/support_album.test.ts`.
- Commit only files this task touched (`git add <paths>`, never `-A`). Branch `feat/support-crm`.
- Single ops instance (one Fly machine). In-memory presence is acceptable.

## Review Focus

1. A TG user who blocked the bot: reply must end `delivery_status='failed'` with a visible retry, never throw out of the request and never mark `sent`. (Task 8 test.)
2. Two operators pressing «Взять» or replying at the same moment on a queued ticket: exactly one wins, the other gets `409` with the winner's name. (Task 7 test.)
3. An operator note must never reach the user: not via TG, not via `/api/support/web/messages`, not via the bell preview. (Task 8 test.)
4. Settings edited to an edge value (1 minute, 240 minutes, cap null) apply on the next worker tick without restart and invalid values are rejected with field errors. (Tasks 3 and 10 tests.)
5. A SSO link opened twice (browser back, forwarded link): second use rejected as replay; an expired session returns 401 and the SPA sends the operator back to the admin link instead of looping. (Task 6 test + Task 15 auth guard.)

---

## File Structure

```
fly.toml                              Fly app config (Task 1)
Dockerfile                            + web build stage (Task 15)
migrations/0016_support_crm.sql       CRM schema (Task 2)
src/config.ts                         + SUPPORT_SURFACE, CRM_SSO_SECRET (Task 2)
src/db.ts                             ensureCrmSchema(); messagesSince excludes notes; attachments[] (Tasks 2, 8)
src/crm/types.ts                      shared CRM types (Task 2)
src/crm/settings.ts                   settings defaults, validation, store, log (Task 3)
src/crm/inbound.ts                    classify TG message, recordUserMessage, timers, reopen (Task 4)
src/crm/events.ts                     NOTIFY publisher, LISTEN hub, presence (Task 5)
src/crm/auth.ts                       SSO token verify, sessions, middleware (Task 6)
src/crm/tickets.ts                    list/detail/take/takeOver/assign/status (Task 7)
src/crm/reply.ts                      operator reply + delivery + retry (Task 8)
src/crm/attachments.ts                attachment fetch incl. TG getFile stream (Task 9)
src/crm/worker.ts                     auto-assign, SLA overdue, nobody-on-shift (Task 10)
src/crm/alerts.ts                     TG group pings (Task 10)
src/crm/user_context.ts               turkarta user-context client + cache (Task 11)
src/crm/stats.ts                      stats queries (Task 12)
src/crm/canned.ts                     canned replies store (Task 13)
src/crm/operators.ts                  operators, prefs, shift, heartbeat (Task 13)
src/crm/routes.ts                     Hono router /crm/api + SSE + static (Task 13)
src/bots/support.ts                   use inbound.ts; SUPPORT_SURFACE gating (Tasks 4, 14)
src/server.ts                         mount CRM; gate Bitrix events (Tasks 13, 14)
src/index.ts                          ensureCrmSchema, start CRM worker + hub (Tasks 2, 5, 10)
scripts/forum_farewell.ts             one-off post into open forum topics (Task 14)
web/                                  SPA (Tasks 15-18)
tests/crm_*.test.ts, tests/crm_*_postgres.test.ts
turkarta (separate worktree + PR):     SSO route, nav, user-context, config default, webapp attachments[] (Task 19)
```

---

### Task 1: Fly.io config

**Files:**
- Create: `fly.toml`
- Modify: `docs/DEPLOY-STATE.md` (append a "Fly.io" section)

- [ ] **Step 1: Write `fly.toml`**

```toml
# Fly.io config for turkarta-operations (support/leads bots + support CRM).
# Single machine on purpose: bot webhooks are re-registered on boot, workers run
# in-process and CRM presence lives in memory. Never scale above 1.
app = "turkarta-operations"
primary_region = "ams"

[build]
  dockerfile = "Dockerfile"

[env]
  PORT = "8000"
  NODE_ENV = "production"

[http_service]
  internal_port = 8000
  force_https = true
  auto_stop_machines = "off"
  auto_start_machines = true
  min_machines_running = 1
  processes = ["app"]

  [[http_service.checks]]
    interval = "30s"
    timeout = "5s"
    grace_period = "20s"
    method = "GET"
    path = "/health"

[[vm]]
  cpu_kind = "shared"
  cpus = 1
  memory_mb = 512
```

- [ ] **Step 2: Validate** — Run: `fly config validate -c fly.toml` (requires `fly auth whoami` OK). Expected: `Configuration is valid`.
- [ ] **Step 3: Append to `docs/DEPLOY-STATE.md`** a section "Fly.io (planned 2026-10-16)": app name, region, domain `support.turkarta.me`, the move sequence from spec §15, and the rule "never scale above 1 machine".
- [ ] **Step 4: Commit** `git add fly.toml docs/DEPLOY-STATE.md && git commit -m "infra: fly.io config for ops"`

---

### Task 2: Schema, config, shared types

**Files:**
- Create: `migrations/0016_support_crm.sql`, `src/crm/types.ts`, `tests/crm_schema_postgres.test.ts`
- Modify: `src/config.ts`, `src/db.ts` (add `ensureCrmSchema`), `src/index.ts` (call it after `ensureSupportPhotoSchema`)

**Interfaces:**
- Produces: `db.ensureCrmSchema(): Promise<void>` (runs the same SQL as the migration file, read from disk at `migrations/0016_support_crm.sql` relative to the package root); `config.SUPPORT_SURFACE: "bitrix" | "crm"`; `config.CRM_SSO_SECRET?: string` (min 32 chars).
- Produces types in `src/crm/types.ts`:

```ts
export type MessageKind = "text" | "photo" | "note" | "unsupported";
export type UnsupportedType = "video" | "animation" | "voice" | "document" | "sticker" | "video_note" | "audio";
export type TicketStatus = "new" | "allocated" | "awaiting" | "resolved";
export type DeliveryStatus = "pending" | "sent" | "failed";
export type CrmRole = "admin" | "support";
export interface Operator {
  id: number; name: string; email: string | null; role: CrmRole; is_lead: boolean;
  auto_assign_enabled: boolean; on_shift: boolean; last_active_at: string | null;
  last_assigned_at: string | null; prefs: OperatorPrefs;
}
export interface OperatorPrefs {
  theme: "system" | "light" | "dark"; sound: boolean; volume: number;
  desktop: boolean; notify_scope: "all" | "mine"; send_key: "enter" | "mod_enter";
}
export const DEFAULT_PREFS: OperatorPrefs = {
  theme: "system", sound: true, volume: 0.6, desktop: true, notify_scope: "all", send_key: "mod_enter",
};
export type TicketEventType = "created" | "assigned" | "auto_assigned" | "unassigned" | "taken_over" | "status_changed" | "reopened";
export const canEditTeamSettings = (o: Pick<Operator, "role" | "is_lead">) => o.role === "admin" || o.is_lead;
```

- [ ] **Step 1: Write the migration** `migrations/0016_support_crm.sql`:

```sql
-- Support CRM (spec docs/superpowers/specs/2026-10-16-support-crm-design.md §4). Additive only.
create table if not exists public.crm_operators (
  id bigint primary key,                       -- turkarta admin_users.id
  name text not null,
  email text,
  role text not null check (role in ('admin','support')),
  is_lead boolean not null default false,
  auto_assign_enabled boolean not null default true,
  on_shift boolean not null default false,
  last_active_at timestamptz,
  last_assigned_at timestamptz,
  prefs jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.support_requests
  add column if not exists assigned_operator_id bigint references public.crm_operators(id),
  add column if not exists auto_assigned boolean not null default false,
  add column if not exists queued_at timestamptz,
  add column if not exists waiting_since timestamptz,
  add column if not exists first_response_at timestamptz,
  add column if not exists last_message_at timestamptz,
  add column if not exists overdue_pinged_at timestamptz;
create index if not exists support_requests_queue_idx on public.support_requests (queued_at) where status = 'new';
create index if not exists support_requests_assignee_idx on public.support_requests (assigned_operator_id) where status in ('allocated','awaiting');
create index if not exists support_requests_last_message_idx on public.support_requests (last_message_at desc);

alter table public.support_messages
  add column if not exists kind text not null default 'text',
  add column if not exists unsupported_type text,
  add column if not exists author_name text,
  add column if not exists response_seconds integer,
  add column if not exists delivery_status text,
  add column if not exists delivery_error text,
  add column if not exists tg_media_group_id text;
do $$ begin
  alter table public.support_messages add constraint support_messages_kind_check
    check (kind in ('text','photo','note','unsupported'));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.support_messages add constraint support_messages_delivery_check
    check (delivery_status is null or delivery_status in ('pending','sent','failed'));
exception when duplicate_object then null; end $$;
create index if not exists support_messages_agent_created_idx on public.support_messages (created_at) where sender = 'agent';

alter table public.support_attachments drop constraint if exists support_attachments_message_id_key;
alter table public.support_attachments
  add column if not exists position smallint not null default 0,
  add column if not exists tg_file_id text,
  add column if not exists tg_file_unique_id text;
alter table public.support_attachments alter column content drop not null;
alter table public.support_attachments alter column size_bytes drop not null;
alter table public.support_attachments drop constraint if exists support_attachments_size_bytes_check;
do $$ begin
  alter table public.support_attachments add constraint support_attachments_size_check
    check (size_bytes is null or (size_bytes > 0 and size_bytes <= 8388608));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.support_attachments add constraint support_attachments_source_check
    check (content is not null or tg_file_id is not null);
exception when duplicate_object then null; end $$;

create table if not exists public.crm_sessions (
  id uuid primary key default gen_random_uuid(),
  token_hash text not null unique,
  operator_id bigint not null references public.crm_operators(id) on delete cascade,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create table if not exists public.crm_sso_nonces (
  jti text primary key,
  expires_at timestamptz not null
);
create table if not exists public.crm_ticket_events (
  id bigserial primary key,
  ticket_id uuid not null references public.support_requests(id) on delete cascade,
  type text not null check (type in ('created','assigned','auto_assigned','unassigned','taken_over','status_changed','reopened')),
  actor_operator_id bigint references public.crm_operators(id),
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists crm_ticket_events_ticket_idx on public.crm_ticket_events (ticket_id, id);
create index if not exists crm_ticket_events_created_idx on public.crm_ticket_events (created_at);
create table if not exists public.crm_canned_replies (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  body text not null,
  use_count integer not null default 0,
  created_by bigint references public.crm_operators(id),
  updated_by bigint references public.crm_operators(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table if not exists public.crm_settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);
create table if not exists public.crm_settings_log (
  id bigserial primary key,
  key text not null,
  old_value jsonb,
  new_value jsonb not null,
  operator_id bigint references public.crm_operators(id),
  created_at timestamptz not null default now()
);

-- Backfill timers for tickets that are open at deploy time.
update public.support_requests set queued_at = coalesce(queued_at, created_at)
  where status = 'new' and queued_at is null;
update public.support_requests r set last_message_at = m.last_at
  from (select ticket_id, max(created_at) as last_at from public.support_messages group by ticket_id) m
  where m.ticket_id = r.id and r.last_message_at is null;
```

Before writing, confirm the existing unique constraint name with `grep -n "unique" migrations/0012_support_attachments.sql` and the inline `unique` in `ensureSupportPhotoSchema`; Postgres names it `support_attachments_message_id_key`. Also change `ensureSupportPhotoSchema()` in `src/db.ts` so its `create table` no longer declares `unique` / `not null` on `content` (it is a no-op on existing DBs but must not fight the new shape on fresh ones).

- [ ] **Step 2: Config** — in `src/config.ts` `Env`:

```ts
  // Operator surface: 'bitrix' = Bitrix Open Lines + TG forum (legacy), 'crm' = /crm only.
  SUPPORT_SURFACE: z.enum(["bitrix", "crm"]).default("bitrix"),
  // Shared with turkarta's admin SSO issuer (HMAC-SHA256). Unset = CRM login disabled.
  CRM_SSO_SECRET: z.string().min(32).optional(),
```

- [ ] **Step 3: `ensureCrmSchema`** in `src/db.ts`:

```ts
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
const CRM_MIGRATION = fileURLToPath(new URL("../migrations/0016_support_crm.sql", import.meta.url));
/** Apply the idempotent CRM migration on boot (same file `pnpm migrate` runs). */
export async function ensureCrmSchema(): Promise<void> {
  await sql.unsafe(readFileSync(CRM_MIGRATION, "utf8"));
}
```

`dist/db.js` resolves `../migrations` to the package root both locally and in the image (Dockerfile copies `migrations`). Call it in `src/index.ts` right after `ensureSupportPhotoSchema()`.

- [ ] **Step 4: Write the Postgres test** `tests/crm_schema_postgres.test.ts`: guard on `CRM_TEST_DATABASE_URL` (localhost + `/crm_test`), apply every migration in `migrations/` in lexical order with `sql.unsafe`, then `ensureCrmSchema()` twice (idempotent), then assert:
  - inserting a `support_attachments` row with neither `content` nor `tg_file_id` fails with code `23514`;
  - two attachments for one message succeed;
  - `support_messages.kind = 'bogus'` fails `23514`;
  - backfill sets `queued_at` on a pre-existing `new` ticket.
- [ ] **Step 5: Run** `pnpm build && CRM_TEST_DATABASE_URL=postgres://postgres@127.0.0.1:5432/crm_test pnpm test` — Expected: PASS (create the DB first: `createdb -h 127.0.0.1 -U postgres crm_test`, or `docker run -d -p 5432:5432 -e POSTGRES_HOST_AUTH_METHOD=trust postgres:16`).
- [ ] **Step 6: Commit** `git add migrations/0016_support_crm.sql src/crm/types.ts src/config.ts src/db.ts src/index.ts tests/crm_schema_postgres.test.ts && git commit -m "feat(crm): schema, config and shared types"`

---

### Task 3: Settings store

**Files:**
- Create: `src/crm/settings.ts`, `tests/crm_settings.test.ts`, `tests/crm_settings_postgres.test.ts`

**Interfaces:**
- Produces:

```ts
export const SettingsSchema = z.object({
  sla_first_minutes: z.number().int().min(1).max(240),
  sla_followup_minutes: z.number().int().min(1).max(240),
  sla_warn_percent: z.number().int().min(10).max(90),
  auto_assign_enabled: z.boolean(),
  auto_assign_minutes: z.number().int().min(1).max(240),
  auto_assign_max_open: z.number().int().min(1).max(500).nullable(),
  offline_after_minutes: z.number().int().min(1).max(240),
  reopen_days: z.number().int().min(0).max(30),
  tg_ping_new_ticket: z.boolean(),
  tg_ping_overdue: z.boolean(),
  tg_ping_no_one_on_shift: z.boolean(),
  resolve_message_enabled: z.boolean(),
  resolve_message_text: z.string().trim().min(1).max(1000),
});
export type Settings = z.infer<typeof SettingsSchema>;
export const DEFAULT_SETTINGS: Settings; // values from spec §13a
export async function getSettings(): Promise<Settings>;           // defaults merged with crm_settings rows
export async function updateSettings(patch: unknown, operatorId: number):
  Promise<{ ok: true; settings: Settings } | { ok: false; errors: Record<string, string> }>;
export async function settingsLog(limit?: number): Promise<Array<{ key: string; old_value: unknown; new_value: unknown; operator_name: string | null; created_at: string }>>;
```

`updateSettings` validates `SettingsSchema.partial().strict()`; unknown keys are an error; writes only changed keys in one transaction (`insert ... on conflict (key) do update`), one `crm_settings_log` row per changed key. No caching: workers call `getSettings()` each tick (spec: apply within 30 s).

- [ ] **Step 1: Unit test** `tests/crm_settings.test.ts` exercising pure validation via an exported `validateSettingsPatch(patch): { ok, value | errors }`:

```ts
test("rejects out-of-range and unknown keys with field errors", () => {
  const r = validateSettingsPatch({ sla_first_minutes: 0, nope: 1 });
  assert.equal(r.ok, false);
  assert.ok(r.errors.sla_first_minutes);
  assert.ok(r.errors.nope);
});
test("accepts edges and a null cap", () => {
  assert.equal(validateSettingsPatch({ sla_first_minutes: 1, sla_followup_minutes: 240, auto_assign_max_open: null }).ok, true);
});
test("defaults match the spec", () => {
  assert.equal(DEFAULT_SETTINGS.sla_first_minutes, 5);
  assert.equal(DEFAULT_SETTINGS.sla_followup_minutes, 15);
  assert.equal(DEFAULT_SETTINGS.auto_assign_minutes, 5);
});
```

- [ ] **Step 2: Run** `pnpm build && pnpm test` — Expected: FAIL (module missing).
- [ ] **Step 3: Implement** `src/crm/settings.ts` per interface.
- [ ] **Step 4: Postgres test**: update two keys, one unchanged → exactly 2 log rows; `getSettings()` returns merged values; a row with an invalid stored value (manually inserted) falls back to the default for that key.
- [ ] **Step 5: Run tests** — Expected: PASS.
- [ ] **Step 6: Commit** `git add src/crm/settings.ts tests/crm_settings*.ts && git commit -m "feat(crm): team settings store with audit log"`

---

### Task 4: Inbound capture (kinds, photos, albums, timers, reopen)

**Files:**
- Create: `src/crm/inbound.ts`, `tests/crm_inbound.test.ts`, `tests/crm_inbound_postgres.test.ts`
- Modify: `src/bots/support.ts` (DM handler, `createAppTicket`, `createWebTicket`, `pushWebUserMessage`), `src/db.ts` (`openTicket`/`openWebTicket` set `queued_at = now()`, `last_message_at = now()` on insert)

**Interfaces:**
- Consumes: `getSettings()` (Task 3), `publish()` (Task 5; until Task 5 lands, import from `./events.js` with a stub that no-ops; Task 5 replaces the body).
- Produces:

```ts
export interface InboundPart {
  kind: "text" | "photo" | "unsupported";
  body: string;                          // text or caption ("" allowed for photo)
  unsupportedType?: UnsupportedType;
  tgPhoto?: { fileId: string; fileUniqueId: string };
  mediaGroupId?: string;
  webPhoto?: ValidPhoto;
}
export function classifyTelegram(message: import("grammy/types").Message): InboundPart | null;
/** Store a user message with CRM fields, update ticket timers, reopen if needed, publish events. */
export async function recordUserMessage(ticket: Ticket, part: InboundPart, meta: { authorId: string; sourceId?: string }):
  Promise<{ messageId: string; appendedToAlbum: boolean; reopened: boolean }>;
/** Body label kept in support_messages.body for legacy readers (Bitrix, AI). */
export function legacyLabel(part: InboundPart): string;
```

Rules (spec §5):
- `classifyTelegram`: text → `text`; photo → `photo` with largest size `file_id`/`file_unique_id`, caption, `media_group_id`; `animation` (GIF) checked before `document` (Telegram sends both) → `unsupported/animation`; video, voice, document, sticker, video_note, audio → `unsupported`; caption kept; anything else → `null`.
- `legacyLabel`: text → body; photo → caption or `"📷 [фото]"`; unsupported → existing labels from `contentLabel` (`🎬 [видео]`, `🎤 [голосовое]`, `📎 [файл]`, sticker emoji + `[стикер]`, `🎵 [аудио]`, `GIF` → `🎞 [GIF]`). Body stores `legacyLabel` so Bitrix mode and AI triggers see the same text as today.
- Album: if `mediaGroupId` set and the ticket's latest user message has the same `tg_media_group_id` and `created_at > now() - interval '10 seconds'` and fewer than 10 attachments, insert only an attachment row (`position` = count) and return `appendedToAlbum: true` (no new message, no new AI trigger).
- In one transaction after insert: `waiting_since = coalesce(waiting_since, now())`, `last_message_at = now()`; status `awaiting` → `allocated`; status `resolved` and `resolved_at > now() - reopen_days`: if assigned operator `on_shift` → `allocated`, else `new` + `queued_at = now()` + `assigned_operator_id = null`; log `reopened` event. `resolved` and older: leave alone (the bot's `ticketByUser` only returns open tickets, so a new ticket is opened by existing code).
- After commit: `publish({ type: "message.created", ticketId })` and `ticket.updated`; if the ticket has an assignee, `publish({ type: "notify", operatorId: assignee, kind: "user_replied", … })`.

Wire-up in `support.ts`:
- DM first contact: keep `openTicket` (now with `queued_at`), replace the `db.addMessage(... contentLabel ...)` call with `recordUserMessage(opened, part, …)`; publish `ticket.created`.
- DM later messages: replace `db.addMessage` with `recordUserMessage`. Keep `contentLabel` usage for Bitrix calls (`legacyLabel(part)` returns the same strings).
- `createAppTicket`, `createWebTicket`, `pushWebUserMessage`: route through `recordUserMessage` with `kind` from presence of `photo`.
- `first_photo_file_id` stays populated for Bitrix mode.

- [ ] **Step 1: Unit tests** `tests/crm_inbound.test.ts` for `classifyTelegram` and `legacyLabel` with fixture messages: text; photo with 3 sizes picks the last; photo with caption and `media_group_id`; GIF (`animation` + `document`) → `animation`; voice; sticker with emoji; empty service message → null.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** `classifyTelegram`, `legacyLabel`, `recordUserMessage`.
- [ ] **Step 4: Postgres tests**: (a) photo album of 3 parts within 10 s → 1 message, 3 attachments positions 0..2; (b) 11th photo starts a new message; (c) user message on `awaiting` → `allocated`, `waiting_since` set once and not moved by the second message; (d) resolved 2 days ago with operator on shift → `allocated`, `reopened` event; operator off shift → `new` with fresh `queued_at`, assignee null; (e) `reopen_days = 0` → no reopen.
- [ ] **Step 5: Update `tests/support_album.test.ts` mocks** so the existing album test still passes (mock `../dist/crm/inbound.js` `recordUserMessage` returning `{ messageId: "stored-message", appendedToAlbum: false, reopened: false }`).
- [ ] **Step 6: Run all tests** — PASS.
- [ ] **Step 7: Commit** `git add src/crm/inbound.ts src/bots/support.ts src/db.ts tests/crm_inbound*.ts tests/support_album.test.ts && git commit -m "feat(crm): capture real message kinds, TG photos and ticket timers"`

---

### Task 5: Events hub and presence

**Files:**
- Create: `src/crm/events.ts`, `tests/crm_events.test.ts`
- Modify: `src/index.ts` (start hub; stop on shutdown)

**Interfaces:**
- Produces:

```ts
export type CrmEvent =
  | { type: "ticket.created" | "ticket.updated"; ticketId: string }
  | { type: "message.created"; ticketId: string; messageId?: string }
  | { type: "operator.updated"; operatorId: number }
  | { type: "presence"; ticketId: string; viewers: Array<{ operatorId: number; name: string; state: "viewing" | "typing" }> }
  | { type: "notify"; operatorId: number | null; kind: "new_ticket" | "assigned" | "mention" | "user_replied"; ticketId: string; title: string; body: string };
export async function publish(event: CrmEvent): Promise<void>;   // sql.notify("crm_events", JSON)
export function subscribe(fn: (e: CrmEvent) => void): () => void;
export async function startEventHub(): Promise<() => Promise<void>>; // sql.listen("crm_events") → fan out
export const presence: {
  set(ticketId: string, operator: { id: number; name: string }, state: "viewing" | "typing", now?: number): void;
  list(ticketId: string, now?: number): Array<{ operatorId: number; name: string; state: "viewing" | "typing" }>;
};
```

Presence TTL 10 s; `set` publishes a `presence` event (local fan-out only, not NOTIFY, since one instance). `publish` payload must stay under Postgres' 8000-byte NOTIFY limit: ids and short strings only; `notify.body` truncated to 140 chars.

- [ ] **Step 1: Unit test**: `subscribe` receives fan-out from an exported `dispatch(e)` used by the listener; unsubscribe stops delivery; `presence.list` drops entries older than 10 s (inject `now`); a second `set` by the same operator replaces state.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `git add src/crm/events.ts src/index.ts tests/crm_events.test.ts && git commit -m "feat(crm): NOTIFY-backed event hub and presence"`

---

### Task 6: SSO and sessions

**Files:**
- Create: `src/crm/auth.ts`, `tests/crm_auth.test.ts`, `tests/crm_auth_postgres.test.ts`

**Interfaces:**
- Produces:

```ts
export interface SsoClaims { sub: number; name: string; email: string | null; role: "admin" | "support"; jti: string; exp: number; next?: string }
/** Token = base64url(JSON claims) + "." + base64url(HMAC-SHA256(secret, payloadPart)). */
export function verifySsoToken(token: string, secret: string, nowSec?: number):
  { ok: true; claims: SsoClaims } | { ok: false; reason: "malformed" | "signature" | "expired" | "role" };
export function signSsoToken(claims: SsoClaims, secret: string): string; // used by tests and mirrored in turkarta
export async function consumeSso(token: string): Promise<{ ok: true; sessionToken: string; operator: Operator; next?: string } | { ok: false; reason: string }>;
export async function operatorForSession(sessionToken: string): Promise<Operator | null>;
export async function deleteSession(sessionToken: string): Promise<void>;
export const SESSION_COOKIE = "crm_session";
export const SESSION_TTL_HOURS = 12;
/** Hono middleware: cookie + X-CRM header; sets c.var.operator; 401 JSON otherwise. */
export function requireOperator(): MiddlewareHandler<{ Variables: { operator: Operator } }>;
```

`consumeSso`: verify; `insert into crm_sso_nonces (jti, expires_at) values (…, to_timestamp(exp) + interval '1 hour') on conflict do nothing returning jti` (no row = replay); upsert `crm_operators` (name, email, role; keep `is_lead`, prefs); create session with `randomBytes(32).toString("base64url")`, store `sha256` hex; delete expired nonces and sessions opportunistically. `next` must match `/^\/crm(\/[\w\-/]*)?$/` or is dropped (open-redirect guard). Signature comparison uses `timingSafeEqual`. `exp` more than 120 s in the future → `malformed` (issuer uses 60 s).

- [ ] **Step 1: Unit tests** for `verifySsoToken`: valid; tampered payload → `signature`; expired by 1 s → `expired`; role `manager` → `role`; garbage → `malformed`; exp 1 hour ahead → `malformed`.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** — PASS.
- [ ] **Step 5: Postgres tests**: consume valid token → session works via `operatorForSession`; consume same token again → `{ ok: false, reason: "replay" }`; session row with `expires_at` in the past → `null`; `next=/crm/t/abc` kept, `next=https://evil` dropped; re-login keeps `is_lead=true` set earlier.
- [ ] **Step 6: Commit** `git add src/crm/auth.ts tests/crm_auth*.ts && git commit -m "feat(crm): SSO token verification and sessions"`

---

### Task 7: Ticket workflow and queries

**Files:**
- Create: `src/crm/tickets.ts`, `tests/crm_tickets_postgres.test.ts`

**Interfaces:**
- Consumes: `publish` (Task 5), `getSettings` (Task 3), types (Task 2).
- Produces:

```ts
export interface TicketListItem {
  id: string; status: TicketStatus; channel: "telegram" | "web"; source: string | null;
  user_name: string | null; user_username: string | null; user_tg: number | null; email: string | null;
  last_message_preview: string; last_message_at: string | null; waiting_since: string | null;
  first_response_at: string | null; assigned_operator_id: number | null; assigned_operator_name: string | null;
  auto_assigned: boolean; intake_pending: boolean; created_at: string;
}
export interface ListQuery { view: "queue" | "mine" | "all"; status?: TicketStatus; channel?: "bot" | "miniapp" | "web"; operatorId?: number; overdue?: boolean; q?: string; cursor?: string; limit?: number }
export async function listTickets(me: Operator, q: ListQuery, s: Settings): Promise<{ items: TicketListItem[]; nextCursor: string | null; counts: { queue: number; mine: number; overdue: number } }>;
export interface TicketEventRow { id: number; type: TicketEventType; actor_name: string | null; payload: Record<string, unknown>; created_at: string }
export async function ticketDetail(id: string): Promise<{ ticket: TicketListItem & { device: string | null; category: string | null; web_user_id: string | null }; messages: CrmMessage[]; events: TicketEventRow[] } | null>;
export interface CrmMessage { id: string; sender: "user" | "agent" | "system"; kind: MessageKind; body: string; unsupported_type: string | null; author_name: string | null; created_at: string; delivery_status: DeliveryStatus | null; delivery_error: string | null; attachments: Array<{ id: string; media_type: string | null; position: number }> }
export class Conflict extends Error { constructor(public code: "assigned_to_other" | "resolved", public assignee?: { id: number; name: string }) }
export async function take(ticketId: string, me: Operator): Promise<void>;          // new → allocated, assign me; Conflict if assigned to other
export async function takeOver(ticketId: string, me: Operator): Promise<void>;      // reassign to me, event taken_over
export async function assign(ticketId: string, to: number | null, me: Operator): Promise<void>; // admin: any; support: only own ticket; null → queue
export async function setStatus(ticketId: string, status: TicketStatus, me: Operator): Promise<void>;
```

Rules:
- Ordering: `queue` by `queued_at asc`; `mine` and `all` by `waiting_since asc nulls last, last_message_at desc`. Cursor = opaque base64 of the sort tuple + id.
- `overdue` computed in SQL: `waiting_since < now() - make_interval(mins => case when first_response_at is null then $first else $followup end)`.
- `channel` filter maps to `source` (`bot`, `miniapp`, web = `source like 'web%'`).
- `q` matches `user_name`, `user_username`, `email`, `user_tg::text`, ticket id prefix (ILIKE, escaped).
- All mutations: `select … for update` on the ticket; write `crm_ticket_events`; `publish(ticket.updated)`; on assignment to someone else also `publish(notify assigned)` for that operator; update `crm_operators.last_assigned_at`.
- `setStatus("resolved")` sets `resolved_at = now()`, `waiting_since = null`; if settings `resolve_message_enabled`, send `resolve_message_text` through `reply.sendSystemText` (Task 8 exports it; until then leave a call guarded by the setting and wire it in Task 8). `setStatus("new")` → unassign + `queued_at = now()`.
- Permission errors throw `Forbidden` (export class) → 403.

- [ ] **Step 1: Postgres tests** (write first): two concurrent `take` on one queued ticket → one succeeds, other throws `Conflict("assigned_to_other")` with winner name; `takeOver` logs `taken_over`; support operator `assign` on a ticket not theirs → `Forbidden`; admin can; `setStatus(resolved)` clears `waiting_since`; list `queue` ordering; `overdue` filter with `sla_first_minutes=5` and a ticket waiting 6 min; search by `@username` substring; cursor pagination returns disjoint pages.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `git add src/crm/tickets.ts tests/crm_tickets_postgres.test.ts && git commit -m "feat(crm): ticket queue, assignment and status workflow"`

---

### Task 8: Operator replies and delivery

**Files:**
- Create: `src/crm/reply.ts`, `tests/crm_reply.test.ts`, `tests/crm_reply_postgres.test.ts`
- Modify: `src/db.ts` (`messagesSince` excludes `kind = 'note'`; returns `attachments` array via `json_agg` ordered by `position`), `src/server.ts` (`serializeMessages` emits `attachments: [...]` and keeps `attachment` = first item), `src/crm/tickets.ts` (wire resolve message)

**Interfaces:**
- Consumes: `take` semantics (Task 7), `publish` (Task 5), `validatePhoto` (`src/support_media.ts`), `turkartaApi.notifySupportReply`.
- Produces:

```ts
export interface TgTransport {
  sendMessage(chatId: number, text: string): Promise<{ message_id: number }>;
  sendPhoto(chatId: number, photo: { bytes: Uint8Array; filename: string }, caption?: string): Promise<{ message_id: number; fileId: string; fileUniqueId: string }>;
  sendMediaGroup(chatId: number, photos: Array<{ bytes: Uint8Array; filename: string }>, caption?: string): Promise<Array<{ message_id: number; fileId: string; fileUniqueId: string }>>;
}
export function grammyTransport(api: Bot["api"]): TgTransport;  // InputFile from bytes
export interface ReplyInput { kind: "reply" | "note"; body: string; photos: ValidPhoto[] }
export async function sendReply(ticketId: string, me: Operator, input: ReplyInput, deps?: { tg?: TgTransport; notify?: typeof turkartaApi.notifySupportReply }): Promise<CrmMessage>;
export async function retryDelivery(messageId: string, me: Operator, deps?: …): Promise<CrmMessage>;
export async function sendSystemText(ticket: Ticket, text: string, deps?: …): Promise<void>; // resolve message; stored as agent text, author_name null
```

Flow (spec §6):
1. Validate: `body.trim()` or at least one photo for `reply`; `note` requires body; ≤10 photos; body ≤ 4000 (TG caption limit 1024 → if photos and body > 1024, send body as a separate text after the photos).
2. Transaction: lock ticket; resolved → `Conflict("resolved")`; assigned to other → `Conflict("assigned_to_other")`; unassigned → assign me + `assigned` event. For `reply`: compute `response_seconds = extract(epoch from now() - waiting_since)::int` when `waiting_since` not null; `first_response_at = coalesce(first_response_at, now())`; `waiting_since = null`; status → `awaiting`. Insert message (`sender='agent'`, `actor_type='human'`, `author_id='crm:<id>'`, `author_name`, `kind` = `note` | (`photo` if photos else `text`), `delivery_status` = `pending` for reply, null for note) and attachment rows with bytes.
3. After commit, for `reply`: TG ticket → transport per photo count; store returned `tg_file_id` on attachments; web ticket → no send. Then `delivery_status='sent'`; web → `notifySupportReply` with `preview` = body or `"📷 Фото"` (catch and log). TG error → `delivery_status='failed'`, `delivery_error` = `` `tg_${error_code}: ${description}` `` truncated 200 chars (description is Telegram's, contains no customer text).
4. Notes: parse `@Name` mentions against `crm_operators.name` (case-insensitive, whole word) → `publish(notify mention)` per match.
5. `publish(message.created)`, `publish(ticket.updated)`.

TG text format: plain text, no «Поддержка:» prefix (operator replies come from the support bot already). Keep it simple; no HTML parse mode, so user-facing text is sent verbatim.

- [ ] **Step 1: Unit tests** with a fake transport: 1 photo → `sendPhoto`; 3 photos → one `sendMediaGroup`; photos + 1500-char body → media group without caption then `sendMessage`; transport throws `{ error_code: 403, description: "Forbidden: bot was blocked by the user" }` → returns message with `delivery_status: "failed"` and `delivery_error` starting `tg_403`.
- [ ] **Step 2: Postgres tests**: reply sets `response_seconds` ≈ age of `waiting_since` (±2 s), `first_response_at` set once; note leaves `waiting_since` and status untouched; note excluded from `db.messagesSince` (web API) and never calls transport or `notifySupportReply`; reply on another operator's ticket → `Conflict`; reply on queued ticket assigns me; `retryDelivery` on a failed message resends and flips to `sent`; web reply calls `notify` once with no note text.
- [ ] **Step 3: Run** — FAIL. **Step 4: Implement** + `db.ts` / `server.ts` changes. **Step 5: Run all tests** — PASS (existing web tests keep `attachment`).
- [ ] **Step 6: Commit** `git add src/crm/reply.ts src/crm/tickets.ts src/db.ts src/server.ts tests/crm_reply*.ts && git commit -m "feat(crm): operator replies with photos, notes and delivery state"`

---

### Task 9: Attachment serving

**Files:**
- Create: `src/crm/attachments.ts`, `tests/crm_attachments.test.ts`

**Interfaces:**
- Produces: `export async function attachmentResponse(id: string, deps?: { getFile?: (fileId) => Promise<{ file_path?: string }>; fetch?: typeof fetch }): Promise<Response>` — bytes row → `Response(content, { headers: content-type, cache-control: "private, max-age=86400" })`; `tg_file_id` → `getFile` then fetch `https://api.telegram.org/file/bot<token>/<file_path>` and stream body; never include token in errors or logs; TG failure → 502 JSON `{ error: "photo_unavailable" }`; unknown id → 404.
- [ ] **Step 1: Unit tests** with injected deps: bytes path; tg path streams and sets `image/jpeg` (TG photos are always JPEG); getFile throws → 502; 404.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `git add src/crm/attachments.ts tests/crm_attachments.test.ts && git commit -m "feat(crm): serve stored and Telegram photos"`

---

### Task 10: Worker (auto-assign, SLA, alerts) and new-ticket notifications

**Files:**
- Create: `src/crm/worker.ts`, `src/crm/alerts.ts`, `tests/crm_worker_postgres.test.ts`, `tests/crm_alerts.test.ts`
- Modify: `src/index.ts` (start/stop worker, only when `SUPPORT_SURFACE === "crm"`), `src/crm/inbound.ts` (new ticket → `alerts.newTicket` + `publish(notify new_ticket)`)

**Interfaces:**
- Produces:

```ts
export async function tick(now?: Date, deps?: { alert?: Alerts }): Promise<{ assigned: number; overdue: number; noOneAlerted: boolean }>;
export function startCrmWorker(intervalMs = 30_000): () => Promise<void>;
export interface Alerts { newTicket(t: TicketListItem): Promise<void>; overdue(t: TicketListItem, minutes: number): Promise<void>; noOneOnShift(queued: number): Promise<void> }
export function telegramAlerts(api: Bot["api"], chatId: number, baseUrl: string): Alerts;
```

`tick` order: (1) `update crm_operators set on_shift = false where on_shift and last_active_at < now() - offline_after`, publish `operator.updated`; (2) if `auto_assign_enabled`: in one transaction `select id from support_requests where status='new' and queued_at < now() - auto_assign_minutes order by queued_at for update skip locked limit 20`; for each pick candidate:

```sql
select o.id, o.name from crm_operators o
 where o.on_shift and o.auto_assign_enabled and o.last_active_at > now() - make_interval(mins => $offline)
   and ($cap::int is null or (select count(*) from support_requests r where r.assigned_operator_id = o.id and r.status in ('allocated','awaiting')) < $cap)
 order by (select count(*) from support_requests r where r.assigned_operator_id = o.id and r.status in ('allocated','awaiting')) asc,
          o.last_assigned_at asc nulls first
 limit 1
```

assign (`status='allocated'`, `auto_assigned=true`, event `auto_assigned`, `last_assigned_at=now()`), notify the assignee; none → stop and remember. (3) If tickets remained unassigned and `tg_ping_no_one_on_shift`, alert at most once per 15 min (module-level timestamp). (4) Overdue: tickets with `waiting_since` past target and `overdue_pinged_at is null or overdue_pinged_at < waiting_since` → alert if `tg_ping_overdue`, set `overdue_pinged_at = now()`.

`telegramAlerts` messages (HTML, escaped): `🆕 Новое обращение · {channel} · {name}\n{first line ≤120}\n{baseUrl}/crm/t/{id}`; `⏰ Ждёт ответа {n} мин · {name}\n{link}`; `🚨 Никого нет на смене, в очереди {n}\n{baseUrl}/crm`. Sent to `SUPPORT_CHAT_ID` without a thread.

- [ ] **Step 1: Postgres tests**: least-loaded online operator wins; tie → oldest `last_assigned_at`; operator with stale heartbeat skipped and flipped off shift; cap respected; nobody → `noOneAlerted` once across two ticks within 15 min; two concurrent `tick()` calls assign each ticket once; overdue alert fires once per waiting period and again after a new user message; setting `auto_assign_minutes` changed between ticks takes effect.
- [ ] **Step 2: Unit test** `telegramAlerts` escapes `<b>` in names and builds the link.
- [ ] **Step 3: Run** — FAIL. **Step 4: Implement.** **Step 5: Run** — PASS.
- [ ] **Step 6: Commit** `git add src/crm/worker.ts src/crm/alerts.ts src/crm/inbound.ts src/index.ts tests/crm_worker_postgres.test.ts tests/crm_alerts.test.ts && git commit -m "feat(crm): auto-assign, SLA overdue and shift alerts"`

---

### Task 11: User context client

**Files:**
- Create: `src/crm/user_context.ts`, `tests/crm_user_context.test.ts`

**Interfaces:**
- Produces:

```ts
export interface UserContext {
  found: boolean; user_id?: string; tg_id?: number | null; tg_username?: string | null; name?: string | null;
  email?: string | null; email_verified?: boolean; registered_at?: string | null; kyc_level?: number | null;
  cards?: Array<{ last4: string; status: string; plan: string | null; balance_usd: string | null }>;
  recent_topups?: Array<{ amount_rub: string | null; amount_usd: string | null; status: string; created_at: string }>;
  admin_url?: string | null;
}
export async function userContext(t: { user_tg: number | null; web_user_id: string | null }, deps?: { fetch?: typeof fetch; now?: () => number }): Promise<UserContext | null>;
```

POST `${TURKARTA_API_URL}/webhooks/ops/support/user-context` with `x-webhook-secret` (same secret resolution as `notifySupportReply`), body `{ tg_id, user_id }`, 3 s timeout. Cache 60 s keyed `tg:<id>` / `web:<id>`, max 500 entries (drop oldest). Unconfigured, timeout, non-2xx, or invalid JSON → `null` (UI shows ops data only). Validate with zod.
- [ ] **Step 1: Tests**: caches within 60 s; refetches after; 500 → null; unconfigured → null without fetch.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `git add src/crm/user_context.ts tests/crm_user_context.test.ts && git commit -m "feat(crm): turkarta user-context client with cache"`

---

### Task 12: Stats

**Files:**
- Create: `src/crm/stats.ts`, `tests/crm_stats_postgres.test.ts`

**Interfaces:**
- Produces:

```ts
export interface StatsRange { from: Date; to: Date } // half-open [from, to)
export interface TeamStats { new_per_day: Array<{ day: string; bot: number; miniapp: number; web: number }>; backlog: number; oldest_waiting_minutes: number | null; within_sla_pct: number | null }
export interface OperatorStats { operator_id: number; name: string; taken: number; auto_assigned: number; resolved: number; replies: number;
  response_median_s: number | null; response_p90_s: number | null; first_response_median_s: number | null; first_response_p90_s: number | null;
  within_sla_pct: number | null; reopen_rate_pct: number | null }
export async function stats(range: StatsRange, me: Operator, s: Settings): Promise<{ team: TeamStats; operators: OperatorStats[] }>;
```

Days bucketed in `Europe/Moscow`. `taken` = events `assigned` where actor = target operator; `auto_assigned` = events `auto_assigned` with payload `operator_id`; `resolved` = `status_changed` to resolved by actor; `replies` = agent messages kind in (text, photo) with `author_id = 'crm:<id>'`; percentiles via `percentile_cont`; within SLA = share of replies where `response_seconds <= target` (first reply of ticket uses first target: reply `created_at = first_response_at`); reopen rate = tickets resolved by the operator in range that got a `reopened` event / resolved. Non-admin non-lead → `operators` filtered to own row.
- [ ] **Step 1: Postgres test** with a fixed fixture (2 operators, 5 tickets, known timestamps) asserting every number.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `git add src/crm/stats.ts tests/crm_stats_postgres.test.ts && git commit -m "feat(crm): team and per-operator stats"`

---

### Task 13: Canned replies, operators, API router, SSE

**Files:**
- Create: `src/crm/canned.ts`, `src/crm/operators.ts`, `src/crm/routes.ts`, `tests/crm_routes.test.ts`
- Modify: `src/server.ts` (`app.route("/crm", crmRoutes())`)

**Interfaces:**
- Produces `crmRoutes(): Hono` with exactly the endpoints in spec §11 plus `GET /crm/sso`, `POST /crm/api/logout`. Error mapping: zod → 422 `{ error: "validation", fields }`; `Conflict` → 409 `{ error: code, assignee }`; `Forbidden` → 403; not found → 404.
- Canned: `listCanned(q?)` (ordered `use_count desc, title`), `createCanned`, `updateCanned`, `deleteCanned(id, me)` (author, admin or lead), `useCanned(id)` increments; title ≤ 80, body ≤ 4000.
- Operators: `listOperators()` with open ticket counts; `setShift(me, on)`; `heartbeat(me)` (`last_active_at = now()`); `updateOperator(id, patch, me)` (`is_lead` admin only; `auto_assign_enabled`, `on_shift` admin or lead); `updatePrefs(me, patch)` validated by zod against `OperatorPrefs`.
- Multipart reply: `c.req.parseBody({ all: true })`; `photos` may be File or File[]; each validated with `validatePhoto(bytes, file.type, file.name)`; reject with 422 `{ error: "photo_invalid", index }`.
- SSE `GET /crm/api/stream` via `hono/streaming` `streamSSE`: subscribe to hub, filter `notify` events to `operatorId === me.id || operatorId === null`, write `event: <type>`, `data: JSON`; `: ping` every 20 s; unsubscribe on abort.
- Static: `serveStatic` from `@hono/node-server/serve-static` with root `dist/web`, SPA fallback: any `GET /crm/*` that is not `/crm/api/*` or `/crm/sso` returns `dist/web/index.html`.
- `/crm/sso`: on success set cookie `crm_session` (`httpOnly`, `secure`, `sameSite: "Lax"`, `path: "/crm"`, `maxAge` 12 h) and 302 to `next ?? "/crm"`; on failure 302 to `/crm/login-failed?reason=…` (SPA page with a link back to the admin).

- [ ] **Step 1: Route tests** using `app.request()` with module mocks for stores (pattern from `tests/support_album.test.ts`): 401 without cookie; 401 with cookie but no `X-CRM` header; 409 shape on conflict; 422 on 11 photos; non-lead support `PUT /settings` → 403; lead → 200; `PUT /operators/:id {is_lead}` by lead → 403; SSE emits `notify` only for own operator and broadcast.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `git add src/crm/canned.ts src/crm/operators.ts src/crm/routes.ts src/server.ts tests/crm_routes.test.ts && git commit -m "feat(crm): API router, SSE stream, canned replies and operators"`

---

### Task 14: Surface switch

**Files:**
- Create: `scripts/forum_farewell.ts`, `tests/crm_surface.test.ts`
- Modify: `src/bots/support.ts`, `src/server.ts`

**Interfaces:** `const legacySurface = () => config.SUPPORT_SURFACE === "bitrix";` (export from `src/config.ts`).

In `crm` mode:
- `support.ts`: skip `postTicketCard`, `sendPhotoToSupport`, all `openlines.sendUserMessage`, forum relay (the `SUPPORT_CHAT_ID` operator-message handler returns `next()` immediately), and the thread relay in the DM handler. Intake (email ask, `QUEUED` reply) unchanged. `QUEUED` text unchanged.
- `server.ts`: Bitrix `ONIMCONNECTORMESSAGEADD` handler returns 200 `{ ok: true, ignored: "surface=crm" }` and logs `[bitrix-ol] ignored surface=crm`.
- `ensureBootstrapped` (Bitrix connector bootstrap) skipped.
- `scripts/forum_farewell.ts`: for every ticket with `status in ('new','allocated','awaiting') and thread_id is not null`, send `Поддержка переехала в CRM: {PUBLIC_BASE_URL}/crm/t/{id}` into the topic. Dry-run by default; `--send` to post. Reads env like `scripts/migrate.ts`.

- [ ] **Step 1: Test** (module mocks as in `support_album.test.ts`, `SUPPORT_SURFACE=crm`): a DM after intake records the message and makes zero calls to `openlines.sendUserMessage` and zero `sendMessage` to `SUPPORT_CHAT_ID`; with `bitrix` the existing behaviour holds (existing album test still green).
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `git add src/bots/support.ts src/server.ts src/config.ts scripts/forum_farewell.ts tests/crm_surface.test.ts && git commit -m "feat(crm): SUPPORT_SURFACE switch between bitrix and crm"`

---

### Task 15: SPA scaffold, design system, auth shell

**Before writing UI code:** invoke the `impeccable` skill (shape the product register: a calm, dense, all-day work tool; light and dark token sets) and keep its output as `web/DESIGN.md`. Fonts and palette are chosen there.

**Files:**
- Create: `web/package.json`, `web/vite.config.ts`, `web/tsconfig.json`, `web/tailwind.config.ts`, `web/postcss.config.js`, `web/index.html`, `web/src/main.tsx`, `web/src/app.tsx`, `web/src/styles/tokens.css`, `web/src/lib/api.ts`, `web/src/lib/sse.ts`, `web/src/lib/theme.ts`, `web/src/components/Shell.tsx`, `web/src/routes/LoginFailed.tsx`, `web/DESIGN.md`
- Modify: `pnpm-workspace.yaml` (`packages: ["web"]`), root `package.json` (`"build:web": "pnpm --filter crm-web build"`), `Dockerfile` (web build stage), `.github/workflows/test.yml` (typecheck + build web), `tsconfig.json` (exclude `web`)

**Interfaces:**
- `web/src/lib/api.ts`: `api<T>(path, init?)` → fetch `/crm/api${path}` with `credentials: "same-origin"`, header `X-CRM: 1`; 401 → `window.location.assign("/crm/login-failed?reason=session")` once (guard against loops with a module flag); throws `ApiError { status, body }`.
- `web/src/lib/sse.ts`: `useCrmStream(onEvent)` with `EventSource("/crm/api/stream")`, exponential reconnect 1 s → 30 s, `onreconnect` invalidates all TanStack queries; exposes `connected` for the «переподключение…» marker.
- `web/src/lib/theme.ts`: `data-theme` on `<html>` = prefs.theme or system (`matchMedia`), listens to system changes.
- Vite: `base: "/crm/"`, `build.outDir: "../dist/web"`, dev proxy `/crm/api` → `http://localhost:8000`.
- Dockerfile build stage additions (after `RUN pnpm build`):

```dockerfile
COPY pnpm-workspace.yaml ./
COPY web ./web
RUN pnpm install --frozen-lockfile --ignore-scripts --filter crm-web... && pnpm --filter crm-web build
```

and runtime stage keeps `COPY --from=build /app/dist ./dist` (now includes `dist/web`).

- [ ] **Step 1:** scaffold, install deps: `pnpm --filter crm-web add react@18.3.1 react-dom@18.3.1 react-router-dom@7 @tanstack/react-query@5` and dev deps `vite@6 @vitejs/plugin-react typescript tailwindcss@3 postcss autoprefixer @types/react @types/react-dom`.
- [ ] **Step 2:** tokens in `tokens.css`: `:root` light set, `[data-theme="dark"]` dark set, semantic names (`--bg`, `--surface`, `--surface-2`, `--border`, `--text`, `--text-muted`, `--accent`, `--sla-ok`, `--sla-warn`, `--sla-late`, `--note-bg`, `--danger`, `--ch-bot`, `--ch-miniapp`, `--ch-web`), mapped in `tailwind.config.ts` `theme.extend.colors`.
- [ ] **Step 3:** `Shell.tsx`: nav rail (Очередь, Мои, Все with counts; Статистика, Шаблоны, Настройки; «На смене» toggle; sound toggle; theme switch) + `<Outlet/>`; heartbeat `POST /me/heartbeat` every 60 s while visible.
- [ ] **Step 4:** `pnpm --filter crm-web build` succeeds, `pnpm build` succeeds; start ops locally and open `/crm` → redirects to `login-failed` without a session.
- [ ] **Step 5: Commit** web scaffold files + workspace/Dockerfile/CI changes: `git commit -m "feat(crm-web): SPA scaffold, tokens, auth shell"`

---

### Task 16: Inbox, thread, side panel

**Files:**
- Create: `web/src/routes/Inbox.tsx`, `web/src/components/TicketList.tsx`, `web/src/components/TicketRow.tsx`, `web/src/components/Thread.tsx`, `web/src/components/MessageBubble.tsx`, `web/src/components/Lightbox.tsx`, `web/src/components/UserPanel.tsx`, `web/src/components/SlaBadge.tsx`, `web/src/lib/sla.ts`, `web/src/lib/keyboard.ts`, `web/src/lib/notify.ts`, `web/src/lib/sla.test.ts`

Behaviour (spec §13):
- Routes `/crm` (queue), `/crm/mine`, `/crm/all`, `/crm/t/:id` (ticket in the current view). List left, thread center, panel right; below 1024 px list and thread are separate screens and the panel is a sheet.
- `TicketRow`: channel dot, name/@username, `SlaBadge` (re-renders every 15 s), preview, assignee avatar initials, presence dots, «авто» chip, «ждём email» chip when `intake_pending`.
- `sla.ts`: `slaState(waitingSince, firstResponseAt, settings, now) → { minutes, level: "none" | "ok" | "warn" | "late" }`; unit-tested with vitest (`pnpm --filter crm-web test`).
- `Thread`: user left, agent right with `author_name`; note amber; events from `crm_ticket_events` as dividers («Назначен автоматически: Аня», «Решён»); photos grid with `loading="lazy"` from `/crm/api/attachments/:id`; unsupported chip text map (`video` → «🎥 Видео не поддерживается», `animation` → «🎞 GIF не поддерживается», `voice` → «🎤 Голосовое не поддерживается», `document` → «📎 Файл не поддерживается», `sticker` → «Стикер», `video_note` → «🎥 Кружок не поддерживается», `audio` → «🎵 Аудио не поддерживается»); delivery state on agent messages with «Повторить» on failed.
- Header actions: status menu, assign menu (operators list), «Взять» / «Перехватить», «Решить» (`e`).
- `UserPanel`: data from ticket + `userContext`; click-to-copy TG id / username / email with a toast; «Нет аккаунта» when `found=false`; past tickets list.
- Presence: `POST /tickets/:id/presence {viewing}` every 5 s while open; typing on input (throttled 3 s).
- `keyboard.ts`: `j`/`k`, `Enter`, `a`, `e`, `g q`/`g m`/`g a`; ignored when focus is in an input.
- `notify.ts`: on SSE `notify`, play a short WebAudio blip (respects prefs sound/volume), show `Notification` if `document.hidden` and permission granted and prefs.desktop; `notify_scope="mine"` drops `new_ticket`.
- [ ] **Step 1:** vitest for `slaState` (none, ok at 2 min, warn at 3 min with 5-min target and 50%, late at 6 min; follow-up target used once `firstResponseAt` set) — write, run FAIL, implement, PASS.
- [ ] **Step 2:** build the components; verify against a locally running ops with seeded data (seed script in Task 18).
- [ ] **Step 3: Commit** `git commit -m "feat(crm-web): inbox, thread and user panel"`

---

### Task 17: Composer with photos, notes, canned replies

**Files:**
- Create: `web/src/components/Composer.tsx`, `web/src/components/DropOverlay.tsx`, `web/src/components/PhotoStrip.tsx`, `web/src/components/CannedPicker.tsx`, `web/src/lib/files.ts`, `web/src/lib/files.test.ts`, `web/src/lib/canned.ts`, `web/src/lib/canned.test.ts`

Behaviour (spec §13 «Attaching photos»):
- `files.ts`: `acceptFiles(existing: File[], incoming: File[]) → { accepted: File[]; rejected: Array<{ name: string; reason: "type" | "size" | "limit" }> }` (types jpeg/png/webp, 8 MB, total ≤ 10). Vitest: mixed drop keeps valid ones; 11th rejected `limit`; `.gif` rejected `type`.
- Drop target = whole thread pane: `dragenter`/`dragleave` counter to avoid flicker, overlay «Отпустите, чтобы прикрепить» + «JPG, PNG, WEBP до 8 МБ, до 10 фото»; ignore non-file drags (`dataTransfer.types` includes `Files`); locked composer → overlay shows «Сначала нажмите «Перехватить»» and drop is ignored.
- Paste: `onPaste` collects `clipboardData.files`.
- 📎 button: hidden `<input type="file" multiple accept="image/jpeg,image/png,image/webp">`.
- Rejections → one toast per reason with file names («только фото: JPG, PNG, WEBP», «больше 8 МБ», «не больше 10 фото»).
- `PhotoStrip`: object-URL thumbnails, remove button, revoke on remove/send/unmount.
- Mode toggle Ответ / Заметка (Tab when input empty or with `Ctrl+.`), amber background in note mode, placeholder changes.
- Send: Enter or Ctrl/Cmd+Enter per prefs; optimistic message (pending state) inserted into the thread query cache; on 409 show the assignee and offer «Перехватить»; on success replace with server message.
- `/` at line start opens `CannedPicker` (fuzzy match on title+body, arrow keys, Enter inserts); `canned.ts` `fillTemplate(body, { имя, оператор })` replaces `{имя}`/`{оператор}`; vitest covers missing values → empty string, unknown placeholders left as-is.
- Typing presence ping on input (throttled 3 s).
- [ ] **Step 1:** vitest for `acceptFiles` and `fillTemplate` — FAIL, implement, PASS.
- [ ] **Step 2:** build components; manual check: drag 3 photos + 1 pdf onto the thread → 3 previews + one rejection toast; paste screenshot; send → appears with delivery «отправлено».
- [ ] **Step 3: Commit** `git commit -m "feat(crm-web): composer with drag-and-drop photos, notes and canned replies"`

---

### Task 18: Settings, operators, canned page, stats page, seed script

**Files:**
- Create: `web/src/routes/Settings.tsx`, `web/src/routes/Canned.tsx`, `web/src/routes/Stats.tsx`, `web/src/components/StatsChart.tsx`, `scripts/seed_crm_dev.ts`

Behaviour:
- Settings «Команда» form from `GET /settings`, read-only unless `canEditTeamSettings(me)`; field errors from 422 shown inline; history list from `/settings/log`. «Операторы» table with lead toggle (admin only), auto-assign toggle and «Снять со смены» (admin/lead). «Личные» tab: theme, sound + volume with a test button, desktop notifications with a permission button, notify scope, send key.
- Canned page: list, search, create/edit/delete (delete hidden unless author/admin/lead).
- Stats: date range presets (Сегодня, 7 дней, 30 дней, custom), team tiles, stacked bars new-per-day by channel (invoke the `dataviz` skill before building the chart; plain SVG, no chart lib), operator table sortable by column; durations formatted «4 мин 12 с».
- `scripts/seed_crm_dev.ts`: refuses unless `DATABASE_URL` host is localhost; creates 2 operators, 12 tickets across channels/statuses with messages, notes, photos (tiny generated PNG), events; prints a signed SSO URL using `CRM_SSO_SECRET` for local login.
- [ ] **Step 1:** build pages; run seed; log in via printed URL; check each page in light and dark.
- [ ] **Step 2: Commit** `git commit -m "feat(crm-web): settings, operators, canned replies and stats pages"`

---

### Task 19: Turkarta side (separate repo, separate PR)

Work in a new worktree: `git -C ~/projects/turkarta worktree add ../turkarta-crm-sso -b feat/support-crm-sso origin/main` (the main checkout is mid-cherry-pick; do not touch it).

**Files (turkarta):**
- Modify: `apps/api/turkarta/config.py` (`crm_sso_secret: SecretStr = SecretStr("")`; `ops_support_base_url` default → `"https://support.turkarta.me"`)
- Create: `apps/api/turkarta/routes/admin_support_crm.py` — `GET /admin/support-crm` (`require_support_role`), builds token identical to ops `signSsoToken` (`base64url(json.dumps(claims, separators=(",", ":")))` + `.` + `base64url(hmac_sha256(secret, payload_part))`, no padding), claims `{sub, name, email, role, jti: uuid4 hex, exp: now+60}`, optional `next` param validated `^/crm(/[\w\-/]*)?$`; 503 page if secret empty; 302 to `{ops_support_base_url}/crm/sso?t=…`.
- Modify: `apps/api/turkarta/routes/_admin_html.py` `NAV_ITEMS`: add `("/admin/support-crm", "Поддержка", SUPPORT_ROLES)` after «Клиенты и карты».
- Modify: `apps/api/turkarta/main.py`: include the router in the `support_only` mount list.
- Modify: `apps/api/turkarta/routes/webhooks_ops.py`: `POST /webhooks/ops/support/user-context` (same secret check) returning the shape in spec §10 from `User`, cards, KYC and the 5 latest top-ups; `found: false` when no user; never PAN/CVV.
- Modify: `tests/test_admin_support_role.py` (classify new route: admin + support allowed, manager 403).
- Create: `tests/test_admin_support_crm.py` (token round-trip against a Python port of the verify logic + a fixed vector shared with ops `tests/crm_auth.test.ts`), `tests/test_webhooks_ops_user_context.py` (403 wrong secret, found false, shape).
- Modify: `apps/webapp/src/lib/api/support.ts` type (`attachments?: Attachment[]`) and `apps/webapp/src/screens/SupportChat.tsx` render `attachments ?? (attachment ? [attachment] : [])` as a grid for any sender.

- [ ] **Step 1:** add the shared test vector: fixed secret `"x".repeat(32)`, claims `{sub: 7, name: "Аня", email: null, role: "support", jti: "j1", exp: 2000000000}`; record the exact token string produced by ops `signSsoToken` in both test suites.
- [ ] **Step 2:** tests first, run `pytest apps/api/tests/test_admin_support_crm.py apps/api/tests/test_webhooks_ops_user_context.py apps/api/tests/test_admin_support_role.py` — FAIL; implement; PASS. Webapp: `pnpm --filter webapp exec tsc -b` passes.
- [ ] **Step 3:** commit with explicit paths; push; open PR into turkarta `main`.

---

### Task 20: Whole-branch verification and PR (ops)

- [ ] `pnpm typecheck && pnpm build && pnpm test` with `CRM_TEST_DATABASE_URL` set → zero failures (grep the summary for `fail 0`).
- [ ] `pnpm --filter crm-web test && pnpm --filter crm-web build`.
- [ ] `docker build .` succeeds locally (or `fly deploy --build-only --remote-only`).
- [ ] Playwright smoke against local ops + seed: SSO URL → inbox → open ticket → drag a PNG onto the thread → send → message shows «отправлено»; toggle dark theme; screenshot both themes.
- [ ] `/emil-design-eng` pass on composer, list transitions and lightbox; fix findings.
- [ ] Push `feat/support-crm`, open PR into ops `main`.

### Task 21: Deploy (prod, manual, after PRs merge)

Each step states blast radius + rollback before running (global rule).
1. `fly apps create turkarta-operations`; `fly secrets set` all current Render env + `CRM_SSO_SECRET`, `SUPPORT_SURFACE=bitrix`, `PUBLIC_BASE_URL=https://support.turkarta.me`.
2. DNS `support.turkarta.me` CNAME → Fly; `fly certs add support.turkarta.me`.
3. `fly deploy` (boot applies `0016` via `ensureCrmSchema` and re-points bot webhooks). Suspend Render immediately.
4. Turkarta: set `OPS_SUPPORT_BASE_URL` + `CRM_SSO_SECRET` on both Fly apps; deploy turkarta PR.
5. Bitrix handler URLs to the Fly host while `bitrix` mode remains.
6. Smoke: TG DM, web ticket, Bitrix reply, CRM login, CRM reply.
7. Cutover when the owner says go: `fly secrets set SUPPORT_SURFACE=crm`, run `scripts/forum_farewell.ts --send`.
8. Record every TEMP state in `docs/DEPLOY-STATE.md` with flip conditions.
