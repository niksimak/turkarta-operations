# CRM topics (contact reasons) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every CRM-resolved ticket gets a topic from an editable list. AI suggests it after the resolve, the operator can change it in the ticket header, and the stats page shows «Причины обращений».

**Architecture:** New feature module `src/crm/topics.ts`: topic list CRUD, ticket topic set by an operator or by the AI, and the job enqueue. Migration `0019_crm_topics.sql`. The existing AI pipeline (`support_agent_jobs` → `src/agents/worker.ts` → `SupportEngine`) gains a third job kind, `topic`, queued from `setStatus` (not from the DB trigger), so bulk closes never queue one. Stats get a `topics` block built on the cycle fragments from PR 1. Web: a topic menu in the ticket header, a «Темы обращений» settings section in its own component file, and a stats block.

**Tech Stack:** Node 22 TS, Hono, zod, postgres.js, node:test with a local Postgres; React 18, TanStack Query, Tailwind, vitest.

**Spec:** `docs/superpowers/specs/2026-10-18-crm-quality-design.md`, section «1. Topics (contact reasons)».

## Global Constraints

- Worktree `~/projects/turkarta-operations-video`, branch `feat/crm-topics` (created off `main` after PR 1 merged). Never touch `~/projects/turkarta-operations`.
- Commit only the files the task names, with explicit `git add <path>`; never `-A` or `.`; never bare `git stash`.
- No new dependencies.
- The migration must be idempotent: it runs on every boot inside one transaction (`ensureCrmSchema`, `src/db.ts`), and its name is appended to `CRM_MIGRATIONS`.
- Seed topics, in order: «Пополнение не пришло», «Карта отклонена», «Выпуск карты», «KYC/верификация», «Antarctic», «Вывод/возврат», «Тарифы и цены», «Как пользоваться», «Жалоба», «Другое».
- An operator's choice is never overwritten by AI. `topic_source` is `'ai'` or `'operator'`.
- Leads and admins (`canEditTeamSettings`) edit the topic list; every operator can set a ticket's topic. Bitrix surface (`crmWritable`) stays read-only.
- Archived topics stay on old tickets and in reports, but are never offered for new choices and never accepted by the API or AI.
- AI topic jobs are queued only by a CRM resolve (`setStatus`), only when the ticket's topic is not operator-set.
- Backend tests: `pnpm build && CRM_TEST_DATABASE_URL=postgres://postgres@127.0.0.1:5433/crm_test node --experimental-test-module-mocks --import tsx --test tests/<file>`. Full suite: `CRM_TEST_DATABASE_URL=postgres://postgres@127.0.0.1:5433/crm_test pnpm test`. Plus `pnpm typecheck`.
- Web: `cd web && pnpm test && pnpm typecheck && pnpm build`.
- UI copy is Russian and exactly as written here.

## Review Focus

1. Archived or unknown topic id sent to `POST /api/tickets/:id/topic` or returned by the model: rejected (422 / job fails `unknown_topic_reference`), ticket unchanged (Task 1, Task 2 tests).
2. AI result arriving after an operator already chose: ignored, no event (Task 1 test `applyAiTopic`).
3. Bulk/cutover close and a resolve of a ticket whose topic the operator set: no topic job queued (Task 2 test).
4. Duplicate topic name on create or rename: 422 `{fields: {name: "duplicate"}}`, not 500 (Task 1 test).
5. Stats for tickets with no topic: a «Без темы» row, never dropped; previous-range counts compare equal-length ranges (Task 3 test).

---

### Task 1: Topics module, migration, API, ticket detail fields

**Files:**
- Create: `migrations/0019_crm_topics.sql`
- Modify: `src/db.ts` (append to `CRM_MIGRATIONS`)
- Create: `src/crm/topics.ts`
- Modify: `src/crm/tickets.ts` (export `logEvent`; detail select and type gain topic fields)
- Modify: `src/crm/types.ts` (`TicketEventType` gains `"topic_changed"`)
- Modify: `src/crm/routes.ts` (4 routes)
- Create: `tests/crm_topics_postgres.test.ts`
- Modify (only if it breaks): `tests/crm_routes.test.ts` (it module-mocks the route dependencies; add a `topics.js` mock in the same style if the new import makes it fail)

**Interfaces:**
- Produces:
  ```ts
  // src/crm/topics.ts
  export interface Topic { id: number; name: string; position: number; archived: boolean }
  export async function listTopics(): Promise<Topic[]>
  export async function createTopic(input: unknown, me: Operator): Promise<Topic>
  export async function updateTopic(id: number, patch: unknown, me: Operator): Promise<Topic>
  export async function setTicketTopic(ticketId: string, topicId: number | null, me: Operator): Promise<void>
  export async function applyAiTopic(ticketId: string, topicId: number): Promise<boolean>
  export async function enqueueTopicJob(tx: postgres.TransactionSql | postgres.Sql, ticketId: string): Promise<void>
  // TicketDetailItem gains:
  topic_id: number | null; topic_name: string | null; topic_source: "ai" | "operator" | null;
  // event payload for type "topic_changed": { from: string | null; to: string | null; source: "ai" | "operator" }
  ```
  Routes: `GET /crm/api/topics` → `Topic[]`; `POST /crm/api/topics` `{name}` → `Topic`; `PUT /crm/api/topics/:id` `{name?, position?, archived?}` → `Topic`; `POST /crm/api/tickets/:id/topic` `{topic_id: number | null}` → `{ok: true, ticket: TicketListItem}` (same `ticketAck` as status).

- [ ] **Step 1: Migration `migrations/0019_crm_topics.sql`**

```sql
-- Contact reasons (spec 2026-10-18 §1). Applied on every boot: every statement is idempotent.
create table if not exists public.crm_topics (
  id serial primary key,
  name text not null,
  position integer not null default 0,
  archived_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index if not exists crm_topics_name_key on public.crm_topics (lower(name));

-- Seed once: only into an empty table, so renames and archives survive every boot.
insert into public.crm_topics (name, position)
select v.name, v.position from (values
  ('Пополнение не пришло', 1), ('Карта отклонена', 2), ('Выпуск карты', 3), ('KYC/верификация', 4),
  ('Antarctic', 5), ('Вывод/возврат', 6), ('Тарифы и цены', 7), ('Как пользоваться', 8),
  ('Жалоба', 9), ('Другое', 10)) as v(name, position)
where not exists (select 1 from public.crm_topics);

alter table public.support_requests add column if not exists topic_id integer references public.crm_topics(id);
alter table public.support_requests add column if not exists topic_source text;
alter table public.support_requests add column if not exists topic_set_at timestamptz;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'support_requests_topic_source_check') then
    alter table public.support_requests add constraint support_requests_topic_source_check
      check (topic_source is null or topic_source in ('ai','operator'));
  end if;
  if not exists (select 1 from pg_constraint
                  where conname = 'crm_ticket_events_type_check' and pg_get_constraintdef(oid) like '%topic_changed%') then
    alter table public.crm_ticket_events drop constraint if exists crm_ticket_events_type_check;
    alter table public.crm_ticket_events add constraint crm_ticket_events_type_check
      check (type in ('created','assigned','auto_assigned','unassigned','taken_over','status_changed','reopened','topic_changed'));
  end if;
  if not exists (select 1 from pg_constraint
                  where conname = 'support_agent_jobs_kind_check' and pg_get_constraintdef(oid) like '%topic%') then
    alter table public.support_agent_jobs drop constraint if exists support_agent_jobs_kind_check;
    alter table public.support_agent_jobs add constraint support_agent_jobs_kind_check
      check (kind in ('triage','review','topic'));
  end if;
end $$;
create index if not exists support_requests_topic_idx on public.support_requests (topic_id) where topic_id is not null;
```

In `src/db.ts` change the list to `["0016_support_crm.sql", "0017_crm_push.sql", "0018_support_video.sql", "0019_crm_topics.sql"]`.

- [ ] **Step 2: Failing test `tests/crm_topics_postgres.test.ts`**

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { assertScratchDb, freshCrmDb } from "./helpers/crm_pg.js";

const url = process.env.CRM_TEST_DATABASE_URL;

test("topics: seed, list, create, rename, archive, ticket topic by operator and AI", { skip: !url }, async (t) => {
  assertScratchDb(url!);
  Object.assign(process.env, {
    LEADS_BOT_TOKEN: "123:test", SUPPORT_BOT_TOKEN: "456:test",
    LEADS_CHAT_ID: "-1001", SUPPORT_CHAT_ID: "-1002",
    DATABASE_URL: url!, PUBLIC_BASE_URL: "https://ops.example",
    LEADS_WEBHOOK_SECRET: "test-secret", TELEGRAM_WEBHOOK_SECRET: "test-secret", ROSTER: "[]",
  });
  const topics = await import("../dist/crm/topics.js");
  const tickets = await import("../dist/crm/tickets.js");
  const { DEFAULT_PREFS } = await import("../dist/crm/types.js");
  const sql = await freshCrmDb(url!);
  type Operator = import("../dist/crm/types.js").Operator;
  const op = (id: number, name: string, role: "admin" | "support", is_lead = false): Operator => ({
    id, name, email: null, role, is_lead, auto_assign_enabled: true, on_shift: true,
    last_active_at: null, last_assigned_at: null, prefs: DEFAULT_PREFS,
  });
  const anna = op(7, "Anna", "support");
  const lead = op(10, "Lena", "support", true);
  await sql`insert into crm_operators(id,name,role,is_lead) values (7,'Anna','support',false), (10,'Lena','support',true)`;
  const [tk] = await sql`insert into support_requests (user_tg, source, status) values (777, 'bot', 'resolved') returning id`;
  const id = tk!.id as string;
  const events = async () => (await sql`select type, actor_operator_id, payload from crm_ticket_events
    where ticket_id = ${id} and type = 'topic_changed' order by id`).map((e) => ({ actor: e.actor_operator_id, ...e.payload }));
  try {
    await t.test("seed: ten topics in order, idempotent on re-run", async () => {
      const { readFileSync } = await import("node:fs");
      await sql.unsafe(readFileSync(new URL("../migrations/0019_crm_topics.sql", import.meta.url), "utf8"));
      const list = await topics.listTopics();
      assert.deepEqual(list.map((x) => x.name), ["Пополнение не пришло", "Карта отклонена", "Выпуск карты",
        "KYC/верификация", "Antarctic", "Вывод/возврат", "Тарифы и цены", "Как пользоваться", "Жалоба", "Другое"]);
      assert.ok(list.every((x) => !x.archived));
    });

    await t.test("create/rename/archive: lead only, duplicates are a field error", async () => {
      await assert.rejects(topics.createTopic({ name: "Возврат" }, anna), { name: "Forbidden" });
      const created = await topics.createTopic({ name: "  Возврат комиссии " }, lead);
      assert.equal(created.name, "Возврат комиссии");
      assert.equal(created.position, 11);
      await assert.rejects(topics.createTopic({ name: "возврат КОМИССИИ" }, lead),
        (e: { issues?: Array<{ path: string[]; message: string }> }) => e.issues?.[0]?.message === "duplicate" && e.issues[0]!.path[0] === "name");
      const renamed = await topics.updateTopic(created.id, { name: "Комиссия" }, lead);
      assert.equal(renamed.name, "Комиссия");
      const archived = await topics.updateTopic(created.id, { archived: true }, lead);
      assert.equal(archived.archived, true);
      assert.equal((await topics.listTopics()).at(-1)!.name, "Комиссия"); // archived stay listed, last
      await assert.rejects(topics.updateTopic(created.id, { name: "x" }, anna), { name: "Forbidden" });
      await assert.rejects(topics.updateTopic(9999, { name: "x" }, lead), { name: "NotFound" });
    });

    await t.test("operator sets, changes and clears the topic; archived and unknown ids are refused", async () => {
      const list = await topics.listTopics();
      const card = list.find((x) => x.name === "Карта отклонена")!;
      const kyc = list.find((x) => x.name === "KYC/верификация")!;
      const archived = list.find((x) => x.archived)!;
      await topics.setTicketTopic(id, card.id, anna);
      await topics.setTicketTopic(id, card.id, anna); // same choice: no second event
      await topics.setTicketTopic(id, kyc.id, anna);
      for (const bad of [archived.id, 9999]) {
        await assert.rejects(topics.setTicketTopic(id, bad, anna),
          (e: { issues?: Array<{ path: string[]; message: string }> }) => e.issues?.[0]?.path[0] === "topic_id");
      }
      const d = await tickets.ticketDetail(id);
      assert.deepEqual([d!.ticket.topic_id, d!.ticket.topic_name, d!.ticket.topic_source], [kyc.id, "KYC/верификация", "operator"]);
      await topics.setTicketTopic(id, null, anna);
      const cleared = await tickets.ticketDetail(id);
      assert.deepEqual([cleared!.ticket.topic_id, cleared!.ticket.topic_source], [null, null]);
      assert.deepEqual(await events(), [
        { actor: "7", from: null, to: "Карта отклонена", source: "operator" },
        { actor: "7", from: "Карта отклонена", to: "KYC/верификация", source: "operator" },
        { actor: "7", from: "KYC/верификация", to: null, source: "operator" },
      ]);
    });

    await t.test("AI applies only when no operator choice, never an archived topic", async () => {
      await sql`delete from crm_ticket_events where ticket_id = ${id}`;
      const list = await topics.listTopics();
      const topup = list.find((x) => x.name === "Пополнение не пришло")!;
      const other = list.find((x) => x.name === "Другое")!;
      const archived = list.find((x) => x.archived)!;
      assert.equal(await topics.applyAiTopic(id, archived.id), false);
      assert.equal(await topics.applyAiTopic(id, topup.id), true); // topic was cleared above: AI may set
      assert.equal(await topics.applyAiTopic(id, topup.id), false); // same: no change, no event
      await topics.setTicketTopic(id, other.id, anna);
      assert.equal(await topics.applyAiTopic(id, topup.id), false); // operator choice wins
      const d = await tickets.ticketDetail(id);
      assert.deepEqual([d!.ticket.topic_name, d!.ticket.topic_source], ["Другое", "operator"]);
      assert.deepEqual(await events(), [
        { actor: null, from: null, to: "Пополнение не пришло", source: "ai" },
        { actor: "7", from: "Пополнение не пришло", to: "Другое", source: "operator" },
      ]);
    });

    await t.test("enqueueTopicJob: one pending topic job at the last seq, none after an operator choice", async () => {
      const [t2] = await sql`insert into support_requests (user_tg, source, status) values (778, 'bot', 'resolved') returning id`;
      const id2 = t2!.id as string;
      await sql`insert into support_messages (ticket_id, sender, body, actor_type) values (${id2}, 'user', 'help', 'customer')`;
      await topics.enqueueTopicJob(sql, id2);
      await topics.enqueueTopicJob(sql, id2);
      const jobs = await sql`select kind, through_seq::int as seq from support_agent_jobs where ticket_id = ${id2} and kind = 'topic'`;
      const [{ max }] = await sql`select max(seq)::int as max from support_messages where ticket_id = ${id2}` as unknown as [{ max: number }];
      assert.deepEqual(jobs.map((j) => [j.kind, j.seq]), [["topic", max]]);
      await topics.enqueueTopicJob(sql, id); // ticket 1 has an operator topic
      const none = await sql`select 1 from support_agent_jobs where ticket_id = ${id} and kind = 'topic'`;
      assert.equal(none.length, 0);
    });
  } finally {
    await sql.end();
    await (await import("../dist/db.js")).sql.end();
  }
});
```

Run: `pnpm build && CRM_TEST_DATABASE_URL=postgres://postgres@127.0.0.1:5433/crm_test node --experimental-test-module-mocks --import tsx --test tests/crm_topics_postgres.test.ts`
Expected: FAIL — `pnpm build` fails or the import of `../dist/crm/topics.js` fails (module missing).

- [ ] **Step 3: `src/crm/types.ts`**

```ts
export type TicketEventType = "created" | "assigned" | "auto_assigned" | "unassigned" | "taken_over" | "status_changed" | "reopened" | "topic_changed";
```

- [ ] **Step 4: `src/crm/tickets.ts`**

- `async function logEvent(` → `export async function logEvent(`.
- `TicketDetailItem` becomes:
  ```ts
  export type TicketDetailItem = TicketListItem & {
    device: string | null; category: string | null; web_user_id: string | null;
    topic_id: number | null; topic_name: string | null; topic_source: "ai" | "operator" | null;
  };
  ```
- In `ticketDetail`, the select becomes
  ```ts
  const [r] = await sql`${itemSelect(sql`, r.device, r.category, r.web_user_id, r.topic_id, r.topic_source,
    (select name from crm_topics where id = r.topic_id) as topic_name`)} where r.id = ${id}`;
  ```
  and the returned `ticket` adds
  ```ts
      topic_id: num(r.topic_id),
      topic_name: (r.topic_name as string | null) ?? null,
      topic_source: (r.topic_source as "ai" | "operator" | null) ?? null,
  ```

- [ ] **Step 5: `src/crm/topics.ts`**

```ts
import type postgres from "postgres";
import { z } from "zod";
import { sql } from "../db.js";
import { publish } from "./events.js";
import { Forbidden, logEvent, NotFound, withLockedTicket } from "./tickets.js";
import { canEditTeamSettings, type Operator } from "./types.js";

export interface Topic { id: number; name: string; position: number; archived: boolean }

const Name = z.string().trim().min(1).max(60);
const TopicInput = z.object({ name: Name }).strict();
const TopicPatch = z.object({
  name: Name.optional(),
  position: z.number().int().min(0).max(1000).optional(),
  archived: z.boolean().optional(),
}).strict().refine((p) => p.name !== undefined || p.position !== undefined || p.archived !== undefined, { message: "empty_patch" });

type Row = Record<string, unknown>;
type Sql = postgres.Sql | postgres.TransactionSql;

const toTopic = (r: Row): Topic => ({
  id: Number(r.id), name: r.name as string, position: Number(r.position), archived: r.archived_at != null,
});

const fieldError = (field: string, message: string) =>
  new z.ZodError([{ code: "custom", path: [field], message }]);

/** A unique-name clash surfaces as a field error, never a 500. */
async function uniqueName<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if ((err as { code?: string }).code === "23505") throw fieldError("name", "duplicate");
    throw err;
  }
}

/** Active topics first in their order, archived ones after. */
export async function listTopics(): Promise<Topic[]> {
  const rows = await sql`select id, name, position, archived_at from crm_topics
    order by archived_at is not null, position, id`;
  return rows.map(toTopic);
}

export async function createTopic(input: unknown, me: Operator): Promise<Topic> {
  if (!canEditTeamSettings(me)) throw new Forbidden();
  const v = TopicInput.parse(input);
  const [r] = await uniqueName(() => sql`
    insert into crm_topics (name, position)
    values (${v.name}, (select coalesce(max(position), 0) + 1 from crm_topics))
    returning id, name, position, archived_at`);
  return toTopic(r!);
}

export async function updateTopic(id: number, patch: unknown, me: Operator): Promise<Topic> {
  if (!canEditTeamSettings(me)) throw new Forbidden();
  const v = TopicPatch.parse(patch);
  if (!Number.isInteger(id) || id <= 0) throw new NotFound();
  const [r] = await uniqueName(() => sql`
    update crm_topics
       set name = coalesce(${v.name ?? null}::text, name),
           position = coalesce(${v.position ?? null}::int, position),
           archived_at = case when ${v.archived ?? null}::boolean is null then archived_at
                              when ${v.archived ?? null}::boolean then coalesce(archived_at, now())
                              else null end
     where id = ${id}
    returning id, name, position, archived_at`);
  if (!r) throw new NotFound();
  return toTopic(r);
}

async function activeTopicName(tx: Sql, id: number): Promise<string | null> {
  const [r] = await tx<{ name: string }[]>`select name from crm_topics where id = ${id} and archived_at is null`;
  return r?.name ?? null;
}

async function currentTopic(tx: Sql, ticketId: string): Promise<{ id: number | null; name: string | null; source: string | null }> {
  const [r] = await tx`select r.topic_id, r.topic_source, t.name from support_requests r
    left join crm_topics t on t.id = r.topic_id where r.id = ${ticketId}`;
  return { id: r?.topic_id == null ? null : Number(r.topic_id), name: (r?.name as string | null) ?? null, source: (r?.topic_source as string | null) ?? null };
}

/** An operator's choice (or clearing it). Allowed on any ticket, resolved included. */
export async function setTicketTopic(ticketId: string, topicId: number | null, me: Operator): Promise<void> {
  const changed = await withLockedTicket(ticketId, async (tx) => {
    const cur = await currentTopic(tx, ticketId);
    const name = topicId === null ? null : await activeTopicName(tx, topicId);
    if (topicId !== null && name === null) throw fieldError("topic_id", "unknown_topic");
    if (cur.id === topicId && (topicId === null || cur.source === "operator")) return false;
    await tx`update support_requests
        set topic_id = ${topicId}, topic_source = ${topicId === null ? null : "operator"},
            topic_set_at = ${topicId === null ? null : sql`now()`}
      where id = ${ticketId}`;
    await logEvent(tx, ticketId, "topic_changed", me.id, { from: cur.name, to: name, source: "operator" });
    return true;
  });
  if (changed) await publish({ type: "ticket.updated", ticketId });
}

/** The AI suggestion: applied only while no operator has chosen. Returns whether the ticket changed. */
export async function applyAiTopic(ticketId: string, topicId: number): Promise<boolean> {
  const changed = await withLockedTicket(ticketId, async (tx) => {
    const cur = await currentTopic(tx, ticketId);
    if (cur.source === "operator") return false;
    const name = await activeTopicName(tx, topicId);
    if (name === null || cur.id === topicId) return false;
    await tx`update support_requests set topic_id = ${topicId}, topic_source = 'ai', topic_set_at = now() where id = ${ticketId}`;
    await logEvent(tx, ticketId, "topic_changed", null, { from: cur.name, to: name, source: "ai" });
    return true;
  });
  if (changed) await publish({ type: "ticket.updated", ticketId });
  return changed;
}

/** Queues the AI topic job for a just-resolved ticket unless an operator already chose. */
export async function enqueueTopicJob(tx: Sql, ticketId: string): Promise<void> {
  await tx`
    insert into support_agent_jobs (ticket_id, kind, through_seq)
    select r.id, 'topic', coalesce((select max(seq) from support_messages where ticket_id = r.id), 0)
      from support_requests r
     where r.id = ${ticketId} and r.topic_source is distinct from 'operator'
    on conflict do nothing`;
}
```

- [ ] **Step 6: Routes in `src/crm/routes.ts`**

Import: `import { createTopic, listTopics, setTicketTopic, updateTopic } from "./topics.js";`

Body schema next to `AssignBody`:

```ts
const TopicBody = z.object({ topic_id: z.number().int().positive().nullable() }).strict();
```

After the `/api/canned/...` routes:

```ts
  r.get("/api/topics", async (c) => c.json(await listTopics()));
  r.post("/api/topics", async (c) => c.json(await createTopic(await readJson(c), c.get("operator"))));
  r.put("/api/topics/:id", async (c) => c.json(await updateTopic(Number(c.req.param("id")), await readJson(c), c.get("operator"))));
```

After the `/api/tickets/:id/status` route:

```ts
  r.post("/api/tickets/:id/topic", writable, async (c) => {
    const { topic_id } = TopicBody.parse(await readJson(c));
    await setTicketTopic(c.req.param("id"), topic_id, c.get("operator"));
    return ticketAck(c);
  });
```

- [ ] **Step 7: Run the new test, then the full suite and typecheck**

Run the Step 2 command. Expected: PASS (5 subtests).
Then `CRM_TEST_DATABASE_URL=postgres://postgres@127.0.0.1:5433/crm_test pnpm test 2>&1 | grep -E "^# (tests|pass|fail|skipped)"` and `pnpm typecheck`.
Expected: `# fail 0`; typecheck 0. If `tests/crm_routes.test.ts` fails because `routes.ts` now imports `topics.js`, add a mock for `../dist/crm/topics.js` exporting `listTopics`, `createTopic`, `updateTopic` and `setTicketTopic` (each recording its call), copying how that file mocks `canned.js`, and re-run.

- [ ] **Step 8: Commit**

```bash
git add migrations/0019_crm_topics.sql src/db.ts src/crm/topics.ts src/crm/tickets.ts src/crm/types.ts src/crm/routes.ts tests/crm_topics_postgres.test.ts
# plus tests/crm_routes.test.ts only if Step 7 changed it
git commit -m "feat(crm topics): topic list, ticket topic by operator or AI, API"
```

---

### Task 2: AI topic job

**Files:**
- Modify: `src/agents/contracts.ts` (TopicChoice, schema, task)
- Modify: `src/agents/engine.ts` (`topic()`)
- Modify: `src/agents/openai.ts` (output cap for `topic`)
- Modify: `src/agents/store.ts` (`Job.kind`)
- Modify: `src/agents/worker.ts` (run topic jobs, apply the result)
- Modify: `src/crm/tickets.ts` (`setStatus` queues the job)
- Modify: `tests/agents.test.ts` (engine unit tests)
- Modify: `tests/crm_tickets_postgres.test.ts` (enqueue on resolve)

**Interfaces:**
- Consumes: `enqueueTopicJob(tx, ticketId)`, `applyAiTopic(ticketId, topicId)`, `listTopics()` from Task 1.
- Produces: `SupportEngine.topic(messages: TranscriptMessage[], topics: Array<{ id: number; name: string }>): Promise<{ topic_id: number; confidence: number }>`; `Task` union gains `"topic"`.

- [ ] **Step 1: Failing engine tests in `tests/agents.test.ts`** (append; `modelFor`, `customer` already exist in the file)

```ts
test("topic picks one of the offered active topics from the redacted transcript", async () => {
  const seen: unknown[] = [];
  const model: Model = { async complete(task, instructions, evidence) {
    assert.equal(task, "topic");
    assert.ok(instructions.startsWith(BASE_INSTRUCTIONS));
    seen.push(evidence);
    return { topic_id: 2, confidence: 0.9 };
  } };
  const engine = new SupportEngine(model);
  const topics = [{ id: 1, name: "Пополнение не пришло" }, { id: 2, name: "Карта отклонена" }];
  assert.deepEqual(await engine.topic([customer("Карта 4111 1111 1111 1111 не проходит")], topics), { topic_id: 2, confidence: 0.9 });
  const evidence = seen[0] as { messages: TranscriptMessage[]; topics: unknown };
  assert.doesNotMatch(evidence.messages[0]!.body, /4111 1111 1111 1111/);
  assert.deepEqual(evidence.topics, topics);
});

test("topic outside the offered list is rejected", async () => {
  const { engine } = modelFor([{ topic_id: 99, confidence: 0.9 }]);
  await assert.rejects(engine.topic([customer("Помогите")], [{ id: 1, name: "Другое" }]), /unknown_topic_reference/);
});

test("topic schema constrains topic_id to the offered ids", () => {
  const schema = schemaFor("topic", { messages: [], topics: [{ id: 3, name: "A" }, { id: 5, name: "B" }] }) as {
    properties: { topic_id: { type: string; enum: number[] } };
  };
  assert.deepEqual(schema.properties.topic_id, { type: "integer", enum: [3, 5] });
});
```

Add `schemaFor` to the existing import from `../src/agents/contracts.js`.

Run: `node --import tsx --test tests/agents.test.ts`
Expected: FAIL — `engine.topic is not a function` / `schemaFor` returns the wrong schema.

- [ ] **Step 2: `src/agents/contracts.ts`**

After `Review`:

```ts
export const TopicChoice = z.object({
  topic_id: z.number().int(), confidence: z.number().min(0).max(1),
}).strict();
export type TopicChoice = z.infer<typeof TopicChoice>;
```

In `schemas` add `topic: objectOf({ topic_id: { type: "integer" }, confidence: { type: "number" } }),`.

`schemaFor` becomes:

```ts
export function schemaFor(task: Task, evidence: unknown): object {
  if (task === "topic") {
    const { topics } = z.object({ topics: z.array(z.object({ id: z.number().int() })).min(1).max(100) }).parse(evidence);
    return objectOf({ topic_id: { type: "integer", enum: topics.map((t) => t.id) }, confidence: { type: "number" } });
  }
  if (task !== "review") return schemas[task];
  // … existing review body unchanged …
}
```

- [ ] **Step 3: `src/agents/engine.ts`** — add `TopicChoice` to the contracts import and the method:

```ts
  async topic(messages: TranscriptMessage[], topics: Array<{ id: number; name: string }>) {
    const safe = messages.map((m) => ({ ...m, body: redact(m.body) }));
    const choice = TopicChoice.parse(await this.model.complete("topic", `${BASE_INSTRUCTIONS}
Определи одну тему обращения из списка topics: главный вопрос клиента в этой переписке.
Если ни одна тема не подходит, выбери «Другое», если она есть в списке. Верни только id темы из списка.`,
      { messages: safe, topics }));
    if (!topics.some((t) => t.id === choice.topic_id)) throw new Error("unknown_topic_reference");
    return choice;
  }
```

- [ ] **Step 4: `src/agents/openai.ts`** — the output cap line becomes

```ts
    const maxOutput = task === "classify" ? 1000 : task === "answer" ? 1600 : task === "topic" ? 300 : 3600;
```

- [ ] **Step 5: `src/agents/store.ts`** — `kind: "triage" | "review" | "topic";` in `Job`.

- [ ] **Step 6: `src/agents/worker.ts`**

Add imports `import { applyAiTopic, listTopics } from "../crm/topics.js";` and `"unknown_topic_reference"` to `errorCodes`. Replace the body from `const transcript = …` through `await agentStore.finish(…)` with:

```ts
    const transcript = await agentStore.transcript(job);
    const model = new OpenAIModel({
      apiKey: config.OPENAI_API_KEY!, model: config.SUPPORT_AI_MODEL,
      meter: {
        reserve: (model, task, usd) => agentStore.reserve(job, model, task, usd, {
          dailyUsd: config.SUPPORT_AI_DAILY_USD, monthlyUsd: config.SUPPORT_AI_MONTHLY_USD,
          ticketDailyCalls: config.SUPPORT_AI_TICKET_DAILY_CALLS,
        }),
        settle: (...args) => agentStore.settle(...args),
      },
    });
    const engine = new SupportEngine(model);
    if (job.kind === "topic") {
      // Internal labelling only: no KB, nothing reaches the customer.
      const active = (await listTopics()).filter((t) => !t.archived).map(({ id, name }) => ({ id, name }));
      const choice = await engine.topic(transcript.messages, active);
      await agentStore.finish(job, { ...choice, policy_version: "ru-support-v2" });
      await applyAiTopic(job.ticket_id, choice.topic_id);
      return true;
    }
    let articles: Awaited<ReturnType<KnowledgeBase["articles"]>> = [];
    let kbAvailable = true;
    try { articles = await kb.articles(); } catch { kbAvailable = false; }
    const result = job.kind === "triage"
      ? await attachDiagnostics(await engine.triage(transcript.messages, articles), await getTicket(job.ticket_id), diagnostics)
      : await engine.review(transcript.messages, articles, transcript.truncated);
    await agentStore.finish(job, { ...result, kb_available: kbAvailable,
      history_truncated: transcript.truncated, policy_version: "ru-support-v2" });
```

(`applyAiTopic` ignores a topic an operator already overrode; a reopened ticket keeps its AI topic.)

- [ ] **Step 7: `setStatus` queues the job** (`src/crm/tickets.ts`)

Lazy import to avoid a cycle (`topics.ts` imports `tickets.ts`). Inside `setStatus`'s `mutate` callback, right after the `update support_requests set status = 'resolved' …` line:

```ts
        const { enqueueTopicJob } = await import("./topics.js");
        await enqueueTopicJob(tx, t.id);
```

The cutover script (`src/crm/cutover.ts`) does not call `setStatus`, so it queues nothing.

- [ ] **Step 8: Failing-first Postgres test in `tests/crm_tickets_postgres.test.ts`**

Add a subtest next to the existing «setStatus: resolved…» one (reuse its `ticket()` helper and `anna`):

```ts
    await t.test("setStatus resolved queues one AI topic job unless the operator chose a topic", async () => {
      const a = await ticket();
      await sql`insert into support_messages (ticket_id, sender, body, actor_type) values (${a}, 'user', 'help', 'customer')`;
      await tickets.setStatus(a, "resolved", anna, { onResolved: async () => {} });
      const jobs = await sql`select kind from support_agent_jobs where ticket_id = ${a} and kind = 'topic'`;
      assert.equal(jobs.length, 1);

      const b = await ticket();
      const [topic] = await sql`select id from crm_topics order by position limit 1`;
      await sql`update support_requests set topic_id = ${topic!.id}, topic_source = 'operator' where id = ${b}`;
      await tickets.setStatus(b, "resolved", anna, { onResolved: async () => {} });
      const none = await sql`select 1 from support_agent_jobs where ticket_id = ${b} and kind = 'topic'`;
      assert.equal(none.length, 0);
    });
```

Write this subtest before Step 7 and watch it fail (`jobs.length` 0), then do Step 7.

- [ ] **Step 9: Run tests**

`node --import tsx --test tests/agents.test.ts` → pass; `pnpm build && CRM_TEST_DATABASE_URL=… node --experimental-test-module-mocks --import tsx --test tests/crm_tickets_postgres.test.ts` → pass; full suite and `pnpm typecheck` → `# fail 0`, exit 0. Also run `CRM_TEST_DATABASE_URL=… node --experimental-test-module-mocks --import tsx --test tests/crm_cutover_postgres.test.ts` and confirm it still passes (cutover queues no topic job).

- [ ] **Step 10: Commit**

```bash
git add src/agents/contracts.ts src/agents/engine.ts src/agents/openai.ts src/agents/store.ts src/agents/worker.ts src/crm/tickets.ts tests/agents.test.ts tests/crm_tickets_postgres.test.ts
git commit -m "feat(crm topics): AI topic job queued on CRM resolve"
```

---

### Task 3: «Причины обращений» in stats

**Files:**
- Modify: `src/crm/stats.ts`
- Create: `tests/crm_stats_topics_postgres.test.ts`

**Interfaces:**
- Consumes: `resolveRows` and `cycles` fragments from PR 1 (in `stats()`), `support_requests.topic_id`, `crm_topics`.
- Produces: `StatsResponse.topics: TopicStats[]` where
  ```ts
  export interface TopicStats {
    topic_id: number | null; name: string; resolved: number; prev_resolved: number;
    share_pct: number | null; resolution_median_s: number | null;
  }
  ```
  `resolved` = operator resolves in `[from, to)` of tickets currently on that topic; `prev_resolved` = the same over the previous range of equal length `[from − (to − from), from)`; `share_pct` = resolved ÷ all resolved in range, 1 decimal; `resolution_median_s` from cycles in range; `topic_id null` row is named «Без темы». Rows with `resolved = 0` and `prev_resolved = 0` are omitted; order: `resolved` desc, then topic position, «Без темы» last on ties.

- [ ] **Step 1: Refactor the fragments into range functions**

In `stats()`, turn `resolveRows` and `cycles` into local functions of a range, and make `cycles` also select `r.ticket_id`:

```ts
  const resolvesIn = (a: Date, b: Date) => sql`
    select e.ticket_id, …unchanged…
       and e.created_at >= ${a} and e.created_at < ${b} and e.actor_operator_id is not null`;
  const cyclesIn = (a: Date, b: Date) => sql`
    select r.ticket_id, r.op, r.reopened, m.replies, m.messages, …unchanged…
      from (${resolvesIn(a, b)}) r …unchanged…`;
  const resolveRows = resolvesIn(from, to);
  const cycles = cyclesIn(from, to);
```

The existing uses of `resolveRows`/`cycles` stay as they are.

- [ ] **Step 2: Failing test `tests/crm_stats_topics_postgres.test.ts`**

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { assertScratchDb, freshCrmDb } from "./helpers/crm_pg.js";

const url = process.env.CRM_TEST_DATABASE_URL;
const msk = (s: string) => `2026-${s}+03:00`;
// Range [10-03, 10-05): previous equal range is [10-01, 10-03).
const FROM = new Date(msk("10-03T00:00:00"));
const TO = new Date(msk("10-05T00:00:00"));
const admin = {
  id: 1, name: "Anna", email: null, role: "admin", is_lead: false, auto_assign_enabled: true, on_shift: true,
  last_active_at: null, last_assigned_at: null,
  prefs: { theme: "system", sound: true, volume: 0.6, desktop: true, notify_scope: "all", send_key: "mod_enter" },
} as const;

test("stats: contact reasons per topic with previous range and «Без темы»", { skip: !url }, async () => {
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
    await sql`insert into crm_operators(id,name,role,is_lead) values (1,'Anna','admin',false)`;
    const topic = async (name: string) => Number((await sql`select id from crm_topics where name = ${name}`)[0]!.id);
    const topup = await topic("Пополнение не пришло");
    const card = await topic("Карта отклонена");
    const kyc = await topic("KYC/верификация");
    let tg = 500;
    // One customer message 10 minutes before an operator resolve.
    const resolved = async (topicId: number | null, at: string, actor: number | null = 1) => {
      const [r] = await sql`insert into support_requests (user_tg, source, status, topic_id, topic_source)
        values (${tg++}, 'bot', 'resolved', ${topicId}, ${topicId === null ? null : "ai"}) returning id`;
      const id = r!.id as string;
      const at10 = new Date(new Date(at).getTime() - 600_000).toISOString();
      await sql`insert into support_messages (ticket_id, sender, body, actor_type, created_at) values (${id}, 'user', 'x', 'customer', ${at10})`;
      await sql`insert into crm_ticket_events (ticket_id, type, actor_operator_id, payload, created_at)
        values (${id}, 'status_changed', ${actor}, ${sql.json({ from: "awaiting", to: "resolved" } as never)}, ${at})`;
    };
    await resolved(topup, msk("10-03T10:00:00"));
    await resolved(topup, msk("10-03T11:00:00"));
    await resolved(topup, msk("10-04T09:00:00"));
    await resolved(card, msk("10-04T10:00:00"));
    await resolved(null, msk("10-04T11:00:00"));
    await resolved(card, msk("10-01T10:00:00")); // previous range
    await resolved(card, msk("10-02T10:00:00")); // previous range
    await resolved(kyc, msk("10-02T12:00:00")); // previous range only: still listed with 0
    await resolved(kyc, msk("10-04T12:00:00"), null); // cutover close: never counts
    await resolved(topup, msk("09-30T10:00:00")); // before both ranges

    const s = await mod.stats({ from: FROM, to: TO }, admin, DEFAULT_SETTINGS);
    assert.deepEqual(s.topics, [
      { topic_id: topup, name: "Пополнение не пришло", resolved: 3, prev_resolved: 0, share_pct: 60, resolution_median_s: 600 },
      { topic_id: card, name: "Карта отклонена", resolved: 1, prev_resolved: 2, share_pct: 20, resolution_median_s: 600 },
      { topic_id: null, name: "Без темы", resolved: 1, prev_resolved: 0, share_pct: 20, resolution_median_s: 600 },
      { topic_id: kyc, name: "KYC/верификация", resolved: 0, prev_resolved: 1, share_pct: 0, resolution_median_s: null },
    ]);

    const empty = await mod.stats({ from: new Date(msk("01-01T00:00:00")), to: new Date(msk("01-02T00:00:00")) }, admin, DEFAULT_SETTINGS);
    assert.deepEqual(empty.topics, []);
  } finally {
    await sql.end();
    await (await import("../dist/db.js")).sql.end();
  }
});
```

Run: `pnpm build && CRM_TEST_DATABASE_URL=postgres://postgres@127.0.0.1:5433/crm_test node --experimental-test-module-mocks --import tsx --test tests/crm_stats_topics_postgres.test.ts`
Expected: FAIL — `s.topics` is `undefined`.

- [ ] **Step 3: Implement**

Add `TopicStats` (above) and `topics: TopicStats[]` to the return type of `stats()` (`Promise<{ team: TeamStats; operators: OperatorStats[]; topics: TopicStats[] }>`). After the `heat` query:

```ts
  const prevFrom = new Date(from.getTime() - (to.getTime() - from.getTime()));
  const topicRows = await sql`
    with cur as (
      select s.topic_id, count(*)::int as n from (${resolveRows}) x
        join public.support_requests s on s.id = x.ticket_id group by 1
    ), prv as (
      select s.topic_id, count(*)::int as n from (${resolvesIn(prevFrom, from)}) x
        join public.support_requests s on s.id = x.ticket_id group by 1
    ), med as (
      select s.topic_id, round((percentile_cont(0.5) within group (order by c.resolution_s))::numeric) as m
        from (${cycles}) c join public.support_requests s on s.id = c.ticket_id group by 1
    ), k as (select topic_id from cur union select topic_id from prv)
    select k.topic_id, t.name, t.position, coalesce(cur.n, 0) as resolved, coalesce(prv.n, 0) as prev_resolved,
           round(100.0 * coalesce(cur.n, 0) / nullif((select sum(n) from cur), 0), 1) as share, med.m as res_med
      from k
      left join public.crm_topics t on t.id = k.topic_id
      left join cur on cur.topic_id is not distinct from k.topic_id
      left join prv on prv.topic_id is not distinct from k.topic_id
      left join med on med.topic_id is not distinct from k.topic_id
     order by coalesce(cur.n, 0) desc, k.topic_id is null, t.position, k.topic_id`;
```

and return `topics: topicRows.map((r) => ({ topic_id: r.topic_id == null ? null : Number(r.topic_id), name: r.topic_id == null ? "Без темы" : String(r.name), resolved: Number(r.resolved), prev_resolved: Number(r.prev_resolved), share_pct: num(r.share), resolution_median_s: num(r.res_med) }))`.

Note the expected order in the test: «Карта отклонена» (1, position 2) before «Без темы» (1) because `k.topic_id is null` sorts false first; «KYC/верификация» (0) last. Share for a 0 row when the range has resolves is `0` (0 ÷ 5); for an empty range there are no rows.

- [ ] **Step 4: Run tests** — the new test passes; `tests/crm_stats_postgres.test.ts` and `tests/crm_stats_resolution_postgres.test.ts` still pass (their deep-equals ignore unknown top-level keys only for `team`/`operators`; `topics` is a new top-level key and is not compared); full suite `# fail 0`; `pnpm typecheck` 0.

- [ ] **Step 5: Commit**

```bash
git add src/crm/stats.ts tests/crm_stats_topics_postgres.test.ts
git commit -m "feat(crm stats): contact reasons per topic"
```

---

### Task 4: Web — topic in the ticket header and timeline

**Files:**
- Create: `web/src/lib/topics.ts`
- Modify: `web/src/lib/tickets.ts` (detail fields, `topic` action)
- Modify: `web/src/components/Thread.tsx` (topic menu, `topic_changed` event text)
- Create: `web/src/components/Thread.topic.test.tsx`

**Interfaces:**
- Consumes: `GET /crm/api/topics`, `POST /crm/api/tickets/:id/topic` (Task 1).
- Produces (`web/src/lib/topics.ts`):
  ```ts
  export interface Topic { id: number; name: string; position: number; archived: boolean }
  export const topicKeys = { all: ["topics"] as const };
  export function useTopics(): UseQueryResult<Topic[]>
  export function useCreateTopic(): UseMutationResult<Topic, unknown, { name: string }>
  export function useUpdateTopic(): UseMutationResult<Topic, unknown, { id: number; patch: Partial<Pick<Topic, "name" | "position" | "archived">> }>
  ```
  `TicketAction` gains `{ kind: "topic"; topic: Pick<Topic, "id" | "name"> | null }`.

- [ ] **Step 1: `web/src/lib/topics.ts`**

```ts
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, json } from "./api";

// Mirrors src/crm/topics.ts.
export interface Topic {
  id: number;
  name: string;
  position: number;
  archived: boolean;
}

export const topicKeys = { all: ["topics"] as const };

export function useTopics() {
  return useQuery({ queryKey: topicKeys.all, queryFn: () => api<Topic[]>("/topics"), staleTime: 5 * 60_000 });
}

export function useCreateTopic() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { name: string }) => api<Topic>("/topics", json("POST", v)),
    onSettled: () => qc.invalidateQueries({ queryKey: topicKeys.all }),
  });
}

export function useUpdateTopic() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: number; patch: Partial<Pick<Topic, "name" | "position" | "archived">> }) =>
      api<Topic>(`/topics/${id}`, json("PUT", patch)),
    onSettled: () => qc.invalidateQueries({ queryKey: topicKeys.all }),
  });
}
```

- [ ] **Step 2: `web/src/lib/tickets.ts`**

- `TicketDetailItem` gains `topic_id: number | null; topic_name: string | null; topic_source: "ai" | "operator" | null;`.
- `TicketAction` gains `| { kind: "topic"; topic: { id: number; name: string } | null }`.
- `requestFor`: `case "topic": return api(\`${base}/topic\`, json("POST", { topic_id: a.topic?.id ?? null }));`
- `applyAction`: `case "topic": return { ...t, topic_id: a.topic?.id ?? null, topic_name: a.topic?.name ?? null, topic_source: a.topic ? "operator" : null };`
- Find every test fixture of a `TicketDetailItem` under `web/src` that `pnpm typecheck` now flags, and add `topic_id: null, topic_name: null, topic_source: null` to it.

- [ ] **Step 3: Failing test `web/src/components/Thread.topic.test.tsx`**

```tsx
import { describe, expect, it } from "vitest";
import { eventText } from "./Thread";
import type { TicketEventRow } from "../lib/tickets";

const ev = (payload: Record<string, unknown>): TicketEventRow =>
  ({ id: 1, type: "topic_changed", actor_name: null, payload, created_at: "2026-10-18T10:00:00Z" }) as TicketEventRow;

describe("topic_changed in the timeline", () => {
  it("names the topic and who chose it", () => {
    expect(eventText(ev({ from: null, to: "Карта отклонена", source: "ai" }))).toBe("Тема (ИИ): Карта отклонена");
    expect(eventText(ev({ from: "Карта отклонена", to: "KYC/верификация", source: "operator" }))).toBe("Тема: KYC/верификация");
    expect(eventText(ev({ from: "KYC/верификация", to: null, source: "operator" }))).toBe("Тема снята");
  });
});
```

Add a header-menu case in the same file if the repo already has a pattern for rendering `ThreadHeader`/`Thread` in tests (look for an existing `Thread` render in `web/src/**/*.test.tsx`; if one exists, render it with a fetch stub returning two topics for `GET /crm/api/topics`, open the «Тема» menu, pick «Карта отклонена», and assert a `POST /crm/api/tickets/<id>/topic` with `{"topic_id":2}`). If there is no such pattern, the `eventText` test alone is the gate and the menu is checked in the final review.

Run: `cd web && pnpm vitest run src/components/Thread.topic.test.tsx` → FAIL (`eventText` returns null).

- [ ] **Step 4: `web/src/components/Thread.tsx`**

In `eventText` add before `default`:

```ts
    case "topic_changed": {
      const to = typeof e.payload.to === "string" ? e.payload.to : null;
      if (!to) return "Тема снята";
      return e.payload.source === "ai" ? `Тема (ИИ): ${to}` : `Тема: ${to}`;
    }
```

`TicketEventType` in `web/src/lib/tickets.ts` (or wherever the web mirrors it) gains `"topic_changed"`.

In `ThreadHeader`, add `import { useTopics } from "../lib/topics";`, then:

```tsx
  const topics = useTopics();
  const activeTopics = (topics.data ?? []).filter((x) => !x.archived);
  const topicItems: MenuItem[] = [
    ...activeTopics.map((x) => ({
      key: String(x.id),
      text: x.name,
      label: <span className="min-w-0 flex-1 truncate">{x.name}</span>,
      checked: ticket.topic_id === x.id,
      onSelect: () => {
        if (ticket.topic_id !== x.id || ticket.topic_source !== "operator") actions.run({ kind: "topic", topic: { id: x.id, name: x.name } });
      },
    })),
    {
      key: "none",
      text: "Без темы",
      label: <span>Без темы</span>,
      checked: false,
      disabled: ticket.topic_id === null,
      separatorBefore: activeTopics.length > 0,
      onSelect: () => actions.run({ kind: "topic", topic: null }),
    },
  ];
  const topicTrigger = ticket.topic_name ? (
    <span className="flex min-w-0 items-center gap-1.5">
      <span className="truncate">{ticket.topic_name}</span>
      {ticket.topic_source === "ai" && <span className="text-xs text-text-muted">ИИ</span>}
    </span>
  ) : (
    <span className="text-text-muted">Без темы</span>
  );
```

In the second header row: in the `readOnly` branch append `<span className="truncate text-text-muted">{ticket.topic_name ?? "Без темы"}</span>` inside the existing span; in the editable branch, after the assign `<Menu …/>`:

```tsx
            <Menu
              label={`Тема: ${ticket.topic_name ?? "Без темы"}`}
              title="Тема"
              items={topicItems}
              disabled={actions.pending}
              triggerClassName="h-7 px-2 text-sm max-w-[14rem]"
              trigger={topicTrigger}
            />
```

- [ ] **Step 5: Run** `cd web && pnpm test && pnpm typecheck && pnpm build` → all pass.

- [ ] **Step 6: Commit**

```bash
git add web/src/lib/topics.ts web/src/lib/tickets.ts web/src/components/Thread.tsx web/src/components/Thread.topic.test.tsx
# plus any fixture files Step 2 touched, by explicit path
git commit -m "feat(crm web): ticket topic menu and topic events in the timeline"
```

---

### Task 5: Web — «Темы обращений» in Settings

**Files:**
- Create: `web/src/components/TopicsSection.tsx`
- Create: `web/src/components/TopicsSection.test.tsx`
- Modify: `web/src/routes/Settings.tsx` (render `<TopicsSection me={me} />` after `<OperatorsSection me={me} />` in `TeamTab`)

**Interfaces:**
- Consumes: `useTopics`, `useCreateTopic`, `useUpdateTopic` (Task 4), `canEditTeamSettings` from `web/src/lib/settings`, `toast` from `./Toast`, `ApiError` from `../lib/api`.
- Produces: `TopicsSection({ me }: { me: Operator })`.

Behavior and copy:
- Heading «Темы обращений», aside «ИИ выбирает тему после решения, оператор может поменять».
- Active topics in order: name; for leads/admins an inline rename (input + «Сохранить» on change, Enter submits), «Выше»/«Ниже» buttons (swap `position` with the neighbour: two `PUT`s), «В архив».
- Archived topics under «Архив» (muted): name and «Вернуть».
- For leads/admins, a final row: input placeholder «Новая тема» and button «Добавить» (disabled while empty).
- A 422 with `fields.name === "duplicate"` shows toast «Такая тема уже есть.»; other errors toast «Не сохранилось. Повторите.» (tone danger).
- Plain operators see the active list and the archive, with no controls.

- [ ] **Step 1: Failing test `web/src/components/TopicsSection.test.tsx`**

```tsx
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { createQueryClient } from "../app";
import { resetApiStateForTests } from "../lib/api";
import { jsonResponse } from "../test/fakes";
import { TopicsSection } from "./TopicsSection";

const prefs = { theme: "system", sound: true, volume: 0.6, desktop: true, notify_scope: "all", send_key: "mod_enter" } as const;
const base = { email: null, auto_assign_enabled: true, on_shift: true, last_active_at: null, last_assigned_at: null, prefs };
const lead = { ...base, id: 10, name: "Лена", role: "support", is_lead: true } as const;
const support = { ...base, id: 7, name: "Аня", role: "support", is_lead: false } as const;
const list = [
  { id: 1, name: "Пополнение не пришло", position: 1, archived: false },
  { id: 2, name: "Карта отклонена", position: 2, archived: false },
  { id: 3, name: "Старая", position: 3, archived: true },
];

function setup(me: typeof lead | typeof support, onWrite?: (key: string, body: unknown) => Response) {
  const calls: Array<[string, unknown]> = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit = {}) => {
    const key = `${init.method ?? "GET"} ${url}`;
    if (key === "GET /crm/api/topics") return jsonResponse(200, list);
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push([key, body]);
    return onWrite ? onWrite(key, body) : jsonResponse(200, { ...list[0], ...body });
  }));
  render(<QueryClientProvider client={createQueryClient()}><TopicsSection me={me as never} /></QueryClientProvider>);
  return calls;
}

describe("TopicsSection", () => {
  beforeEach(() => resetApiStateForTests());
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  it("lets a lead add, reorder and archive", async () => {
    const calls = setup(lead);
    await screen.findByText("Пополнение не пришло");
    fireEvent.change(screen.getByPlaceholderText("Новая тема"), { target: { value: "Комиссия" } });
    fireEvent.click(screen.getByRole("button", { name: "Добавить" }));
    fireEvent.click(screen.getAllByRole("button", { name: "Ниже" })[0]!);
    fireEvent.click(screen.getAllByRole("button", { name: "В архив" })[1]!);
    await waitFor(() => expect(calls).toEqual([
      ["POST /crm/api/topics", { name: "Комиссия" }],
      ["PUT /crm/api/topics/1", { position: 2 }],
      ["PUT /crm/api/topics/2", { position: 1 }],
      ["PUT /crm/api/topics/2", { archived: true }],
    ]));
    expect(screen.getByText("Старая")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Вернуть" })).toBeTruthy();
  });

  it("shows a duplicate name as a toast", async () => {
    setup(lead, () => jsonResponse(422, { error: "validation", fields: { name: "duplicate" } }));
    await screen.findByText("Пополнение не пришло");
    fireEvent.change(screen.getByPlaceholderText("Новая тема"), { target: { value: "карта отклонена" } });
    fireEvent.click(screen.getByRole("button", { name: "Добавить" }));
    expect(await screen.findByText("Такая тема уже есть.")).toBeTruthy();
  });

  it("is read-only for a plain operator", async () => {
    setup(support);
    await screen.findByText("Пополнение не пришло");
    expect(screen.queryByPlaceholderText("Новая тема")).toBeNull();
    expect(screen.queryByRole("button", { name: "В архив" })).toBeNull();
  });
});
```

If toasts render only inside a `<Toaster>`-style host, render that host next to the section in `setup` the way other tests in `web/src` do (search for an existing test asserting toast text); keep the assertion.

Run `cd web && pnpm vitest run src/components/TopicsSection.test.tsx` → FAIL (module missing).

- [ ] **Step 2: Implement `web/src/components/TopicsSection.tsx`** to the behavior above. Use the `Section`-like markup of `OperatorsSection` (`<section aria-labelledby>` + `<h2 className="text-md font-semibold">`), the button classes used in `Settings.tsx` (`press hover-surface h-8 rounded-sm px-3` for secondary actions, `press h-9 rounded-sm bg-accent px-4 font-semibold text-accent-fg hover:bg-accent-hover disabled:opacity-60` for «Добавить»), and the input classes of `DateField` in `web/src/routes/Stats.tsx`. Reorder is a swap: «Ниже» on topic A with next topic B sends `PUT A {position: B.position}` then `PUT B {position: A.position}`. Errors map with:

```ts
function topicErrorText(err: unknown): string {
  const fields = err instanceof ApiError ? (err.body as { fields?: Record<string, string> } | undefined)?.fields : undefined;
  return fields?.name === "duplicate" ? "Такая тема уже есть." : "Не сохранилось. Повторите.";
}
```

- [ ] **Step 3: Render it** in `TeamTab` of `web/src/routes/Settings.tsx` after `<OperatorsSection me={me} />`: `<TopicsSection me={me} />` (import from `../components/TopicsSection`). If `web/src/routes/Settings.test.tsx` now fails on an unexpected `GET /crm/api/topics`, extend its fetch stub to answer that path with `[]`.

- [ ] **Step 4: Run** `cd web && pnpm test && pnpm typecheck && pnpm build` → pass.

- [ ] **Step 5: Commit**

```bash
git add web/src/components/TopicsSection.tsx web/src/components/TopicsSection.test.tsx web/src/routes/Settings.tsx
# plus web/src/routes/Settings.test.tsx only if Step 3 changed it
git commit -m "feat(crm web): edit contact topics in team settings"
```

---

### Task 6: Web — «Причины обращений» on Stats

**Files:**
- Modify: `web/src/lib/stats.ts` (types)
- Create: `web/src/components/TopicStatsTable.tsx`
- Create: `web/src/components/TopicStatsTable.test.tsx`
- Modify: `web/src/routes/Stats.tsx` (new block)
- Modify: `web/src/routes/Stats.test.tsx` (fixture gains `topics: []`)

**Interfaces:**
- Consumes: `StatsResponse.topics` (Task 3).
- Produces: `TopicStatsTable({ rows }: { rows: TopicStats[] })`; `TopicStats` in `web/src/lib/stats.ts` mirroring Task 3.

- [ ] **Step 1: Types** — in `web/src/lib/stats.ts` add

```ts
export interface TopicStats {
  topic_id: number | null;
  name: string;
  resolved: number;
  prev_resolved: number;
  share_pct: number | null;
  resolution_median_s: number | null;
}
```

and `topics: TopicStats[];` in `StatsResponse`. Add `topics: []` to the fixture objects in `web/src/routes/Stats.test.tsx`.

- [ ] **Step 2: Failing test `web/src/components/TopicStatsTable.test.tsx`**

```tsx
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { formatDuration, formatPercent } from "../lib/stats";
import { TopicStatsTable } from "./TopicStatsTable";

// Testing Library normalizes NBSP in the DOM to a space but not in the matcher string.
const norm = (s: string) => s.replace(/\u00a0/g, " ");

describe("TopicStatsTable", () => {
  afterEach(cleanup);

  it("lists topics with count, change vs the previous period, share and resolution time", () => {
    render(<TopicStatsTable rows={[
      { topic_id: 1, name: "Пополнение не пришло", resolved: 3, prev_resolved: 1, share_pct: 60, resolution_median_s: 600 },
      { topic_id: 2, name: "Карта отклонена", resolved: 1, prev_resolved: 2, share_pct: 20, resolution_median_s: null },
      { topic_id: null, name: "Без темы", resolved: 1, prev_resolved: 1, share_pct: 20, resolution_median_s: 600 },
    ]} />);
    const rows = screen.getAllByRole("row").slice(1);
    expect(within(rows[0]!).getByText("Пополнение не пришло")).toBeTruthy();
    expect(within(rows[0]!).getByText("+2")).toBeTruthy();
    expect(within(rows[0]!).getByText(norm(formatPercent(60)))).toBeTruthy();
    expect(within(rows[0]!).getByText(norm(formatDuration(600)))).toBeTruthy();
    expect(within(rows[1]!).getByText("−1")).toBeTruthy();
    expect(within(rows[1]!).getByText("нет")).toBeTruthy();
    expect(within(rows[2]!).getByText("0")).toBeTruthy();
  });

  it("says so when nothing was resolved", () => {
    render(<TopicStatsTable rows={[]} />);
    expect(screen.getByText("За период решённых обращений нет.")).toBeTruthy();
  });
});
```

Run → FAIL (module missing).

- [ ] **Step 3: `web/src/components/TopicStatsTable.tsx`**

```tsx
import { formatDuration, formatPercent, type TopicStats } from "../lib/stats";

const delta = (n: number) => (n > 0 ? `+${n}` : n < 0 ? `−${-n}` : "0");

/** Contact reasons for the range: resolved count, change vs the previous equal period, share, median time. */
export function TopicStatsTable({ rows }: { rows: TopicStats[] }) {
  if (!rows.length) return <p className="text-text-muted">За период решённых обращений нет.</p>;
  return (
    <div className="overflow-x-auto rounded-md bg-surface shadow-[0_0_0_1px_var(--border)]">
      <table className="w-full min-w-[36rem] border-collapse text-left">
        <thead>
          <tr className="border-b border-border text-xs text-text-muted">
            <th scope="col" className="h-8 px-4 font-normal">Тема</th>
            <th scope="col" className="px-4 text-right font-normal">Решено</th>
            <th scope="col" className="px-4 text-right font-normal" title="Разница с предыдущим таким же периодом">К прошлому</th>
            <th scope="col" className="px-4 text-right font-normal">Доля</th>
            <th scope="col" className="px-4 text-right font-normal" title="Медиана: от сообщения клиента до решения">Время решения</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {rows.map((r) => (
            <tr key={r.topic_id ?? "none"} className="h-11">
              <th scope="row" className={r.topic_id === null ? "px-4 font-normal text-text-muted" : "px-4 font-semibold"}>{r.name}</th>
              <td className="num px-4 text-right">{r.resolved}</td>
              <td className="num px-4 text-right text-text-muted">{delta(r.resolved - r.prev_resolved)}</td>
              <td className="num px-4 text-right">{r.share_pct === null ? <span className="text-text-muted">нет</span> : formatPercent(r.share_pct)}</td>
              <td className="num px-4 text-right">
                {r.resolution_median_s === null ? <span className="text-text-muted">нет</span> : formatDuration(r.resolution_median_s)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
```

- [ ] **Step 4: Stats page** — in `web/src/routes/Stats.tsx`, import `TopicStatsTable` and add after the «Когда пишут клиенты» block:

```tsx
            <Block title="Причины обращений" aside={<span className="text-sm text-text-muted">По темам решённых обращений.</span>}>
              <TopicStatsTable rows={stats.data.topics} />
            </Block>
```

- [ ] **Step 5: Run** `cd web && pnpm test && pnpm typecheck && pnpm build` → pass.

- [ ] **Step 6: Commit**

```bash
git add web/src/lib/stats.ts web/src/components/TopicStatsTable.tsx web/src/components/TopicStatsTable.test.tsx web/src/routes/Stats.tsx web/src/routes/Stats.test.tsx
git commit -m "feat(crm web): contact reasons block on Stats"
```
