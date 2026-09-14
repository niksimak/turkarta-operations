# Support AI production rollout — 2026-09-15

## Scope and operating mode

Promote PR #6 into the existing Render `turkarta-operations` service
(`srv-d90g7t4m0tmc73dpi000`, Frankfurt). Runtime remains the Telegram/Bitrix
relay, with `SUPPORT_AI_MODE=shadow`. New customer messages queue classification
and Russian reply drafts; operator replies queue evidence-based quality reviews.
Results require the dedicated internal API credential. No automatic customer
replies, financial actions, internal Telegram notifications, or employee scoring
publication are enabled. Reviews require a supervisor's assessment.

Use `gpt-5.4-nano`, the published knowledge API at
`https://api.turkarta.me/api/knowledge-base`, $1/day and $20/month application
model budgets, and 12 model calls per ticket per UTC day. The model credential
is transferred directly from the authorized dev secret into Render configuration;
production receives its own independently generated AI admin secret. No secrets
are checked in. Account diagnostics remain disconnected.

The existing free Render service can sleep when idle; queued analysis resumes
when it wakes. This rollout does not establish an always-on analysis SLA.

## Deployment gates and sequence

1. Typecheck and all 60 tests pass, including real PostgreSQL integrations.
2. Dev image built from `885167a` runs five synthetic queued triage/review cases.
   Review generation limits citations to the supplied message IDs, requires
   Cyrillic text in prose fields, and explicitly permits an empty optional draft.
   Existing Russian-language and evidence validators remain in force.
3. Production preflight: previous live commit `989e6f1e0260f7d9a19d409342761f2c74f3e3fa`,
   530 support tickets and 757 messages, no AI schema as of preflight.
4. Apply only `0012_support_agents.sql` and `0013_support_agent_operations.sql`
   in one transaction with 5-second lock timeout and 30-second statement timeout.
   These add columns, tables, indexes, and queue triggers. Existing customer and
   system messages receive actor metadata; no historical analysis is queued.
   Migration `0014_bitrix_delivery_receipts.sql` is already installed.
5. Configure production shadow mode and secrets, then merge the tested PR and
   deploy that exact production merge commit. Existing webhook addresses and
   connector routing remain the same.
6. Verify Render live commit, public health, authenticated readiness, rejection
   of unauthenticated AI requests, and absent sandbox mutation routes. Use a
   clearly marked synthetic DB ticket with no Telegram/Bitrix destination to
   verify production triage and QA. Do not send test customer messages.

## Rollback

To pause analysis, set `SUPPORT_AI_MODE=off` and redeploy. Customer support relay
continues. For a code regression, deploy the previous production commit
`989e6f1e0260f7d9a19d409342761f2c74f3e3fa` with AI mode off. Keep the additive
schema and existing delivery receipts in place; do not drop tables or delete
customer messages. Old code ignores the added AI columns/tables. The queue may
accumulate jobs while analysis is off; account for this before reactivation.

## Verification record

Dev gate: all five queued triage jobs and all five queued reviews completed,
with six validated assessments per review. CI passed for `885167a` (run
`34888679695`). Production deployment and smoke check are pending.

Dev failures from the
initial activation remain available for audit; they were not rewritten as passes.
