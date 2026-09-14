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
