# Topic greetings

New customer messages can receive one short Russian acknowledgment per ticket.
Topics are security, payments/top-ups, KYC, cards, technical issues, complaints,
and general support. Selection uses local text patterns and fixed templates;
there is no model call, customer-text interpolation, account lookup, financial
action or promise that an investigation has already happened.

Examples:

- Payment: «Здравствуйте! Получили ваш вопрос по оплате или пополнению.
  Оператор проверит детали и ответит в этом чате.»
- KYC: «Здравствуйте! Получили ваш вопрос о проверке личности (KYC).
  Оператор поможет разобраться и ответит в этом чате.»
- Card: «Здравствуйте! Получили ваш вопрос по карте.
  Оператор поможет разобраться и ответит в этом чате.»

## Behavior

- Telegram: greet after persisting the first request, then keep the email intake.
- Mini-app: greet the linked Telegram user; a user who has not opened the support
  bot may reject delivery, which is recorded without failing ticket creation.
- Web: persist an agent message with automation attribution for chat polling.
- An existing onboarding welcome is separate; the first actual customer question
  can receive the topic acknowledgment. Follow-ups do not repeat the greeting.
- Skip tickets with earlier customer messages, any human/unknown agent reply,
  a resolved status, or a first message older than five minutes. No backlog scan.
- Attachment-only requests use a general greeting; this does not analyze images.

A persistent row keyed by ticket ID reserves the greeting before Telegram send.
Web greeting and delivery state commit together. Telegram sends have a five-second
cancellation limit; explicit rejections are marked failed and ambiguous failures
are marked unknown. Neither is automatically retried, avoiding duplicate greetings
if Telegram accepted a message before a timeout. A crash can leave a sending row;
it is also not automatically replayed. Logs never include message text or tokens.

Greetings are automation, so they do not create human QA reviews or make an AI
analysis stale. New customer/operator messages still invalidate older analyses.
The existing substantive AI replies remain drafts. Readiness reports automatic
customer messages enabled for greetings, with automatic AI answers still false.

## Rollout and rollback

Apply additive migration `0015_support_topic_greetings.sql` before setting
`SUPPORT_TOPIC_GREETINGS_ENABLED=true` on production Render service
`srv-d90g7t4m0tmc73dpi000`. The flag defaults to false. Keep the existing shadow AI
configuration, model credential, budgets, and webhook routing.

Rollback: disable the flag and redeploy, or redeploy previous production code
`6d376c339849d10f6d485c173eee0f68a5d2443f`. Keep the additive table; it records
which greetings were already attempted and prevents repeats on reactivation.

Validation: typecheck and full local suite including real Postgres deduplication,
first-message eligibility, attribution, AI freshness, Telegram failure/ambiguity,
and unchanged photo/delivery handling. Production verification uses a synthetic
web ticket without real customer/Telegram identity; no test messages to customers.

## Release status

PR #7 was explicitly approved by the user and merged as
`10a1f5a9c67206d4ee34963a81fc16ca378f527c`. CI passed for PR head `bfbc6b2`
(run `34893666692`). All 66 local tests passed with no skips. Migration 0015
was applied to production with zero historical greeting rows. The production
greeting flag is enabled; existing AI analysis remains in shadow mode.

Dev verification passed on image
`registry.fly.io/turkarta-support-ai-dev:deployment-01M2GSVWJDBK7EJWQ85E0Q5HSP`
(digest `sha256:946225f4323a52158b753526d3d00a8f855aa9f7e92ba4312d270f4676848edc`).
Synthetic ticket `afc187c9-cdff-4d23-96b8-f48ad35e95bd` received one persisted KYC
greeting; concurrent attempts returned sent/skipped. The message was attributed
to automation, queued no human QA review, and its AI triage completed without
becoming stale. The check called the compiled greeting service against the
isolated dev DB and did not send any Telegram/Bitrix message.

Production deployment `dep-dak5orek1f9s73eh5qbg` is live at
`2026-09-14T20:44:02Z`, using merge commit `10a1f5a` (September 15 in
Asia/Almaty). Production readiness confirms topic greetings enabled, AI mode
shadow, automatic AI answers disabled, and unchanged $1/day and $20/month caps.
Public health is 200 and unauthenticated AI readiness is 403.

Greetings run during first-message intake, without waiting for model analysis.
Telegram normally delivers within seconds; web chat shows the message on its
next automatic poll. The existing free Render service can sleep when idle, so
a cold start or upstream network delay can make the first response slower.

## Production greeting verification

Synthetic web ticket `ffa02d52-7d6e-4e28-b2f9-b5414c324f54` was created with
source `support-topic-greeting-prod-smoke` and a random web identity, with no
Telegram/Bitrix destination. The tested compiled greeting service returned
sent/skipped for concurrent attempts. Exactly one payment greeting was persisted
with automation attribution, and the live production web polling API returned
that same greeting. No Telegram or Bitrix test message was sent.

The live production AI triage completed with `stale=false`, money-related routing
and `automatic_send_allowed=false`. The first result-read attempt hit a local
TCP timeout; a read-only retry succeeded. The synthetic ticket was then resolved,
retaining its greeting and metering records; normal closure QA may queue.

The rollout is complete: production greetings are enabled. Existing conversations
are not backfilled and substantive AI answers still require an operator.
