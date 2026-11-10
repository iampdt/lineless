// A fixed-window counter, one object per client address hash and action. Used for the actions
// that create things (queues and demos), which are the expensive ones to abuse.

import { DurableObject } from "cloudflare:workers";

export interface LimitResult {
  allowed: boolean;
  retryAfterSeconds: number;
}

export class RateLimiter extends DurableObject<Env> {
  async hit(limit: number, windowMs: number): Promise<LimitResult> {
    const now = Date.now();
    const windowEnd = (Math.floor(now / windowMs) + 1) * windowMs;
    const key = `count:${windowEnd}`;
    const count = (await this.ctx.storage.get<number>(key)) ?? 0;
    if (count >= limit) return { allowed: false, retryAfterSeconds: Math.ceil((windowEnd - now) / 1000) };
    await this.ctx.storage.put(key, count + 1);
    // Forget everything once the window is over.
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(windowEnd);
    return { allowed: true, retryAfterSeconds: 0 };
  }

  async alarm(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }
}
