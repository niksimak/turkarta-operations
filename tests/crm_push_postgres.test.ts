import assert from "node:assert/strict";
import test from "node:test";
import { assertScratchDb, freshCrmDb } from "./helpers/crm_pg.js";

const url = process.env.CRM_TEST_DATABASE_URL;

test("crm push: subscriptions, targets, delivery and pruning", { skip: !url }, async (t) => {
  assertScratchDb(url!);
  Object.assign(process.env, {
    LEADS_BOT_TOKEN: "123:test", SUPPORT_BOT_TOKEN: "456:test",
    LEADS_CHAT_ID: "-1001", SUPPORT_CHAT_ID: "-1002",
    DATABASE_URL: url!, PUBLIC_BASE_URL: "https://ops.example",
    LEADS_WEBHOOK_SECRET: "test-secret", TELEGRAM_WEBHOOK_SECRET: "test-secret", ROSTER: "[]",
    CRM_VAPID_PUBLIC_KEY: "BPub", CRM_VAPID_PRIVATE_KEY: "priv",
  });
  const push = await import("../dist/crm/push.js");
  const events = await import("../dist/crm/events.js");
  const db = await import("../dist/db.js");
  const sql = await freshCrmDb(url!);

  type Sent = { endpoint: string; payload: Record<string, unknown> };
  const sent: Sent[] = [];
  const failFor = new Map<string, number>();
  const send = async (sub: { endpoint: string }, payload: string) => {
    sent.push({ endpoint: sub.endpoint, payload: JSON.parse(payload) });
    const code = failFor.get(sub.endpoint);
    if (code) throw Object.assign(new Error("push failed"), { statusCode: code });
  };
  const keys = { p256dh: "k1", auth: "a1" };
  const notify = (operatorId: number | null, kind = "assigned") => ({
    type: "notify" as const, operatorId, kind: kind as "assigned", ticketId: "t-1", title: "Вам назначено обращение", body: "Иван",
  });
  const rows = () => sql`select operator_id::int as op, endpoint, failures, last_ok_at from crm_push_subscriptions order by endpoint`;

  try {
    await sql`insert into crm_operators (id, name, role, prefs) values
      (1, 'Anna', 'support', '{}'), (2, 'Oleg', 'support', '{"notify_scope":"mine"}'), (3, 'Lena', 'admin', '{"notify_scope":"all"}')`;

    await t.test("the public key is exposed only when VAPID is configured", () => {
      assert.equal(push.pushPublicKey(), "BPub");
    });

    await t.test("subscribe upserts by endpoint and re-binds the operator; unsubscribe removes only your own", async () => {
      await push.saveSubscription(1, { endpoint: "https://push.example/a", keys }, "UA");
      await push.saveSubscription(2, { endpoint: "https://push.example/a", keys: { p256dh: "k2", auth: "a2" } }, "UA");
      await push.saveSubscription(2, { endpoint: "https://push.example/b", keys }, null);
      await push.saveSubscription(3, { endpoint: "https://push.example/c", keys }, null);
      assert.deepEqual((await rows()).map((r) => [r.op, r.endpoint]), [
        [2, "https://push.example/a"], [2, "https://push.example/b"], [3, "https://push.example/c"],
      ]);
      assert.equal(await push.deleteSubscription(1, "https://push.example/b"), false, "not yours");
      assert.equal(await push.deleteSubscription(2, "https://push.example/b"), true);
      await push.saveSubscription(1, { endpoint: "https://push.example/a", keys }, "UA");
      assert.deepEqual((await rows()).map((r) => [r.op, r.endpoint]), [[1, "https://push.example/a"], [3, "https://push.example/c"]]);
    });

    await t.test("targets: a personal event goes to that operator; a broadcast to scope «Все» only", async () => {
      await push.saveSubscription(2, { endpoint: "https://push.example/o2", keys }, null);
      const personal = await push.pushTargets(notify(2));
      assert.deepEqual(personal.map((s) => s.endpoint), ["https://push.example/o2"]);
      const broadcast = await push.pushTargets(notify(null, "new_ticket"));
      assert.deepEqual(broadcast.map((s) => s.endpoint).sort(), ["https://push.example/a", "https://push.example/c"],
        "Anna (default scope) and Lena; Oleg chose «Мои»");
    });

    await t.test("delivery: the payload links the ticket; 410 prunes, other errors count, success resets", async () => {
      sent.length = 0;
      failFor.set("https://push.example/c", 410);
      failFor.set("https://push.example/a", 500);
      const r = await push.deliverPush(notify(null, "new_ticket"), send);
      assert.deepEqual(r, { sent: 0, pruned: 1, failed: 1 });
      assert.deepEqual(sent.find((s) => s.endpoint === "https://push.example/a")!.payload, {
        title: "Вам назначено обращение", body: "Иван", url: "https://ops.example/crm/t/t-1", tag: "crm-new_ticket-t-1", kind: "new_ticket",
      });
      const after = await rows();
      assert.equal(after.find((x) => x.endpoint === "https://push.example/c"), undefined, "a gone endpoint is deleted");
      assert.equal(after.find((x) => x.endpoint === "https://push.example/a")!.failures, 1);

      failFor.clear();
      assert.deepEqual(await push.deliverPush(notify(null, "new_ticket"), send), { sent: 1, pruned: 0, failed: 0 });
      const ok = (await rows()).find((x) => x.endpoint === "https://push.example/a")!;
      assert.equal(ok.failures, 0);
      assert.ok(ok.last_ok_at instanceof Date);
    });

    await t.test("fan-out sends on notify events and ignores the rest", async () => {
      sent.length = 0;
      const stop = push.startPushFanout(send);
      events.dispatch({ type: "ticket.updated", ticketId: "t-1" });
      events.dispatch(notify(1));
      await new Promise((r) => setTimeout(r, 100));
      stop();
      events.dispatch(notify(1));
      await new Promise((r) => setTimeout(r, 100));
      assert.deepEqual(sent.map((s) => s.endpoint), ["https://push.example/a"]);
    });
  } finally {
    await db.sql.end();
    await sql.end();
  }
});
