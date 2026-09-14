import type { Context, MiddlewareFn } from "grammy";

/** Telegram delivers album items as concurrent updates. Keep one private
 * chat's intake transitions ordered without blocking other customers.
 * This is process-local; database constraints remain the cross-process guard.
 */
export function sequencePrivateMessages(): MiddlewareFn<Context> {
  const pending = new Map<number, Promise<void>>();
  return async (ctx, next) => {
    if (ctx.chat?.type !== "private" || !ctx.message) return next();
    const key = ctx.chat.id;
    const previous = pending.get(key);
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    pending.set(key, current);
    await previous;
    try {
      await next();
    } finally {
      release();
      if (pending.get(key) === current) pending.delete(key);
    }
  };
}
