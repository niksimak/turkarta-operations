import { z } from "zod";
import { sql } from "../db.js";
import { toOperator, type OperatorRow } from "./auth.js";
import { publish } from "./events.js";
import { Forbidden, NotFound } from "./tickets.js";
import { canEditTeamSettings, type Operator } from "./types.js";

export type OperatorSummary = Omit<Operator, "prefs"> & { open_tickets: number };

const PrefsPatch = z.object({
  theme: z.enum(["system", "light", "dark"]),
  sound: z.boolean(),
  volume: z.number().min(0).max(1),
  desktop: z.boolean(),
  notify_scope: z.enum(["all", "mine"]),
  send_key: z.enum(["enter", "mod_enter"]),
}).partial().strict();

const OperatorPatch = z.object({
  is_lead: z.boolean(),
  auto_assign_enabled: z.boolean(),
  on_shift: z.boolean(),
}).partial().strict().refine((p) => Object.values(p).some((v) => v !== undefined), { message: "empty_patch" });

const summarySelect = () => sql`
  select o.*, (select count(*) from support_requests r
                where r.assigned_operator_id = o.id and r.status in ('allocated','awaiting'))::int as open_tickets
    from crm_operators o`;

function toSummary(r: OperatorRow & { open_tickets: number }): OperatorSummary {
  const { prefs: _prefs, ...rest } = toOperator(r);
  return { ...rest, open_tickets: Number(r.open_tickets) };
}

export async function listOperators(): Promise<OperatorSummary[]> {
  const rows = await sql<Array<OperatorRow & { open_tickets: number }>>`${summarySelect()} order by o.name, o.id`;
  return rows.map(toSummary);
}

/** Going on shift counts as activity, otherwise the worker would switch a stale operator straight back off. */
export async function setShift(me: Operator, on: boolean): Promise<Operator> {
  const [row] = await sql<OperatorRow[]>`
    update crm_operators
       set on_shift = ${on}::boolean,
           last_active_at = case when ${on}::boolean then now() else last_active_at end,
           updated_at = now()
     where id = ${me.id}
    returning *`;
  if (!row) throw new NotFound("operator_not_found");
  await publish({ type: "operator.updated", operatorId: me.id });
  return toOperator(row);
}

export async function heartbeat(me: Operator): Promise<void> {
  await sql`update crm_operators set last_active_at = now() where id = ${me.id}`;
}

export async function updateOperator(id: number, patch: unknown, me: Operator): Promise<OperatorSummary> {
  const p = OperatorPatch.parse(patch);
  if (p.is_lead !== undefined && me.role !== "admin") throw new Forbidden();
  if ((p.auto_assign_enabled !== undefined || p.on_shift !== undefined) && !canEditTeamSettings(me)) throw new Forbidden();
  if (!Number.isSafeInteger(id)) throw new NotFound("operator_not_found");
  const [updated] = await sql<{ id: string }[]>`
    update crm_operators
       set is_lead = coalesce(${p.is_lead ?? null}::boolean, is_lead),
           auto_assign_enabled = coalesce(${p.auto_assign_enabled ?? null}::boolean, auto_assign_enabled),
           on_shift = coalesce(${p.on_shift ?? null}::boolean, on_shift),
           updated_at = now()
     where id = ${id}
    returning id::text as id`;
  if (!updated) throw new NotFound("operator_not_found");
  await publish({ type: "operator.updated", operatorId: id });
  const [row] = await sql<Array<OperatorRow & { open_tickets: number }>>`${summarySelect()} where o.id = ${id}`;
  return toSummary(row!);
}

export async function updatePrefs(me: Operator, patch: unknown): Promise<Operator> {
  const p = PrefsPatch.parse(patch);
  const [row] = await sql<OperatorRow[]>`
    update crm_operators set prefs = prefs || ${JSON.stringify(p)}::text::jsonb, updated_at = now()
     where id = ${me.id}
    returning *`;
  if (!row) throw new NotFound("operator_not_found");
  return toOperator(row);
}
