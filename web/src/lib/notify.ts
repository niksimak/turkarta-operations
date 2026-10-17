import type { Operator } from "./queries";

export type NotifyKind = "new_ticket" | "assigned" | "mention" | "user_replied" | "reminder";

export interface NotifyEvent {
  operatorId: number | null;
  kind: NotifyKind;
  ticketId: string;
  title: string;
  body: string;
}

export function isNotifyEvent(data: unknown): data is NotifyEvent {
  const d = data as Partial<NotifyEvent> | null;
  return Boolean(
    d &&
      typeof d.kind === "string" &&
      typeof d.ticketId === "string" &&
      (d.operatorId === null || typeof d.operatorId === "number"),
  );
}

/**
 * Addressed to me (or everyone), and no broadcast when I asked for my tickets only.
 * Mirrors the push targets in src/crm/push.ts.
 */
export function shouldNotify(e: NotifyEvent, me: Pick<Operator, "id" | "prefs">): boolean {
  if (e.operatorId !== null && e.operatorId !== me.id) return false;
  if (me.prefs.notify_scope === "mine" && e.operatorId === null) return false;
  return true;
}

export type DesktopDecision = "show" | "skip";

/** A browser notification only when the tab is hidden, permission is granted and the operator wants them. */
export function desktopDecision(me: Pick<Operator, "prefs">, hidden: boolean, permission: string): DesktopDecision {
  return hidden && permission === "granted" && me.prefs.desktop ? "show" : "skip";
}

let audio: AudioContext | null = null;

/** A short two-tone blip. Silent when sound is off, volume is 0 or WebAudio is missing. */
export function playBlip(volume: number): void {
  const gainLevel = Math.max(0, Math.min(1, volume));
  if (gainLevel === 0) return;
  const Ctor =
    (window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext })
      .AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return;
  try {
    audio ??= new Ctor();
    const ctx = audio;
    if (ctx.state === "suspended") void ctx.resume();
    const t = ctx.currentTime;
    const gain = ctx.createGain();
    gain.connect(ctx.destination);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.25 * gainLevel, t + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(880, t);
    osc.frequency.setValueAtTime(1320, t + 0.07);
    osc.connect(gain);
    osc.start(t);
    osc.stop(t + 0.2);
  } catch {
    // Autoplay policy before the first click: the toast and the list still show it.
  }
}

export const NOTIFY_FALLBACK_TITLE: Record<NotifyKind, string> = {
  new_ticket: "Новое обращение",
  assigned: "Вам назначено обращение",
  mention: "Вас упомянули в заметке",
  user_replied: "Клиент ответил",
  reminder: "Ждёт ответа",
};

export interface NotifyDeps {
  /** In-app toast; `key` dedupes per ticket. */
  toast: (title: string, body: string, key: string, open: () => void) => void;
  open: (ticketId: string) => void;
  hidden?: () => boolean;
  permission?: () => string;
  blip?: (volume: number) => void;
  showDesktop?: (title: string, body: string, tag: string, onClick: () => void) => void;
}

function defaultDesktop(title: string, body: string, tag: string, onClick: () => void) {
  try {
    const n = new Notification(title, { body, tag });
    n.onclick = () => {
      window.focus();
      onClick();
      n.close();
    };
  } catch {
    // Some browsers only allow notifications from a service worker.
  }
}

/** SSE `notify`: blip, in-app toast for personal events, browser notification when hidden. */
export function handleNotify(e: NotifyEvent, me: Pick<Operator, "id" | "prefs">, deps: NotifyDeps): void {
  if (!shouldNotify(e, me)) return;
  const hidden = deps.hidden?.() ?? document.hidden;
  const permission = deps.permission?.() ?? (typeof Notification === "undefined" ? "denied" : Notification.permission);
  const title = e.title || NOTIFY_FALLBACK_TITLE[e.kind];
  const open = () => deps.open(e.ticketId);

  if (me.prefs.sound) (deps.blip ?? playBlip)(me.prefs.volume);
  if (desktopDecision(me, hidden, permission) === "show") {
    (deps.showDesktop ?? defaultDesktop)(title, e.body, `crm-${e.kind}-${e.ticketId}`, open);
  } else if (!hidden && e.kind !== "new_ticket") {
    // New tickets already appear in the live list; personal events deserve a toast.
    deps.toast(title, e.body, `notify-${e.ticketId}`, open);
  }
}
