# Support ticket system

Two ways a user opens a ticket; one shared operator workflow in the support channel.

## Entry points

### 1. Telegram support bot (`@turkarta_support_bot`)
Guided intake (state persisted in DB, survives restarts):
1. User sends their request as one message.
2. Bot asks for an email → user sends it, or `/skip`.
3. Ticket card is posted to the support channel.

Device is **not** asked over the bot (we capture it from the app when available).

### 2. In-app (Mini App) → webhook
The app already knows the user's tg/email and can read the device from the client,
so it posts a fully-structured ticket — no Q&A.

```
POST https://turkarta-operations.onrender.com/webhooks/support
Headers:
  Content-Type: application/json
  X-Webhook-Secret: <APP_WEBHOOK_SECRET, falls back to SUPABASE_WEBHOOK_SECRET>
Body:
{
  "tg":      123456789,                       // REQUIRED — end-user telegram id
  "username": "ivan",                          // optional
  "name":     "Ivan Petrov",                   // optional
  "email":    "ivan@example.com",              // optional
  "device":   "iPhone 14, iOS 17.2, Safari",   // optional (from UA/cookies)
  "request":  "SMS code never arrives"         // REQUIRED (alias: "message")
}
→ { "ok": true, "ticketId": "<uuid>" }
```

⚠️ **The user must have started the bot for the operator's replies to reach them.**
Telegram forbids bots from messaging users who never opened them. Route app users
through the bot once via a deep link (`t.me/turkarta_support_bot?start=app`) so a
relay channel exists. If a reply can't be delivered, the bot flags it in the ops thread
instead of failing silently.

One open ticket per user is enforced; a re-submit returns the existing ticket.

## Operator workflow (support channel)

1. **Take** — first tap wins (race-safe), opens a forum topic for the relay, and
   pings the user that an operator joined.
2. **Classify** — `🔧 Tech` / `🐞 Bug` / `💡 Feature` (operator decides; the chosen
   one is marked ✓ and shown on the card).
3. **Talk** — type in the ticket's topic; text **and media** relay both ways.
4. **Status:**
   - `⏳ Awaiting` — parked but still open (waiting on a fix / dev team). Relay stays live.
   - `✅ Resolve` — closes the ticket, notifies the user, closes the topic.

Status lifecycle: `new → allocated (in progress) → awaiting ⇄ → resolved`.
Only the assigned agent can park or resolve a ticket.
