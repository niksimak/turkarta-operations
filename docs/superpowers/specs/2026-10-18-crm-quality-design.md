# CRM quality: contact reasons, CSAT, AI review, weekly summary

Date: 2026-10-18. Status: design approved in chat, spec awaiting owner review.

## Goal

Show the owner how well support performs and what to fix in the product:
why customers write (topics), whether we helped (CSAT), how good each
conversation was (existing AI review), which answers should become saved
replies, and a weekly summary in the support Telegram chat.

## Owner decisions (2026-10-18)

- Topic list as proposed (below). Leads/admins can edit it later.
- AI review is visible **only to the owner** for now.
- Weekly summary goes to the support Telegram chat.
- CSAT question text: «Мы смогли вам помочь?».

## What exists and is reused

| Need | Existing piece | Change |
|---|---|---|
| Ticket resolve | `setStatus()` in `src/crm/tickets.ts`, resolve message via `sendSystemText()` in `src/crm/reply.ts` | add two after-resolve hooks: queue topic job, send CSAT |
| AI calls | `src/agents/*`: OpenAI Responses, `store:false`, redaction, budget meter (`support_agent_calls`) | new task kinds `topic` and `template` |
| AI review of operators | `support_agent_jobs` kind `review`, result jsonb (6 dimensions, verdicts, `suggested_reply_ru`) | read-only surface in the CRM |
| Saved replies | `crm_canned_replies`, `src/crm/canned.ts`, `web/src/routes/Canned.tsx` | suggestions list feeding `createCanned` |
| Stats | `src/crm/stats.ts`, `/api/stats`, `web/src/routes/Stats.tsx` | new fields and sections |
| Settings | `src/crm/settings.ts` (key/value + log) | three new keys |
| Telegram send | `deliver()` / `sendTelegram` in `src/crm/reply.ts` | optional `reply_markup` |
| Telegram callbacks | `supportBot.callbackQuery` in `src/bots/support.ts` | one `csat:` handler |
| Web chat | ops `/api/support/web/messages` → Turkarta `services/ops_support.py` + `routes/web_support.py` → webapp `SupportChat.tsx` | `csat` field + one POST route + widget |
| Periodic work | `src/crm/worker.ts` loop | weekly summary, weekly template mining |

No new service, no new process, no Redis.

## 1. Topics (contact reasons)

Data (`migrations/0019_crm_quality.sql`, idempotent, appended to `CRM_MIGRATIONS`):
- `crm_topics(id serial, name text unique, position int, archived_at timestamptz null, created_at)`.
  Seeded once, in order: «Пополнение не пришло», «Карта отклонена», «Выпуск карты»,
  «KYC/верификация», «Antarctic», «Вывод/возврат», «Тарифы и цены», «Как пользоваться»,
  «Жалоба», «Другое».
- `support_requests.topic_id int null references crm_topics`, `topic_source text null check in ('ai','operator')`,
  `topic_set_at timestamptz null`.
- `crm_ticket_events` type check widened with `topic_changed` (payload `{from, to, source}`).

Flow:
- On a CRM resolve (`setStatus` → resolved), if the ticket has no operator-set topic, insert a
  `support_agent_jobs` row of kind `topic` (kind check widened). Queued from code, not the
  DB trigger, so the backlog archive and other bulk closes never queue one.
- The agent worker runs `engine.topic(transcript, activeTopics)` → `{topic_id, confidence}`
  (strict JSON schema, topic must be one of the active ids). It writes the topic with
  `topic_source='ai'` unless an operator set one meanwhile. Runs whenever `SUPPORT_AI_MODE`
  is not `off` (prod is `shadow`; topics are internal, not customer-facing).
- The operator sees the topic in the ticket header as a select («Тема: …», «Без темы»); any
  change sets `topic_source='operator'` and logs `topic_changed`. An operator choice is never
  overwritten by AI.
- If the AI budget is exhausted or the call fails, the ticket stays «Без темы»; nothing retries
  beyond the existing job attempts.
- Settings → «Темы обращений» (leads/admins): rename, reorder, add, archive. Archived topics
  stay on old tickets and in reports, but are not offered for new choices.

Report (stats page section «Причины обращений», range-driven):
- per topic: resolved tickets in range, change vs previous equal range, median resolution
  time, CSAT % (when ≥5 answers), share of all resolved; «Без темы» as its own row.

## 2. CSAT

Data:
- `crm_csat(id uuid, ticket_id uuid, resolved_at timestamptz, operator_id int null, topic_id int null,
  channel text check in ('telegram','web'), prompt_message_id uuid, comment_prompt_tg_id bigint null,
  rating text null check in ('up','down'), comment text null check length ≤ 1000,
  asked_at, answered_at, commented_at)`, unique `(ticket_id, resolved_at)`.
  `operator_id` = assignee at resolve; `topic_id` is filled when the topic lands.
- `crm_ticket_events` type check widened with `csat` (payload `{rating}`).
- Settings: `csat_enabled` (default **true**), `csat_text` (default «Мы смогли вам помочь?», 1–200 chars).

When it is asked (all must hold):
- resolved through the CRM `setStatus` (never cutover/bulk),
- `csat_enabled`, not legacy Bitrix surface,
- the ticket has at least one human operator reply (`actor_type='human'`) since its last
  reopen; spam and empty tickets are not asked,
- no `crm_csat` row for this resolution yet.

It is sent right after the resolve message (if that is enabled), as its own agent message
(`actor_type='automation'`, `kind='text'`, body = `csat_text`), so it shows in the CRM thread
and never triggers AI triage/review (those fire on `customer` / `human`).

Telegram (bot and Mini App customers, i.e. `user_tg` set):
- inline keyboard `[«👍 Да» csat:<id>:up] [«👎 Нет» csat:<id>:down]` (transport gains
  `reply_markup`).
- tap → store rating (a later tap overwrites; allowed until the ticket is reopened), answer
  the callback, edit the prompt to «Спасибо за оценку!».
- on 👎 also send «Что пошло не так? Ответьте на это сообщение — это необязательно.» with
  `force_reply`. A customer message that is a **reply to that prompt** is saved as the
  comment, answered «Спасибо, передали команде.», and does not reopen the ticket or create a
  new one. Any other message follows the normal path (reopen / new ticket).
- the `csat:` prefix is outside the legacy-callback guard regex.

Web (PWA, `channel='web'`):
- ops `/api/support/web/messages` adds `csat: {id, rating, comment_allowed} | null` for a
  resolved ticket with an open CSAT row.
- ops `POST /api/support/web/csat` (same `x-webhook-secret`) `{csat_id, web_user_id, rating?, comment?}`,
  checks the row belongs to that web user.
- Turkarta: `services/ops_support.py` passes `csat` through; new `POST /api/web/support/csat`
  in `routes/web_support.py`; `SupportChat.tsx` shows under «Обращение закрыто» the question
  with two buttons, then a comment box after 👎, then «Спасибо за оценку!».
- Requires a Turkarta main → prod release (backend + webapp). Until then web customers simply
  see no question; ops ships independently.

CRM:
- ticket thread shows the result as an event line («Клиент оценил: 👍» / «👎 + комментарий»).
- stats: per operator and team: CSAT % = up / (up + down), answers, response rate
  = answered / asked; shown only when answers ≥ 5, else «мало оценок».

## 3. Quality page (owner only)

Access:
- env `CRM_QA_OPERATOR_EMAILS` (comma list, matched case-insensitively to `crm_operators.email`).
  Empty → nobody. Prod value = the owner's operator email. Not a team setting, so no one else
  can grant it in the UI.
- `GET /api/quality/*` return 404 for everyone else; the nav item «Качество» renders only
  when `/api/me` says `qa: true`.

Content («Качество»):
- **Очередь**: resolved tickets in range with (a) a completed `review` job having any verdict
  `critical` or `needs_improvement`, or (b) a 👎 CSAT. Row: ticket, operator, topic, worst
  verdict, CSAT, date. «Просмотрено» marks it (`crm_qa_marks(ticket_id, operator_id, marked_at)`),
  reviewed rows hide by default.
- **Разбор тикета**: the review's summary and 6 assessments (verdict, explanation,
  suggested reply) next to a link to the ticket.
- **По операторам**: per operator count of reviews, share `meets`, criticals, CSAT %.
- Reads `support_agent_jobs.result` as is; no change to the review job or its trigger.

Template suggestions (on «Шаблоны», visible to every operator, since they are not judgements of people):
- Weekly job (Monday, after the summary) in `src/crm/worker.ts`: operator text replies of
  the last 30 days (`actor_type='human'`, `kind='text'`, ≥ 40 chars), grouped by `pg_trgm`
  similarity ≥ 0.6. A group qualifies with replies on ≥ 3 distinct tickets and no existing
  saved reply at similarity ≥ 0.6.
- For each group (max 10 a week) one AI call `template` drafts `{title ≤80, body ≤4000}`
  with names, amounts, card digits and dates replaced by placeholders like «[сумма]».
- `crm_template_suggestions(id, title, body, sample_count, status in ('new','accepted','dismissed'),
  created_at, decided_by, decided_at, canned_id null)`.
- «Шаблоны» shows «Предложено ИИ (N)»: preview, «Создать шаблон» (opens the normal editor
  prefilled, saving calls `createCanned` and marks accepted), «Скрыть» (dismissed).

## 4. Weekly summary

- Setting `tg_weekly_summary` (default true). Sent Monday 10:00 МСК for the previous
  Monday–Sunday to `SUPPORT_CHAT_ID`.
- Exactly once: `crm_weekly_summaries(week_start date primary key, sent_at)` claimed with
  `insert … on conflict do nothing` before sending, so restarts or a second process never
  double-send. A missed Monday (machine down) sends on the next worker tick that day.
- Content (no AI review data, the chat is team-visible):
  - new tickets, total and by channel, vs previous week;
  - top 5 topics with counts and change, «Без темы» count;
  - median first response, SLA %, median resolution time;
  - CSAT % and number of answers;
  - link to the stats page for that week.

## 5. Stats additions

`/api/stats` and the stats page gain:
- team: median time to resolution (first customer message of the cycle → resolve), share
  solved with one operator reply and not reopened, average messages per resolved ticket;
- per operator: median resolution time, one-reply share, CSAT;
- heatmap of new tickets by weekday × hour (МСК) for the range.

## Delivery

Each PR ships and deploys on its own; order:
1. Stats additions (5).
2. Topics (1): migration 0019, AI task, header select, settings, report.
3. CSAT ops (2) + Telegram; then Turkarta PR for the web widget, released main → prod.
4. Quality page + template suggestions (3).
5. Weekly summary (4) (needs 1–2 for content).

Tests: Postgres tests for every new query (stats, topics, CSAT state machine, summary
idempotency, suggestion grouping), unit tests for the AI contracts and the Telegram callback
and force-reply paths, web tests for the new UI, Turkarta pytest for the proxy route and
vitest for the widget.

## Risks and limits

- AI budget is shared with triage and review ($1/day, $20/month on prod). Topic calls are one
  per CRM-resolved ticket on the nano model; if the cap is hit, topics fall back to manual.
- The CSAT comment relies on the customer using Telegram's reply; a plain message is treated
  as a new question. This is deliberate: it never swallows a real request.
- `pg_trgm` must be available on Neon (it is a supported extension); the migration runs
  `create extension if not exists pg_trgm`.
- The existing review trigger already queued reviews for the 713 archived backlog tickets;
  this spec does not change that. The quality queue only lists tickets resolved through the
  CRM (`status_changed` without `reason: cutover_backlog`).
