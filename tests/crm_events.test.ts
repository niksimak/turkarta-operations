import assert from "node:assert/strict";
import test from "node:test";
import { assertScratchDb } from "./helpers/crm_pg.js";

Object.assign(process.env, {
  LEADS_BOT_TOKEN: "123:test", SUPPORT_BOT_TOKEN: "456:test",
  LEADS_CHAT_ID: "-1001", SUPPORT_CHAT_ID: "-1002",
  DATABASE_URL: process.env.CRM_TEST_DATABASE_URL ?? "postgres://test:test@127.0.0.1:1/not-used",
  PUBLIC_BASE_URL: "https://ops.example",
  LEADS_WEBHOOK_SECRET: "test-secret", TELEGRAM_WEBHOOK_SECRET: "test-secret", ROSTER: "[]",
});

const mod = await import("../dist/crm/events.js");
type Ev = import("../dist/crm/events.js").CrmEvent;

test("subscribe receives dispatch fan-out; unsubscribe stops delivery", () => {
  const got: Ev[] = [];
  const off = mod.subscribe((e: Ev) => got.push(e));
  mod.dispatch({ type: "ticket.created", ticketId: "t1" });
  off();
  mod.dispatch({ type: "ticket.updated", ticketId: "t1" });
  assert.deepEqual(got, [{ type: "ticket.created", ticketId: "t1" }]);
});

test("a throwing subscriber does not block the others", () => {
  const got: Ev[] = [];
  const a = mod.subscribe(() => { throw new Error("boom"); });
  const b = mod.subscribe((e: Ev) => got.push(e));
  mod.dispatch({ type: "operator.updated", operatorId: 1 });
  a(); b();
  assert.equal(got.length, 1);
});

test("presence: TTL 10 s, same operator replaces state, set fans out locally", () => {
  const got: Ev[] = [];
  const off = mod.subscribe((e: Ev) => got.push(e));
  const anna = { id: 1, name: "Anna" };
  mod.presence.set("p1", anna, "viewing", 1000);
  mod.presence.set("p1", { id: 2, name: "Boris" }, "viewing", 5000);
  mod.presence.set("p1", anna, "typing", 6000);
  off();
  assert.deepEqual(mod.presence.list("p1", 6000), [
    { operatorId: 2, name: "Boris", state: "viewing" },
    { operatorId: 1, name: "Anna", state: "typing" },
  ].sort((x, y) => x.operatorId - y.operatorId));
  assert.deepEqual(mod.presence.list("p1", 15500).map((v: { operatorId: number }) => v.operatorId), [1]);
  assert.deepEqual(mod.presence.list("p1", 16001), []);
  assert.equal(got.length, 3);
  assert.equal(got[2]!.type, "presence");
  assert.deepEqual((got[2] as Extract<Ev, { type: "presence" }>).viewers.map((v) => v.state).sort(), ["typing", "viewing"]);
});

test("publish never throws when NOTIFY fails", async () => {
  // DATABASE_URL points at a dead port in unit runs; with a live scratch DB this still must not throw.
  await assert.doesNotReject(mod.publish({ type: "ticket.created", ticketId: "x" }));
});

const url = process.env.CRM_TEST_DATABASE_URL;

test("PG round trip: publish -> LISTEN -> subscriber, body truncated to 140", { skip: !url }, async () => {
  assertScratchDb(url!);
  const stop = await mod.startEventHub();
  const got: Ev[] = [];
  const off = mod.subscribe((e: Ev) => got.push(e));
  try {
    await mod.publish({ type: "message.created", ticketId: "t9", messageId: "m1" });
    await mod.publish({ type: "notify", operatorId: null, kind: "new_ticket", ticketId: "t9", title: "T", body: "x".repeat(500) });
    for (let i = 0; i < 50 && got.length < 2; i++) await new Promise((r) => setTimeout(r, 50));
    assert.equal(got.length, 2);
    assert.deepEqual(got[0], { type: "message.created", ticketId: "t9", messageId: "m1" });
    assert.equal((got[1] as Extract<Ev, { type: "notify" }>).body.length, 140);
  } finally {
    off();
    await stop();
    await (await import("../dist/db.js")).sql.end({ timeout: 2 });
  }
});
