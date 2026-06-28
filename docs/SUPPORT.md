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

### 3. Web app (standalone PWA) → in-app chat
Web users have **no Telegram**, so operator replies can't be DM'd. Instead the
ticket is `channel = 'web'` and the conversation lives in a durable message log the
app **polls**. The operator still works entirely in the Telegram channel.

These are **server-to-server** endpoints: the web app's FastAPI backend authenticates
the user and proxies here with `X-Webhook-Secret`, passing the app's `user.id` as
`web_user_id`. The browser never calls ops directly.

```
POST /api/support/web/open      { web_user_id, request, name?, email?, device? }
                                → { ok, ticketId, status }
POST /api/support/web/message   { web_user_id, body }      → { ok }   (404 if no open ticket)
GET  /api/support/web/messages?web_user_id=<id>&since=<seq>
   → { ticketId, status, category,
       messages: [ { id, seq, sender: 'user'|'agent'|'system', body, at } ],
       cursor }            # pass `cursor` back as `since` on the next poll
```

Polling: call the GET every ~3–5s with the last `cursor`; `since` is an exclusive
integer cursor (no dupes). `sender:'system'` = status notices (operator joined, resolved).
Media from operators isn't rendered in web (Telegram-only); it shows as a placeholder.

**FastAPI proxy sketch** (web app side — `apps/api`):
```python
# routes/web_support.py — all behind the user's web-auth dependency
OPS = "https://turkarta-operations.onrender.com"
HDR = {"X-Webhook-Secret": settings.OPS_WEBHOOK_SECRET}

@router.post("/api/web/support/open")
async def open_ticket(body: OpenIn, user = Depends(current_web_user)):
    return await httpx_post(f"{OPS}/api/support/web/open",
        json={"web_user_id": str(user.id), "request": body.request,
              "name": user.display_name, "email": user.email, "device": body.device})

@router.get("/api/web/support/messages")
async def poll(since: int = 0, user = Depends(current_web_user)):
    return await httpx_get(f"{OPS}/api/support/web/messages",
        params={"web_user_id": str(user.id), "since": since})
```

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
