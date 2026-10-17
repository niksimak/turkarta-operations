export type MessageKind = "text" | "photo" | "video" | "note" | "unsupported";
export type UnsupportedType = "video" | "animation" | "voice" | "document" | "sticker" | "video_note" | "audio";
export type TicketStatus = "new" | "allocated" | "awaiting" | "resolved";
export type DeliveryStatus = "pending" | "sent" | "failed";
export type CrmRole = "admin" | "support";
export interface Operator {
  id: number; name: string; email: string | null; role: CrmRole; is_lead: boolean;
  auto_assign_enabled: boolean; on_shift: boolean; last_active_at: string | null;
  last_assigned_at: string | null; prefs: OperatorPrefs;
}
export interface OperatorPrefs {
  theme: "system" | "light" | "dark"; sound: boolean; volume: number;
  desktop: boolean; notify_scope: "all" | "mine"; send_key: "enter" | "mod_enter";
}
export const DEFAULT_PREFS: OperatorPrefs = {
  theme: "system", sound: true, volume: 0.6, desktop: true, notify_scope: "all", send_key: "mod_enter",
};
export type TicketEventType = "created" | "assigned" | "auto_assigned" | "unassigned" | "taken_over" | "status_changed" | "reopened";
export const canEditTeamSettings = (o: Pick<Operator, "role" | "is_lead">) => o.role === "admin" || o.is_lead;
