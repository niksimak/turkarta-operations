import assert from "node:assert/strict";
import test from "node:test";
import type { Context } from "grammy";
import { sequencePrivateMessages } from "../src/telegram_sequence.js";

test("same-chat updates wait, while another customer continues", async () => {
  const middleware = sequencePrivateMessages();
  const ctx = (id: number) => ({ chat: { id, type: "private" }, message: {} }) as Context;
  const events: string[] = [];
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const first = middleware(ctx(1), async () => { events.push("first"); await blocked; });
  const second = middleware(ctx(1), async () => { events.push("second"); });
  await middleware(ctx(2), async () => { events.push("other"); });
  assert.deepEqual(events, ["first", "other"]);
  release();
  await Promise.all([first, second]);
  assert.deepEqual(events, ["first", "other", "second"]);
});
