// Local CRM demo data: 2 operators, 12 tickets, canned replies, a settings change.
// Resets every CRM and support table in the target DB, so it refuses anything but localhost.
//   DATABASE_URL=postgres://postgres@127.0.0.1:5433/crm_test CRM_SSO_SECRET=<32+ chars> \
//     node --import tsx scripts/seed_crm_dev.ts
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import postgres from "postgres";

const url = process.env.DATABASE_URL ?? "";
const secret = process.env.CRM_SSO_SECRET ?? "";
const origin = process.env.CRM_DEV_ORIGIN ?? "http://localhost:8000";

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

let host = "";
try {
  host = new URL(url).hostname;
} catch {
  fail("DATABASE_URL is missing or not a URL.");
}
if (host !== "localhost" && host !== "127.0.0.1") fail(`Refusing to seed ${host}: DATABASE_URL must point at localhost.`);
if (secret.length < 32) fail("CRM_SSO_SECRET must be at least 32 characters (the same value the local server runs with).");

// auth.ts loads config.ts, which validates the whole service env; the token signer needs none of it.
process.env.PUBLIC_BASE_URL ??= origin;
process.env.SUPPORT_RUNTIME ??= "sandbox";
const { signSsoToken } = await import("../src/crm/auth.js");

const sql = postgres(url, { max: 1, onnotice: () => {} });

/* ---------- tiny PNG ---------- */

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
/** A w×h RGB PNG: a diagonal two-colour gradient, enough to tell photos apart. */
function png(w: number, h: number, from: [number, number, number], to: [number, number, number]): Buffer {
  const rows: Buffer[] = [];
  for (let y = 0; y < h; y++) {
    const row = Buffer.alloc(1 + w * 3);
    for (let x = 0; x < w; x++) {
      const t = (x / w + y / h) / 2;
      for (let i = 0; i < 3; i++) row[1 + x * 3 + i] = Math.round(from[i]! + (to[i]! - from[i]!) * t);
    }
    rows.push(row);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(Buffer.concat(rows))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
const PHOTOS = [
  png(96, 64, [33, 96, 224], [14, 138, 128]),
  png(64, 96, [200, 50, 47], [151, 86, 0]),
  png(80, 80, [122, 79, 214], [26, 143, 204]),
];

/* ---------- data ---------- */

interface Op { id: number; name: string; email: string; role: "admin" | "support" }
const ADMIN: Op = { id: 1001, name: "Аня Смирнова", email: "anya@turkarta.local", role: "admin" };
const SUPPORT: Op = { id: 1002, name: "Олег Петров", email: "oleg@turkarta.local", role: "support" };

type Who = "user" | Op;
interface Step {
  /** Minutes ago. */
  at: number;
  who: Who;
  kind?: "text" | "photo" | "note" | "unsupported";
  body?: string;
  photos?: number;
  failed?: boolean;
}
interface Spec {
  source: "bot" | "miniapp" | "web";
  name: string | null;
  username?: string;
  email?: string;
  status: "new" | "allocated" | "awaiting" | "resolved";
  assignee?: Op;
  auto?: boolean;
  /** Minutes after creation when the ticket was assigned. */
  assignedAfter?: number;
  /** Minutes ago. */
  resolvedAt?: number;
  reopenedAt?: number;
  firstResolvedAt?: number;
  steps: Step[];
}

const H = 60;
const D = 24 * H;

const SPECS: Spec[] = [
  { source: "bot", name: "Марина Козлова", username: "marina_k", status: "new",
    steps: [{ at: 1, who: "user", body: "Не приходит код подтверждения при входе. Жду уже несколько минут." }] },
  { source: "miniapp", name: "Игорь Белов", username: "igor_belov", status: "new",
    steps: [
      { at: 4, who: "user", body: "Карта не активируется, скриншот ниже." },
      { at: 4, who: "user", kind: "photo", body: "", photos: 2 },
    ] },
  { source: "web", name: "Светлана Орлова", email: "s.orlova@example.com", status: "new",
    steps: [{ at: 12, who: "user", body: "Платёж по СБП висит в обработке уже час. Деньги списались." }] },
  { source: "bot", name: null, username: "dmitry_tk", status: "new",
    steps: [
      { at: 35, who: "user", body: "Здравствуйте, вопрос по лимитам." },
      { at: 34, who: "user", kind: "unsupported", body: "" },
    ] },
  { source: "miniapp", name: "Алексей Ким", username: "alexkim", status: "allocated", assignee: ADMIN, assignedAfter: 2,
    steps: [
      { at: 50, who: "user", body: "Как поменять email в профиле?" },
      { at: 47, who: ADMIN, body: "Здравствуйте! Откройте Профиль, затем Почта. Пришлите скриншот, если поле неактивно." },
      { at: 3, who: "user", body: "Поле серое, нажать нельзя." },
    ] },
  { source: "web", name: "Наталья Фролова", email: "frolova.n@example.com", status: "allocated", assignee: SUPPORT, auto: true, assignedAfter: 5,
    steps: [
      { at: 95, who: "user", body: "Не вижу пополнение на 15 000 ₽ от вчерашнего дня." },
      { at: 88, who: SUPPORT, body: "Проверяю платёж, вернусь с ответом." },
      { at: 86, who: SUPPORT, kind: "note", body: "@Аня Смирнова платёж в статусе pending у банка, глянь, пожалуйста." },
      { at: 20, who: "user", body: "Есть новости?" },
    ] },
  { source: "bot", name: "Павел Сидоров", username: "psidorov", status: "allocated", assignee: ADMIN, assignedAfter: 1,
    steps: [
      { at: 130, who: "user", body: "Хочу закрыть карту и вернуть остаток." },
      { at: 126, who: ADMIN, body: "Остаток вернём на карту, с которой пополняли. Подтвердите, пожалуйста.", failed: true },
    ] },
  { source: "miniapp", name: "Екатерина Лебедева", username: "katya_leb", status: "awaiting", assignee: SUPPORT, assignedAfter: 3,
    steps: [
      { at: 300, who: "user", body: "Где посмотреть реквизиты карты?" },
      { at: 296, who: SUPPORT, body: "Главная, нажмите на карту, затем Реквизиты. Сработало?" },
    ] },
  { source: "web", name: "Роман Гусев", email: "gusev.roman@example.com", status: "awaiting", assignee: ADMIN, assignedAfter: 2,
    steps: [
      { at: 8 * H, who: "user", body: "Где найти кнопку выпуска второй карты?" },
      { at: 8 * H - 6, who: ADMIN, kind: "photo", body: "Вот здесь, внизу экрана карт.", photos: 1 },
    ] },
  { source: "bot", name: "Ольга Морозова", username: "olga_m", status: "resolved", assignee: ADMIN, assignedAfter: 2, resolvedAt: D - 30,
    steps: [
      { at: D + 40, who: "user", body: "Списали комиссию дважды." },
      { at: D + 36, who: ADMIN, body: "Вижу двойное списание, вернём вторую комиссию в течение дня." },
      { at: D + 10, who: "user", body: "Спасибо!" },
    ] },
  { source: "web", name: "Виктор Зайцев", email: "zaitsev@example.com", status: "resolved", assignee: SUPPORT, assignedAfter: 4,
    firstResolvedAt: 3 * D, reopenedAt: 3 * D - 5 * H, resolvedAt: 2 * D,
    steps: [
      { at: 3 * D + 60, who: "user", body: "Не проходит оплата в зарубежном магазине." },
      { at: 3 * D + 51, who: SUPPORT, body: "Проверьте, что магазин принимает Visa. Если да, пришлите время попытки." },
      { at: 3 * D - 5 * H, who: "user", body: "Снова не прошла, в 14:10." },
      { at: 3 * D - 5 * H - 17, who: SUPPORT, body: "Банк-эквайер отклонил, лимит магазина. Попробуйте другую сумму." },
    ] },
  { source: "miniapp", name: "Илья Новиков", username: "inovikov", status: "resolved", assignee: ADMIN, auto: true, assignedAfter: 5, resolvedAt: 6 * D - 2 * H,
    steps: [
      { at: 6 * D, who: "user", body: "Можно ли пополнить карту с карты другого банка?" },
      { at: 6 * D - 7, who: ADMIN, body: "Да, через СБП с любой карты российского банка." },
    ] },
];

const CANNED: Array<{ title: string; body: string; by: Op; uses: number }> = [
  { title: "Приветствие", body: "Здравствуйте, {имя}! Меня зовут {оператор}, помогу разобраться.", by: ADMIN, uses: 42 },
  { title: "Код не пришёл", body: "Проверьте папку «Спам» и запросите код ещё раз через минуту. Если не придёт, напишите сюда.", by: ADMIN, uses: 17 },
  { title: "Платёж в обработке", body: "Платёж обрабатывается банком. Обычно это занимает до 30 минут, мы следим за ним.", by: SUPPORT, uses: 9 },
  { title: "Нужен скриншот", body: "Пришлите, пожалуйста, скриншот экрана с ошибкой.", by: SUPPORT, uses: 3 },
];

/* ---------- write ---------- */

const ago = (min: number) => new Date(Date.now() - min * 60_000);

async function migrate() {
  await sql`create extension if not exists pgcrypto`;
  const dir = new URL("../migrations/", import.meta.url);
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    await sql.unsafe(readFileSync(new URL(file, dir), "utf8"));
  }
}

async function reset() {
  await sql`truncate table public.support_requests, public.crm_operators, public.crm_canned_replies,
    public.crm_settings, public.crm_settings_log, public.crm_sessions, public.crm_sso_nonces restart identity cascade`;
}

async function seedTicket(tx: postgres.TransactionSql, spec: Spec, i: number) {
  const steps = [...spec.steps].sort((a, b) => b.at - a.at);
  const createdAt = steps[0]!.at;
  const isWeb = spec.source === "web";
  const replies = steps.filter((s) => s.who !== "user" && s.kind !== "note");
  const firstResponse = replies[0]?.at ?? null;
  const lastReply = replies.at(-1)?.at ?? Infinity;
  const pendingUser = spec.status === "resolved" ? [] : steps.filter((s) => s.who === "user" && s.at < lastReply);
  const waitingSince = pendingUser[0]?.at ?? null;

  const [row] = await tx<{ id: string }[]>`
    insert into public.support_requests
      (channel, source, user_tg, web_user_id, user_name, user_username, email, first_message, status,
       assigned_operator_id, auto_assigned, queued_at, waiting_since, first_response_at, last_message_at,
       resolved_at, created_at, claimed_at)
    values (${isWeb ? "web" : "telegram"}, ${spec.source}, ${isWeb ? null : 700_000 + i}, ${isWeb ? `web-user-${i}` : null},
            ${spec.name}, ${spec.username ?? null}, ${spec.email ?? null}, ${steps[0]!.body ?? ""}, ${spec.status},
            ${spec.assignee?.id ?? null}, ${spec.auto ?? false}, ${spec.status === "new" ? ago(createdAt) : null},
            ${waitingSince === null ? null : ago(waitingSince)}, ${firstResponse === null ? null : ago(firstResponse)},
            ${ago(steps.at(-1)!.at)}, ${spec.resolvedAt === undefined ? null : ago(spec.resolvedAt)}, ${ago(createdAt)},
            ${spec.assignee ? ago(createdAt - (spec.assignedAfter ?? 1)) : null})
    returning id`;
  const ticketId = row!.id;

  let unansweredSince: number | null = null;
  let photo = 0;
  for (const s of steps) {
    const kind = s.kind ?? "text";
    const isUser = s.who === "user";
    const op = isUser ? null : (s.who as Op);
    const isReply = !isUser && kind !== "note";
    const responseSeconds = isReply && unansweredSince !== null ? (unansweredSince - s.at) * 60 : null;
    const [m] = await tx<{ id: string }[]>`
      insert into public.support_messages
        (ticket_id, sender, body, actor_type, author_id, author_name, kind, unsupported_type,
         delivery_status, delivery_error, response_seconds, created_at)
      values (${ticketId}, ${isUser ? "user" : "agent"}, ${s.body ?? ""},
              ${isUser ? "customer" : kind === "note" ? "system" : "human"},
              ${isUser ? (isWeb ? `web:web-user-${i}` : `tg:${700_000 + i}`) : `crm:${op!.id}`},
              ${op?.name ?? null}, ${kind}, ${kind === "unsupported" ? "video" : null},
              ${isReply ? (s.failed ? "failed" : "sent") : null}, ${s.failed ? "bot_blocked" : null},
              ${responseSeconds}, ${ago(s.at)})
      returning id`;
    for (let p = 0; p < (s.photos ?? 0); p++) {
      const content = PHOTOS[photo++ % PHOTOS.length]!;
      await tx`
        insert into public.support_attachments (message_id, media_type, filename, size_bytes, content, position)
        values (${m!.id}, 'image/png', ${`photo-${p + 1}.png`}, ${content.length}, ${content}, ${p})`;
    }
    if (isUser) unansweredSince ??= s.at;
    else if (isReply) unansweredSince = null;
  }

  const event = (type: string, at: number, actor: number | null, payload: Record<string, unknown>) =>
    tx`insert into public.crm_ticket_events (ticket_id, type, actor_operator_id, payload, created_at)
       values (${ticketId}, ${type}, ${actor}, ${JSON.stringify(payload)}::text::jsonb, ${ago(at)})`;

  await event("created", createdAt, null, {});
  if (spec.assignee) {
    const at = createdAt - (spec.assignedAfter ?? 1);
    const who = { operator_id: spec.assignee.id, operator_name: spec.assignee.name };
    await event(spec.auto ? "auto_assigned" : "assigned", at, spec.auto ? null : spec.assignee.id, who);
  }
  if (spec.firstResolvedAt !== undefined) {
    await event("status_changed", spec.firstResolvedAt, spec.assignee!.id, { from: "awaiting", to: "resolved" });
  }
  if (spec.reopenedAt !== undefined) await event("reopened", spec.reopenedAt, null, { status: "allocated" });
  if (spec.resolvedAt !== undefined) {
    await event("status_changed", spec.resolvedAt, spec.assignee!.id, { from: "awaiting", to: "resolved" });
  }
}

async function seed() {
  await sql.begin(async (tx) => {
    for (const [op, onShift] of [[ADMIN, true], [SUPPORT, false]] as const) {
      await tx`
        insert into public.crm_operators (id, name, email, role, on_shift, last_active_at, last_assigned_at)
        values (${op.id}, ${op.name}, ${op.email}, ${op.role}, ${onShift}, ${ago(onShift ? 0 : 3 * H)}, ${ago(H)})`;
    }
    for (const [i, spec] of SPECS.entries()) await seedTicket(tx, spec, i + 1);
    for (const c of CANNED) {
      await tx`
        insert into public.crm_canned_replies (title, body, use_count, created_by, updated_by)
        values (${c.title}, ${c.body}, ${c.uses}, ${c.by.id}, ${c.by.id})`;
    }
    await tx`insert into public.crm_settings (key, value) values ('auto_assign_max_open', '8'::jsonb)`;
    await tx`
      insert into public.crm_settings_log (key, old_value, new_value, operator_id, created_at)
      values ('auto_assign_max_open', 'null'::jsonb, '8'::jsonb, ${ADMIN.id}, ${ago(2 * D)})`;
  });
}

function ssoUrl(op: Op): string {
  const token = signSsoToken(
    { sub: op.id, name: op.name, email: op.email, role: op.role, jti: randomUUID(), exp: Math.floor(Date.now() / 1000) + 110 },
    secret,
  );
  return `${origin}/crm/sso?t=${token}`;
}

try {
  await migrate();
  await reset();
  await seed();
  console.log(`Seeded: 2 operators, ${SPECS.length} tickets, ${CANNED.length} canned replies.`);
  console.log("Start the server against the same DATABASE_URL and CRM_SSO_SECRET, then open within 110 s (single use):");
  console.log(`  admin   ${ADMIN.name}: ${ssoUrl(ADMIN)}`);
  console.log(`  support ${SUPPORT.name}: ${ssoUrl(SUPPORT)}`);
} finally {
  await sql.end();
}
