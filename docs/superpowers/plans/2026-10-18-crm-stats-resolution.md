# CRM stats: resolution metrics and heatmap — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The stats page shows time to resolution, share solved with one reply, messages per ticket (team and per operator) and a weekday × hour heatmap of new tickets.

**Architecture:** Extend the existing `stats()` query module (`src/crm/stats.ts`) with two shared SQL fragments (operator resolves in range, and their resolution cycles) and two new queries; extend the response types; render the new numbers on the existing Stats page plus one new heatmap component. No new route, table or migration.

**Tech Stack:** Node 22 TS, postgres.js, node:test (Postgres tests against a local scratch DB); React 18 + Vite + Tailwind + vitest + Testing Library for `web/`.

**Spec:** `docs/superpowers/specs/2026-10-18-crm-quality-design.md`, section «5. Stats additions».

## Global Constraints

- Worktree: `~/projects/turkarta-operations-video`, branch `feat/crm-stats-resolution`. Never touch `~/projects/turkarta-operations` (another session's checkout).
- Commit only the files the task names, with explicit `git add <path>`; never `git add -A` / `.`; never bare `git stash`.
- No new dependencies.
- All times are Moscow time (`Europe/Moscow`) where the user sees a day or hour.
- Cutover/bulk closes (`status_changed` with `actor_operator_id is null`) never count.
- UI copy is Russian and exact as written in this plan.
- Backend tests: from repo root `pnpm build && CRM_TEST_DATABASE_URL=postgres://postgres@127.0.0.1:5433/crm_test node --experimental-test-module-mocks --import tsx --test <file>`; full suite `CRM_TEST_DATABASE_URL=postgres://postgres@127.0.0.1:5433/crm_test pnpm test`. The local Postgres on port 5433 is already running.
- Web tests: `cd web && pnpm test` and `pnpm typecheck`; build `pnpm build`.

## Definitions (used by both tasks)

- **Resolve** = a `crm_ticket_events` row `type='status_changed'`, `payload->>'to'='resolved'`, `actor_operator_id is not null`, `created_at` in `[from, to)`. Attributed to `actor_operator_id`.
- **Cycle** of a resolve = that ticket's `support_messages` with `created_at` after the ticket's previous resolve event (any actor, any time) and `<=` this resolve. A cycle counts only if it has a customer message (`sender='user'`).
- **Resolution time** = resolve `created_at` − first customer message of the cycle, seconds.
- **Replies** in a cycle = `sender='agent' and author_id like 'crm:%' and kind in ('text','photo','video')`.
- **Messages** in a cycle = `kind <> 'note'` and (`sender='user'` or (`sender='agent'` and `actor_type not in ('automation','system')`)).
- **Reopened** = a `reopened` event on the ticket after the resolve and before the ticket's next resolve (same rule the existing reopen-rate uses).
- **One-reply share** = cycles with `replies = 1` and not reopened ÷ cycles with `replies >= 1`, percent, 1 decimal.
- **Messages per ticket** = average messages over counted cycles, 1 decimal.
- **Heatmap** = tickets whose first-ever customer message falls in `[from, to)`, grouped by Moscow ISO weekday (1 = Monday … 7 = Sunday) and hour (0–23) of that message; only non-zero cells, ordered by weekday, hour.

## Review Focus

1. A cycle must not include messages from before the previous resolve: a reopened ticket's second resolution time starts at the customer's new message, not the original one (Task 1 fixture ticket F).
2. Welcome tickets created at signup long before the customer writes: resolution time starts at the first customer message (Task 1 fixture ticket B).
3. Cutover/bulk closes must not appear in any new metric (Task 1 fixture ticket C).
4. Operator notes and the automated resolve message are not «messages» (Task 1 fixture ticket A).
5. Heatmap hours are Moscow time, not UTC: a 23:00 МСК message lands in hour 23 (Task 1 fixture ticket C); empty range gives nulls and `[]`, and the page shows «нет решённых» / «За период новых обращений нет.» (Tasks 1 and 2).

---

### Task 1: Backend metrics in `stats()`

**Files:**
- Modify: `src/crm/stats.ts`
- Modify: `tests/crm_stats_postgres.test.ts` (ignore the new fields in the existing deep-equals)
- Create: `tests/crm_stats_resolution_postgres.test.ts`

**Interfaces:**
- Produces (extends `TeamStats` and `OperatorStats` in `src/crm/stats.ts`, consumed by Task 2 through `GET /api/stats`):
  ```ts
  export interface HeatCell { dow: number; hour: number; n: number }
  // TeamStats gains:
  resolution_median_s: number | null;
  one_reply_pct: number | null;
  messages_per_ticket: number | null;
  heatmap: HeatCell[];
  // OperatorStats gains:
  resolution_median_s: number | null;
  one_reply_pct: number | null;
  ```

- [ ] **Step 1: Write the failing Postgres test**

Create `tests/crm_stats_resolution_postgres.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { assertScratchDb, freshCrmDb } from "./helpers/crm_pg.js";

const url = process.env.CRM_TEST_DATABASE_URL;

// Moscow range [10-01 00:00, 10-05 00:00). 2026-10-01 is a Thursday (ISO 4), 10-03 a Saturday (ISO 6).
const FROM = new Date("2026-10-01T00:00:00+03:00");
const TO = new Date("2026-10-05T00:00:00+03:00");
const msk = (s: string) => `2026-${s}+03:00`;

const A = "00000000-0000-0000-0000-00000000000a";
const B = "00000000-0000-0000-0000-00000000000b";
const C = "00000000-0000-0000-0000-00000000000c";
const D = "00000000-0000-0000-0000-00000000000d";
const E = "00000000-0000-0000-0000-00000000000e";
const F = "00000000-0000-0000-0000-00000000000f";

const admin = {
  id: 1, name: "Anna", email: null, role: "admin", is_lead: false, auto_assign_enabled: true, on_shift: true,
  last_active_at: null, last_assigned_at: null,
  prefs: { theme: "system", sound: true, volume: 0.6, desktop: true, notify_scope: "all", send_key: "mod_enter" },
} as const;

test("stats: resolution time, one-reply share, messages per ticket, heatmap", { skip: !url }, async () => {
  assertScratchDb(url!);
  Object.assign(process.env, {
    LEADS_BOT_TOKEN: "123:test", SUPPORT_BOT_TOKEN: "456:test",
    LEADS_CHAT_ID: "-1001", SUPPORT_CHAT_ID: "-1002",
    DATABASE_URL: url!, PUBLIC_BASE_URL: "https://ops.example",
    LEADS_WEBHOOK_SECRET: "test-secret", TELEGRAM_WEBHOOK_SECRET: "test-secret", ROSTER: "[]",
  });
  const sql = await freshCrmDb(url!);
  const mod = await import("../dist/crm/stats.js");
  const { DEFAULT_SETTINGS } = await import("../dist/crm/settings.js");
  try {
    await sql`insert into crm_operators(id,name,role,is_lead) values (1,'Anna','admin',false), (2,'Boris','support',false)`;

    let tg = 100;
    const ticket = (id: string, source: string, status: string, created: string) =>
      sql`insert into support_requests (id, user_tg, source, status, created_at)
          values (${id}, ${tg++}, ${source}, ${status}, ${created})`;
    const msg = (t: string, sender: string, kind: string, actor: string, author: string | null, at: string) =>
      sql`insert into support_messages (ticket_id, sender, body, kind, actor_type, author_id, created_at)
          values (${t}, ${sender}, 'x', ${kind}, ${actor}, ${author}, ${at})`;
    const user = (t: string, at: string) => msg(t, "user", "text", "customer", null, at);
    const resolve = (t: string, op: number | null, at: string, payload: object = { from: "awaiting", to: "resolved" }) =>
      sql`insert into crm_ticket_events (ticket_id, type, actor_operator_id, payload, created_at)
          values (${t}, 'status_changed', ${op}, ${sql.json(payload as never)}, ${at})`;
    const reopened = (t: string, at: string) =>
      sql`insert into crm_ticket_events (ticket_id, type, actor_operator_id, payload, created_at)
          values (${t}, 'reopened', null, ${sql.json({} as never)}, ${at})`;

    // A (bot): customer 10:00, Anna reply 10:05, Anna note 10:10 (not a message), automated resolve text 10:20
    // (not a message), Anna resolves 10:20. Cycle 1200 s, 1 reply, 2 messages, not reopened.
    await ticket(A, "bot", "resolved", msk("10-01T10:00:00"));
    await user(A, msk("10-01T10:00:00"));
    await msg(A, "agent", "text", "human", "crm:1", msk("10-01T10:05:00"));
    await msg(A, "agent", "note", "human", "crm:1", msk("10-01T10:10:00"));
    await msg(A, "agent", "text", "automation", "crm:system", msk("10-01T10:20:00"));
    await resolve(A, 1, msk("10-01T10:20:00"));

    // F (miniapp): first cycle before the range (customer 09-30 09:00, Boris 09:05, Boris resolves 09:10).
    // Reopened 10-02 09:00 by a new customer message; Boris text 09:10 + photo 09:20, resolves 09:30.
    // Second cycle starts at 10-02 09:00: 1800 s, 2 replies, 3 messages.
    await ticket(F, "miniapp", "resolved", msk("09-30T09:00:00"));
    await user(F, msk("09-30T09:00:00"));
    await msg(F, "agent", "text", "human", "crm:2", msk("09-30T09:05:00"));
    await resolve(F, 2, msk("09-30T09:10:00"));
    await reopened(F, msk("10-02T09:00:00"));
    await user(F, msk("10-02T09:00:00"));
    await msg(F, "agent", "text", "human", "crm:2", msk("10-02T09:10:00"));
    await msg(F, "agent", "photo", "human", "crm:2", msk("10-02T09:20:00"));
    await resolve(F, 2, msk("10-02T09:30:00"));

    // B (web-onboarding): welcome ticket created at signup 08:00; customer first writes 12:00, Anna video 12:10,
    // Anna resolves 12:40 → 2400 s (not 16800), 1 reply, 2 messages; then reopened 13:00 → not one-reply.
    await ticket(B, "web-onboarding", "awaiting", msk("10-03T08:00:00"));
    await user(B, msk("10-03T12:00:00"));
    await msg(B, "agent", "video", "human", "crm:1", msk("10-03T12:10:00"));
    await resolve(B, 1, msk("10-03T12:40:00"));
    await reopened(B, msk("10-03T13:00:00"));
    await user(B, msk("10-03T13:00:00"));

    // C (bot): customer 23:00 МСК (20:00 UTC), closed by the backlog cutover (no actor): heatmap only.
    await ticket(C, "bot", "resolved", msk("10-03T23:00:00"));
    await user(C, msk("10-03T23:00:00"));
    await resolve(C, null, msk("10-04T00:00:00"), { from: "new", to: "resolved", reason: "cutover_backlog" });

    // D (bot): resolved before the range: excluded everywhere.
    await ticket(D, "bot", "resolved", msk("09-30T10:00:00"));
    await user(D, msk("09-30T10:00:00"));
    await msg(D, "agent", "text", "human", "crm:1", msk("09-30T10:05:00"));
    await resolve(D, 1, msk("09-30T11:00:00"));

    // E (web-onboarding): Anna resolves a welcome ticket nobody wrote in: no cycle.
    await ticket(E, "web-onboarding", "resolved", msk("10-04T09:00:00"));
    await resolve(E, 1, msk("10-04T10:00:00"));

    const s = await mod.stats({ from: FROM, to: TO }, admin, DEFAULT_SETTINGS);

    assert.equal(s.team.resolution_median_s, 1800); // [1200, 1800, 2400]
    assert.equal(s.team.one_reply_pct, 33.3); // A of {A, F, B}
    assert.equal(s.team.messages_per_ticket, 2.3); // (2 + 3 + 2) / 3
    assert.deepEqual(s.team.heatmap, [
      { dow: 4, hour: 10, n: 1 }, // A
      { dow: 6, hour: 12, n: 1 }, // B (first customer message, not created_at 08:00)
      { dow: 6, hour: 23, n: 1 }, // C, Moscow hour
    ]); // F's first customer message is 09-30, D's too; E has none

    const pick = (id: number) => {
      const o = s.operators.find((r) => r.operator_id === id)!;
      return { resolution_median_s: o.resolution_median_s, one_reply_pct: o.one_reply_pct };
    };
    assert.deepEqual(pick(1), { resolution_median_s: 1800, one_reply_pct: 50 }); // A 1200, B 2400; A yes, B reopened
    assert.deepEqual(pick(2), { resolution_median_s: 1800, one_reply_pct: 0 }); // F 1800, two replies

    // Empty range: no cycles, no heatmap.
    const empty = await mod.stats({ from: new Date("2026-01-01T00:00:00+03:00"), to: new Date("2026-01-02T00:00:00+03:00") },
      admin, DEFAULT_SETTINGS);
    assert.equal(empty.team.resolution_median_s, null);
    assert.equal(empty.team.one_reply_pct, null);
    assert.equal(empty.team.messages_per_ticket, null);
    assert.deepEqual(empty.team.heatmap, []);
    assert.deepEqual(empty.operators.map((o) => [o.name, o.resolution_median_s, o.one_reply_pct]),
      [["Anna", null, null], ["Boris", null, null]]);
  } finally {
    await sql.end();
    await (await import("../dist/db.js")).sql.end();
  }
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm build && CRM_TEST_DATABASE_URL=postgres://postgres@127.0.0.1:5433/crm_test node --experimental-test-module-mocks --import tsx --test tests/crm_stats_resolution_postgres.test.ts`
Expected: FAIL, `actual: undefined` vs `expected: 1800` on `resolution_median_s`.

- [ ] **Step 3: Implement in `src/crm/stats.ts`**

3a. Types. Add after the `StatsRange` interface and extend the two interfaces:

```ts
/** New tickets by Moscow ISO weekday (1 = Monday) and hour of the customer's first message. */
export interface HeatCell { dow: number; hour: number; n: number }
export interface TeamStats {
  new_per_day: Array<{ day: string; bot: number; miniapp: number; web: number }>;
  backlog: number;
  oldest_waiting_minutes: number | null;
  within_sla_pct: number | null;
  resolution_median_s: number | null;
  one_reply_pct: number | null;
  messages_per_ticket: number | null;
  heatmap: HeatCell[];
}
export interface OperatorStats {
  operator_id: number; name: string; taken: number; auto_assigned: number; resolved: number; replies: number;
  response_median_s: number | null; response_p90_s: number | null;
  first_response_median_s: number | null; first_response_p90_s: number | null;
  within_sla_pct: number | null; reopen_rate_pct: number | null;
  resolution_median_s: number | null; one_reply_pct: number | null;
}
```

3b. Shared fragments. Insert right after the `const inSla = ...` line:

```ts
  // Operator resolves in range (cutover/bulk closes have no actor), each with the ticket's previous
  // resolve and whether a reopen followed before the ticket's next resolve.
  const resolveRows = sql`
    select e.ticket_id, e.actor_operator_id as op, e.created_at as resolved_at,
           (select max(p.created_at) from public.crm_ticket_events p
             where p.ticket_id = e.ticket_id and p.type = 'status_changed' and p.payload->>'to' = 'resolved'
               and (p.created_at, p.id) < (e.created_at, e.id)) as prev_resolved_at,
           exists (select 1 from public.crm_ticket_events o
                    where o.ticket_id = e.ticket_id and o.type = 'reopened' and o.created_at > e.created_at
                      and (nx.created_at is null or o.created_at < nx.created_at)) as reopened
      from public.crm_ticket_events e
      left join lateral (
        select x.created_at from public.crm_ticket_events x
         where x.ticket_id = e.ticket_id and x.type = 'status_changed' and x.payload->>'to' = 'resolved'
           and (x.created_at, x.id) > (e.created_at, e.id)
         order by x.created_at, x.id limit 1
      ) nx on true
     where e.type = 'status_changed' and e.payload->>'to' = 'resolved'
       and e.created_at >= ${from} and e.created_at < ${to} and e.actor_operator_id is not null`;

  // One row per resolve whose cycle (after the previous resolve, up to this one) has a customer message.
  // Resolution time runs from the cycle's first customer message, never from created_at (welcome tickets).
  const cycles = sql`
    select r.op, r.reopened, m.replies, m.messages,
           extract(epoch from r.resolved_at - m.first_user_at) as resolution_s
      from (${resolveRows}) r
      cross join lateral (
        select min(created_at) filter (where sender = 'user') as first_user_at,
               count(*) filter (where sender = 'agent' and author_id like 'crm:%'
                                  and kind in ('text','photo','video'))::int as replies,
               count(*) filter (where kind <> 'note' and (sender = 'user'
                                  or (sender = 'agent' and actor_type not in ('automation','system'))))::int as messages
          from public.support_messages
         where ticket_id = r.ticket_id and created_at <= r.resolved_at
           and (r.prev_resolved_at is null or created_at > r.prev_resolved_at)
      ) m
     where m.first_user_at is not null`;
```

3c. Team queries. Insert after the `teamSla` query:

```ts
  const [teamCycles] = await sql`
    select round((percentile_cont(0.5) within group (order by resolution_s))::numeric) as res_med,
           round(100.0 * count(*) filter (where replies = 1 and not reopened)
                 / nullif(count(*) filter (where replies >= 1), 0), 1) as one_reply,
           round(avg(messages)::numeric, 1) as msgs
      from (${cycles}) c`;

  // New tickets by when the customer first wrote (Moscow weekday and hour), not by created_at.
  const heat = await sql`
    select extract(isodow from f.at at time zone 'Europe/Moscow')::int as dow,
           extract(hour from f.at at time zone 'Europe/Moscow')::int as hour,
           count(*)::int as n
      from (select min(m.created_at) as at from public.support_messages m
             where m.sender = 'user'
               and m.ticket_id in (select ticket_id from public.support_messages
                                    where sender = 'user' and created_at >= ${from} and created_at < ${to})
             group by m.ticket_id) f
     where f.at >= ${from} and f.at < ${to}
     group by 1, 2 order by 1, 2`;
```

3d. Operator rows query. In the existing `rows` query, replace the whole `resolves as ( ... )` CTE body (from `-- A resolve counts as reopened…` through the `where e.type = 'status_changed' … e.actor_operator_id is not null` line) with the shared fragment, and add a `cyc` CTE after `rep`:

```ts
    ), resolves as (
      -- A resolve counts as reopened when a reopen follows it before the ticket's next resolve.
      ${resolveRows}
    ), res as (
```

```ts
    ), cyc as (
      select op, round((percentile_cont(0.5) within group (order by resolution_s))::numeric) as res_med,
             round(100.0 * count(*) filter (where replies = 1 and not reopened)
                   / nullif(count(*) filter (where replies >= 1), 0), 1) as one_reply
        from (${cycles}) c group by 1
    )
```

and extend the final select and joins:

```ts
    select o.id, o.name, coalesce(t.n, 0) as taken, coalesce(a.n, 0) as auto_assigned,
           coalesce(rs.n, 0) as resolved, coalesce(rp.n, 0) as replies,
           rp.med, rp.p90, rp.first_med, rp.first_p90, rp.sla,
           round(100.0 * rs.reopened / nullif(rs.n, 0), 1) as reopen,
           cy.res_med, cy.one_reply
      from ops o
      left join taken t on t.op = o.id
      left join auto a on a.op = o.id
      left join res rs on rs.op = o.id
      left join rep rp on rp.author_id = 'crm:' || o.id
      left join cyc cy on cy.op = o.id
     order by o.name, o.id`;
```

3e. Return mapping. In `team:` add after `within_sla_pct`:

```ts
      resolution_median_s: num(teamCycles!.res_med),
      one_reply_pct: num(teamCycles!.one_reply),
      messages_per_ticket: num(teamCycles!.msgs),
      heatmap: heat.map((h) => ({ dow: Number(h.dow), hour: Number(h.hour), n: Number(h.n) })),
```

and in each operator row after `reopen_rate_pct`:

```ts
      resolution_median_s: num(r.res_med),
      one_reply_pct: num(r.one_reply),
```

- [ ] **Step 4: Run the new test and watch it pass**

Run: `pnpm build && CRM_TEST_DATABASE_URL=postgres://postgres@127.0.0.1:5433/crm_test node --experimental-test-module-mocks --import tsx --test tests/crm_stats_resolution_postgres.test.ts`
Expected: `# pass 1`, `# fail 0`.

- [ ] **Step 5: Keep the existing stats test about the existing fields**

In `tests/crm_stats_postgres.test.ts`, add after the `msk` helper:

```ts
// The resolution metrics have their own fixture (crm_stats_resolution_postgres.test.ts).
const NEW_TEAM = ["resolution_median_s", "one_reply_pct", "messages_per_ticket", "heatmap"];
const NEW_OP = ["resolution_median_s", "one_reply_pct"];
const omit = (o: object, keys: string[]) => Object.fromEntries(Object.entries(o).filter(([k]) => !keys.includes(k)));
```

and change exactly these assertions:
- `assert.deepEqual(zoe.team, {` → `assert.deepEqual(omit(zoe.team, NEW_TEAM), {`
- `assert.deepEqual(zoe.operators, [anna, boris, zoeRow]);` → `assert.deepEqual(zoe.operators.map((o) => omit(o, NEW_OP)), [anna, boris, zoeRow]);`
- `assert.deepEqual(lead.operators, [anna, boris, zoeRow]);` → `assert.deepEqual(lead.operators.map((o) => omit(o, NEW_OP)), [anna, boris, zoeRow]);`
- `assert.deepEqual(own.operators, [anna]);` → `assert.deepEqual(own.operators.map((o) => omit(o, NEW_OP)), [anna]);`
- `assert.deepEqual(empty.team, {` → `assert.deepEqual(omit(empty.team, NEW_TEAM), {`

(`assert.deepEqual(own.team, zoe.team)` stays as is.)

- [ ] **Step 6: Full backend suite and typecheck**

Run: `CRM_TEST_DATABASE_URL=postgres://postgres@127.0.0.1:5433/crm_test pnpm test 2>&1 | grep -E "^# (tests|pass|fail|skipped)"` and `pnpm typecheck`
Expected: `# fail 0`, typecheck exits 0.

- [ ] **Step 7: Commit**

```bash
git add src/crm/stats.ts tests/crm_stats_postgres.test.ts tests/crm_stats_resolution_postgres.test.ts
git commit -m "feat(crm stats): resolution time, one-reply share, messages per ticket, heatmap"
```

---

### Task 2: Show the new metrics on the Stats page

**Files:**
- Modify: `web/src/lib/stats.ts` (types)
- Create: `web/src/components/StatsHeatmap.tsx`
- Create: `web/src/components/StatsHeatmap.test.tsx`
- Modify: `web/src/routes/Stats.tsx`
- Create: `web/src/routes/Stats.test.tsx`

**Interfaces:**
- Consumes: the `GET /crm/api/stats` response from Task 1 (fields listed in Task 1 Interfaces).
- Produces: `StatsHeatmap({ cells }: { cells: HeatCell[] })`, `HeatCell` type in `web/src/lib/stats.ts`.

- [ ] **Step 1: Types in `web/src/lib/stats.ts`**

Add before `TeamStats` and extend both interfaces (keep the «Mirrors src/crm/stats.ts» comment true):

```ts
/** New tickets by Moscow ISO weekday (1 = Monday) and hour of the customer's first message. */
export interface HeatCell {
  dow: number;
  hour: number;
  n: number;
}
```

`TeamStats` gains:

```ts
  resolution_median_s: number | null;
  one_reply_pct: number | null;
  messages_per_ticket: number | null;
  heatmap: HeatCell[];
```

`OperatorStats` gains (after `reopen_rate_pct`):

```ts
  resolution_median_s: number | null;
  one_reply_pct: number | null;
```

- [ ] **Step 2: Failing heatmap test**

Create `web/src/components/StatsHeatmap.test.tsx`:

```tsx
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { StatsHeatmap } from "./StatsHeatmap";

describe("StatsHeatmap", () => {
  afterEach(cleanup);

  it("says so when the range has no new tickets", () => {
    render(<StatsHeatmap cells={[]} />);
    expect(screen.getByText("За период новых обращений нет.")).toBeTruthy();
  });

  it("puts each count in its weekday row and hour column, busiest cell darkest", () => {
    render(<StatsHeatmap cells={[{ dow: 4, hour: 10, n: 4 }, { dow: 7, hour: 23, n: 1 }]} />);
    const busy = screen.getByTitle("Чт, 10:00–10:59: 4");
    const quiet = screen.getByTitle("Вс, 23:00–23:59: 1");
    expect(screen.getByTitle("Пн, 0:00–0:59: 0")).toBeTruthy();
    const opacity = (cell: HTMLElement) => Number((cell.querySelector("[data-fill]") as HTMLElement).style.opacity);
    expect(opacity(busy)).toBe(1);
    expect(opacity(quiet)).toBeCloseTo(0.4);
    expect(screen.getByRole("table", { name: "Новые обращения по дням недели и часам" })).toBeTruthy();
  });
});
```

Run: `cd web && pnpm vitest run src/components/StatsHeatmap.test.tsx`
Expected: FAIL, cannot resolve `./StatsHeatmap`.

- [ ] **Step 3: Implement `web/src/components/StatsHeatmap.tsx`**

```tsx
import type { HeatCell } from "../lib/stats";

const DAYS = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];
const HOURS = Array.from({ length: 24 }, (_, h) => h);

/** 7 × 24 grid of new tickets in Moscow time; darker means more. */
export function StatsHeatmap({ cells }: { cells: HeatCell[] }) {
  if (!cells.length) return <p className="text-text-muted">За период новых обращений нет.</p>;
  const count = new Map(cells.map((c) => [`${c.dow}:${c.hour}`, c.n]));
  const max = Math.max(...cells.map((c) => c.n));
  return (
    <div className="overflow-x-auto rounded-md bg-surface p-3 shadow-[0_0_0_1px_var(--border)]">
      <table aria-label="Новые обращения по дням недели и часам" className="border-separate border-spacing-0.5 text-xs">
        <thead>
          <tr>
            <th scope="col">
              <span className="sr-only">День</span>
            </th>
            {HOURS.map((h) => (
              <th key={h} scope="col" aria-label={`${h}:00`} className="num w-6 font-normal text-text-muted">
                {h % 3 === 0 ? h : ""}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {DAYS.map((day, i) => (
            <tr key={day}>
              <th scope="row" className="pr-2 text-left font-normal text-text-muted">
                {day}
              </th>
              {HOURS.map((h) => {
                const n = count.get(`${i + 1}:${h}`) ?? 0;
                return (
                  <td key={h} title={`${day}, ${h}:00–${h}:59: ${n}`} className="h-6 w-6 rounded-xs bg-hover p-0">
                    {n > 0 && (
                      <span data-fill className="block h-full w-full rounded-xs bg-accent" style={{ opacity: 0.2 + 0.8 * (n / max) }} />
                    )}
                    <span className="sr-only">{n}</span>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
```

Run: `cd web && pnpm vitest run src/components/StatsHeatmap.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 4: Failing Stats page test**

Create `web/src/routes/Stats.test.tsx`:

```tsx
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { createQueryClient } from "../app";
import { resetApiStateForTests } from "../lib/api";
import { formatNumber } from "../lib/format";
import { formatDuration, formatPercent } from "../lib/stats";
import { jsonResponse } from "../test/fakes";
import { Stats } from "./Stats";

const prefs = { theme: "system", sound: true, volume: 0.6, desktop: true, notify_scope: "all", send_key: "mod_enter" };
const admin = {
  id: 1, name: "Аня", email: null, role: "admin", is_lead: false, auto_assign_enabled: true,
  on_shift: true, last_active_at: null, last_assigned_at: null, prefs,
};
const op = {
  operator_id: 1, name: "Аня", taken: 1, auto_assigned: 0, resolved: 2, replies: 2,
  response_median_s: 60, response_p90_s: 60, first_response_median_s: 60, first_response_p90_s: 60,
  within_sla_pct: 100, reopen_rate_pct: 0, resolution_median_s: 1800, one_reply_pct: 50,
};
const team = {
  new_per_day: [{ day: "2026-10-01", bot: 1, miniapp: 0, web: 0 }],
  backlog: 0, oldest_waiting_minutes: null, within_sla_pct: 100,
  resolution_median_s: 1800, one_reply_pct: 33.3, messages_per_ticket: 2.3,
  heatmap: [{ dow: 4, hour: 10, n: 1 }],
};

function renderStats(stats: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const key = `${init.method ?? "GET"} ${url}`;
      if (key === "GET /crm/api/me") return jsonResponse(200, admin);
      if (key.startsWith("GET /crm/api/stats?")) return jsonResponse(200, stats);
      throw new Error(`unexpected ${key}`);
    }),
  );
  render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter initialEntries={["/stats"]}>
        <Stats />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("Stats page", () => {
  beforeEach(() => resetApiStateForTests());
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("shows resolution tiles, the heatmap and the two new operator columns", async () => {
    renderStats({ team, operators: [op] });
    expect(await screen.findByText("Время решения")).toBeTruthy();
    // Expected strings come from the app formatters (they may use non-breaking spaces).
    expect(screen.getAllByText(formatDuration(1800)).length).toBe(2); // team tile + Аня's «Решение»
    expect(screen.getByText(formatPercent(33.3))).toBeTruthy();
    expect(screen.getByText(formatNumber(2.3))).toBeTruthy();
    expect(screen.getByRole("table", { name: "Новые обращения по дням недели и часам" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Решение" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Одним ответом" })).toBeTruthy();
    expect(screen.getByText(formatPercent(50))).toBeTruthy();
  });

  it("says «нет решённых» when nothing was resolved", async () => {
    renderStats({
      team: { ...team, resolution_median_s: null, one_reply_pct: null, messages_per_ticket: null, heatmap: [] },
      operators: [{ ...op, resolution_median_s: null, one_reply_pct: null }],
    });
    expect(await screen.findByText("Время решения")).toBeTruthy();
    expect(screen.getAllByText("нет решённых")).toHaveLength(5); // 3 tiles + 2 operator cells
    expect(screen.getByText("За период новых обращений нет.")).toBeTruthy();
  });
});
```

If `StatsChart` needs a browser API jsdom lacks (for example `ResizeObserver`), stub it in this test file with `vi.stubGlobal` inside `renderStats`, the way existing tests in `web/src` stub globals; do not change `StatsChart`.

Run: `cd web && pnpm vitest run src/routes/Stats.test.tsx`
Expected: FAIL, «Время решения» not found.

- [ ] **Step 5: Implement in `web/src/routes/Stats.tsx`**

5a. Imports: add `import { StatsHeatmap } from "../components/StatsHeatmap";` and `import { formatNumber } from "../lib/format";`.

5b. In the page body, replace

```tsx
            <TeamTiles data={stats.data} />
            <Block title="Новые обращения по дням">
              <StatsChart days={stats.data.team.new_per_day} />
            </Block>
```

with

```tsx
            <div className="flex flex-col gap-3">
              <TeamTiles data={stats.data} />
              <ResolutionTiles data={stats.data} />
            </div>
            <Block title="Новые обращения по дням">
              <StatsChart days={stats.data.team.new_per_day} />
            </Block>
            <Block title="Когда пишут клиенты" aside={<span className="text-sm text-text-muted">Новые обращения по дням недели и часам, МСК.</span>}>
              <StatsHeatmap cells={stats.data.team.heatmap} />
            </Block>
```

5c. Add after `TeamTiles`:

```tsx
function ResolutionTiles({ data }: { data: StatsResponse }) {
  const t = data.team;
  const none = "нет решённых";
  const tiles: Array<{ label: string; value: string; note: string; muted: boolean }> = [
    {
      label: "Время решения",
      note: "медиана",
      value: t.resolution_median_s === null ? none : formatDuration(t.resolution_median_s),
      muted: t.resolution_median_s === null,
    },
    {
      label: "Решено одним ответом",
      note: "без переоткрытия",
      value: t.one_reply_pct === null ? none : formatPercent(t.one_reply_pct),
      muted: t.one_reply_pct === null,
    },
    {
      label: "Сообщений на обращение",
      note: "в среднем",
      value: t.messages_per_ticket === null ? none : formatNumber(t.messages_per_ticket),
      muted: t.messages_per_ticket === null,
    },
  ];
  return (
    <dl className="grid grid-cols-1 overflow-hidden rounded-md bg-surface shadow-[0_0_0_1px_var(--border)] md:grid-cols-3">
      {tiles.map((tile, i) => (
        <div key={tile.label} className={cx("flex flex-col gap-1 border-border px-4 py-3", i > 0 && "max-md:border-t md:border-l")}>
          <dt className="text-sm text-text-muted">
            {tile.label} <span className="text-xs">· {tile.note}</span>
          </dt>
          <dd className={cx("text-xl font-semibold", tile.muted && "text-text-muted")}>{tile.value}</dd>
        </div>
      ))}
    </dl>
  );
}
```

5d. Append to `COLUMNS` (after the `reopen_rate_pct` entry):

```ts
  { key: "resolution_median_s", label: "Решение", title: "Медиана: от сообщения клиента до решения", kind: "duration" },
  { key: "one_reply_pct", label: "Одним ответом", title: "Доля решённых одним ответом без переоткрытия", kind: "percent" },
```

and widen the table: `min-w-[56rem]` → `min-w-[64rem]`.

5e. Operator cells for the new columns show «нет решённых» instead of «нет» when null: change `cell()` to take the column key and return `<span className="text-text-muted">нет решённых</span>` for `resolution_median_s` and `one_reply_pct`, «нет» otherwise:

```tsx
const NO_RESOLVES: ReadonlySet<SortKey> = new Set(["resolution_median_s", "one_reply_pct"]);

function cell(col: Column, v: string | number | null): ReactNode {
  if (v === null) return <span className="text-text-muted">{NO_RESOLVES.has(col.key) ? "нет решённых" : "нет"}</span>;
  if (col.kind === "duration") return formatDuration(v as number);
  if (col.kind === "percent") return formatPercent(v as number);
  return v;
}
```

and its call site `{cell(c.kind, r[c.key])}` → `{cell(c, r[c.key])}`.

- [ ] **Step 6: Run web tests, typecheck and build**

Run: `cd web && pnpm test && pnpm typecheck && pnpm build`
Expected: all vitest files pass (existing `src/lib/stats.test.ts` still passes), typecheck 0, build ok.

- [ ] **Step 7: Commit**

```bash
git add web/src/lib/stats.ts web/src/components/StatsHeatmap.tsx web/src/components/StatsHeatmap.test.tsx web/src/routes/Stats.tsx web/src/routes/Stats.test.tsx
git commit -m "feat(crm web): resolution tiles, operator columns and new-ticket heatmap on Stats"
```
