# Support replies and Telegram albums — 2026-09-12

## Investigation: separate confirmed facts from hypotheses

- The owner subsequently confirmed that Bitrix is working again. No connector
  mutation or reinstall was performed by this investigation. The precise
  recovery action was not supplied, so do not infer which portal flag changed.
- Production support relay is still on `826dca0`, deployed 2026-08-21.
  The later main-product/Fly deployments did not deploy this service.
- The queried September 5–11 log window contains 62 failed Bitrix relay calls:
  `ACCESS_DENIED REST is available only on commercial plans.` This is a
  confirmed portal entitlement refusal, not a manager device diagnosis.
- Incoming delivery succeeded on September 12, including the reported support
  message at 09:34 UTC. This proves that message entered Bitrix, not that the
  reply channel was operational or all previously rejected messages recovered.
- The supplied screenshot reports an inactive Open Line and an unconfigured
  communication channel. An earlier incident had the same UI symptom when the
  custom connector was inactive. That history alone does not establish which
  setting changed this time or who changed it.
- Direct read-only status queries using the stored access token returned
  `expired_token`. Expiry during idle time is normal: the existing relay
  refreshes on demand. No token rotation, connector activation, billing change,
  message replay or production deployment was performed for this investigation.
- Bootstrap currently binds reply/deletion events only; it neither activates
  the connector nor monitors plan entitlement. It must not silently undo an
  administrator's intentional deactivation.

## Administrator checks

1. In Bitrix desktop, open **Мой тариф**, click the current plan and check its
   expiration date. Also check **BitrixGPT + Маркетплейс** entitlement: the RU
   portal's REST integration requires the appropriate subscription/access.
   Do not buy or change a plan merely from an old error; check its current state.
2. Open **CRM → Клиенты → Контакт-центр**, select the existing Turkarta custom
   support channel, then **Открытая линия 3 → Настроить → Прочее**.
3. Enable **Линия активна**, then **Сохранить**. Keep the existing line identity
   (configured API ID `5`) and connector ID `turkarta_support`.
4. Line activation and custom-connector activation are separate. If the line is
   already active, capture the channel settings for review. The current local
   app handler only displays installation status; it does not implement a
   connector activation button. An application-context repair may be needed.
5. Do not reconnect the bot through Bitrix's built-in Telegram tile: it is a
   different integration and can replace the existing Telegram webhook. Do not
   reinstall the app, create a new line or change connector IDs as a shortcut.
6. After restoring entitlement and channel configuration, verify connector
   status for the exact line and event-handler binding, then use a controlled
   test conversation to check inbound text/photo and an operator reply. Do not
   automatically replay old replies into customer chats.

Official references:

- https://apidocs.bitrix24.ru/first-steps/access-to-rest-api.html
- https://helpdesk.bitrix24.ru/open/24515854/
- https://helpdesk.bitrix24.ru/open/25004908/
- https://apidocs.bitrix24.ru/api-reference/imopenlines/imconnector/imconnector-status.html

## Confirmed photo defects and scoped fix

Telegram sends each album item as a separate message/update. The old intake
handler treated any next message as email or skip. A second photo therefore
finished intake with no email and returned without relaying that photo.
Concurrent first-contact updates could also all see no ticket, enter the
creation branch, and discard all but the database's winning first photo.

- Only text answers the email prompt; photos/captions do not consume it.
- Media arriving during intake uses the existing per-message attachment relay.
- Private-chat updates are sequenced per chat; different customers proceed
  independently. This is process-local sequencing for the existing single
  support-service process, not a distributed queue or delivery outbox.
- Finishing intake is conditional on still being in the email step.
- Existing pending tickets still relay their persisted first photo on email/skip.
- Photos remain separate Bitrix messages, not a new grouped gallery. The first
  photo retains the existing deferred-intake behavior, so it may arrive after
  later photos when email is submitted. No schema or provider API changes.

## Verification and limits

`pnpm typecheck` and `pnpm test`: 10 tests, no network/database dependencies.
Tests exercise the compiled production bot with mocked database and transport
boundaries, including two photos, ten simultaneous photos, captions, text-first
intake, email/skip, completed intake, legacy pending tickets and queue release.
Removing the email guard and sequencing from the generated test artifact makes
three regression tests fail; rebuilding restores the shipping implementation.
CI runs the same checks on Node 22.

This fixes confirmed Telegram intake loss, not every possible attachment failure.
Bitrix availability/entitlement, best-effort background sends, restarts, webhook
redelivery deduplication and historical recovery remain separate concerns.
No claim of a live end-to-end delivery test is made. Production rollout and a
controlled operator/customer test still need to happen after review.
