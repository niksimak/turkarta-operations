# Support AI dev deployment — 2026-09-14

Code branch: `feat/support-ai-dev` in `turkarta-operations`.
The original local AI work is preserved in commit `c90b89d`, then integrated
with production support main `989e6f1` (delivery confirmations and photo fixes).
Original working copies remain untouched. The optional backend diagnostics
work is separately preserved on `feat/support-ai-diagnostics-dev` in `turkarta`;
it is not required or enabled for the shadow sandbox.

## Environment

- Fly app: `turkarta-support-ai-dev`, Frankfurt, single 512 MB shared CPU VM.
- URL: `https://turkarta-support-ai-dev.fly.dev`.
- Neon project: `calm-rain-98006074` (`turkarta-ops`).
- Isolated branch: `br-still-hall-asexjg9j` (`support-ai-dev`), created schema-only.
- Separate empty database and branch-specific role: `support_ai_dev`.
- Runtime: `node dist/agents/index.js`, with `SUPPORT_RUNTIME=sandbox`.
- No Telegram/Bitrix credentials, relay routes, customer sends, internal Telegram
  notifications, or financial tools in this runtime. It permits only `off`/`shadow`.
- Public published knowledge articles from `https://api.turkarta.me/api/knowledge-base`.
- Configured model: `gpt-5.4-nano`; application limits $1/day and $20/month.
  Infrastructure billing is separate from model usage.

**TEMP (2026-09-14):** deploy with `SUPPORT_AI_MODE=off` until the owner supplies
`OPENAI_API_KEY` through Fly secrets. Then set `SUPPORT_AI_MODE=shadow` and verify
a synthetic ticket completes with a Russian draft and metered usage. No model
credentials were found in the existing support/dev service or local project
configuration. Mock tests do not establish live model account access.

The service and Neon compute can stop when idle. This is an on-demand dev
sandbox; pending work resumes when the service starts. Do not treat it as an
always-on support worker or a customer response-time commitment.

## API smoke test

All paths below except `/health` require `X-Support-AI-Secret`, using the
dedicated `SUPPORT_AI_ADMIN_SECRET` in Fly secrets. No secrets are committed.

1. `GET /health`: service health.
2. `GET /api/internal/support-ai/readiness`: configuration only; distinguish
   `model_key_configured` and mode from proven model connectivity.
3. `POST /api/internal/support-ai/sandbox/tickets` with
   `{"text_ru":"Как добавить карту в Apple Wallet?"}` creates a synthetic ticket.
   Customer account/Telegram identifiers are not accepted.
4. `GET /api/internal/support-ai/tickets/<ticket_id>` retrieves draft results.
5. `POST /api/internal/support-ai/sandbox/tickets/<ticket_id>/messages` with
   `{"actor":"human","text_ru":"Проверим инструкцию в базе знаний."}` adds a
   simulated operator reply for QA; `actor=customer` adds another test question.

Writes are limited to tickets created by the sandbox. Ordinary relay tickets
cannot be modified through these endpoints. Authentication failures must return
403, and `/bitrix/app/handler` and Telegram webhook routes must return 404.

## Build and deploy

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm typecheck
pnpm test
fly deploy --config fly.support-ai-dev.toml --remote-only --ha=false
```

Startup applies the repository's idempotent migrations only to the configured
dev database, then checks the AI schema before serving traffic. Full local
validation: 58 tests passed, including real Postgres queue/lease/budget tests,
sandbox isolation, photo+metadata idempotency, and delivery-receipt tests.

To pause model work, set `SUPPORT_AI_MODE=off` in this dev app. To roll back a
deployment, redeploy the previous dev image. Production support/main-app
services, databases, webhooks and secrets are not part of this rollout.

Model compatibility/pricing checked against the [official model documentation](https://developers.openai.com/api/docs/models/gpt-5.4-nano).

## Live verification — 2026-09-14

Deployed code `6b40aca`, image
`registry.fly.io/turkarta-support-ai-dev:support-ai-6b40aca`
(digest `sha256:02c78505d5199fb1449e9f584d4c15b58f56c7855b8e8ebbdea1c9f2500099c4`).
Machine `7845d4da1d39e8` was created successfully.

- Public `/health`: 200, `runtime=sandbox`.
- Unauthenticated readiness: 403; authenticated readiness: 200.
- Readiness reports `mode=off`, `model_key_configured=false`, and no automatic
  customer replies or financial actions.
- Bitrix handler path: 404.
- Synthetic ticket `104e1822-fbae-4368-94e1-ea0dd3a56b29`: created through the
  authenticated dev API; its triage job is persisted as `pending` until activation.
- Knowledge adapter fetched 46 published articles; all 46 have nonempty text.

Real model classification/drafting, QA generation, and account diagnostics have
not been verified live. The next step is the model-key configuration and shadow
smoke test described above. No messages were sent to Telegram or Bitrix.
