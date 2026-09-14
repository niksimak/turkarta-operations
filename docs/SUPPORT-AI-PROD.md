# Support AI production rollout — 2026-09-15

**Current status:** production AI is active in **shadow mode**. The user
explicitly approved copying the supplied OpenAI key from Fly dev into Render
production. The transfer is complete. Substantive AI answers remain drafts and internal
Telegram notifications remain disabled. Fixed topic greetings are enabled
separately; see `SUPPORT-TOPIC-GREETINGS.md`.

## Scope and operating mode

Promote PR #6 into the existing Render `turkarta-operations` service
(`srv-d90g7t4m0tmc73dpi000`, Frankfurt). Runtime remains the Telegram/Bitrix
relay, with `SUPPORT_AI_MODE=shadow`. New customer messages queue classification
and Russian reply drafts; operator replies queue evidence-based quality reviews.
AI results require the dedicated internal API credential. Automatic substantive
AI answers, financial actions, internal Telegram notifications, and employee
scoring publication remain disabled. Short fixed topic greetings are sent
separately during intake. Reviews require a supervisor's assessment.

Use `gpt-5.4-nano`, the published knowledge API at
`https://api.turkarta.me/api/knowledge-base`, $1/day and $20/month application
model budgets, and 12 model calls per ticket per UTC day. The model credential
is transferred directly from the authorized dev secret into Render configuration;
production has its own independently generated AI admin secret. No secrets
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
5. The tested branch was first deployed with AI off. After explicit user
   approval, copy the supplied model key from Fly dev to Render, generate a
   separate production admin secret, set shadow mode and the spend limits, and
   redeploy the same tested commit. Existing webhook addresses and connector
   routing remain the same.
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
`34888679695`). Production code and shadow configuration are live. The production model
smoke check passed; results are recorded below.

Dev failures from the
initial activation remain available for audit; they were not rewritten as passes.

## QA interpretation

The live wallet scenario produced an excessive `critical` resolution finding
solely because an unfinished synthetic dialogue had no final answer. Structural
validation now passes, but severity calibration remains experimental. Reviews
must remain pending supervisor review; do not publish them as employee scores
or enable automatic critical notifications based on this validation alone.

## Initial production deployment — before activation

- Commit: `6d376c339849d10f6d485c173eee0f68a5d2443f` on `main`.
- Render deployment: `dep-dak50p0ae00c73fmr58g`, live at
  `2026-09-14T19:52:42Z` (September 15 in Asia/Almaty).
- Public `/health`: 200. Unauthenticated internal AI readiness: 403, confirming
  the new endpoint is deployed and access is denied without its credential.
- Migrations 0012/0013 committed together; zero historical jobs were queued.
- Production configuration was verified as AI off, without OpenAI key or AI
  admin secret. The rejected secret transfer was not executed.
- Production model smoke testing is deferred until activation; no synthetic
  customer messages were sent through production Telegram or Bitrix.
- GitHub API connectivity timed out during the final metadata check. The tested
  branch was merged with Git and pushed to main; Render confirms that exact merge.

## Shadow activation — 2026-09-15

- User explicitly approved the model-key transfer and production activation.
- The key was transferred directly from the dev Fly machine into Render
  environment configuration, without printing it or saving it in a local file.
- A separate production AI admin secret was generated and configured.
- Deployment `dep-dak5433l550s739ui8a0` became live at
  `2026-09-14T19:59:32Z`, using the same code commit `6d376c3`.
- Mode: shadow; model: `gpt-5.4-nano`; application caps: $1 per UTC day,
  $20 per UTC month, 12 calls per ticket per UTC day.
- Drafts and reviews are available through the authenticated internal API;
  there is currently no Bitrix/Telegram UI showing these drafts to operators.
- Customer replies remain operator-controlled. Account diagnostics and internal
  task/QA Telegram groups remain disconnected.

## Production smoke result

- Authenticated readiness: 200, shadow mode, model key configured, published KB
  source configured, $1/day and $20/month caps, automatic replies/financial
  actions disabled. Public health: 200; unauthenticated readiness: 403.
- Authenticated sandbox ticket creation: 404; dev mutation routes are absent.
- Synthetic ticket `6db2f1df-dfd8-4ae3-bc9d-8588ce8a9db4` was created directly
  with source `support-ai-prod-smoke`, a random web identity, and no Telegram
  or Bitrix delivery destination. No customer message was sent.
- Triage completed with a Russian operator-handoff draft. The general service
  question was classified as general/other, so conservative policy skipped KB
  answer generation. KB retrieval was available; this production sample does
  not establish successful KB-grounded answer generation.
- A synthetic human reply triggered a completed review with six validated
  assessments and state `pending_lead_review`.
- Both model calls were metered and settled, total $0.00190985 for this test.
  The synthetic ticket was marked resolved; its evidence and usage were kept.
- Existing dev smoke tests separately cover a KB answer, payment handoff and
  prompt-injection handling. Human QA calibration limitations still apply.
