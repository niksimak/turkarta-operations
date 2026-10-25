import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { HTTPException } from "hono/http-exception";
import { streamSSE } from "hono/streaming";
import { z, ZodError } from "zod";
import { config, legacySurface } from "../config.js";
import { SEGMENTS } from "../db.js";
import { MAX_PHOTO_BYTES, MAX_VIDEO_BYTES, validatePhoto, validateVideo, type ValidPhoto } from "../support_media.js";
import { attachmentResponse } from "./attachments.js";
import { consumeSso, deleteSession, operatorForSession, requireOperator, SESSION_COOKIE, SESSION_TTL_HOURS } from "./auth.js";
import { createCanned, deleteCanned, listCanned, updateCanned, useCanned } from "./canned.js";
import { presence, subscribe } from "./events.js";
import { heartbeat, listOperators, setShift, updateOperator, updatePrefs } from "./operators.js";
import { InvalidReply, retryDelivery, sendReply, type ReplyInput } from "./reply.js";
import { deleteSubscription, pushPublicKey, saveSubscription } from "./push.js";
import { getSettings, settingsLog, updateSettings } from "./settings.js";
import { stats } from "./stats.js";
import {
  assign, BadCursor, Conflict, Forbidden, listTickets, NotFound, setStatus, take, takeOver, ticketCustomer, ticketDetail,
  ticketItem,
  type ListQuery,
} from "./tickets.js";
import { canEditTeamSettings, type Operator } from "./types.js";
import { createTopic, listTopics, setTicketTopic, updateTopic } from "./topics.js";
import { userContext } from "./user_context.js";

type Env = { Variables: { operator: Operator } };

const BASE = "/crm";
// dist/crm/routes.js -> dist/web, independent of the process cwd.
const DEFAULT_WEB_ROOT = fileURLToPath(new URL("../web/", import.meta.url));
const PING_MS = 20_000;
const JSON_MAX_BYTES = 1024 * 1024;
const PHOTO_FIELDS = new Set(["photos", "photos[]"]);
const VIDEO_FIELD = "video";
const MESSAGES_PATH = new RegExp(`^${BASE}/api/tickets/[^/]+/messages$`);
const MAX_PHOTOS = 10;
const DAY_MS = 86_400_000;
const MSK_OFFSET_MS = 3 * 3_600_000;
const MAX_STATS_DAYS = 400;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// <img src> and EventSource cannot send X-CRM; these GETs authenticate by cookie alone.
const COOKIE_ONLY_GET = new RegExp(`^${BASE}/api/(stream|attachments/[^/]+)$`);

const StatusBody = z.object({ status: z.enum(["new", "allocated", "awaiting", "resolved"]) }).strict();
const TopicBody = z.object({ topic_id: z.number().int().positive().max(2147483647).nullable() }).strict();
const AssignBody = z.object({ operator_id: z.number().int().positive().nullable() }).strict();
const ShiftBody = z.object({ on: z.boolean() }).strict();
const PushEndpoint = z.string().url().max(2000).refine((u) => u.startsWith("https://"), "https only");
const PushSubscribeBody = z.object({
  endpoint: PushEndpoint,
  keys: z.object({ p256dh: z.string().min(1).max(200), auth: z.string().min(1).max(100) }),
}).strip();
const PushUnsubscribeBody = z.object({ endpoint: PushEndpoint }).strip();
const PresenceBody = z.object({ state: z.enum(["viewing", "typing"]) }).strict();
const ReplyKind = z.enum(["reply", "note"]);
const JsonReply = z.object({ kind: ReplyKind.default("reply"), body: z.string().default("") }).strict();
const ListParams = z.object({
  view: z.enum(["queue", "mine", "all"]).default("all"),
  status: z.enum(["new", "allocated", "awaiting", "resolved"]).optional(),
  channel: z.enum(["bot", "miniapp", "web", "payout"]).optional(),
  operator: z.coerce.number().int().positive().optional(),
  overdue: z.enum(["1", "0", "true", "false"]).optional(),
  segment: z.enum(SEGMENTS).optional(),
  q: z.string().max(200).optional(),
  cursor: z.string().max(1000).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});
const IsoDate = z.string().datetime({ offset: true });
const StatsParams = z.object({ from: IsoDate.optional(), to: IsoDate.optional() });

const code = (err: unknown) => (err as { code?: string }).code ?? "error";

function zodFields(err: ZodError): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const issue of err.issues) {
    if (issue.code === "unrecognized_keys") {
      for (const k of issue.keys) fields[k] = "unknown_field";
      continue;
    }
    const key = issue.path.join(".") || "_form";
    fields[key] ??= issue.message;
  }
  return fields;
}

const invalid = (fields: Record<string, string>) => new ZodError([
  ...Object.entries(fields).map(([k, message]) => ({ code: "custom" as const, path: k === "_form" ? [] : [k], message })),
]);

async function readJson(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw invalid({ _form: "invalid_json" });
  }
}

/** Drops empty params so `?status=` means "no filter" rather than a validation error. */
function queryParams(c: Context): Record<string, string> {
  return Object.fromEntries(Object.entries(c.req.query()).filter(([, v]) => v !== ""));
}

function onError(err: Error, c: Context): Response | Promise<Response> {
  if (err instanceof HTTPException) return err.getResponse();
  if (err instanceof ZodError) return c.json({ error: "validation", fields: zodFields(err) }, 422);
  if (err instanceof InvalidReply) return c.json({ error: err.code }, 422);
  if (err instanceof Conflict) return c.json({ error: err.code, assignee: err.assignee ?? null }, 409);
  if (err instanceof Forbidden) return c.json({ error: "forbidden" }, 403);
  if (err instanceof NotFound) return c.json({ error: err.message }, 404);
  if (err instanceof BadCursor) return c.json({ error: "bad_cursor" }, 400);
  console.error(`[crm-api] ${c.req.method} ${c.req.routePath} failed code=${code(err)}`);
  return c.json({ error: "internal" }, 500);
}

/** For read-only GETs the browser makes without our headers (EventSource, <img>). */
const cookieOperator = (): MiddlewareHandler<Env> => async (c, next) => {
  const operator = await operatorForSession(getCookie(c, SESSION_COOKIE) ?? "");
  if (!operator) return c.json({ error: "unauthorized" }, 401);
  c.set("operator", operator);
  await next();
};

/** Spec §14: before cutover Bitrix owns replies and assignment, so the CRM is read-only for tickets. */
const crmWritable = (): MiddlewareHandler<Env> => async (c, next) => {
  if (legacySurface()) return c.json({ error: "surface_bitrix" }, 409);
  await next();
};

function defaultStatsRange(now: number): { from: Date; to: Date } {
  const mskMidnight = Math.floor((now + MSK_OFFSET_MS) / DAY_MS) * DAY_MS - MSK_OFFSET_MS;
  return { from: new Date(mskMidnight - 6 * DAY_MS), to: new Date(now) };
}

async function replyInput(c: Context): Promise<ReplyInput | { photoInvalid: number } | { videoInvalid: true }> {
  if (!(c.req.header("content-type") ?? "").startsWith("multipart/form-data")) {
    const j = JsonReply.parse(await readJson(c));
    return { kind: j.kind, body: j.body, photos: [] };
  }
  const form = await c.req.parseBody({ all: true });
  // Fail closed: a duplicated or unknown `kind` must never default a note into a customer reply.
  if (form.kind !== undefined && (typeof form.kind !== "string" || !ReplyKind.safeParse(form.kind).success)) {
    throw invalid({ kind: "invalid_kind" });
  }
  if (form.body !== undefined && typeof form.body !== "string") throw invalid({ body: "invalid_body" });
  const kind = (form.kind ?? "reply") as ReplyInput["kind"];
  const body = form.body ?? "";
  const raw: unknown[] = [];
  const rawVideo: unknown[] = [];
  for (const [name, value] of Object.entries(form)) {
    const values = Array.isArray(value) ? value : [value];
    if (PHOTO_FIELDS.has(name)) raw.push(...values);
    else if (name === VIDEO_FIELD) rawVideo.push(...values);
    else if (values.some((v) => v instanceof File)) throw invalid({ [name]: "unknown_field" });
  }
  if (rawVideo.length > 0) {
    const [f] = rawVideo;
    if (rawVideo.length > 1 || !(f instanceof File) || f.size <= 0 || f.size > MAX_VIDEO_BYTES) return { videoInvalid: true };
    const video = validateVideo(new Uint8Array(await f.arrayBuffer()), f.type, f.name);
    if (!video) return { videoInvalid: true };
    if (raw.length > 0) throw new InvalidReply("video_with_photos");
    return { kind, body, photos: [], video };
  }
  if (raw.length > MAX_PHOTOS) throw new InvalidReply("too_many_photos");
  const photos: ValidPhoto[] = [];
  for (const [index, f] of raw.entries()) {
    if (!(f instanceof File) || f.size <= 0 || f.size > MAX_PHOTO_BYTES) return { photoInvalid: index };
    const photo = validatePhoto(new Uint8Array(await f.arrayBuffer()), f.type, f.name);
    if (!photo) return { photoInvalid: index };
    photos.push(photo);
  }
  return { kind, body, photos };
}

function spa(webRoot: string): MiddlewareHandler {
  const indexPath = join(webRoot, "index.html");
  let assets: MiddlewareHandler | undefined;
  return async (c, next) => {
    const p = c.req.path;
    if (p === `${BASE}/api` || p.startsWith(`${BASE}/api/`) || p === `${BASE}/sso`) return next();
    // Backend-only deploys and tests run without a web build.
    if (!existsSync(indexPath)) return c.json({ error: "not_found" }, 404);
    assets ??= serveStatic({ root: webRoot, rewriteRequestPath: (path) => path.slice(BASE.length) || "/" });
    const res = await assets(c, async () => {});
    if (res) {
      // Set on the response itself: serveStatic's onFound runs after the response is built.
      const file = p.slice(BASE.length);
      // Vite fingerprints everything under assets/.
      if (file.startsWith("/assets/")) res.headers.set("Cache-Control", "public, max-age=31536000, immutable");
      // The service worker must reach browsers the moment it changes.
      if (file === "/sw.js") res.headers.set("Cache-Control", "no-cache");
      if (file.endsWith(".webmanifest")) res.headers.set("Content-Type", "application/manifest+json");
      return res;
    }
    return c.html(await readFile(indexPath, "utf8"), 200, { "Cache-Control": "no-cache" });
  };
}

export function crmRoutes(opts: { webRoot?: string; pingMs?: number } = {}): Hono<Env> {
  const r = new Hono<Env>();
  r.onError(onError);

  r.get("/sso", async (c) => {
    // The token rides in ?t=, so neither the URL nor the token is ever logged.
    c.header("Cache-Control", "no-store");
    c.header("Referrer-Policy", "no-referrer");
    const fail = (reason: string) => {
      console.warn(`[crm-sso] login failed reason=${reason}`);
      return c.redirect(`${BASE}/login-failed?reason=${reason}`, 302);
    };
    const token = c.req.query("t") ?? "";
    if (!token) return fail("malformed");
    let res: Awaited<ReturnType<typeof consumeSso>>;
    try {
      res = await consumeSso(token);
    } catch (err) {
      console.error(`[crm-sso] login error code=${code(err)}`);
      return fail("error");
    }
    if (!res.ok) return fail(res.reason);
    setCookie(c, SESSION_COOKIE, res.sessionToken, {
      httpOnly: true, secure: true, sameSite: "Lax", path: BASE, maxAge: SESSION_TTL_HOURS * 3600,
    });
    console.log(`[crm-sso] login operator=${res.operator.id}`);
    return c.redirect(res.next ?? BASE, 302);
  });

  const auth = requireOperator();
  const cookieAuth = cookieOperator();
  r.use("/api/*", (c, next) => (c.req.method === "GET" && COOKIE_ONLY_GET.test(c.req.path) ? cookieAuth : auth)(c, next));
  // The reply route carries photos and sets its own, larger limit.
  const jsonLimit = bodyLimit({ maxSize: JSON_MAX_BYTES, onError: (c) => c.json({ error: "too_large" }, 413) });
  r.use("/api/*", (c, next) => (c.req.method === "POST" && MESSAGES_PATH.test(c.req.path) ? next() : jsonLimit(c, next)));

  r.post("/api/logout", async (c) => {
    await deleteSession(getCookie(c, SESSION_COOKIE) ?? "");
    deleteCookie(c, SESSION_COOKIE, { path: BASE, secure: true, httpOnly: true, sameSite: "Lax" });
    return c.json({ ok: true });
  });

  r.get("/api/me", (c) => c.json({ ...c.get("operator"), surface: config.SUPPORT_SURFACE }));
  r.post("/api/me/shift", async (c) => {
    const { on } = ShiftBody.parse(await readJson(c));
    return c.json(await setShift(c.get("operator"), on));
  });
  r.post("/api/me/heartbeat", async (c) => {
    await heartbeat(c.get("operator"));
    return c.json({ ok: true });
  });
  r.put("/api/me/prefs", async (c) => c.json(await updatePrefs(c.get("operator"), await readJson(c))));

  // Web Push for this browser (PWA). 404 while VAPID is not configured, so the UI can hide the switch.
  r.get("/api/push/key", (c) => {
    const publicKey = pushPublicKey();
    if (!publicKey) throw new NotFound("push_disabled");
    return c.json({ publicKey });
  });
  r.post("/api/push/subscribe", async (c) => {
    if (!pushPublicKey()) throw new NotFound("push_disabled");
    const s = PushSubscribeBody.parse(await readJson(c));
    await saveSubscription(c.get("operator").id, s, c.req.header("user-agent")?.slice(0, 300) ?? null);
    return c.json({ ok: true });
  });
  r.post("/api/push/unsubscribe", async (c) => {
    const { endpoint } = PushUnsubscribeBody.parse(await readJson(c));
    await deleteSubscription(c.get("operator").id, endpoint);
    return c.json({ ok: true });
  });

  r.get("/api/tickets", async (c) => {
    const p = ListParams.parse(queryParams(c));
    const q: ListQuery = { view: p.view };
    if (p.status) q.status = p.status;
    if (p.channel) q.channel = p.channel;
    if (p.operator !== undefined) q.operatorId = p.operator;
    if (p.overdue !== undefined) q.overdue = p.overdue === "1" || p.overdue === "true";
    if (p.segment) q.segment = p.segment;
    if (p.q !== undefined) q.q = p.q;
    if (p.cursor !== undefined) q.cursor = p.cursor;
    if (p.limit !== undefined) q.limit = p.limit;
    return c.json(await listTickets(c.get("operator"), q, await getSettings()));
  });

  r.get("/api/tickets/:id", async (c) => {
    const id = c.req.param("id");
    const d = await ticketDetail(id);
    if (!d) throw new NotFound();
    return c.json({ ...d, viewers: presence.list(id) });
  });

  // Its own call: the Turkarta lookup (up to 3 s) must never hold up opening a ticket.
  r.get("/api/tickets/:id/user", async (c) => {
    const t = await ticketCustomer(c.req.param("id"));
    if (!t) throw new NotFound();
    return c.json(await userContext(t).catch(() => null));
  });

  const writable = crmWritable();
  r.post(
    "/api/tickets/:id/messages",
    writable,
    bodyLimit({ maxSize: MAX_PHOTOS * MAX_PHOTO_BYTES + 1024 * 1024, onError: (c) => c.json({ error: "too_large" }, 413) }),
    async (c) => {
      const input = await replyInput(c);
      if ("photoInvalid" in input) return c.json({ error: "photo_invalid", index: input.photoInvalid }, 422);
      if ("videoInvalid" in input) return c.json({ error: "video_invalid" }, 422);
      return c.json(await sendReply(c.req.param("id"), c.get("operator"), input));
    },
  );
  r.post("/api/messages/:id/retry", writable, async (c) => c.json(await retryDelivery(c.req.param("id"), c.get("operator"))));

  const ticketAck = async (c: Context<Env>) => c.json({ ok: true, ticket: await ticketItem(c.req.param("id") ?? "") });
  r.post("/api/tickets/:id/take", writable, async (c) => {
    await take(c.req.param("id"), c.get("operator"));
    return ticketAck(c);
  });
  r.post("/api/tickets/:id/take-over", writable, async (c) => {
    await takeOver(c.req.param("id"), c.get("operator"));
    return ticketAck(c);
  });
  r.post("/api/tickets/:id/assign", writable, async (c) => {
    const { operator_id } = AssignBody.parse(await readJson(c));
    await assign(c.req.param("id"), operator_id, c.get("operator"));
    return ticketAck(c);
  });
  r.post("/api/tickets/:id/status", writable, async (c) => {
    const { status } = StatusBody.parse(await readJson(c));
    await setStatus(c.req.param("id"), status, c.get("operator"));
    return ticketAck(c);
  });
  r.post("/api/tickets/:id/topic", writable, async (c) => {
    const { topic_id } = TopicBody.parse(await readJson(c));
    await setTicketTopic(c.req.param("id"), topic_id, c.get("operator"));
    return ticketAck(c);
  });
  r.post("/api/tickets/:id/presence", async (c) => {
    const id = c.req.param("id");
    if (!UUID_RE.test(id)) throw new NotFound();
    const { state } = PresenceBody.parse(await readJson(c));
    const me = c.get("operator");
    presence.set(id, { id: me.id, name: me.name }, state);
    return c.json({ ok: true });
  });

  r.get("/api/attachments/:id", (c) => attachmentResponse(c.req.param("id"), { range: c.req.header("range") }));

  r.get("/api/canned", async (c) => c.json(await listCanned(c.req.query("q"))));
  r.post("/api/canned", async (c) => c.json(await createCanned(await readJson(c), c.get("operator"))));
  r.put("/api/canned/:id", async (c) => c.json(await updateCanned(c.req.param("id"), await readJson(c), c.get("operator"))));
  r.delete("/api/canned/:id", async (c) => {
    await deleteCanned(c.req.param("id"), c.get("operator"));
    return c.json({ ok: true });
  });
  r.post("/api/canned/:id/use", async (c) => c.json({ ok: true, ...(await useCanned(c.req.param("id"))) }));

  r.get("/api/topics", async (c) => c.json(await listTopics()));
  r.post("/api/topics", async (c) => c.json(await createTopic(await readJson(c), c.get("operator"))));
  r.put("/api/topics/:id", async (c) => c.json(await updateTopic(Number(c.req.param("id")), await readJson(c), c.get("operator"))));

  r.get("/api/operators", async (c) => c.json(await listOperators()));
  r.put("/api/operators/:id", async (c) =>
    c.json(await updateOperator(Number(c.req.param("id")), await readJson(c), c.get("operator"))));

  r.get("/api/stats", async (c) => {
    const p = StatsParams.parse(queryParams(c));
    const def = defaultStatsRange(Date.now());
    const from = p.from ? new Date(p.from) : def.from;
    const to = p.to ? new Date(p.to) : def.to;
    if (from >= to) throw invalid({ from: "from_after_to" });
    if (to.getTime() - from.getTime() > MAX_STATS_DAYS * DAY_MS) throw invalid({ from: "range_too_long" });
    return c.json(await stats({ from, to }, c.get("operator"), await getSettings()));
  });

  r.get("/api/settings", async (c) => c.json(await getSettings()));
  r.put("/api/settings", async (c) => {
    const me = c.get("operator");
    if (!canEditTeamSettings(me)) throw new Forbidden();
    const res = await updateSettings(await readJson(c), me.id);
    if (!res.ok) return c.json({ error: "validation", fields: res.errors }, 422);
    return c.json(res.settings);
  });
  r.get("/api/settings/log", async (c) => {
    if (!canEditTeamSettings(c.get("operator"))) throw new Forbidden();
    return c.json(await settingsLog());
  });

  r.get("/api/stream", (c) => {
    const me = c.get("operator");
    const cookie = getCookie(c, SESSION_COOKIE) ?? "";
    c.header("X-Accel-Buffering", "no");
    return streamSSE(c, async (stream) => {
      let ended = false;
      let end = () => {};
      const done = new Promise<void>((resolve) => { end = () => { ended = true; resolve(); }; });
      // Serialized so concurrent events never interleave inside one frame.
      let chain = Promise.resolve();
      const send = (chunk: string) => {
        if (ended) return;
        chain = chain.then(async () => { await stream.write(chunk); });
      };
      const unsubscribe = subscribe((e) => {
        if (e.type === "notify" && e.operatorId !== null && e.operatorId !== me.id) return;
        send(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
      });
      // The cookie is checked only at connect, so re-check on every ping: logout or expiry ends the stream.
      let checking = false;
      const ping = setInterval(() => {
        if (checking || ended) return;
        checking = true;
        operatorForSession(cookie)
          .then((op) => { if (op) send(": ping\n\n"); else end(); })
          .catch((err) => { console.error(`[crm-api] stream session check failed code=${code(err)}`); end(); })
          .finally(() => { checking = false; });
      }, opts.pingMs ?? PING_MS);
      send(": connected\n\n");
      stream.onAbort(end);
      const signal = c.req.raw.signal;
      if (signal.aborted) end();
      else signal.addEventListener("abort", end, { once: true });
      await done;
      clearInterval(ping);
      unsubscribe();
      await chain;
    });
  });

  r.all("/api/*", (c) => c.json({ error: "not_found" }, 404));
  r.get("*", spa(opts.webRoot ?? DEFAULT_WEB_ROOT));
  return r;
}
