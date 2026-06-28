# Wiring the Lovable landing → leads bot

The landing runs on **Lovable Cloud**, so its database isn't reachable from outside.
Instead, the landing sends each submission to this service's `/webhooks/leads` endpoint.

## The contract

`POST https://turkarta-operations.onrender.com/webhooks/leads`

Headers:
```
Content-Type: application/json
X-Webhook-Secret: <SUPABASE_WEBHOOK_SECRET from .env>
```

Body:
```json
{
  "name":        "Jane Doe",
  "company":     "Acme LLC",
  "phone":       "+1 555 123 4567",
  "email":       "jane@example.com",
  "tg_username": "jane_doe",
  "message":     "I'm interested in ...",
  "source":      "lovable-landing"
}
```
All fields optional; `source` defaults to `"lovable-landing"`. Returns `{ "ok": true }`.
Empty fields are simply omitted from the Telegram card.

**Telegram handle:** send it as `tg_username`. Aliases `telegram`, `tg`, and
`username` are also accepted. A leading `@` is optional (added automatically).

**Freeform fallback:** a generic `contact` field (email/phone/handle in one string)
is still accepted for forms that don't split contact info into separate fields.

## Recommended: Lovable Cloud edge function (keeps the secret server-side)

Paste this into Lovable's AI chat:

> Add a backend edge function `notify-lead` that runs whenever a new row is inserted
> into the leads table (or is called from the contact form's submit handler). It should
> send a POST request to `https://turkarta-operations.onrender.com/webhooks/leads` with header
> `X-Webhook-Secret: <SECRET>` and a JSON body
> `{ name, company, phone, email, tg_username, message, source: "lovable-landing" }`
> built from the submitted form fields. Store the secret as a backend env var, never in
> client code. Keep saving the submission to the database as before.

## Fallback: client-side fetch on submit

If edge functions aren't available, add to the form's `onSubmit` (after the DB insert):

```ts
await fetch("https://turkarta-operations.onrender.com/webhooks/leads", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "X-Webhook-Secret": import.meta.env.VITE_LEAD_WEBHOOK_SECRET,
  },
  body: JSON.stringify({
    name: form.name,
    contact: form.email ?? form.phone,
    message: form.message,
    source: "lovable-landing",
  }),
});
```

⚠️ A client-side secret is visible in the browser. Prefer the edge function. If you must
go client-side, treat `X-Webhook-Secret` as a low-value throttle token and rotate it if abused.

## Mini App support entry

In the Turkarta Mini App settings, the "Связаться с поддержкой" button should open:
```
https://t.me/turkarta_support?start=miniapp
```
That deep-links into the support bot; the user's first message opens a ticket exactly like
the in-bot button. (The `miniapp` payload is available to tag the source if we want.)
