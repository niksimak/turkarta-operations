import assert from "node:assert/strict";
import test from "node:test";

Object.assign(process.env, {
  LEADS_BOT_TOKEN: "123:test", SUPPORT_BOT_TOKEN: "456:test",
  LEADS_CHAT_ID: "-1001", SUPPORT_CHAT_ID: "-1002",
  DATABASE_URL: "postgres://test:test@127.0.0.1:1/not-used",
  PUBLIC_BASE_URL: "https://ops.example",
  LEADS_WEBHOOK_SECRET: "test-secret", TELEGRAM_WEBHOOK_SECRET: "test-secret", ROSTER: "[]",
});
const { shortAnswer } = await import("../dist/crm/csat.js");

test("shortAnswer: an exact short answer is the rating, anything else is not", () => {
  const cases: Array<[string, "up" | "down" | null]> = [
    ["да", "up"], ["Да!", "up"], ["ДА.", "up"], ["ага", "up"], ["угу", "up"], ["yes", "up"], ["Yes!!", "up"], ["👍", "up"],
    ["нет", "down"], [" нет ", "down"], ["Нет.", "down"], ["no", "down"], ["👎", "down"], ["нет !", "down"],
    ["нет, не пришло", null], ["нет, деньги не пришли", null], ["спасибо", null], ["да, спасибо", null],
    ["", null], ["   ", null], ["!", null], ["не", null], ["noo", null], ["да?", null],
  ];
  for (const [text, want] of cases) assert.equal(shortAnswer(text), want, JSON.stringify(text));
});
